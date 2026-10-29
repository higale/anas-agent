import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { saveToolResultFile } from './toolResultFile'
import { archiveAgentAttachments } from './agentAttachmentStore'
import { AgentStorage } from './agentStorage'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeRuntimeCoordinator } from './nativeRuntimeCoordinator'
import { snapshotAgentStorage } from './agentDatabaseBackup'
import { getAgentConversationDatabaseFile, getAgentConversationDir, getAgentConversationTempDir, getAgentAttachmentsDir } from '../config/dataDir'

const faults = vi.hoisted(() => ({ failRm: '', partialFile: '', unavailableFile: '', statError: 'ENOENT' }))
vi.mock('node:fs', async (original) => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => String(path) === faults.unavailableFile ? false : actual.existsSync(path),
    lstatSync: (...args: Parameters<typeof actual.lstatSync>) => {
      if (String(args[0]) === faults.unavailableFile) throw Object.assign(new Error('File is unavailable'), { code: faults.statError })
      return actual.lstatSync(...args)
    }
  }
})
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, rm: async (...args: Parameters<typeof actual.rm>) => {
    if (String(args[0]) === faults.failRm) {
      if (faults.partialFile) await actual.rm(faults.partialFile, { force: true })
      throw Object.assign(new Error('File temporarily in use'), { code: 'EPERM' })
    }
    return actual.rm(...args)
  } }
})
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn(async (id: string) => ({ id, kind: 'workspace', sourceFolders: [] })) }))

const roots: string[] = []
type NativeStorage = ReturnType<typeof AgentStorage.openNative>
let storage: NativeStorage | undefined
let coordinator: NativeRuntimeCoordinator | undefined
function route(current: NativeStorage) {
  return new NativeRuntimeCoordinator(current, { push: vi.fn() }, { prepareWorkspace: false,
    providerFetch: async () => { throw new Error('No model in deletion test') } })
}
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anas-conversation-deletion-'))
  roots.push(root)
  storage = AgentStorage.openNative(root)
  coordinator = route(storage)
  return { root, storage, coordinator }
}
afterEach(async () => {
  faults.failRm = ''; faults.partialFile = ''
  faults.unavailableFile = ''; faults.statError = 'ENOENT'
  await coordinator?.shutdown()
  storage?.close()
  coordinator = undefined; storage = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
})

it.each([
  ['database', 'single'], ['directory', 'single'],
  ['database', 'cleanup'], ['directory', 'cleanup'],
  ['database', 'project'], ['directory', 'project']
] as const)('deletes a conversation with missing %s through %s deletion', async (missing, operation) => {
  const { root, storage, coordinator } = await fixture()
  const thread = storage.createThread({ title: 'Missing conversation', projectId: 'project-a' })
  const retained = storage.createThread({ title: 'Keep conversation', projectId: 'project-b' })
  storage.conversationForThread(retained.id).updateThread(retained.id, { pinned: true })
  const directory = getAgentConversationDir(thread.id, root, thread.projectId)
  const temporary = getAgentConversationTempDir(thread.id, root)
  for (const name of ['attachments', 'file_edits', 'tool_results']) {
    await mkdir(join(directory, name), { recursive: true })
    await writeFile(join(directory, name, 'leftover.txt'), 'leftover resource')
  }
  await mkdir(temporary, { recursive: true })
  await writeFile(join(temporary, 'draft.txt'), 'temporary draft')
  await mkdir(join(root, 'db/plugins/test-plugin'), { recursive: true })
  const preservedFiles = ['db/plugins/test-plugin/state.json', 'db/input_history.json']
  for (const name of preservedFiles) await writeFile(join(root, name), `keep ${name}`)
  storage.closeConversation(thread.id)
  await rm(missing === 'database' ? getAgentConversationDatabaseFile(thread.id, root, thread.projectId) : directory, { recursive: true })

  expect(storage.isConversationDeleting(thread.id)).toBe(false)
  expect(() => coordinator.getSnapshot(thread.id)).toThrow('Conversation database is missing')
  if (operation === 'single') await coordinator.deleteThread(thread.id)
  else if (operation === 'cleanup') {
    expect(await coordinator.cleanupThreads()).toMatchObject({ deletedThreadIds: [thread.id], failures: [] })
  } else {
    expect(await coordinator.deleteProjectThreads('project-a')).toMatchObject({ deletedThreadIds: [thread.id] })
  }
  expect(storage.listThreads().map(item => item.id)).toEqual([retained.id])
  expect(storage.isConversationDeleting(thread.id)).toBe(false)
  expect(existsSync(directory)).toBe(false)
  expect(existsSync(temporary)).toBe(false)
  expect((await coordinator.getSnapshot(retained.id)).thread.title).toBe('Keep conversation')
  for (const name of preservedFiles) expect(await readFile(join(root, name), 'utf8')).toBe(`keep ${name}`)
})

it('keeps a missing-database deletion retryable if removing its remaining resources fails', async () => {
  const current = await fixture()
  const thread = current.storage.createThread()
  current.storage.closeConversation(thread.id)
  await rm(getAgentConversationDatabaseFile(thread.id, current.root))
  faults.failRm = getAgentConversationDir(thread.id, current.root)
  await expect(current.coordinator.deleteThread(thread.id)).rejects.toMatchObject({ code: 'EPERM' })
  expect(current.storage.isConversationDeleting(thread.id)).toBe(true)
  expect(current.storage.getThread(thread.id)).not.toBeNull()
  faults.failRm = ''
  await current.coordinator.shutdown()
  current.storage.close()
  storage = AgentStorage.openNative(current.root)
  coordinator = route(storage)
  await coordinator.deleteThread(thread.id)
  expect(storage.listThreads()).toEqual([])
})

it('waits for an existing runtime to drain even when its database path is unavailable', async () => {
  const { root, storage, coordinator } = await fixture()
  const thread = storage.createThread()
  const runtime = coordinator.forThread(thread.id)
  vi.spyOn(runtime, 'shutdown').mockResolvedValueOnce({ drained: false, lingeringRunIds: ['active-run'], lingeringCallIds: [] })
  faults.unavailableFile = getAgentConversationDatabaseFile(thread.id, root, thread.projectId)
  await expect(coordinator.deleteThread(thread.id)).rejects.toThrow('before its work stops')
  expect(storage.getThread(thread.id)).not.toBeNull()
  expect(storage.isConversationDeleting(thread.id)).toBe(true)
  await coordinator.deleteThread(thread.id)
  expect(storage.getThread(thread.id)).toBeNull()
})

it.each(['unreadable', 'corrupt', 'empty', 'unsupported version'] as const)('deletes an %s database without opening or validating it', async kind => {
  const { root, storage, coordinator } = await fixture()
  const thread = storage.createThread()
  storage.closeConversation(thread.id)
  const file = getAgentConversationDatabaseFile(thread.id, root, thread.projectId)
  if (kind === 'corrupt') await writeFile(file, 'damaged database')
  else if (kind === 'empty') await writeFile(file, '')
  else if (kind === 'unsupported version') {
    const database = new Database(file)
    database.pragma('user_version = 999')
    database.close()
  } else { faults.unavailableFile = file; faults.statError = 'EACCES' }
  await coordinator.deleteThread(thread.id)
  expect(storage.getThread(thread.id)).toBeNull()
  expect(storage.isConversationDeleting(thread.id)).toBe(false)
  await expect(readFile(file)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('deletes an open conversation without reading damaged message tables or refreshing the catalog', async () => {
  const { root, storage, coordinator } = await fixture()
  const thread = storage.createThread()
  const database = storage.conversationForThread(thread.id)
  vi.spyOn(database, 'getThread').mockImplementation(() => { throw new Error('Damaged message tables') })
  await coordinator.deleteThread(thread.id)
  expect(storage.getThread(thread.id)).toBeNull()
  expect(existsSync(getAgentConversationDir(thread.id, root, thread.projectId))).toBe(false)
})

it('clears a project containing a corrupt conversation while preserving another project', async () => {
  const { root, storage, coordinator } = await fixture()
  const broken = storage.createThread({ projectId: 'broken-project' })
  const healthy = storage.createThread({ projectId: 'broken-project' })
  const retained = storage.createThread({ projectId: 'retained-project' })
  storage.closeConversation(broken.id)
  await writeFile(getAgentConversationDatabaseFile(broken.id, root, broken.projectId), 'invalid database')
  const result = await coordinator.deleteProjectThreads('broken-project')
  expect(new Set(result.deletedThreadIds)).toEqual(new Set([broken.id, healthy.id]))
  expect(storage.listThreads().map(thread => thread.id)).toEqual([retained.id])
})

it.each(['conversation', 'temporary', 'partial conversation'] as const)('retries deletion after a transient %s removal failure, including after reopening storage', async kind => {
  const current = await fixture()
  const thread = current.storage.createThread({ title: 'Delete me' })
  const file = getAgentConversationDatabaseFile(thread.id, current.root)
  faults.failRm = kind !== 'temporary' ? getAgentConversationDir(thread.id, current.root) : getAgentConversationTempDir(thread.id, current.root)
  if (kind === 'partial conversation') faults.partialFile = file
  await expect(current.coordinator.deleteThread(thread.id)).rejects.toMatchObject({ code: 'EPERM' })
  expect(current.storage.isConversationDeleting(thread.id)).toBe(true)
  expect(current.storage.listThreads().map(thread => thread.title)).toEqual(['Delete me'])
  expect(() => current.coordinator.getSnapshot(thread.id)).toThrow('deletion is pending')
  faults.failRm = ''
  await current.coordinator.shutdown()
  current.storage.close()
  storage = AgentStorage.openNative(current.root)
  coordinator = route(storage)
  await coordinator.deleteThread(thread.id)
  expect(storage.listThreads()).toEqual([])
  expect(storage.isConversationDeleting(thread.id)).toBe(false)
  expect(existsSync(file)).toBe(false)
})

it('keeps cleanup failure retryable after the main thread row has been deleted', async () => {
  const { root, storage, coordinator } = await fixture()
  const thread = storage.createThread({ title: 'Attachment cleanup' })
  // Simulate an incomplete external cleanup while the catalog still owns the directory.
  const damaged = new Database(getAgentConversationDatabaseFile(thread.id, root, thread.projectId))
  try { damaged.pragma('foreign_keys=ON'); damaged.prepare('DELETE FROM agent_threads WHERE id=?').run(thread.id) }
  finally { damaged.close() }
  faults.failRm = getAgentConversationDir(thread.id, root, thread.projectId)
  await expect(coordinator.deleteThread(thread.id)).rejects.toThrow('File temporarily in use')
  expect(storage.openedConversation(thread.id)).toBeUndefined()
  expect(storage.isConversationDeleting(thread.id)).toBe(true)
  faults.failRm = ''; faults.partialFile = ''
  await coordinator.deleteThread(thread.id)
  expect(storage.listThreads()).toEqual([])
  expect(existsSync(getAgentConversationDatabaseFile(thread.id, root, thread.projectId))).toBe(false)
})

it('keeps online backups restorable while deletion waits and ordinary execution commits continue', async () => {
  const { root, storage, coordinator } = await fixture()
  const thread = storage.createThread({ title: 'Delete during backup' })
  const database = storage.conversationForThread(thread.id)
  const destination = await mkdtemp(join(tmpdir(), 'anas-online-backup-'))
  roots.push(destination)
  let releaseCatalog!: () => void
  let copiedCatalog!: () => void
  const catalogGate = new Promise<void>(resolve => { releaseCatalog = resolve })
  const catalogReady = new Promise<void>(resolve => { copiedCatalog = resolve })
  const backup = Database.prototype.backup
  vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (this: Database.Database, ...args) {
    const result = await backup.apply(this, args)
    if (this.name.endsWith('catalog.sqlite')) { copiedCatalog(); await catalogGate }
    return result
  })
  const copying = snapshotAgentStorage(root, destination)
  await catalogReady
  const deleting = coordinator.deleteThread(thread.id)
  try {
    const owner = { threadId: thread.id, runId: 'backup-run' }, id = 'message'
    database.runs.createRun({ ...owner, operation: 'agent', message: { id, value: { id, kind: 'user', content: 'Completed while backing up', context: { runId: owner.runId } } } })
    await database.runs.enter('input', owner)
    database.runs.store.finish({ ...owner, expectedRevisionId: database.runs.store.load(thread.id)!.revisionId }, 'completed')
    expect(database.messages.window(thread.id).messages[0].content).toEqual([{ type: 'text', text: 'Completed while backing up' }])
    expect(database.getThread(thread.id)?.title).toBe('Delete during backup')
    expect(storage.isConversationDeleting(thread.id)).toBe(false)
  } finally { releaseCatalog() }
  await expect(copying).resolves.toHaveLength(2)
  await deleting
  expect(() => NativeConversationDatabase.validateBackup(getAgentConversationDatabaseFile(thread.id, destination),
    getAgentAttachmentsDir(thread.id, destination), new Set([thread.projectId]), thread.id)).not.toThrow()
  expect(storage.listThreads()).toEqual([])
})

it('omits accepted pending deletions from the backup catalog without changing the source', async () => {
  const { root, storage, coordinator } = await fixture()
  const deleted = storage.createThread({ title: 'Deleting' })
  const retained = storage.createThread({ title: 'Keep' })
  faults.failRm = getAgentConversationDir(deleted.id, root)
  await expect(coordinator.deleteThread(deleted.id)).rejects.toThrow('File temporarily in use')
  faults.failRm = ''
  const destination = await mkdtemp(join(tmpdir(), 'anas-pending-deletion-backup-'))
  roots.push(destination)
  const files = await snapshotAgentStorage(root, destination)
  expect(files.map(file => file.relPath)).toEqual(['db/catalog.sqlite', `db/projects/default-workspace/conversations/${retained.id}/conversation.sqlite`])
  expect(storage.isConversationDeleting(deleted.id)).toBe(true)
  const copied = AgentStorage.openNative(destination)
  try { expect(copied.listThreads().map(thread => thread.id)).toEqual([retained.id]) } finally { copied.close() }
})

it('deletes the whole conversation and its temporary drafts while preserving other conversations and shared data', async () => {
  const { root, storage, coordinator } = await fixture()
  const first = storage.createThread(), second = storage.createThread()
  const database = storage.conversationForThread(first.id)
  const other = storage.conversationForThread(second.id)
  const source = join(root, 'original.txt')
  await writeFile(source, 'attachment')
  const attachments = await archiveAgentAttachments([{ path: source, name: 'original.txt', size: 10,
    mimeType: 'text/plain', kind: 'text', contextPolicy: 'conversation' }],
    { threadId: first.id, runId: 'run', messageId: 'message' }, getAgentAttachmentsDir(first.id, root, first.projectId))
  const result = await saveToolResultFile('long tool output', database.resources.toolResultsRoot)
  const otherResult = await saveToolResultFile('long tool output', other.resources.toolResultsRoot)
  expect(result).not.toBe(otherResult)
  expect(await saveToolResultFile('long tool output', database.resources.toolResultsRoot)).toBe(result)
  const recovery = join(database.resources.fileEditStore.root, 'retained-evidence')
  const draft = join(getAgentConversationTempDir(first.id, root), 'message_edit', 'draft')
  await mkdir(recovery, { recursive: true }); await mkdir(draft, { recursive: true })
  await writeFile(join(recovery, 'record.json'), 'recovery evidence')
  await mkdir(join(root, 'db', 'plugins', 'test-plugin'), { recursive: true })
  const sharedFiles = ['db/plugins/test-plugin/state.json', 'db/projects.json', 'db/input_history.json']
  for (const name of sharedFiles) await writeFile(join(root, name), `keep ${name}`)
  await mkdir(join(root, 'cache'), { recursive: true })
  await writeFile(join(root, 'cache', 'shared.json'), 'shared cache')
  await rm(join(root, 'cache'), { recursive: true })
  expect(await readFile(result, 'utf8')).toBe('long tool output')
  expect(attachments[0].artifact.path.startsWith(getAgentConversationDir(first.id, root, first.projectId))).toBe(true)
  await coordinator.deleteThread(first.id)
  expect(existsSync(getAgentConversationDir(first.id, root, first.projectId))).toBe(false)
  expect(existsSync(getAgentConversationTempDir(first.id, root))).toBe(false)
  expect(await readFile(otherResult, 'utf8')).toBe('long tool output')
  expect(await readFile(source, 'utf8')).toBe('attachment')
  for (const name of sharedFiles) expect(await readFile(join(root, name), 'utf8')).toBe(`keep ${name}`)
  expect(storage.listThreads().map(thread => thread.id)).toEqual([second.id])
})
