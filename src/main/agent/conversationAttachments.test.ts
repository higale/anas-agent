import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { AgentAttachmentArtifact } from '@shared/agentTypes'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createConversationAttachmentProjector, validateSubmittedImageAttachments } from './conversationAttachments'
import { stripConversationAttachments } from './conversationAttachments'

vi.mock('../config/appConfig', () => ({ getAppConfigSnapshot: async () => ({ settings: { attachmentTextMaxChars: 1000, attachmentTextOverflow: 'truncate' } }) }))

const pixel = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j3ioAAAAASUVORK5CYII='
const imageBlock = { type: 'image' as const, data: pixel, mimeType: 'image/png' }

describe('attachment submission preflight', () => {
  it('counts only retained conversation attachments alongside the new input, preserving originals', async () => {
    const root = await temporaryDirectory(), path = join(root, 'pixel.png')
    await writeFile(path, Buffer.from(pixel, 'base64'))
    const messages: ConversationMessage[] = [{ id: 'run-1:input', kind: 'user', content: 'Earlier image' }]
    const original = structuredClone(messages)
    const input = { text: 'New image', content: [imageBlock] }
    const model = { capabilities: { vision: true, toolUse: true }, imageLimits: { maxCount: 1 } }
    const image = artifact(path, { kind: 'image', mimeType: 'image/png' })
    await expect(validateSubmittedImageAttachments(input, model, messages, [image])).resolves.toBeUndefined()
    await expect(validateSubmittedImageAttachments(input, model, messages, [{ ...image, contextPolicy: 'conversation' }])).rejects.toThrow('contains 2 embedded images')
    await expect(validateSubmittedImageAttachments(input, model, [], [{ ...image, contextPolicy: 'conversation' }])).resolves.toBeUndefined()
    expect(messages).toEqual(original)
    expect(input.content).toEqual([imageBlock])
  })

  it('rereads source files and rejects changed files or rules without modifying the input', async () => {
    const root = await temporaryDirectory(), path = join(root, 'pixel.png')
    await writeFile(path, Buffer.from(pixel, 'base64'))
    const input = { text: 'Keep this draft', attachments: [{ path, name: 'pixel.png', kind: 'image' as const,
      mimeType: 'image/png', size: 1, contextPolicy: 'one_turn' as const }] }
    const model = { capabilities: { vision: true, toolUse: true }, imageLimits: { minShortSide: 1 } }
    await expect(validateSubmittedImageAttachments(input, model)).resolves.toBeUndefined()
    await expect(validateSubmittedImageAttachments(input, { ...model, imageLimits: { minShortSide: 2 } })).rejects.toThrow('pixel.png: Dimensions 1×1')
    await expect(validateSubmittedImageAttachments(input, { ...model, imageLimits: { maxBytes: 1 } })).rejects.toThrow('Original size')
    await writeFile(path, 'no longer an image')
    await expect(validateSubmittedImageAttachments(input, model)).rejects.toThrow('pixel.png')
    expect(input.text).toBe('Keep this draft')
    expect(input.attachments).toHaveLength(1)
  })
})

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
  it.each([true, false])('retains the original path when historical image data is omitted (vision=%s)', async vision => {
    const sourcePath = 'C:\\images\\diagram.png'
    const image = artifact('/archive/need/not/exist.png', { name: 'diagram.png', sourcePath, kind: 'image', mimeType: 'image/png' })
    const messages: ConversationMessage[] = [{ id: image.messageId, kind: 'user', content: 'Inspect this' }]
    const target = projector([], 'later-run', vision)
    target.addArtifacts([image])
    const [projected] = await target.project(messages)
    expect(projected.content).toContainEqual({ type: 'text', text: `[Attachment: diagram.png]\nOriginal path: ${sourcePath}` })
    expect(JSON.stringify(projected.content)).not.toContain(image.path)
    expect(JSON.stringify(projected.content)).toContain('image data omitted')
    expect((projected.content as { type: string }[]).every(block => block.type === 'text')).toBe(true)
    expect(stripConversationAttachments([projected])).toEqual([{ ...messages[0], content: [{ type: 'text', text: 'Inspect this' }], context: {} }])
    expect(messages[0].content).toBe('Inspect this')
  })

  it.each(['image', 'text'] as const)('provides the original %s path while reading the archived content', async kind => {
    const root = await temporaryDirectory(), archivedPath = join(root, 'content'), originalPath = join(root, '原始目录', '附件 # 100%')
    await writeFile(archivedPath, kind === 'image' ? Buffer.from(pixel, 'base64') : 'Archived text')
    const saved = artifact(archivedPath, { name: '附件 # 100%', sourcePath: originalPath, kind, mimeType: kind === 'image' ? 'image/png' : 'text/plain' })
    const [projected] = await projector([saved], 'run-1').project([{ id: saved.messageId, kind: 'user', content: 'Inspect' }])
    expect(projected.content).toContainEqual({ type: 'text', text: kind === 'image'
      ? `[Attachment: 附件 # 100%]\nOriginal path: ${originalPath}` : `Original path: ${originalPath}\n<file name="附件 # 100%">\nArchived text\n</file>` })
    expect(JSON.stringify(projected.content)).not.toContain(JSON.stringify(archivedPath).slice(1, -1))
    if (kind === 'image') expect(projected.content).toContainEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${pixel}`, detail: 'auto' } })
    expect(saved.sourcePath).toBe(originalPath)
    expect(saved.path).toBe(archivedPath)
  })

  it('keeps only the filename for an old image without an original path', async () => {
    const root = await temporaryDirectory(), path = join(root, 'archived.png')
    await writeFile(path, Buffer.from(pixel, 'base64'))
    const image = artifact(path, { name: 'old.png', kind: 'image', mimeType: 'image/png' })
    const messages: ConversationMessage[] = [{ id: image.messageId, kind: 'user', content: 'Old image' }]
    const [projected] = await projector([image], 'later-run').project(messages)
    expect(projected.content).toContainEqual({ type: 'text', text: '[Attachment: old.png]' })
    expect(JSON.stringify(projected.content)).not.toContain(JSON.stringify(path).slice(1, -1))
    expect(JSON.stringify(projected.content)).not.toContain('Original path:')
    const [retained] = await projector([{ ...image, contextPolicy: 'conversation' }], 'later-run').project(messages)
    expect(retained.content).toContainEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${pixel}`, detail: 'auto' } })
  })

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
  expect(JSON.stringify(projected.content)).not.toContain(JSON.stringify(path).slice(1, -1))
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
