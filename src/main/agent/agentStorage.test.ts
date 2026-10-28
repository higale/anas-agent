import Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { defaultCapabilities } from '@shared/agentCapabilities'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'
import { getAgentCatalogFile, getAgentConversationDatabaseFile, getAgentConversationDir, getAgentConversationsDir } from '../config/dataDir'
import { AgentStorage } from './agentStorage'
import { writeConversationCatalogSnapshot } from './conversationCatalog'

type NativeStorage = ReturnType<typeof AgentStorage.openNative>

const roots: string[] = []
const storages = new Set<NativeStorage>()

async function fixture(): Promise<{ root: string; storage: NativeStorage }> {
  const root = await mkdtemp(join(tmpdir(), 'anas-agent-storage-'))
  roots.push(root)
  const storage = AgentStorage.openNative(root)
  storages.add(storage)
  return { root, storage }
}

function reopen(root: string, previous: NativeStorage): NativeStorage {
  previous.close()
  const storage = AgentStorage.openNative(root)
  storages.add(storage)
  return storage
}

afterEach(async () => {
  for (const storage of storages) storage.close()
  storages.clear()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('agent conversation storage', () => {
  it('rolls sidebar metadata and lookup changes back when a run belongs to another conversation', async () => {
    const { root, storage } = await fixture()
    const first = storage.createThread({ title: 'First' }), second = storage.createThread({ title: 'Second' })
    const database = storage.conversationForThread(first.id)
    database.runs.createRun({ threadId: first.id, runId: 'owned-run', operation: 'agent', submissionId: 'saved-submission', message: { id: 'owned-input', value: { id: 'owned-input', kind: 'user', content: 'Question', context: { runId: 'owned-run' } } } })
    storage.refreshConversation(first.id)
    const snapshot = storage.conversationForThread(second.id).readCatalogSnapshot(second.id)!
    const catalog = new Database(getAgentCatalogFile(root)); catalog.pragma('foreign_keys=ON')
    try {
      expect(() => writeConversationCatalogSnapshot(catalog, { ...snapshot,
        thread: { ...snapshot.thread, title: 'Must roll back' }, threadIds: [...snapshot.threadIds, 'new-child'],
        runs: [{ id: 'owned-run', threadId: 'new-child' }] })).toThrow('already belongs to another conversation')
      expect(storage.getThread(second.id)?.title).toBe('Second')
      expect(storage.ownerForThread('new-child')).toBeUndefined()
      expect(storage.submissionOwner('saved-submission')).toBe(first.id)
      expect(storage.conversationForRun('owned-run')).toBe(database)
    } finally { catalog.close() }
  })

  it('starts with empty conversations and memories while leaving the old layout intact', async () => {
    const { root, storage } = await fixture()
    const oldThread = storage.createThread({ title: 'Old conversation' })
    await storage.memoryStore.saveMemory({ scope: 'global', kind: 'fact', content: 'Old memory', keywords: [], importance: 3 }, { origin: 'user' })
    storage.close()
    await rename(join(root, 'db'), join(root, 'sqlite'))
    const rootConversation = join(root, 'conversations', 'abandoned')
    await mkdir(rootConversation, { recursive: true })
    await writeFile(join(rootConversation, 'conversation.sqlite'), 'obsolete conversation data')
    const oldCatalog = await readFile(join(root, 'sqlite', 'catalog.sqlite'))
    const current = reopen(root, storage)
    expect(current.listThreads()).toEqual([])
    expect((await current.memoryStore.searchMemories({ scope: 'global' })).total).toBe(0)
    expect(current.getWorkspaceState().mode).toBe('new_thread')
    const thread = current.createThread({ title: 'New conversation' })
    expect(existsSync(getAgentConversationDatabaseFile(thread.id, root))).toBe(true)
    expect(existsSync(join(root, 'sqlite', 'conversations', oldThread.id, 'conversation.sqlite'))).toBe(true)
    expect(await readFile(join(root, 'sqlite', 'catalog.sqlite'))).toEqual(oldCatalog)
    expect(await readFile(join(rootConversation, 'conversation.sqlite'), 'utf8')).toBe('obsolete conversation data')
    expect(reopen(root, current).listThreads().map(item => item.title)).toEqual(['New conversation'])
  })

  it('lists the catalog without opening an unreadable conversation and keeps another usable', async () => {
    const { root, storage } = await fixture()
    const first = storage.createThread({ title: 'First' })
    const second = storage.createThread({ title: 'Second' })
    storage.close()
    await writeFile(getAgentConversationDatabaseFile(first.id, root), 'not sqlite', 'utf8')
    const current = AgentStorage.openNative(root)
    storages.add(current)

    expect(new Set(current.listThreads().map(({ id }) => id))).toEqual(new Set([first.id, second.id]))
    expect(current.openedConversations()).toEqual([])
    expect(() => current.conversationForThread(first.id)).toThrow()
    const secondDatabase = current.conversationForThread(second.id)
    expect(secondDatabase.getThread(second.id)?.title).toBe('Second')
    expect(current.openedConversations()).toEqual([{ ownerId: second.id, database: secondDatabase }])
    current.openedConversations().splice(0)
    expect(current.openedConversations()).toHaveLength(1)
    current.closeConversation(second.id)
    expect(current.openedConversations()).toEqual([])
  })

  it('keeps subagents in their owner database and refreshes thread, run, submission, and queue routes', async () => {
    const { root, storage } = await fixture()
    const parent = storage.createThread()
    const database = storage.conversationForThread(parent.id)
    const run = database.runs.createRun({ threadId: parent.id, runId: 'parent-run', operation: 'agent', submissionId: 'submission-1', message: { id: 'parent-input', value: { id: 'parent-input', kind: 'user', content: 'Question', context: { runId: 'parent-run' } } } })
    database.runs.createSubagentCall({
      id: 'child-call', ownerThreadId: parent.id, parentThreadId: parent.id, parentRunId: run.id,
      childThreadId: 'child-thread', childRunId: 'child-run', description: 'Inspect this project',
      childThread: { projectId: parent.projectId },
      config: { index: 0, name: 'inspector', enabled: true, builtIn: false,
        description: 'Inspect a project.', systemPrompt: 'Inspect the selected project.',
        capabilities: structuredClone(defaultCapabilities) }
    })
    database.queue.createQueuedInput({ id: 'queued-1', threadId: parent.id, text: 'Next request' }, [])
    await Promise.resolve()

    expect(storage.conversationForThread('child-thread')).toBe(database)
    expect(storage.conversationForRun('child-run')).toBe(database)
    expect(storage.submissionOwner('submission-1')).toBe(parent.id)
    expect(storage.queuedConversationIds()).toEqual([parent.id])
    expect((await readdir(getAgentConversationsDir(root)))).toEqual([parent.id])
    const current = reopen(root, storage)
    expect(current.submissionOwner('submission-1')).toBe(parent.id)
    expect(current.ownerForThread('child-thread')).toBe(parent.id)
  })

  it('shares durable memories between conversations and previews while keeping their run data separate', async () => {
    const { root, storage } = await fixture()
    const first = storage.createThread()
    const second = storage.createThread()
    await storage.conversationForThread(first.id).resources.memoryStore.saveMemory({
      scope: 'global', kind: 'fact', content: 'Shared project fact', keywords: ['shared'], importance: 3
    }, { origin: 'user' })
    storage.conversationForThread(first.id).runs.createRun({ threadId: first.id, runId: 'first-run', operation: 'agent', message: { id: 'first-input', value: { id: 'first-input', kind: 'user', content: 'Question', context: { runId: 'first-run' } } } })

    expect(storage.conversationForThread(second.id).readModel.getRun('first-run')).toBeNull()
    expect((await storage.conversationForThread(second.id).resources.memoryStore.searchMemories({ scope: 'global' })).total).toBe(1)
    storage.closeConversation(first.id)
    expect((await storage.previewDatabase().resources.memoryStore.searchMemories({ scope: 'global' })).total).toBe(1)
    const current = reopen(root, storage)
    expect((await current.memoryStore.searchMemories({ scope: 'global' })).total).toBe(1)
    expect(current.listThreads()).toHaveLength(2)
    expect((await current.getStorageUsage()).memories.totalBytes).toBeGreaterThan(0)
  })

  it('persists workspace selection and moves a conversation without moving its file', async () => {
    const { root, storage } = await fixture()
    const thread = storage.createThread({ projectId: 'first-project' })
    const file = getAgentConversationDatabaseFile(thread.id, root)
    storage.setWorkspaceState({ mode: 'thread', threadId: thread.id })
    storage.updateThread(thread.id, { projectId: 'second-project', title: 'Moved' })
    const current = reopen(root, storage)

    expect(current.getWorkspaceState()).toEqual({ mode: 'thread', threadId: thread.id })
    expect(current.getThread(thread.id)).toMatchObject({ title: 'Moved', projectId: 'second-project' })
    expect(existsSync(file)).toBe(true)
    expect(AgentStorage.validateCatalogBackup(getAgentCatalogFile(root), new Set(['second-project']))).toEqual([thread.id])
  })

  it('removes only the selected conversation and resets its active workspace reference', async () => {
    const { root, storage } = await fixture()
    const first = storage.createThread()
    const second = storage.createThread()
    storage.setWorkspaceState({ mode: 'thread', threadId: first.id })
    storage.beginConversationDeletion(first.id)
    await storage.removeConversation(first.id)

    expect(storage.getThread(first.id)).toBeNull()
    expect(existsSync(getAgentConversationDatabaseFile(first.id, root))).toBe(false)
    expect(storage.getWorkspaceState()).toMatchObject({ mode: 'new_thread' })
    expect(storage.conversationForThread(second.id).getThread(second.id)?.id).toBe(second.id)
  })

  it('discards only empty databases created by this instance when a first submission fails', async () => {
    const { root, storage } = await fixture()
    const ownerId = 'failed-first-submission'
    storage.openConversation(ownerId, { create: true })
    expect(storage.getThread(ownerId)).toBeNull()
    expect(storage.openedConversations()).toHaveLength(1)
    expect(existsSync(getAgentConversationDatabaseFile(ownerId, root))).toBe(true)
    await storage.removeConversation(ownerId)
    expect(storage.openedConversations()).toEqual([])
    expect(existsSync(getAgentConversationDatabaseFile(ownerId, root))).toBe(false)
    expect(storage.createThread({ title: 'Retry succeeds' }, ownerId).id).toBe(ownerId)

    await mkdir(getAgentConversationDir('unregistered-existing', root), { recursive: true })
    const unrelatedFile = getAgentConversationDatabaseFile('unregistered-existing', root)
    await writeFile(unrelatedFile, 'existing file', 'utf8')
    await storage.removeConversation('unregistered-existing')
    expect(existsSync(unrelatedFile)).toBe(true)
    expect(() => storage.openConversation('unregistered-existing', { create: true })).toThrow('already exists')
  })

  it('removes project memories only after its conversations have been removed', async () => {
    const { storage } = await fixture()
    const thread = storage.createThread({ projectId: 'project' })
    await storage.memoryStore.saveMemory({ scope: 'project', projectId: 'project', kind: 'fact',
      content: 'Project fact', keywords: ['project'], importance: 3 }, { origin: 'user' })
    expect(() => storage.completeProjectDeletion('project')).toThrow('while project conversations still exist')
    storage.beginConversationDeletion(thread.id)
    await storage.removeConversation(thread.id)
    storage.setWorkspaceState({ mode: 'new_thread', projectId: 'project', modelParameterPresetId: null })
    storage.completeProjectDeletion('project')

    expect(storage.getWorkspaceState()).toEqual({ mode: 'new_thread', projectId: DEFAULT_WORKSPACE_PROJECT_ID, modelParameterPresetId: null })
    expect((await storage.memoryStore.searchMemories({ scope: 'project', projectId: 'project' })).total).toBe(0)
  })

  it('reports cleanup data from unpinned conversations and actual memories rather than database overhead', async () => {
    const { storage } = await fixture()
    expect((await storage.getStorageUsage()).conversations.hasData).toBe(false)
    expect((await storage.getStorageUsage()).memories.hasData).toBe(false)
    const thread = storage.createThread({ title: 'Retained' })
    expect((await storage.getStorageUsage()).conversations.hasData).toBe(true)
    storage.updateThread(thread.id, { pinned: true })
    expect((await storage.getStorageUsage()).conversations.hasData).toBe(false)
    await storage.memoryStore.saveMemory({ scope: 'global', kind: 'fact',
      content: 'Stored fact', keywords: ['fact'], importance: 3 }, { origin: 'user' })
    expect((await storage.getStorageUsage()).memories.hasData).toBe(true)
  })

  it('reopens shared storage after worker maintenance and accepts further writes', async () => {
    const { storage } = await fixture()
    const thread = storage.createThread({ title: 'Before maintenance' })
    await storage.compact()

    expect(storage.conversationForThread(thread.id).getThread(thread.id)?.title).toBe('Before maintenance')
    storage.createThread({ title: 'After maintenance' })
    expect(storage.listThreads()).toHaveLength(2)
    const usage = await storage.getStorageUsage()
    expect(usage.conversations.totalBytes).toBeGreaterThan(0)
    expect(usage.memories.totalBytes).toBe(0)
    expect(usage.memories.hasData).toBe(false)
  })
})
