import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { AgentAttachmentArtifact } from '@shared/agentTypes'
import { afterEach, describe, expect, it } from 'vitest'
import { createConversationAttachmentProjector } from './conversationAttachments'
import { stripConversationAttachments } from './conversationAttachments'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'anas-attachment-projection-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

function artifact(
  path: string,
  overrides: Partial<AgentAttachmentArtifact> = {}
): AgentAttachmentArtifact {
  return {
    id: 'attachment-1',
    threadId: 'thread-1',
    messageId: 'run-1:input',
    runId: 'run-1',
    name: 'notes.txt',
    mimeType: 'text/plain',
    size: 12,
    kind: 'text',
    path,
    available: true,
    textTruncated: false,
    contextPolicy: 'one_turn',
    createdAt: '2026-07-28T00:00:00.000Z',
    ...overrides
  }
}

function projector(
  artifacts: AgentAttachmentArtifact[],
  currentRunId: string,
  visionEnabled = true
) {
  const projection = createConversationAttachmentProjector({
    artifacts,
    currentRunId,
    textMaxChars: 1_000,
    textOverflow: 'truncate'
  })
  return { ...projection, project: (messages: ConversationMessage[], includedMessageIds?: ReadonlySet<string>) => projection.project(messages, visionEnabled, includedMessageIds) }
}

describe('conversation attachment projection', () => {
  it('projects one-turn content throughout its source run without mutating stored messages', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'notes.txt')
    await writeFile(path, 'projected text', 'utf8')
    const source = { kind: 'user' as const,
      id: 'run-1:input',
      content: 'Review this',
      context: { runId: 'run-1' }
    }

    const projected = await projector([artifact(path)], 'run-1').project([source])

    expect(source.content).toBe('Review this')
    expect(projected[0]).not.toBe(source)
    expect(JSON.stringify(projected[0].content)).toContain('projected text')
    expect(stripConversationAttachments(projected)[0].content).toEqual([
      { type: 'text', text: 'Review this' }
    ])
  })

  it('projects attachments registered after the current run has started', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'direction.txt')
    await writeFile(path, 'late direction attachment', 'utf8')
    const target = projector([], 'run-1')
    target.addArtifacts([artifact(path, {
      messageId: 'run-1:direction:queued-1',
      name: 'direction.txt'
    })])

    const [projected] = await target.project([
      { kind: 'user' as const, id: 'run-1:direction:queued-1', content: 'Updated direction' }
    ])

    expect(JSON.stringify(projected.content)).toContain('late direction attachment')
  })

  it('excludes one-turn artifacts from later runs and keeps conversation artifacts', async () => {
    const root = await temporaryDirectory()
    const oneTurnPath = join(root, 'one-turn.txt')
    const pinnedPath = join(root, 'pinned.txt')
    await writeFile(oneTurnPath, 'one turn only', 'utf8')
    await writeFile(pinnedPath, 'retained conversation content', 'utf8')
    const source = { kind: 'user' as const, id: 'run-1:input', content: 'Earlier request' }
    const current = { kind: 'user' as const, id: 'run-2:input', content: 'Follow up' }

    const projected = await projector([
      artifact(oneTurnPath),
      artifact(pinnedPath, {
        id: 'attachment-2',
        name: 'pinned.txt',
        contextPolicy: 'conversation'
      })
    ], 'run-2').project([source, current])
    const content = JSON.stringify(projected.map((message) => message.content))

    expect(content).not.toContain('one turn only')
    expect(content).toContain('retained conversation content')
  })

  it('stops projecting retained artifacts after their source message is compressed', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'pinned.txt')
    await writeFile(path, 'long-lived reference', 'utf8')
    const summary = { kind: 'user' as const,
      id: 'summary-1',
      content: 'Previous conversation summary',
      context: { summary: true }
    }

    const [projectedSummary] = await projector([
      artifact(path, { contextPolicy: 'conversation' })
    ], 'run-2').project([summary])

    expect(projectedSummary.content).toBe('Previous conversation summary')
    expect(projectedSummary.context?.summary).toBe(true)
  })

  it('keeps projecting retained artifacts while their source message remains after compression', async () => {
    const root = await temporaryDirectory()
    const path = join(root, 'pinned.txt')
    await writeFile(path, 'preserved reference', 'utf8')
    const summary = { kind: 'user' as const,
      id: 'summary-1',
      content: 'Earlier conversation summary',
      context: { summary: true }
    }
    const preservedSource = { kind: 'user' as const,
      id: 'run-1:input',
      content: 'Preserved request'
    }

    const projected = await projector([
      artifact(path, { contextPolicy: 'conversation' })
    ], 'run-2').project([summary, preservedSource])

    expect(JSON.stringify(projected[0].content)).not.toContain('preserved reference')
    expect(JSON.stringify(projected[1].content)).toContain('preserved reference')
  })

  it('stops instead of omitting required images when the model does not support vision', async () => {
    const source = { kind: 'user' as const, id: 'run-1:input', content: 'Review this image' }
    const image = artifact('/path/does/not/need/to/exist.png', {
      name: 'diagram.png',
      mimeType: 'image/png',
      kind: 'image'
    })

    await expect(projector([image], 'run-1', false).project([source])).rejects.toThrow('does not support the required image attachment "diagram.png"')
    expect(source.content).toBe('Review this image')
  })

  it('does not reopen compressed image attachments for a model without vision', async () => {
    const source = { kind: 'user' as const, id: 'run-1:input', content: 'Earlier image request' }
    const current = { kind: 'user' as const, id: 'run-2:input', content: 'Continue from the summary' }
    const image = artifact('/compressed/image/need/not/exist.png', {
      name: 'diagram.png', mimeType: 'image/png', kind: 'image', contextPolicy: 'conversation'
    })
    const messages = [source, current]
    expect(await projector([image], 'run-2', false).project(messages, new Set([current.id!]))).toEqual(messages)
    await expect(projector([image], 'run-2', false).project(messages, new Set([source.id!, current.id!])))
      .rejects.toThrow('does not support the required image attachment')
  })
})


it.each([true, false])('reports missing attachment content to the model (available=%s)', async available => {
  const root = await temporaryDirectory(), path = join(root, 'missing.txt')
  const source = { id: 'run-1:input', kind: 'user' as const, content: 'Read the attachment.' }
  const target = projector([artifact(path, { available })], 'run-1')
  const [projected] = await target.project([source])
  expect(JSON.stringify(projected.content)).toContain('Application attachment notice')
  expect(JSON.stringify(projected.content)).toContain('content was not provided')
  expect(source.content).toBe('Read the attachment.')
  expect(stripConversationAttachments([projected])[0].content).toEqual([{ type: 'text', text: source.content }])
  await writeFile(path, 'late change')
  expect(await target.project([source])).toEqual([projected])
})

it('passes readable image bytes through without imposing local decoder compatibility', async () => {
  const root = await temporaryDirectory(), path = join(root, 'provider-specific.png')
  await writeFile(path, 'provider-specific-image-bytes')
  const [projected] = await projector([artifact(path, { kind: 'image', mimeType: 'image/png' })], 'run-1')
    .project([{ id: 'run-1:input', kind: 'user', content: 'Look' }])
  expect(JSON.stringify(projected.content)).toContain(Buffer.from('provider-specific-image-bytes').toString('base64'))
  expect(JSON.stringify(projected.content)).not.toContain('Application attachment notice')
})

it('reports extraction failure instead of silently omitting a document', async () => {
  const root = await temporaryDirectory(), path = join(root, 'broken.docx')
  await writeFile(path, 'not a document archive')
  const [projected] = await projector([artifact(path, { name: 'broken.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' })], 'run-1')
    .project([{ id: 'run-1:input', kind: 'user', content: 'Read' }])
  expect(JSON.stringify(projected.content)).toContain('extracting its text failed')
  expect(JSON.stringify(projected.content)).toContain('broken.docx')
})
