import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import Database from 'better-sqlite3'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeAgentRuntime } from './nativeAgentRuntime'
import { NativeRunHost } from './nativeRunHost'
import { ManagedCallService } from './managedCallService'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { conversationExecution } from '../../runtime/conversationExecution'
import type { RunExecution } from '../../runtime/runExecution'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeEvent } from '@shared/agentTypes'
import {
  archiveAgentAttachments, type ArchivedAgentAttachment,
  deleteArchivedAgentAttachments
} from './agentAttachmentStore'

const temporaryDirectories: string[] = []

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'anas-attachment-test-'))
  temporaryDirectories.push(directory)
  return directory
}

const databases: Array<{ product: NativeConversationDatabase; global: Database.Database }> = []
function openDatabase(file: string, attachmentRoot: string) {
  const global = new Database(':memory:')
  const product = NativeConversationDatabase.open(file, { attachmentRoot, memoryStore: new SqliteMemoryStore(global),
    fileEditStore: new FileEditStore(join(dirname(attachmentRoot), 'file_edits')) })
  databases.push({ product, global })
  return product
}
function createHost(database: NativeConversationDatabase, events: AgentRuntimeEvent[] = []) {
  return new NativeRunHost(database, new ManagedCallService(database.managed, database.results), { push: event => events.push(event) })
}
function execution(database: NativeConversationDatabase) {
  return conversationExecution({ store: database.runs.store, enter: database.execution.enter,
    prepareModel: async state => ({ kind: 'model', invoke: async () => ({
      message: { id: state.runId + ':answer', value: { kind: 'assistant', content: 'Done', context: { runId: state.runId } } },
      calls: [], context: { ...state.context, modelCalls: state.context.modelCalls + 1 } }) }),
    afterModel: async () => ({ kind: 'complete' }), prepareTools: async () => ({ calls: [] }),
    executeTool: async () => { throw new Error('No tools expected') }, directions: async () => [], drain: async () => {}, retry: { maxRetries: 0 } })
}
async function completeInput(database: NativeConversationDatabase, threadId: string, runId: string, attachments: ArchivedAgentAttachment[], text = 'Task') {
  const id = runId + ':input'
  database.runs.createRun({ threadId, runId, operation: 'agent', attachments,
    message: { id, value: { id, kind: 'user', content: text, context: { runId } } } })
  await database.runs.enter('input', { threadId, runId })
  const scope = () => ({ threadId, runId, expectedRevisionId: database.runs.store.load(threadId)!.revisionId })
  database.runs.store.acceptModel(scope(), { id: runId + ':answer', value: { kind: 'assistant', content: 'Done', context: { runId } } }, [],
    { modelCalls: 1, todos: [] })
  database.runs.store.finish(scope(), 'completed')
}

afterEach(async () => {
  vi.restoreAllMocks()
  for (const { product, global } of databases.splice(0)) { product.close(); global.close() }
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ))
})

describe('agent attachment store', () => {
  it('archives a durable local copy and restores its metadata from SQLite', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.txt')
    const attachmentRoot = join(root, 'attachments')
    const databasePath = join(root, 'agent.sqlite')
    await writeFile(sourcePath, 'durable attachment', 'utf8')
    const database = openDatabase(databasePath, attachmentRoot)
    const matchingThread = database.createThread({ title: 'Archived attachment' })
    database.close()
    const matchingRunId = randomUUID()
    const matchingMessageId = `${matchingRunId}:input`

    const matchingArchived = await archiveAgentAttachments([{
      path: sourcePath,
      name: 'source.txt',
      mimeType: 'text/plain',
      size: 18,
      kind: 'text',
      textTruncated: true,
      contextPolicy: 'one_turn'
    }], {
      threadId: matchingThread.id,
      runId: matchingRunId,
      messageId: matchingMessageId
    }, attachmentRoot)
    const writeDatabase = openDatabase(databasePath, attachmentRoot)
    await completeInput(writeDatabase, matchingThread.id, matchingRunId, matchingArchived)
    writeDatabase.close()
    await rm(sourcePath)

    const restoredDatabase = openDatabase(databasePath, attachmentRoot)
    const [artifact] = restoredDatabase.resources.listAttachmentsForThread(matchingThread.id)
    expect(artifact).toMatchObject({
      threadId: matchingThread.id,
      runId: matchingRunId,
      messageId: matchingMessageId,
      name: 'source.txt',
      mimeType: 'text/plain',
      kind: 'text',
      available: true,
      textTruncated: true,
      contextPolicy: 'one_turn'
    })
    expect(await readFile(artifact.path, 'utf8')).toBe('durable attachment')
    await rm(artifact.path)
    expect(restoredDatabase.resources.listAttachmentsForThread(matchingThread.id)[0].available).toBe(false)
    restoredDatabase.close()
  })

  it('rolls back earlier copies when a later attachment cannot be archived', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.txt')
    const attachmentRoot = join(root, 'attachments')
    await writeFile(sourcePath, 'first attachment', 'utf8')
    const threadId = randomUUID()
    const runId = randomUUID()

    await expect(archiveAgentAttachments([
      {
        path: sourcePath,
        name: 'source.txt',
        mimeType: 'text/plain',
        size: 16,
        kind: 'text',
        contextPolicy: 'one_turn'
      },
      {
        path: join(root, 'missing.txt'),
        name: 'missing.txt',
        mimeType: 'text/plain',
        size: 0,
        kind: 'text',
        contextPolicy: 'one_turn'
      }
    ], {
      threadId,
      runId,
      messageId: `${runId}:input`
    }, attachmentRoot)).rejects.toThrow()

    const threadEntries = await readdir(join(attachmentRoot, threadId))
    expect(threadEntries).toEqual([])
  })

  it('removes archived copies when run creation fails', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.txt')
    const attachmentRoot = join(root, 'attachments')
    await writeFile(sourcePath, 'rollback attachment', 'utf8')
    const database = openDatabase(':memory:', attachmentRoot)
    const runtime = createHost(database)
    const failedThreadId = database.createThread({ title: 'Failed submission' }).id
    vi.spyOn(database.runs, 'createRun').mockImplementationOnce(() => { throw new Error('Run transaction failed') })
    const runId = randomUUID()

    await expect(runtime.submitRunWithAttachments({
      runId,
      threadId: failedThreadId,
      submissionId: randomUUID(),
      text: 'Read the attachment',
      attachments: [{
        path: sourcePath,
        name: 'source.txt',
        mimeType: 'text/plain',
        size: 19,
        kind: 'text',
        contextPolicy: 'one_turn'
      }]
    }, async () => { throw new Error('Failed input must not execute') })).rejects.toThrow('Run transaction failed')

    expect(await readdir(join(attachmentRoot, failedThreadId))).toEqual([])
    expect(database.messages.activities.getRun(runId)).toBeNull()
    await runtime.shutdown()
    database.close()
  })

  it('waits for persisted attachment cleanup during runtime startup', async () => {
    const root = await temporaryDirectory()
    const attachmentRoot = join(root, 'attachments')
    const file = join(root, 'conversation.sqlite')
    const database = openDatabase(file, attachmentRoot)
    // Persist the cleanup intent left after a conversation was removed, without constructing a legacy database.
    const thread = { id: randomUUID() }
    const threadRoot = join(attachmentRoot, thread.id)
    await mkdir(threadRoot, { recursive: true })
    await writeFile(join(threadRoot, 'orphan.txt'), 'remove on startup', 'utf8')
    const pending = new Database(file)
    pending.pragma('foreign_keys=ON')
    pending.prepare('INSERT INTO agent_attachment_cleanup_outbox(thread_id) VALUES (?)').run(thread.id)
    pending.close()
    expect(database.resourceCleanup.listAttachmentCleanupThreadIds()).toEqual([thread.id])

    const runtime = new NativeAgentRuntime(database, root, { push: () => {} })
    await runtime.waitForStartupCleanup()

    await expect(stat(threadRoot)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(database.resourceCleanup.listAttachmentCleanupThreadIds()).toEqual([])
    await runtime.shutdown()
    database.close()
  })

  it('publishes the authoritative user message with archived attachment metadata', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.txt')
    const attachmentRoot = join(root, 'attachments')
    await writeFile(sourcePath, 'event attachment', 'utf8')
    const database = openDatabase(':memory:', attachmentRoot)
    const thread = database.createThread({ title: 'Attachment event' })
    const runId = randomUUID()
    const events: AgentRuntimeEvent[] = []
    const runtime = createHost(database, events)
    const cleanupFileEdits = vi.spyOn(database.resourceCleanup, 'acknowledgeFileEditCleanup')
    const runExecution = execution(database)
    const execute = vi.fn<RunExecution['execute']>((state, context, observer) => runExecution.execute(state, context, observer))
    const submitted = await runtime.submitRunWithAttachments({
      submissionId: randomUUID(),
      runId,
      threadId: thread.id,
      text: 'Review the attachment',
      attachments: [{
        path: sourcePath,
        name: 'source.txt',
        mimeType: 'text/plain',
        size: 16,
        kind: 'text',
        contextPolicy: 'one_turn'
      }]
    }, async () => ({ execution: { execute }, dispose: async () => {} }))
    expect((await submitted.handle!.completed).status).toBe('completed')
    await submitted.handle!.drained

    expect(events[0]).toMatchObject({
      type: 'run_started',
      newUserTurn: true,
      userMessage: {
        id: `${runId}:input`,
        role: 'user',
        runId,
        content: [{ type: 'text', text: 'Review the attachment' }],
        attachments: [{
          threadId: thread.id,
          runId,
          messageId: `${runId}:input`,
          name: 'source.txt',
          path: expect.stringContaining(attachmentRoot)
        }]
      }
    })
    if (events[0]?.type !== 'run_started' || !events[0].newUserTurn) {
      throw new Error('Expected a new-user-turn run event.')
    }
    expect(events[0].userMessage.attachments?.[0]?.path).not.toBe(sourcePath)
    expect(execute).toHaveBeenCalledOnce()
    expect(database.runs.store.readHistory(thread.id)!.messages[0]).toMatchObject({
      id: `${runId}:input`, value: { kind: 'user', context: { runId } }
    })
    expect(cleanupFileEdits).toHaveBeenCalledWith(runId)
    await runtime.shutdown()
    database.close()
  })

  it('deletes archived files durably queued by run-range cleanup', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.txt')
    const attachmentRoot = join(root, 'attachments')
    await writeFile(sourcePath, 'cleanup attachment', 'utf8')
    const database = openDatabase(':memory:', attachmentRoot)
    const thread = database.createThread({ title: 'Cleanup' })
    const runId = randomUUID()
    const archived = await archiveAgentAttachments([{
      path: sourcePath,
      name: 'source.txt',
      mimeType: 'text/plain',
      size: 18,
      kind: 'text',
      contextPolicy: 'one_turn'
    }], {
      threadId: thread.id,
      runId,
      messageId: `${runId}:input`
    }, attachmentRoot)
    await completeInput(database, thread.id, runId, archived)
    database.history.commit(database.history.prepare({ threadId: thread.id, messageId: runId + ':input', kind: 'truncate' }))
    const [artifact] = database.resourceCleanup.listAttachmentFileCleanup()

    await deleteArchivedAgentAttachments([artifact], attachmentRoot)
    database.resourceCleanup.acknowledgeAttachmentFileCleanup(artifact.id)
    await expect(stat(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(database.resources.listAttachmentsForThread(thread.id)).toEqual([])
    expect(database.resourceCleanup.listAttachmentFileCleanup()).toEqual([])
    database.close()
  })

  it('rebinds target-run attachments and only discards later-run files during regeneration', async () => {
    const root = await temporaryDirectory()
    const attachmentRoot = join(root, 'attachments')
    const targetSource = join(root, 'target.txt')
    const laterSource = join(root, 'later.txt')
    await writeFile(targetSource, 'target attachment', 'utf8')
    await writeFile(laterSource, 'later attachment', 'utf8')
    const database = openDatabase(':memory:', attachmentRoot)
    const thread = database.createThread({ title: 'Regeneration attachments' })
    const targetRunId = 'target-run'
    const laterRunId = 'later-run'
    const targetMessageId = `${targetRunId}:input`
    const targetArchived = await archiveAgentAttachments([{
      path: targetSource,
      name: 'target.txt',
      mimeType: 'text/plain',
      size: 17,
      kind: 'text',
      contextPolicy: 'one_turn'
    }], {
      threadId: thread.id,
      runId: targetRunId,
      messageId: targetMessageId
    }, attachmentRoot)
    await completeInput(database, thread.id, targetRunId, targetArchived)
    const laterArchived = await archiveAgentAttachments([{
      path: laterSource,
      name: 'later.txt',
      mimeType: 'text/plain',
      size: 16,
      kind: 'text',
      contextPolicy: 'conversation'
    }], {
      threadId: thread.id,
      runId: laterRunId,
      messageId: `${laterRunId}:input`
    }, attachmentRoot)
    await completeInput(database, thread.id, laterRunId, laterArchived)

    const replacement = database.history.commit(database.history.prepare({ threadId: thread.id, messageId: targetMessageId,
      kind: 'regenerate', runId: 'replacement-run' }))

    expect(replacement.run).toMatchObject({ id: 'replacement-run', status: 'running' })
    const discarded = database.resourceCleanup.listAttachmentFileCleanup()
    expect(discarded).toEqual([expect.objectContaining({ id: laterArchived[0].artifact.id })])
    await deleteArchivedAgentAttachments(discarded, attachmentRoot)
    for (const attachment of discarded) database.resourceCleanup.acknowledgeAttachmentFileCleanup(attachment.id)
    await expect(stat(laterArchived[0].artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
    const [preserved] = database.resources.listAttachmentsForThread(thread.id)
    expect(preserved).toMatchObject({
      id: targetArchived[0].artifact.id,
      runId: 'replacement-run',
      messageId: targetMessageId
    })
    expect(await readFile(preserved.path, 'utf8')).toBe('target attachment')
    expect(database.messages.activities.getRun(targetRunId)).toBeNull()
    expect(database.messages.activities.getRun(laterRunId)).toBeNull()
    database.close()
  })

  it('copies message attachments into editable temporary files before truncating history', async () => {
    const root = await temporaryDirectory()
    const attachmentRoot = join(root, 'attachments')
    const temporaryRoot = join(root, 'tmp')
    const sourcePath = join(root, 'editable.txt')
    const imageSourcePath = join(root, 'editable.png')
    await Promise.all([
      writeFile(sourcePath, 'editable attachment', 'utf8'),
      writeFile(imageSourcePath, 'editable image', 'utf8')
    ])
    const database = openDatabase(':memory:', attachmentRoot)
    const thread = database.createThread({ title: 'Edit attachments' })
    const runId = 'editable-run'
    const messageId = `${runId}:input`
    const archived = await archiveAgentAttachments([
      {
        path: sourcePath,
        name: 'editable.txt',
        mimeType: 'text/plain',
        size: 19,
        kind: 'text',
        textTruncated: true,
        contextPolicy: 'conversation'
      },
      {
        path: imageSourcePath,
        name: 'editable.png',
        mimeType: 'image/png',
        size: 14,
        kind: 'image',
        contextPolicy: 'one_turn'
      }
    ], {
      threadId: thread.id,
      runId,
      messageId
    }, attachmentRoot)
    await completeInput(database, thread.id, runId, archived, 'Review it')
    const runtime = createHost(database)
    const result = await runtime.prepareMessageEdit({ threadId: thread.id, messageId }, temporaryRoot)

    expect(result.snapshot.messages).toEqual([])
    expect(result.attachments).toEqual([
      expect.objectContaining({
        name: 'editable.txt',
        contextPolicy: 'conversation',
        truncated: true,
        temporary: true
      }),
      expect.objectContaining({
        name: 'editable.png',
        contextPolicy: 'one_turn',
        temporary: true,
        dataUri: `data:image/png;base64,${Buffer.from('editable image').toString('base64')}`
      })
    ])
    expect(await readFile(result.attachments[0].path, 'utf8')).toBe('editable attachment')
    expect(await readFile(result.attachments[1].path, 'utf8')).toBe('editable image')
    await Promise.all(archived.map(({ artifact }) =>
      expect(stat(artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
    ))

    const missingSource = join(root, 'missing-after-archive.txt')
    await writeFile(missingSource, 'will disappear', 'utf8')
    const missingThread = database.createThread({ title: 'Missing edit attachment' })
    const missingRunId = 'missing-edit-run'
    const missingMessageId = `${missingRunId}:input`
    const missingArchived = await archiveAgentAttachments([{
      path: missingSource,
      name: 'missing-after-archive.txt',
      mimeType: 'text/plain',
      size: 14,
      kind: 'text',
      contextPolicy: 'one_turn'
    }], {
      threadId: missingThread.id,
      runId: missingRunId,
      messageId: missingMessageId
    }, attachmentRoot)
    await completeInput(database, missingThread.id, missingRunId, missingArchived, 'Missing attachment')
    await rm(missingArchived[0].artifact.path)

    await expect(runtime.prepareMessageEdit({
      threadId: missingThread.id,
      messageId: missingMessageId
    }, temporaryRoot)).rejects.toThrow('missing-after-archive.txt')
    expect(database.messages.activities.getRun(missingRunId)).toMatchObject({ status: 'completed' })
    expect(database.runs.store.readHistory(missingThread.id)!.messages[0].id).toBe(missingMessageId)
    await runtime.shutdown()
    database.close()
  })
})
