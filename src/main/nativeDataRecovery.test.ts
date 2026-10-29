import { writeProjectFixture } from '../test/projectDirectories'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import projectDefaults from '../../data/config/projects.json'
import { serializeCapabilities, defaultCapabilities } from '../shared/agentCapabilities'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '../shared/types'
import { AgentStorage } from './agent/agentStorage'
import { snapshotAgentStorage } from './agent/agentDatabaseBackup'
import { NativeConversationDatabase } from './agent/nativeConversationDatabase'
import { configFileNames, getAgentAttachmentsDir, getAgentCatalogFile, getAgentConversationDatabaseFile } from './config/dataDir'
import { validateRestoredDataDirectory } from './dataRestoreValidation'
import { inspectProjectStorageRepair, repairProjectStorage } from './recoveryProjectStorage'
import { preserveRecoveryData } from './recoveryData'
import { readFrozenStorage } from '../test/frozenStorage'

const roots: string[] = []
const storages: Array<AgentStorage<NativeConversationDatabase>> = []
async function directory() { const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-native-data-recovery-'))); roots.push(root); return root }
function open(root: string) { const storage = AgentStorage.openNative(root); storages.push(storage); return storage }
afterEach(async () => {
  for (const storage of storages.splice(0)) storage.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await directory()
  await mkdir(join(root, 'config'))
  for (const name of configFileNames) await cp(join(process.cwd(), 'data/config', name), join(root, 'config', name))
  await cp(join(process.cwd(), 'data/subagents'), join(root, 'subagents'), { recursive: true })
  const storage = open(root), thread = storage.createThread({ title: 'Preserved conversation', modelConfigId: 'selected' })
  const database = storage.conversationForThread(thread.id), runId = randomUUID(), id = `${runId}:input`
  database.runs.createRun({ threadId: thread.id, runId, operation: 'agent',
    message: { id, value: { id, kind: 'user', content: 'Question', context: { runId } } } })
  await database.execution.enter('input', { threadId: thread.id, runId, signal: new AbortController().signal })
  const scope = () => ({ threadId: thread.id, runId, expectedRevisionId: database.runs.store.load(thread.id)!.revisionId })
  database.runs.store.acceptModel(scope(), { id: 'answer', value: { id: 'answer', kind: 'assistant', content: 'Saved answer' } }, [], { modelCalls: 1, todos: [] })
  database.runs.store.finish(scope(), 'completed')
  const pending = storage.createThread({ title: 'Unaccepted input' }), pendingRunId = randomUUID(), inputId = `${pendingRunId}:input`
  storage.conversationForThread(pending.id).runs.createRun({ threadId: pending.id, runId: pendingRunId, operation: 'agent',
    message: { id: inputId, value: { id: inputId, kind: 'user', content: 'Pending', context: { runId: pendingRunId } } } })
  const attachments = getAgentAttachmentsDir(thread.id, root), path = join(attachments, 'queued.txt')
  await mkdir(attachments, { recursive: true }); await writeFile(path, 'queued')
  database.queue.createQueuedInput({ id: 'queued', threadId: thread.id, text: 'Next' }, [{ storagePath: 'queued.txt', artifact: {
    id: 'queued-file', threadId: thread.id, messageId: 'queued', runId: 'queued', name: 'queued.txt', path,
    mimeType: 'text/plain', size: 6, kind: 'text', available: true, textTruncated: false, contextPolicy: 'one_turn', createdAt: new Date().toISOString()
  } }])
  await storage.memoryStore.saveMemory({ scope: 'global', kind: 'fact', content: 'Preserved memory', keywords: [], importance: 3 }, { origin: 'user' })
  const { version: _version, ...defaults } = projectDefaults
  const projects = JSON.stringify({ version: 0, projects: [{ ...defaults, id: DEFAULT_WORKSPACE_PROJECT_ID,
    kind: 'workspace', name: 'Workspace', pinned: false, collapsed: false, sourceFolders: [], restrict_subagents: false,
    capabilities: serializeCapabilities(defaultCapabilities), createdAt: '2026-10-27T00:00:00Z', updatedAt: '2026-10-27T00:00:00Z' }] })
  await writeProjectFixture(root, JSON.parse(projects))
  const repairDocument = await import('./recoveryProjectStorage').then(module => module.readRepairProjectDocument(root))
  if (repairDocument === undefined) throw new Error('Project fixture must contain definitions.')
  await Promise.resolve()
  return { root, storage, thread, pending, runId, pendingRunId, projects: repairDocument, snapshot: database.readSnapshot(thread.id),
    file: getAgentConversationDatabaseFile(thread.id, root), pendingFile: getAgentConversationDatabaseFile(pending.id, root) }
}
function mutate(file: string, sql: string) { const raw = new Database(file); try { raw.exec(sql) } finally { raw.close() } }

it('preserves unsupported legacy execution databases during explicit repair instead of changing their version', async () => {
  const f = await fixture(); f.storage.close()
  await rm(join(f.root, 'db'), { recursive: true })
  const catalog = readFrozenStorage<{ thread: { id: string } }>('legacy-catalog')
  const conversation = readFrozenStorage('legacy-conversation')
  const file = getAgentConversationDatabaseFile(catalog.metadata.thread.id, f.root)
  await mkdir(getAgentAttachmentsDir(catalog.metadata.thread.id, f.root), { recursive: true })
  await writeFile(getAgentCatalogFile(f.root), catalog.bytes)
  await writeFile(file, conversation.bytes)
  await writeProjectFixture(f.root, JSON.parse(f.projects))
  const preserved = await directory()
  const result = await repairProjectStorage(f.root, f.projects, f.projects, () => preserveRecoveryData(f.root, preserved))
  expect(result.unresolved).toHaveLength(2)
  expect(result.unresolved.join('\n')).toContain('Unsupported execution schema')
  expect(await readFile(getAgentCatalogFile(f.root))).toEqual(catalog.bytes)
  expect(await readFile(file)).toEqual(conversation.bytes)
})

it('backs up committed native WAL with history, queued attachments, memory and unaccepted input without executing it', async () => {
  const f = await fixture(), destination = await directory()
  await cp(join(f.root, 'config'), join(destination, 'config'), { recursive: true })
  await cp(join(f.root, 'subagents'), join(destination, 'subagents'), { recursive: true })
  await snapshotAgentStorage(f.root, destination)
  await writeProjectFixture(destination, JSON.parse(f.projects))
  await cp(getAgentAttachmentsDir(f.thread.id, f.root), getAgentAttachmentsDir(f.thread.id, destination), { recursive: true })
  await expect(validateRestoredDataDirectory(destination)).resolves.toBeUndefined()
  const restored = open(destination), database = restored.conversationForThread(f.thread.id)
  expect(database.readSnapshot(f.thread.id).messages).toEqual(f.snapshot.messages)
  expect(database.queue.listQueuedInputs()).toMatchObject([{ id: 'queued', attachments: [{ contextPolicy: 'one_turn', size: 6 }] }])
  expect(await readFile(database.queue.listQueuedInputs()[0].attachments[0].path, 'utf8')).toBe('queued')
  expect(restored.conversationForThread(f.pending.id).runs.readRunInput({ threadId: f.pending.id, runId: f.pendingRunId })).toMatchObject({ value: { content: 'Pending' } })
  expect((await restored.memoryStore.searchMemories({ scope: 'global' })).total).toBe(1)
  expect(restored.getThread(f.thread.id)).toMatchObject({ pinned: false, modelConfigId: 'selected' })
  restored.close()
  const files = [getAgentCatalogFile(destination), getAgentConversationDatabaseFile(f.thread.id, destination)]
  const before = await Promise.all(files.map(file => readFile(file)))
  await validateRestoredDataDirectory(destination)
  expect(await Promise.all(files.map(file => readFile(file)))).toEqual(before)
})

it('rejects missing native bodies, foreign ownership and missing attachments without repairing or rewriting them', async () => {
  const f = await fixture(); f.storage.close()
  const attachments = getAgentAttachmentsDir(f.thread.id, f.root)
  const projects = new Set([DEFAULT_WORKSPACE_PROJECT_ID])
  expect(() => NativeConversationDatabase.validateBackup(f.file, attachments, projects, 'other')).toThrow('does not belong')
  await rm(join(attachments, 'queued.txt'))
  await expect(validateRestoredDataDirectory(f.root)).rejects.toThrow('Queued attachment is missing')
  await writeFile(join(attachments, 'queued.txt'), 'queued')
  mutate(f.file, 'PRAGMA foreign_keys=OFF; DELETE FROM execution_message_bodies')
  const before = await readFile(f.file)
  await expect(validateRestoredDataDirectory(f.root)).rejects.toThrow()
  expect(await readFile(f.file)).toEqual(before)
})

it('rejects a mixed execution version instead of converting a conversation while validating a backup', async () => {
  const f = await fixture(); f.storage.close()
  mutate(f.pendingFile, 'PRAGMA user_version=0')
  const before = await readFile(f.pendingFile)
  await expect(validateRestoredDataDirectory(f.root)).rejects.toThrow('Unsupported native conversation database version')
  expect(await readFile(f.pendingFile)).toEqual(before)
})

it('repairs native version fields through preserved directory replacement without changing configs or saved execution', async () => {
  const f = await fixture(); f.storage.close()
  const files = [getAgentCatalogFile(f.root), f.file, f.pendingFile]
  for (const file of files) mutate(file, 'PRAGMA user_version=99')
  const before = await Promise.all(files.map(file => readFile(file)))
  const config = await readFile(join(f.root, 'config/models.json'))
  const inspection = await inspectProjectStorageRepair(f.root, f.projects, f.projects)
  expect(inspection.issues).toEqual([])
  expect(inspection.fields).toHaveLength(3)
  expect(await Promise.all(files.map(file => readFile(file)))).toEqual(before)
  const preserved = await directory()
  const result = await repairProjectStorage(f.root, f.projects, f.projects, () => preserveRecoveryData(f.root, preserved))
  expect(result.unresolved).toEqual([])
  expect(await readFile(join(result.preservationPath, 'data/db/catalog.sqlite'))).toEqual(before[0])
  expect(await readFile(join(f.root, 'config/models.json'))).toEqual(config)
  await validateRestoredDataDirectory(f.root)
  const restored = open(f.root)
  expect(restored.conversationForThread(f.thread.id).readSnapshot(f.thread.id).messages).toEqual(f.snapshot.messages)
  expect(restored.conversationForThread(f.pending.id).runs.readRunInput({ threadId: f.pending.id, runId: f.pendingRunId })).toMatchObject({ value: { content: 'Pending' } })
}, 20_000)

it('preserves an unrepairable native conversation and salvages independent version errors', async () => {
  const f = await fixture(); f.storage.close()
  mutate(f.file, 'PRAGMA foreign_keys=OFF; DELETE FROM execution_message_bodies')
  mutate(f.pendingFile, 'PRAGMA user_version=99')
  const damaged = await readFile(f.file), preserved = await directory()
  const result = await repairProjectStorage(f.root, f.projects, f.projects, () => preserveRecoveryData(f.root, preserved))
  expect(result.unresolved).toHaveLength(1)
  expect(result.unresolved[0]).toContain(f.thread.id)
  expect(await readFile(f.file)).toEqual(damaged)
  expect(await readFile(join(result.preservationPath, 'data/db/projects/default-workspace/conversations', f.thread.id, 'conversation.sqlite'))).toEqual(damaged)
  const raw = new Database(f.pendingFile, { readonly: true })
  try { expect(raw.pragma('user_version', { simple: true })).toBe(1) } finally { raw.close() }
  NativeConversationDatabase.validateBackup(f.pendingFile, getAgentAttachmentsDir(f.pending.id, f.root), new Set([DEFAULT_WORKSPACE_PROJECT_ID]), f.pending.id)
})
