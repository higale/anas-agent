import { readFrozenStorage } from '../../test/frozenStorage'
import type { AgentThread } from '../../shared/agentTypes'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '../../shared/types'
import { getAgentCatalogFile, getAgentConversationDatabaseFile, getAgentConversationsDir } from '../config/dataDir'
import { AgentStorage } from './agentStorage'
import type { NativeConversationDatabase } from './nativeConversationDatabase'

const roots: string[] = []
const storages = new Set<AgentStorage<NativeConversationDatabase>>()
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anas-native-storage-'))
  roots.push(root)
  return { root, storage: open(root) }
}
function open(root: string) { const storage = AgentStorage.openNative(root); storages.add(storage); return storage }
afterEach(async () => {
  for (const storage of storages) storage.close()
  storages.clear()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})
function submit(database: NativeConversationDatabase, threadId: string) {
  const runId = randomUUID(), submissionId = randomUUID(), id = `${runId}:input`
  database.runs.createRun({ threadId, runId, submissionId, operation: 'agent',
    message: { id, value: { id, kind: 'user', content: 'Question', context: { runId } } } })
  return { threadId, runId, submissionId }
}

it('persists thread metadata and every access mode through the native catalog and conversation after reopening', async () => {
  const { root, storage } = await fixture()
  const created = storage.createThread({ title: '  Original   title ', projectId: 'selected-project' })
  expect(created).toMatchObject({ title: 'Original title', status: 'idle', accessMode: 'smart_approval' })
  storage.updateThread(created.id, { title: 'Updated title', pinned: true, modelConfigId: 'chosen-model', modelParameterPresetId: 'chosen-preset' })
  let current = storage
  for (const accessMode of ['strict_approval', 'full_access', 'smart_approval'] as const) {
    expect(current.setAccessMode(created.id, accessMode).accessMode).toBe(accessMode)
    current.close(); current = open(root)
    const expected = { id: created.id, title: 'Updated title', pinned: true, projectId: 'selected-project', accessMode,
      modelConfigId: 'chosen-model', modelParameterPresetId: 'chosen-preset' }
    expect(current.getThread(created.id)).toMatchObject(expected)
    expect(current.listThreads()).toEqual([expect.objectContaining(expected)])
    expect(current.conversationForThread(created.id).getThread(created.id)).toMatchObject(expected)
  }
  current.updateThread(created.id, { pinned: false, modelParameterPresetId: null })
  current.close(); current = open(root)
  expect(current.getThread(created.id)).toMatchObject({ pinned: false, modelConfigId: 'chosen-model' })
  expect(current.getThread(created.id)?.modelParameterPresetId).toBeUndefined()
})

it('routes native submissions, hidden children and queues from committed notifications and preserves product choices', async () => {
  const { root, storage } = await fixture()
  const thread = storage.createThread({ title: '  Original   title ', modelConfigId: 'model', modelParameterPresetId: 'preset', accessMode: 'strict_approval' })
  const database = storage.conversationForThread(thread.id), run = submit(database, thread.id)
  const childThreadId = randomUUID(), childRunId = randomUUID()
  database.runs.createSubagentCall({ id: randomUUID(), ownerThreadId: thread.id, parentThreadId: thread.id, parentRunId: run.runId,
    childThreadId, childRunId, description: 'Inspect', childThread: { projectId: thread.projectId },
    config: { index: 0, name: 'inspector', enabled: true, builtIn: false, description: 'Inspect', systemPrompt: 'Inspect',
      capabilities: structuredClone(defaultCapabilities) } })
  database.queue.createQueuedInput({ id: 'queued', threadId: thread.id, text: 'Next' }, [])
  await Promise.resolve()
  expect(storage.getThread(thread.id)).toMatchObject({ title: 'Original title', status: 'running', userTurnCount: 1 })
  expect(storage.conversationForRun(childRunId)).toBe(database)
  expect(storage.conversationForThread(childThreadId)).toBe(database)
  expect(storage.submissionOwner(run.submissionId)).toBe(thread.id)
  expect(storage.queuedConversationIds()).toEqual([thread.id])
  expect(await readdir(getAgentConversationsDir(root))).toEqual([thread.id])
  expect(() => storage.updateThread(thread.id, { modelConfigId: null })).toThrow('must select its own model')
  storage.updateThread(thread.id, { pinned: true })
  storage.updateThread(thread.id, { pinned: false, modelParameterPresetId: null })
  storage.setAccessMode(thread.id, 'smart_approval')
  storage.updateThread(childThreadId, { modelConfigId: null })
  expect(database.getThread(childThreadId)).toMatchObject({ projectId: thread.projectId, modelConfigId: undefined })
  expect(storage.getThread(thread.id)).toMatchObject({ pinned: false, modelConfigId: 'model', accessMode: 'smart_approval' })
  expect(storage.getThread(thread.id)?.modelParameterPresetId).toBeUndefined()
  database.queue.deleteQueuedInput(thread.id, 'queued')
  database.runs.requestCancellation(run); database.runs.completeCancellation(run)
  await Promise.resolve()
  expect(storage.queuedConversationIds()).toEqual([])
  expect(storage.getThread(thread.id)?.status).toBe('idle')
  storage.close()
  const current = open(root)
  expect(current.openedConversations()).toEqual([])
  expect(current.ownerForThread(childThreadId)).toBe(thread.id)
  expect(current.submissionOwner(run.submissionId)).toBe(thread.id)
  expect(AgentStorage.validateCatalogBackup(getAgentCatalogFile(root), new Set([thread.projectId]))).toEqual([thread.id])
  const raw = new Database(getAgentConversationDatabaseFile(thread.id, root), { readonly: true })
  try {
    expect(raw.pragma('user_version', { simple: true })).toBe(1)
    expect(raw.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('message_bodies','checkpoints')").all()).toEqual([])
  } finally { raw.close() }
})

it('projects committed execution status without publishing rolled back submissions', async () => {
  const { storage } = await fixture(), thread = storage.createThread()
  const database = storage.conversationForThread(thread.id), run = submit(database, thread.id)
  await Promise.resolve()
  expect(storage.getThread(thread.id)?.status).toBe('running')
  expect(() => submit(database, thread.id)).toThrow('is busy')
  await database.execution.enter('input', { ...run, signal: new AbortController().signal })
  const scope = () => ({ ...run, expectedRevisionId: database.runs.store.load(thread.id)!.revisionId })
  database.runs.store.acceptModel(scope(), { id: 'answer', value: { id: 'answer', kind: 'assistant', content: 'Saved answer' } }, [], { modelCalls: 1, todos: [] })
  database.runs.store.finish(scope(), 'completed')
  await Promise.resolve()
  expect(storage.getThread(thread.id)).toMatchObject({ status: 'idle', userTurnCount: 1 })
  const failedThreadId = randomUUID()
  expect(() => database.runs.createThreadAndRun({ threadId: failedThreadId, runId: randomUUID(), thread: {}, submissionId: 'invalid',
    message: { id: 'wrong', value: { id: 'wrong', kind: 'assistant', content: 'Invalid' } } })).toThrow('complete owned user message')
  await Promise.resolve()
  expect(storage.ownerForThread(failedThreadId)).toBeUndefined()
  expect(storage.submissionOwner('invalid')).toBeUndefined()
  expect(database.listThreadIds()).toEqual([thread.id])
})

it('shares memories and workspace state across preview, close, maintenance and deletion', async () => {
  const { root, storage } = await fixture(), first = storage.createThread(), second = storage.createThread()
  await storage.conversationForThread(first.id).resources.memoryStore.saveMemory({ scope: 'global', kind: 'fact',
    content: 'Shared fact', keywords: [], importance: 3 }, { origin: 'user' })
  storage.setWorkspaceState({ mode: 'thread', threadId: first.id })
  storage.closeConversation(first.id)
  expect((await storage.previewDatabase().resources.memoryStore.searchMemories({ scope: 'global' })).total).toBe(1)
  await storage.compact()
  expect((await storage.conversationForThread(second.id).resources.memoryStore.searchMemories({ scope: 'global' })).total).toBe(1)
  storage.beginConversationDeletion(first.id)
  storage.close()
  const current = open(root)
  expect(() => current.conversationForThread(first.id)).toThrow('deletion is pending')
  expect(current.conversationForCleanup(first.id)?.getThread(first.id)?.id).toBe(first.id)
  await current.removeConversation(first.id)
  expect(existsSync(getAgentConversationDatabaseFile(first.id, root))).toBe(false)
  expect(current.listThreads().map(item => item.id)).toEqual([second.id])
  expect(current.getWorkspaceState()).toEqual({ mode: 'new_thread', projectId: DEFAULT_WORKSPACE_PROJECT_ID, modelParameterPresetId: null })
  expect((await current.memoryStore.searchMemories({ scope: 'global' })).total).toBe(1)
})

async function frozenLegacyStorage(root: string) {
  const catalog = readFrozenStorage<{ thread: AgentThread }>('legacy-catalog')
  const conversation = readFrozenStorage<{ thread: AgentThread }>('legacy-conversation')
  expect(catalog.metadata.thread).toEqual(conversation.metadata.thread)
  const thread = catalog.metadata.thread, file = getAgentConversationDatabaseFile(thread.id, root)
  await mkdir(dirname(file), { recursive: true })
  await writeFile(getAgentCatalogFile(root), catalog.bytes); await writeFile(file, conversation.bytes)
  return thread
}

it('rejects a legacy catalog without changing its bytes or opening its conversations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anas-native-storage-reject-')); roots.push(root)
  const thread = await frozenLegacyStorage(root)
  const catalog = getAgentCatalogFile(root), conversation = getAgentConversationDatabaseFile(thread.id, root)
  const before = await Promise.all([readFile(catalog), readFile(conversation)])
  expect(() => AgentStorage.openNative(root)).toThrow('expected 2')
  expect(await Promise.all([readFile(catalog), readFile(conversation)])).toEqual(before)
})

it('rejects a legacy conversation registered in a native catalog and preserves unrelated usable conversations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anas-native-storage-mixed-')); roots.push(root)
  const frozen = readFrozenStorage<{ thread: AgentThread }>('legacy-conversation')
  const thread = frozen.metadata.thread
  const initial = open(root)
  initial.createThread({ title: thread.title }, thread.id)
  initial.close()
  const file = getAgentConversationDatabaseFile(thread.id, root)
  await writeFile(file, frozen.bytes)
  const before = await readFile(file), storage = open(root)
  expect(storage.listThreads().map(item => item.id)).toEqual([thread.id])
  expect(() => storage.conversationForThread(thread.id)).toThrow()
  expect(await readFile(file)).toEqual(before)
  expect(storage.openedConversations()).toEqual([])
  expect(storage.createThread({ title: 'Native' }).title).toBe('Native')
})
