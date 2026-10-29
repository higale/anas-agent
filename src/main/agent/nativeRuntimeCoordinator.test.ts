import { defaultCapabilities } from '../../shared/agentCapabilities'
import type { ExecutionToolCall } from '../../runtime/executionState'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NativeAgentRuntime } from './nativeAgentRuntime'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeRuntimeCoordinator } from './nativeRuntimeCoordinator'
import { AgentStorage } from './agentStorage'
import { getAgentConversationDatabaseFile } from '../config/dataDir'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'

vi.mock('../projectStore', () => ({
  getProject: vi.fn(async (id: string) => ({ id, kind: 'workspace', sourceFolders: [] })),
  deleteProjectWithThreads: vi.fn(async (_id: string, _threads: string[], commit: (apply: () => void) => void) => commit(() => {}))
}))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

let directory: string | undefined
let storage: AgentStorage<NativeConversationDatabase> | undefined
let coordinator: NativeRuntimeCoordinator | undefined

async function fixture() {
  directory = await mkdtemp(join(tmpdir(), 'anas-conversation-routing-'))
  storage = AgentStorage.openNative(directory)
  const runtimeStarts = vi.spyOn(NativeConversationDatabase.prototype, 'recover')
  coordinator = new NativeRuntimeCoordinator(storage, { push: vi.fn() }, { prepareWorkspace: false,
    providerFetch: async () => { throw new Error('This routing test must not call a model.') } })
  return { directory, storage, coordinator, runtimeStarts }
}

afterEach(async () => {
  vi.restoreAllMocks()
  await coordinator?.shutdown()
  storage?.close()
  coordinator = undefined
  storage = undefined
  if (directory) await rm(directory, { recursive: true, force: true })
  directory = undefined
})

async function busyRun(database: NativeConversationDatabase, threadId: string, interrupted = false) {
  const runId = randomUUID(), id = runId + ':input'
  database.runs.createRun({ threadId, runId, operation: 'agent', message: { id, value: { id, kind: 'user', content: 'Question', context: { runId } } } })
  await database.runs.enter('input', { threadId, runId })
  if (!interrupted) return
  const { store } = database.runs
  const scope = () => ({ threadId, runId, expectedRevisionId: store.load(threadId)!.revisionId })
  const call: ExecutionToolCall = { id: 'pending', providerCallId: 'provider', name: 'update_config', args: {},
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
  store.acceptModel(scope(), { id: 'response', value: { kind: 'assistant', content: '', calls: [{ id: call.providerCallId, name: call.name, args: call.args }] } }, [call], { modelCalls: 1, todos: [] })
  store.prepareTools(scope(), [{ callId: call.id, args: {}, authorization: { approval: 'pending' } }], [{
    id: 'approval', generation: 'generation', kind: 'tool', callIds: [call.id], request: {
      actionRequests: [{ name: call.name, args: {}, description: 'Approve fixture' }],
      reviewConfigs: [{ actionName: call.name, allowedDecisions: ['approve', 'reject'] }] }
  }])
  expect(database.getThread(threadId)?.status).toBe('interrupted')
}

describe('conversation runtime routing', () => {
  it('uses one runtime per conversation and reads a catalog without opening runtimes', async () => {
    const { storage, coordinator, runtimeStarts } = await fixture()
    const first = storage.createThread({ title: 'First', projectId: 'project-a' })
    const second = storage.createThread({ title: 'Second', projectId: 'project-a' })
    expect(storage.listThreads().map((thread) => thread.id).sort()).toEqual([first.id, second.id].sort())
    expect(runtimeStarts).not.toHaveBeenCalled()
    expect(coordinator.forThread(first.id)).toBe(coordinator.forThread(first.id))
    expect(coordinator.forThread(second.id)).not.toBe(coordinator.forThread(first.id))
    expect(runtimeStarts).toHaveBeenCalledTimes(2)
    expect((await coordinator.getSnapshot(first.id)).thread.id).toBe(first.id)
    expect((await coordinator.getSnapshot(second.id)).thread.id).toBe(second.id)
  })

  it('rejects a project with a busy conversation before deleting any conversation', async () => {
    const { directory, storage, coordinator } = await fixture()
    const idle = storage.createThread({ title: 'Idle', projectId: 'project-a' })
    const busy = storage.createThread({ title: 'Busy', projectId: 'project-a' })
    await busyRun(storage.conversationForThread(busy.id), busy.id)

    await expect(coordinator.deleteProjectThreads('project-a')).rejects.toThrow('is busy')
    expect(storage.getThread(idle.id)).not.toBeNull()
    expect(storage.getThread(busy.id)).not.toBeNull()
    expect(existsSync(getAgentConversationDatabaseFile(idle.id, directory, idle.projectId))).toBe(true)
    expect(existsSync(getAgentConversationDatabaseFile(busy.id, directory, busy.projectId))).toBe(true)
  })

  it('deletes the selected project conversations and leaves another project readable', async () => {
    const { directory, storage, coordinator } = await fixture()
    const first = storage.createThread({ title: 'Selected 1', projectId: 'project-a' })
    const second = storage.createThread({ title: 'Selected 2', projectId: 'project-a' })
    const retained = storage.createThread({ title: 'Retained', projectId: 'project-b' })
    const result = await coordinator.deleteProjectThreads('project-a')
    expect(result.deletedThreadIds.sort()).toEqual([first.id, second.id].sort())
    expect(storage.listThreads().map((thread) => thread.id)).toEqual([retained.id])
    expect(existsSync(getAgentConversationDatabaseFile(first.id, directory, first.projectId))).toBe(false)
    expect(existsSync(getAgentConversationDatabaseFile(second.id, directory, second.projectId))).toBe(false)
    expect((await coordinator.getSnapshot(retained.id)).thread.title).toBe('Retained')
  })

  it('blocks new runs in a project while its conversations are being removed', async () => {
    const { storage, coordinator } = await fixture()
    const thread = storage.createThread({ title: 'Deleting', projectId: 'project-a' })
    const other = storage.createThread({ title: 'Keep', projectId: 'project-b' })
    const runtime = coordinator.forThread(thread.id)
    await runtime.waitForStartupCleanup()
    let release!: () => void
    let entered!: () => void
    const enteredDeletion = new Promise<void>((resolve) => { entered = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const shutdown = runtime.shutdown.bind(runtime)
    vi.spyOn(runtime, 'shutdown').mockImplementation(async () => {
      entered()
      await gate
      return shutdown()
    })
    const deletion = coordinator.deleteProjectThreads('project-a')
    await enteredDeletion
    try {
      await expect(coordinator.submitRunWithAttachments({
        submissionId: randomUUID(), runId: randomUUID(), threadId: randomUUID(),
        newThread: { projectId: 'project-a', title: 'Must not start' }, text: 'New work'
      })).rejects.toThrow('being deleted')
      expect(storage.getThread(other.id)?.projectId).toBe('project-b')
      expect(storage.listThreads()).toHaveLength(2)
    } finally {
      release()
      await deletion
    }
  })

  it('checks all running conversations before clearing shared memory', async () => {
    const { storage, coordinator } = await fixture()
    const thread = storage.createThread({ title: 'Working' })
    const runtime = coordinator.forThread(thread.id)
    await runtime.waitForStartupCleanup()
    vi.spyOn(runtime, 'hasLiveWork').mockReturnValue(true)
    const clear = vi.spyOn(storage.memoryStore, 'clearMemories')
    expect(() => coordinator.clearMemories()).toThrow('Agent runs are active')
    expect(clear).not.toHaveBeenCalled()
  })

  it('rejects project deletion while a new conversation has not reached the catalog', async () => {
    const { storage, coordinator } = await fixture()
    let release!: () => void
    let entered!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const pendingSubmission = new Promise<void>((resolve) => { entered = resolve })
    vi.spyOn(NativeAgentRuntime.prototype, 'submitRunWithAttachments').mockImplementationOnce(async () => {
      entered()
      await gate
      throw new Error('Submission stopped after attachment staging.')
    })
    const submission = coordinator.submitRunWithAttachments({
      submissionId: randomUUID(), runId: randomUUID(), threadId: randomUUID(),
      newThread: { projectId: 'project-a', title: 'Creating' }, text: 'New work'
    })
    const rejected = expect(submission).rejects.toThrow('Submission stopped')
    await pendingSubmission
    try {
      expect(storage.listThreads()).toEqual([])
      await expect(coordinator.deleteProject('project-a')).rejects.toThrow('still being created')
    } finally {
      release()
      await rejected
    }
    await expect(coordinator.deleteProject('project-a')).resolves.toMatchObject({ deletedThreadIds: [] })
  })

  it('checks unopened pending conversations before clearing shared memory', async () => {
    const { storage, coordinator, runtimeStarts } = await fixture()
    const thread = storage.createThread({ title: 'Approval' })
    await busyRun(storage.conversationForThread(thread.id), thread.id, true)
    storage.refreshConversation(thread.id)
    const clear = vi.spyOn(storage.memoryStore, 'clearMemories')
    expect(runtimeStarts).not.toHaveBeenCalled()
    expect(() => coordinator.clearMemories()).toThrow('Agent runs are active')
    expect(clear).not.toHaveBeenCalled()
  })

  it('keeps runtime and storage usable when maintenance cannot drain cleanup', async () => {
    const { storage, coordinator } = await fixture()
    const thread = storage.createThread({ title: 'Cleanup pending' })
    const runtime = coordinator.forThread(thread.id)
    await runtime.waitForStartupCleanup()
    vi.spyOn(runtime, 'shutdown').mockResolvedValue({ drained: false, lingeringRunIds: ['cleanup-run'], lingeringCallIds: [] })
    const resume = vi.spyOn(runtime, 'resumeAfterIncompleteShutdown')
    const compact = vi.spyOn(storage, 'compact')
    await expect(coordinator.compactDatabase()).rejects.toThrow('all Agent work to stop')
    expect(compact).not.toHaveBeenCalled()
    expect(resume).toHaveBeenCalledOnce()
    expect(coordinator.forThread(thread.id)).toBe(runtime)
  })

  it('bounds idle handles while preserving an async reader and an unopened approval', async () => {
    const { storage, coordinator } = await fixture()
    const held = storage.createThread({ title: 'Reading' })
    const approval = storage.createThread({ title: 'Approval' })
    const approvalDatabase = storage.conversationForThread(approval.id)
    await busyRun(approvalDatabase, approval.id, true)
    storage.refreshConversation(approval.id)
    const heldRuntime = coordinator.forThread(held.id)
    const getSnapshot = heldRuntime.getSnapshot.bind(heldRuntime)
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    vi.spyOn(heldRuntime, 'getSnapshot').mockImplementation(async (threadId) => {
      await gate
      return getSnapshot(threadId)
    })
    const pendingRead = coordinator.getSnapshot(held.id)
    try {
      for (let index = 0; index < 38; index += 1) {
        const thread = storage.createThread({ title: `Idle ${index}` })
        await coordinator.getSnapshot(thread.id)
        await coordinator.waitForStartupCleanup()
      }
      coordinator.trimIdleConversations()
      const opened = storage.openedConversations()
      expect(opened).toHaveLength(34)
      expect(opened.map(({ ownerId }) => ownerId)).toEqual(expect.arrayContaining([held.id, approval.id]))
      await expect(coordinator.compactDatabase()).rejects.toThrow('requires Agent runs to finish')
      await expect(coordinator.deleteThread(held.id)).rejects.toThrow('conversation operation is in progress')
    } finally {
      release()
      expect((await pendingRead).thread.title).toBe('Reading')
    }
    coordinator.trimIdleConversations()
    expect(storage.openedConversations()).toHaveLength(33)
    expect((await coordinator.getSnapshot(held.id)).thread.title).toBe('Reading')
  }, 15_000) // Initializes dozens of SQLite databases; this is a handle-lifecycle test, not a disk-speed benchmark.

  it('keeps the shared catalog open across a pending memory operation and excludes writes during maintenance', async () => {
    const { storage, coordinator } = await fixture()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const memoryWrite = coordinator.useStorage(async (leased) => {
      await gate
      return leased.memoryStore.saveMemory({
        scope: 'global', kind: 'fact', content: 'Keep this memory across maintenance', keywords: ['maintenance'], importance: 3
      }, { origin: 'user' })
    })
    await expect(coordinator.compactDatabase()).rejects.toThrow('requires Agent runs to finish')
    release()
    const saved = await memoryWrite
    expect(saved.content).toBe('Keep this memory across maintenance')
    const maintenance = coordinator.compactDatabase()
    expect(() => coordinator.useStorage((leased) => leased.memoryStore.searchMemories({}))).toThrow('shutting down')
    await maintenance
    expect((await coordinator.useStorage((leased) => leased.memoryStore.searchMemories({}))).items)
      .toEqual([expect.objectContaining({ id: saved.id })])
    expect(storage.getWorkspaceState()).toBeDefined()
  })
})

it('executes separate native conversations concurrently while rejecting a duplicate owner', async () => {
  const { storage, coordinator } = await fixture()
  let releaseDisposal!: () => void, disposing = false
  const disposal = new Promise<void>(resolve => { releaseDisposal = resolve })
  const release: Array<() => void> = [], entered: string[] = []
  const submissions = [0, 1].map(index => {
    const thread = storage.createThread({ title: `Conversation ${index}`, projectId: 'project-a' })
    const database = storage.conversationForThread(thread.id), runtime = coordinator.forThread(thread.id), runId = randomUUID()
    const gate = new Promise<void>(resolve => { release.push(resolve) })
    const create = async () => {
      entered.push(thread.id)
      const services: ConversationExecutionServices = { store: database.runs.store, enter: database.execution.enter,
        prepareModel: async state => ({ kind: 'model', invoke: async () => {
          await gate
          return { message: { id: `${runId}:answer`, value: { kind: 'assistant', content: `Answer ${index}`, context: { runId } } },
            calls: [], context: { ...state.context, modelCalls: 1 } }
        } }), afterModel: async () => ({ kind: 'complete' }), prepareTools: async () => ({ calls: [] }),
        executeTool: async () => { throw new Error('No tool expected') }, directions: async () => [], drain: async () => {}, retry: { maxRetries: 0 } }
      return { execution: conversationExecution(services), dispose: async () => {
        if (index === 1) { disposing = true; await disposal }
      } }
    }
    const input = { threadId: thread.id, runId, submissionId: randomUUID(), text: `Task ${index}` }
    return { input, runtime, create, pending: runtime.submitRunWithAttachments(input, create) }
  })
  try {
    const first = await submissions[0].pending, second = await submissions[1].pending
    expect(entered.sort()).toEqual(submissions.map(item => item.input.threadId).sort())
    await expect(submissions[0].runtime.submitRunWithAttachments({ ...submissions[0].input, runId: randomUUID(), submissionId: randomUUID() }, submissions[0].create)).rejects.toThrow()
    release[1]()
    await vi.waitFor(() => expect(disposing).toBe(true))
    expect((await coordinator.getSnapshot(submissions[1].input.threadId)).settlingRun?.status).toBe('completed')
    await expect(coordinator.cleanupThreads()).resolves.toMatchObject({ deleted: 0, skipped: 2, failed: 0 })
    await expect(submissions[1].runtime.submitRunWithAttachments({ ...submissions[1].input, runId: randomUUID(), submissionId: randomUUID() }, submissions[1].create)).rejects.toThrow()
    releaseDisposal()
    expect((await second.handle!.completed).status).toBe('completed'); await second.handle!.drained
    expect(submissions[0].runtime.isActive(submissions[0].input)).toBe(true)
    expect((await coordinator.getSnapshot(submissions[1].input.threadId)).messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Answer 1' }])
    release[0]()
    expect((await first.handle!.completed).status).toBe('completed'); await first.handle!.drained
    expect((await coordinator.getSnapshot(submissions[0].input.threadId)).messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Answer 0' }])
    expect(storage.listThreads()).toHaveLength(2)
  } finally { releaseDisposal(); for (const finish of release) finish() }
})

it('cleans idle native owners and hidden children while retaining pinned, active, paused and unresolved conversations', async () => {
  const { storage, coordinator, runtimeStarts } = await fixture()
  const idle = storage.createThread({ title: 'Idle owner' }), pinned = storage.createThread({ title: 'Pinned owner' })
  storage.conversationForThread(pinned.id).updateThread(pinned.id, { pinned: true })
  const active = storage.createThread(), paused = storage.createThread(), unresolved = storage.createThread(), owner = storage.createThread()
  await busyRun(storage.conversationForThread(active.id), active.id)
  await busyRun(storage.conversationForThread(paused.id), paused.id, true)
  const detached = storage.conversationForThread(unresolved.id)
  await busyRun(detached, unresolved.id)
  const saved = detached.runs.store.load(unresolved.id)!
  detached.managed.createManagedCall({ id: 'remote', threadId: unresolved.id, runId: saved.runId, kind: 'http', summary: 'Remote result unknown' })
  detached.managed.markManagedCallRunning('remote', unresolved.id)
  detached.managed.markManagedCallDetached('remote', unresolved.id)
  detached.managed.finishManagedCall({ callId: 'remote', threadId: unresolved.id, status: 'uncertain', error: 'Remote result unknown' })
  detached.runs.requestCancellation(saved); detached.runs.completeCancellation(saved)
  const database = storage.conversationForThread(owner.id)
  await busyRun(database, owner.id)
  const parent = database.runs.store.load(owner.id)!
  const child = database.runs.createSubagentCall({ id: randomUUID(), ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parent.runId,
    childThreadId: randomUUID(), childRunId: randomUUID(), childThread: {}, description: 'Hidden child',
    config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
  const childOwner = { threadId: child.childThreadId, runId: child.childRunId }
  database.runs.requestCancellation(childOwner); database.runs.completeCancellation(childOwner)
  database.runs.reconcileSubagent(child.id, owner.id)
  database.runs.requestCancellation(parent); database.runs.completeCancellation(parent)
  // These fixtures write the durable owner directly, without host notifications.
  for (const thread of [active, paused, unresolved, owner]) storage.refreshConversation(thread.id)
  expect(database.getThread(owner.id)?.status).toBe('idle')
  expect(storage.getThread(owner.id)?.status).toBe('idle')
  const removedFile = getAgentConversationDatabaseFile(owner.id, directory!)
  const result = await coordinator.cleanupThreads()
  expect(result).toMatchObject({ deleted: 2, skipped: 3, failed: 0 })
  expect(result.deletedThreadIds.sort()).toEqual([idle.id, owner.id].sort())
  expect(result.skippedThreadIds.sort()).toEqual([active.id, paused.id, unresolved.id].sort())
  expect(runtimeStarts).not.toHaveBeenCalled()
  expect(storage.listThreads().map(thread => thread.id).sort()).toEqual([pinned.id, active.id, paused.id, unresolved.id].sort())
  expect(existsSync(removedFile)).toBe(false)
  expect(detached.managed.getManagedCall('remote', unresolved.id)?.status).toBe('uncertain')
  expect(storage.conversationForThread(paused.id).runs.readInterrupts({ threadId: paused.id, runId: storage.conversationForThread(paused.id).runs.store.load(paused.id)!.runId })).toHaveLength(1)
})
