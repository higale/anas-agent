import Database from 'better-sqlite3'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as attachmentStore from './agentAttachmentStore'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { NativeAgentRuntime } from './nativeAgentRuntime'
import { runtimeLog } from '../runtimeLogger'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

const roots: string[] = [], globals: Database.Database[] = []
function openDatabase(file: string, attachmentRoot: string, onFileChanges?: (runId: string) => void) {
  const global = new Database(':memory:'); globals.push(global)
  return NativeConversationDatabase.open(file, { attachmentRoot, onFileChanges,
    memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(attachmentRoot, '..', 'file_edits')) })
}
afterEach(async () => {
  vi.restoreAllMocks()
  for (const global of globals.splice(0)) global.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function editableConversation(onFileChanges?: (runId: string) => void) {
  const root = await mkdtemp(join(tmpdir(), 'anas-history-cleanup-'))
  roots.push(root)
  const attachmentRoot = join(root, 'attachments')
  const temporaryRoot = join(root, 'temporary')
  const databasePath = join(root, 'conversation.sqlite')
  const database = openDatabase(databasePath, attachmentRoot, onFileChanges)
  const source = join(root, 'original.txt')
  await writeFile(source, 'original attachment')
  const thread = database.createThread({ title: 'Editable conversation' })
  const runId = 'editable-run'
  const messageId = `${runId}:input`
  const archived = await attachmentStore.archiveAgentAttachments([{
    path: source, name: 'original.txt', size: 19, mimeType: 'text/plain',
    kind: 'text', contextPolicy: 'conversation'
  }], { threadId: thread.id, runId, messageId }, attachmentRoot)
  database.runs.createRun({ threadId: thread.id, runId, operation: 'agent', attachments: archived,
    message: { id: messageId, value: { id: messageId, kind: 'user', content: 'Keep my draft', context: { runId } } } })
  await database.runs.enter('input', { threadId: thread.id, runId })
  database.runs.store.finish({ threadId: thread.id, runId, expectedRevisionId: database.runs.store.load(thread.id)!.revisionId }, 'completed')
  return { database, databasePath, attachmentRoot, temporaryRoot, thread, runId, messageId, artifact: archived[0].artifact }
}

function runtimeFor(database: NativeConversationDatabase, temporaryRoot: string): NativeAgentRuntime {
  return new NativeAgentRuntime(database, temporaryRoot, { push: () => {} })
}

it.each([false, true])('returns an intact edit draft after cleanup failure and retries on reopen (display failure: %s)', async displayFails => {
  const onFileChanges = vi.fn(() => { if (displayFails) throw new Error('display unavailable') })
  const fixture = await editableConversation(onFileChanges)
  let database = fixture.database
  let runtime = runtimeFor(database, fixture.temporaryRoot)
  try {
    await runtime.waitForStartupCleanup()
    const cleanup = vi.spyOn(attachmentStore, 'deleteArchivedAgentAttachments')
      .mockRejectedValueOnce(Object.assign(new Error('attachment busy'), { code: 'EPERM' }))
    onFileChanges.mockClear()
    const draft = await runtime.prepareMessageEdit({ threadId: fixture.thread.id, messageId: fixture.messageId }, fixture.temporaryRoot)
    expect(draft.snapshot.messages).toEqual([])
    expect(onFileChanges).toHaveBeenCalledWith(fixture.runId)
    if (displayFails) expect(runtimeLog).toHaveBeenCalledWith('warn', 'agent', expect.stringContaining('committed history'),
      { runId: fixture.runId, error: 'display unavailable' })
    expect(database.messages.activities.getRun(fixture.runId)).toBeNull()
    expect(await readFile(draft.attachments[0].path, 'utf8')).toBe('original attachment')
    expect(database.resourceCleanup.listAttachmentFileCleanup()).toEqual([{ id: fixture.artifact.id, path: fixture.artifact.path }])
    expect(await readFile(fixture.artifact.path, 'utf8')).toBe('original attachment')
    await runtime.shutdown()
    database.close()

    cleanup.mockRestore()
    database = openDatabase(fixture.databasePath, fixture.attachmentRoot)
    runtime = runtimeFor(database, fixture.temporaryRoot)
    await runtime.waitForStartupCleanup()
    expect(database.resourceCleanup.listAttachmentFileCleanup()).toEqual([])
    await expect(stat(fixture.artifact.path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(draft.attachments[0].path, 'utf8')).toBe('original attachment')
  } finally {
    await runtime.shutdown()
    database.close()
  }
})

it('rolls history and attachment references back if durable cleanup enqueue fails', async () => {
  const onFileChanges = vi.fn()
  const fixture = await editableConversation(onFileChanges)
  const { database } = fixture, runtime = runtimeFor(database, fixture.temporaryRoot)
  try {
    await runtime.waitForStartupCleanup()
    const raw = (database as unknown as { database: Database.Database }).database
    raw.exec(`CREATE TRIGGER reject_cleanup BEFORE INSERT ON agent_attachment_file_cleanup_outbox
      BEGIN SELECT RAISE(ABORT, 'cleanup unavailable'); END`)
    onFileChanges.mockClear()
    await expect(runtime.prepareMessageEdit({ threadId: fixture.thread.id, messageId: fixture.messageId }, fixture.temporaryRoot)).rejects.toThrow('cleanup unavailable')
    expect(onFileChanges).not.toHaveBeenCalled()
    expect(database.messages.window(fixture.thread.id).messages.map((message) => message.id)).toEqual([fixture.messageId])
    expect(database.messages.activities.getRun(fixture.runId)?.status).toBe('completed')
    expect(database.resources.listAttachmentsForThread(fixture.thread.id).map((attachment) => attachment.id)).toEqual([fixture.artifact.id])
    expect(database.resourceCleanup.listAttachmentFileCleanup()).toEqual([])
    expect(await readFile(fixture.artifact.path, 'utf8')).toBe('original attachment')
  } finally { await runtime.shutdown(); database.close() }
})

it('rejects cleanup entries that would remove an attachment still used by the conversation', async () => {
  const fixture = await editableConversation()
  const { database } = fixture
  try {
    const raw = (database as unknown as { database: Database.Database }).database
    raw.prepare(`INSERT INTO agent_attachment_file_cleanup_outbox(attachment_id, thread_id, storage_path)
      SELECT id, thread_id, storage_path FROM agent_attachments WHERE id = ?`).run(fixture.artifact.id)
    expect(() => database.resourceCleanup.listAttachmentFileCleanup()).toThrow('cannot be scheduled for cleanup')
    expect(await readFile(fixture.artifact.path, 'utf8')).toBe('original attachment')
  } finally { database.close() }
})
