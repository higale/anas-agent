import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeRunHost } from './nativeRunHost'
import { ManagedCallService, type ManagedCallControl } from './managedCallService'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import type { AgentContextStatus, AgentRuntimeEvent } from '../../shared/agentTypes'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import { directoryTreePages } from '../directoryTree'
import type { ExecutionToolCall } from '../../runtime/executionState'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { beginToolEffect, checkToolExecutionCancelled, currentToolExecution, toolLocalCommitStarted, withToolExecution } from './toolExecutionContext'
import { ModelSelectionError, ModelRequestChangedError } from '../../runtime/errors'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
afterEach(() => vi.useRealTimers())
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
function fixture(displayText?: string) {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-host-')), global = new Database(':memory:')
  const database = NativeConversationDatabase.open(join(root, 'conversation.sqlite'), {
    attachmentRoot: join(root, 'attachments'), memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) })
  const owner = { threadId: 'thread', runId: 'run' }
  database.runs.createThreadAndRun({ ...owner, thread: {}, submissionId: 'submission',
    message: { id: 'run:input', value: { id: 'run:input', kind: 'user', content: 'Task', context: { runId: 'run', ...(displayText === undefined ? {} : { displayText }) } } } })
  const managed = new ManagedCallService(database.managed, database.results), events: AgentRuntimeEvent[] = []
  const sink = { push: vi.fn((event: AgentRuntimeEvent) => { events.push(event) }) }
  const host = new NativeRunHost(database, managed, sink)
  const services: ConversationExecutionServices = { store: database.runs.store, enter: database.execution.enter,
    prepareModel: async state => ({ kind: 'model', invoke: async () => ({
      message: { id: 'answer', value: { id: 'answer', kind: 'assistant', content: 'Final answer', context: { runId: state.runId } } },
      calls: [], context: { ...state.context, modelCalls: state.context.modelCalls + 1 } }) }),
    afterModel: async () => ({ kind: 'complete' }), prepareTools: async () => ({ calls: [] }),
    executeTool: async () => { throw new Error('No tool expected') }, directions: async () => [], drain: async () => {}, retry: { maxRetries: 0 } }
  const instance = { execution: conversationExecution(services), dispose: vi.fn(async () => {}) }
  return { root, database, owner, managed, events, sink, host, services, instance,
    async close() { await host.waitForIdle(); database.validate(); database.close(); global.close(); rmSync(root, { recursive: true, force: true }) } }
}

it.each(['completed', 'failed'] as const)('retains committed %s when the renderer or disposal fails, then releases the run', async status => {
  const h = fixture()
  const cleanup = vi.spyOn(h.database.resources.fileEditStore, 'deleteFileEditRecordsForRequest').mockResolvedValue(undefined)
  if (status === 'failed') h.services.prepareModel = async () => { throw new Error('Execution failure') }
  h.sink.push.mockImplementation(event => { h.events.push(event); throw new Error('Renderer disconnected') })
  h.instance.dispose.mockRejectedValue(new Error('Disposal diagnostic'))
  try {
    const handle = h.host.start(h.owner, 'input', async () => h.instance)
    expect((await handle.completed).status).toBe(status)
    await handle.drained
    expect(h.host.isActive(h.owner)).toBe(false)
    expect(h.events.map(event => event.type)).toContain(`run_${status}`)
    expect(h.events.find(event => event.type === 'run_started')).toMatchObject({ newUserTurn: true, userMessage: { id: 'run:input' } })
    expect(handle.diagnostics).toContainEqual(new Error('Disposal diagnostic'))
    if (status === 'completed') expect(h.database.runs.store.readHistory('thread')?.messages.at(-1)?.value.content).toBe('Final answer')
    else expect(h.database.messages.activities.getRun('run')?.error).toContain('Execution failure')
    expect(cleanup).toHaveBeenCalledWith('run', undefined)
    expect(h.database.resourceCleanup.listFileEditCleanupRunIds()).not.toContain('run')
    expect(h.host.cancel(h.owner)).toBe(false)
  } finally { await h.close() }
})

it('persists cancellation during assembly and waits for disposal before discarding an unaccepted input', async () => {
  const h = fixture(), assembly = deferred(), disposal = deferred(), disposing = deferred()
  const execute = vi.spyOn(h.instance.execution, 'execute')
  h.instance.dispose.mockImplementation(async () => { disposing.resolve(); await disposal.promise })
  const handle = h.host.start(h.owner, 'input', async context => {
    await assembly.promise
    expect(context.signal.aborted).toBe(true)
    return h.instance
  })
  try {
    expect(h.host.cancel(h.owner)).toBe(true)
    assembly.resolve(); await disposing.promise
    expect(h.database.messages.activities.getRun('run')?.status).toBe('running')
    expect(() => h.host.start(h.owner, 'input', async () => h.instance)).toThrow('still active')
    disposal.resolve()
    expect((await handle.completed).status).toBe('cancelled')
    await handle.drained
    expect(execute).not.toHaveBeenCalled()
    expect(h.database.runs.store.readHistory('thread')?.messages).toEqual([])
    expect(h.events.map(event => event.type)).toEqual(['run_cancelled', 'run_settled'])
  } finally { assembly.resolve(); disposal.resolve(); await h.close() }
})

it('retains ownership after a shutdown deadline and can resume after the pending executor really drains', async () => {
  const h = fixture(), assembly = deferred(), disposal = deferred(), disposing = deferred()
  let savedBeforeAbort: number | undefined
  const execute = vi.spyOn(h.instance.execution, 'execute')
  h.instance.dispose.mockImplementation(async () => { disposing.resolve(); await disposal.promise })
  try {
    await expect(h.host.shutdown({ timeoutMs: -1 })).rejects.toThrow('non-negative safe integer')
    const handle = h.host.start(h.owner, 'input', async context => {
      context.signal.addEventListener('abort', () => {
        const raw = new Database(join(h.root, 'conversation.sqlite'), { readonly: true })
        try { savedBeforeAbort = (raw.prepare('SELECT cancellation_requested FROM agent_runs WHERE id=?').get('run') as { cancellation_requested: number }).cancellation_requested }
        finally { raw.close() }
      }, { once: true })
      await assembly.promise; expect(context.signal.aborted).toBe(true); return h.instance
    })
    expect(h.host.hasLiveWork()).toBe(true)
    expect(h.host.retireIfIdle()).toBe(false)
    expect(await h.host.shutdown({ timeoutMs: 0 })).toEqual({ drained: false, lingeringRunIds: ['run'], lingeringCallIds: [] })
    expect(savedBeforeAbort).toBe(1)
    const raw = new Database(join(h.root, 'conversation.sqlite'), { readonly: true })
    try { expect(raw.prepare('SELECT cancellation_requested FROM agent_runs WHERE id=?').get('run')).toEqual({ cancellation_requested: 1 }) }
    finally { raw.close() }
    expect(() => h.host.enqueueQueuedInput({ id: 'late', threadId: 'thread', text: 'Late' })).toThrow('shutting down')
    expect(() => h.host.start(h.owner, 'input', async () => h.instance)).toThrow('shutting down')
    assembly.resolve(); await disposing.promise
    expect(h.database.messages.activities.getRun('run')?.status).toBe('running')
    expect(await h.host.shutdown({ timeoutMs: 0 })).toMatchObject({ drained: false, lingeringRunIds: ['run'] })
    disposal.resolve()
    expect(await h.host.shutdown()).toEqual({ drained: true, lingeringRunIds: [], lingeringCallIds: [] })
    expect((await handle.completed).status).toBe('cancelled')
    expect(execute).not.toHaveBeenCalled()
    expect(h.host.hasLiveWork()).toBe(false)
    h.host.resumeAfterIncompleteShutdown()
    const nextId = randomUUID()
    await h.host.enqueueQueuedInput({ id: nextId, threadId: 'thread', text: 'Next' })
    expect(h.host.listQueuedInputs()).toMatchObject([{ id: nextId }])
    expect(h.host.retireIfIdle()).toBe(true)
    expect(() => h.host.retryQueuedInput('thread', nextId)).toThrow('shutting down')
  } finally { assembly.resolve(); disposal.resolve(); await h.close() }
})

it.each([new Error('Configuration unavailable'), new ModelSelectionError('Configuration unavailable'), new ModelRequestChangedError()])('keeps an unaccepted input recoverable after $name and accepts it exactly once on retry', async error => {
  const h = fixture('Visible task')
  try {
    const failed = h.host.start(h.owner, 'input', async () => { throw error })
    expect((await failed.completed).status).toBe('running')
    await failed.drained
    expect(h.events.find(event => event.type === 'run_recovery_failed')).toMatchObject({ type: 'run_recovery_failed', error: error.message })
    expect(h.database.runs.store.load('thread')).toBeUndefined()
    const retry = h.host.recoverRun('thread', async () => h.instance)!
    expect((await retry.completed).status).toBe('completed')
    await retry.drained
    expect(h.database.runs.store.readHistory('thread')?.messages.filter(message => message.value.kind === 'user')).toHaveLength(1)
    expect(h.database.runs.store.readHistory('thread')?.messages[0].value.content).toBe('Task')
    expect(h.events.find(event => event.type === 'run_started')).toMatchObject({ newUserTurn: false,
      userMessage: { id: 'run:input', content: [{ type: 'text', text: 'Visible task' }] } })
  } finally { await h.close() }
})

it.each([false, true])('publishes the final reply but holds the session and cleanup until the operation exits (local commit=%s)', async localCommit => {
  vi.useFakeTimers()
  const h = fixture(), operation = deferred(), cleaned = deferred()
  const cleanup = vi.spyOn(h.database.resources.fileEditStore, 'deleteFileEditRecordsForRequest').mockImplementation(() => cleaned.promise)
  const starting = h.managed.start({ ...h.owner, kind: localCommit ? 'builtin' : 'mcp', summary: 'Pending operation', uncertainWhenCancelledAfterDispatch: true,
    execute: async control => {
      control.markRunning(); if (localCommit) control.markLocalCommit()
      await operation.promise
      if (localCommit) control.setOutcome({ ok: true, local_commit_completed: true })
      return 'Late output'
    } })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    const { call_id: id } = JSON.parse(await starting) as { call_id: string }
    const handle = h.host.start(h.owner, 'input', async () => h.instance)
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await handle.completed).status).toBe('completed')
    expect(h.host.isActive(h.owner)).toBe(true)
    expect(cleanup).not.toHaveBeenCalled()
    await h.host.cleanupResources()
    expect(cleanup).not.toHaveBeenCalled()
    expect(h.events.some(event => event.type === 'run_settled')).toBe(false)
    expect(h.host.readSnapshot('thread').settlingRun?.backgroundCleanup?.status).toBe('unconfirmed')
    expect(h.events.find(event => event.type === 'run_cleanup')).toMatchObject({ reply: { content: [{ type: 'text', text: 'Final answer' }] } })
    expect(() => h.host.start(h.owner, 'continue', async () => h.instance)).toThrow('still active')
    const shutdown = h.host.shutdown({ timeoutMs: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(await shutdown).toEqual({ drained: false, lingeringRunIds: ['run'], lingeringCallIds: [id] })
    expect(h.host.retireIfIdle()).toBe(false)
    operation.resolve(); await vi.advanceTimersByTimeAsync(1)
    expect(cleanup).toHaveBeenCalledOnce()
    expect(h.database.resourceCleanup.listFileEditCleanupRunIds()).toContain('run')
    const repeated = h.host.cleanupResources()
    await vi.advanceTimersByTimeAsync(1)
    expect(cleanup).toHaveBeenCalledOnce()
    cleaned.resolve(); await repeated; await handle.drained
    expect(h.database.resourceCleanup.listFileEditCleanupRunIds()).not.toContain('run')
    expect(await h.host.shutdown()).toEqual({ drained: true, lingeringRunIds: [], lingeringCallIds: [] })
    expect(cleanup).toHaveBeenCalledExactlyOnceWith('run', undefined)
    expect(h.host.isActive(h.owner)).toBe(false)
    expect(h.events.at(-1)).toMatchObject({ type: 'run_settled', runId: 'run', status: 'completed' })
    expect(h.database.managed.getManagedCall(id, 'thread')).toMatchObject({ status: localCommit ? 'completed' : 'uncertain', result: 'Late output' })
  } finally { operation.resolve(); cleaned.resolve(); await h.close() }
})

it('drains cancellation of a saved input even when there is no live executor', async () => {
  const h = fixture()
  try {
    expect(h.host.cancel(h.owner)).toBe(true)
    await h.host.waitForIdle()
    expect(h.events.find(event => event.type === 'run_cancelled')).toMatchObject({ type: 'run_cancelled', run: { id: 'run' } })
    expect(h.database.runs.store.load('thread')).toBeUndefined()
    expect(h.host.isActive(h.owner)).toBe(false)
  } finally { await h.close() }
})

const waitForRules: ConversationExecutionServices['prepareModel'] = async state => ({
  kind: 'wait', context: { ...state.context, projectRules: { runId: 'run', roots: [], trustedFolders: [], documents: [], directories: [], initialScopes: [], activeScopes: [], blockedCalls: [], rejectedCalls: [], checkedWrites: [], blockedReason: '', fatalError: '' }, rulePreparation: { runId: 'run', initialized: true, reads: [] } },
  approval: { id: 'rules', generation: 'first', kind: 'context_read', callIds: [], path: '/fixture/AGENTS.md', resumePhase: 'prepare_model',
    request: { actionRequests: [{ name: 'read_file', args: { path: '/fixture/AGENTS.md' }, description: 'Read project rules' }], reviewConfigs: [{ actionName: 'read_file', allowedDecisions: ['approve', 'reject'] }] } }
})

it.each(['completed', 'interrupted', 'failed'] as const)('retains committed %s when snapshot projection fails', async status => {
  const h = fixture()
  if (status === 'interrupted') h.services.prepareModel = waitForRules
  if (status === 'failed') h.services.prepareModel = async () => { throw new Error('Execution failure') }
  const snapshot = vi.spyOn(h.host, 'readSnapshot').mockImplementation(() => { throw new Error('Snapshot unavailable') })
  try {
    const handle = h.host.start(h.owner, 'input', async () => h.instance)
    expect((await handle.completed).status).toBe(status)
    await handle.drained
    const event = h.events.find(event => event.type === `run_${status}`)
    expect(event).toBeDefined()
    if (status === 'failed') expect(snapshot).not.toHaveBeenCalled()
    else {
      expect(event).toMatchObject({ snapshot: undefined })
      expect(handle.diagnostics).toContainEqual(new Error('Snapshot unavailable'))
    }
    if (status === 'interrupted') expect(event).toMatchObject({ interrupts: [{ id: 'rules', value: { actionRequests: [{ name: 'read_file' }] } }] })
    snapshot.mockRestore()
    expect(h.host.readSnapshot('thread').thread.status).toBe(status === 'completed' ? 'idle' : status)
  } finally { await h.close() }
})

it('allows resuming a context approval while an unrelated background operation is still running', async () => {
  vi.useFakeTimers()
  const h = fixture(), operation = deferred()
  const starting = h.managed.start({ ...h.owner, kind: 'shell', summary: 'Background search',
    execute: async control => { control.markRunning(); control.signal.addEventListener('abort', operation.resolve, { once: true }); await operation.promise; return 'Stopped' } })
  const prepare = h.services.prepareModel
  h.services.prepareModel = async (state, ...args) => state.context.rulePreparation?.reads.length ? prepare(state, ...args) : waitForRules(state, ...args)
  try {
    await vi.advanceTimersByTimeAsync(10_000); await starting
    const waiting = h.host.start(h.owner, 'input', async () => h.instance)
    expect((await waiting.completed).status).toBe('interrupted')
    await waiting.drained
    expect(h.managed.hasActiveForRun('run')).toBe(true)
    expect(h.host.readSnapshot('thread').activities[0].models).toEqual([])
    expect(h.events.some(event => event.type === 'model_started')).toBe(false)
    const interrupt = h.host.readSnapshot('thread').interrupts[0]
    expect(h.host.recoverRun('thread', async () => h.instance)).toBeUndefined()
    const resumed = h.host.resumeRun({ ...h.owner, responses: [{ interruptId: interrupt.id,
      expectedGeneration: interrupt.approvalGeneration!, decisions: [{ type: 'approve' }] }] }, async () => h.instance)
    expect(h.host.readSnapshot('thread').interrupts).toEqual([])
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await resumed.completed).status).toBe('completed')
    await resumed.drained
    expect(h.events.filter(event => event.type === 'run_interrupted')).toHaveLength(1)
  } finally { operation.resolve(); await h.close() }
})

it.each(['completed', 'failed', 'retryable', 'interrupted'] as const)('holds parent ownership until child disposal after %s and retains children on retryable failure', async outcome => {
  vi.useFakeTimers()
  const h = fixture(), started = deferred(), disposal = deferred()
  await h.database.runs.enter('input', h.owner)
  const child = h.database.runs.createSubagentCall({ id: 'child', ownerThreadId: 'thread', parentThreadId: 'thread', parentRunId: 'run',
    childThreadId: 'child-thread', childRunId: 'child-run', childThread: {}, description: 'Child task',
    config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
  const childServices: ConversationExecutionServices = { ...h.services, prepareModel: async (_state, request) => {
    started.resolve()
    await new Promise<void>(resolve => request.signal.addEventListener('abort', () => resolve(), { once: true }))
    request.signal.throwIfAborted()
    throw new Error('Child must have been cancelled')
  } }
  const childRun = h.host.start({ threadId: child.childThreadId, runId: child.childRunId }, 'input', async () => ({
    execution: conversationExecution(childServices), dispose: () => disposal.promise }))
  try {
    await started.promise
    const cancelManaged = vi.spyOn(h.managed, 'cancelRun')
    if (outcome === 'failed') h.services.prepareModel = async () => { throw new Error('Parent model failure') }
    if (outcome === 'interrupted') h.services.prepareModel = waitForRules
    const parent = h.host.start(h.owner, 'continue', async () => {
      if (outcome === 'retryable') throw new Error('Temporary parent assembly failure')
      return h.instance
    })
    if (outcome === 'retryable' || outcome === 'interrupted') {
      expect((await parent.completed).status).toBe(outcome === 'retryable' ? 'running' : 'interrupted')
      await parent.drained
      expect(h.host.isActive({ threadId: child.childThreadId, runId: child.childRunId })).toBe(true)
      expect(cancelManaged).not.toHaveBeenCalled()
      expect(h.host.cancel(h.owner)).toBe(true)
      expect(cancelManaged).toHaveBeenCalledWith('run', 'Agent run cancelled.')
    }
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.database.messages.activities.getRun('run')?.status).toBe(outcome === 'retryable' || outcome === 'interrupted' ? 'cancelled' : outcome)
    expect(h.host.isActive(h.owner)).toBe(true)
    expect(h.host.isActive({ threadId: child.childThreadId, runId: child.childRunId })).toBe(true)
    disposal.resolve()
    expect((await childRun.completed).status).toBe('cancelled')
    await h.host.waitForIdle()
    expect(h.database.background.listDescendantSubagentCalls('thread')).toMatchObject([{ status: 'cancelled' }])
  } finally { disposal.resolve(); await h.close() }
})

it.each([
  { outcome: 'failed', projectionFails: false }, { outcome: 'failed', projectionFails: true },
  { outcome: 'cancelled', projectionFails: false }
] as const)('removes uncommitted context previews after $outcome (projection fails=$projectionFails)', async ({ outcome, projectionFails }) => {
  const h = fixture(), preparing = deferred()
  const status: AgentContextStatus = { modelConfigId: 'fixture', estimatedInputTokens: 40, currentContextTokens: 40,
    maxContextTokens: 1000, maxOutputTokens: 100, inputCapacityTokens: 900, compressionEnabled: true, compressionThreshold: 0.8,
    compressionThresholdTokens: 720, compressionApplied: false, manualCompressionAvailable: false,
    breakdown: { profileTokens: 0, systemInstructionTokens: 0, runtimeContextTokens: 0, workspaceTokens: 0, memoryTokens: 0,
      skillTokens: 0, toolDefinitionTokens: 0, messageTokens: 40, attachmentTokens: 0 } }
  h.services.prepareModel = async (_state, request) => {
    if (outcome === 'cancelled') {
      preparing.resolve()
      await new Promise<void>((_, reject) => {
        if (request.signal.aborted) reject(request.signal.reason)
        else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
    }
    throw new Error('Provider failed before committing response')
  }
  try {
    const handle = h.host.start(h.owner, 'input', async context => {
      context.onContextStatus({ ...status, estimatedInputTokens: 10, currentContextTokens: 10, compressionApplied: true })
      return { ...h.instance, context: { projectedStatus: async source => {
        expect(source.messages.map(message => message.content)).toEqual(['Task'])
        expect(source.summary).toBeUndefined()
        if (projectionFails) throw new Error('Could not calculate saved context')
        return status
      } } }
    })
    if (outcome === 'cancelled') { await preparing.promise; expect(h.host.cancel(h.owner)).toBe(true) }
    expect((await handle.completed).status).toBe(outcome)
    await handle.drained
    expect(h.host.readSnapshot('thread').contextStatus).toEqual(projectionFails ? undefined : status)
    expect(h.events.filter(event => event.type === 'context_status_updated').at(-1)).toMatchObject({ status: projectionFails ? undefined : status })
    expect(h.events.find(event => event.type === `run_${outcome}`)).toMatchObject({ type: `run_${outcome}`,
      ...(outcome === 'failed' ? { error: 'Provider failed before committing response' } : {}) })
  } finally { await h.close() }
})

it('releases only the finished run directory cursors after draining', async () => {
  const h = fixture(), root = join(h.root, 'tree')
  mkdirSync(root)
  for (const name of ['first', 'second', 'third']) writeFileSync(join(root, name), name)
  const options = { root, entryLimit: 1, scope: 'run' }
  try {
    const own = await directoryTreePages.read(options)
    const other = await directoryTreePages.read({ ...options, scope: 'other-run' })
    expect(own.nextCursor).toEqual(expect.any(String))
    const handle = h.host.start(h.owner, 'input', async () => h.instance)
    await handle.completed; await handle.drained
    await expect(directoryTreePages.read({ ...options, cursor: own.nextCursor as string })).rejects.toThrow('expired')
    await expect(directoryTreePages.read({ ...options, scope: 'other-run', cursor: other.nextCursor as string })).resolves.toHaveProperty('entries')
  } finally { await directoryTreePages.closeIdleCursors('other-run'); await h.close() }
})

it('projects a nested native child stream and durable result to its ancestors without exposing hidden child lifecycle events', async () => {
  const h = fixture(), streamed = deferred(), finish = deferred()
  const config = { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' }
  await h.database.runs.enter('input', h.owner)
  h.database.runs.createSubagentCall({ id: 'child', ownerThreadId: 'thread', parentThreadId: 'thread', parentRunId: 'run',
    childThreadId: 'child-thread', childRunId: 'child-run', childThread: {}, description: 'Child task', config })
  await h.database.runs.enter('input', { threadId: 'child-thread', runId: 'child-run' })
  const grand = h.database.runs.createSubagentCall({ id: 'grand', ownerThreadId: 'thread', parentThreadId: 'child-thread', parentRunId: 'child-run', parentSubagentId: 'child',
    childThreadId: 'grand-thread', childRunId: 'grand-run', childThread: {}, description: 'Grandchild task', config })
  let modelId!: string
  const services: ConversationExecutionServices = { ...h.services, prepareModel: async (state, _request, observer) => {
    modelId = observer.startModel()
    return { kind: 'model', invoke: async () => {
      observer.model({ kind: 'delta', modelId, channel: 'text', text: 'Nested answer' })
      observer.model({ kind: 'tool_input', modelId, progress: [{ index: 0, name: 'read_file', characterCount: 12, complete: false }] })
      streamed.resolve(); await finish.promise
      observer.model({ kind: 'completed', modelId, message: { id: 'nested-answer', role: 'assistant', content: [{ type: 'text', text: 'Nested answer' }] },
        calls: [], streamedText: 'Nested answer', streamedReasoning: '', usage: undefined, responseMetadata: undefined })
      return { message: { id: 'nested-answer', value: { id: 'nested-answer', kind: 'assistant', content: 'Nested answer', context: { runId: state.runId } } },
        calls: [], context: { ...state.context, modelCalls: 1 } }
    } }
  } }
  const handle = h.host.start({ threadId: grand.childThreadId, runId: grand.childRunId }, 'input', async () => ({
    execution: conversationExecution(services), dispose: async () => {} }))
  try {
    await streamed.promise
    expect(h.events.find(event => event.type === 'model_delta')).toMatchObject({ runId: 'run', threadId: 'thread', subagentId: 'grand' })
    h.database.messages.observations.recordModel('run', { id: 'stale-root', status: 'running', text: '', reasoning: '', toolCallIds: [] })
    expect(h.host.readSnapshot('thread').activities[0].models.some(model => model.id === 'stale-root')).toBe(false)
    expect(h.host.readSnapshot('thread').activities[0].models.find(model => model.id === modelId)?.toolCallProgress)
      .toMatchObject([{ characterCount: 12 }])
    finish.resolve(); expect((await handle.completed).status).toBe('completed'); await handle.drained
    expect(handle.diagnostics).toEqual([])
    expect(h.events.filter(event => event.type === 'run_started' || event.type === 'run_completed' || event.type === 'run_settled')).toEqual([])
    expect(h.events.filter(event => event.type === 'subagent_updated').at(-1)).toMatchObject({ runId: 'run', subagent: { id: 'grand', status: 'completed', result: 'Nested answer' } })
    for (const runId of ['run', 'child-run']) {
      expect(h.database.messages.activities.getModelActivity(runId, modelId)).toMatchObject({ subagentId: 'grand', text: 'Nested answer', status: 'completed' })
    }
  } finally { finish.resolve(); await h.close() }
})

it('cancels a saved approval and releases transient activity bodies only after the native host drains', async () => {
  const h = fixture()
  try {
    await h.database.runs.enter('input', h.owner)
    const store = h.database.runs.store, scope = () => ({ ...h.owner, expectedRevisionId: store.load('thread')!.revisionId })
    const call: ExecutionToolCall = { id: 'waiting-tool', providerCallId: 'provider', name: 'write_file', args: {},
      artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
    store.acceptModel(scope(), { id: 'saved-model', value: { kind: 'assistant', content: '', calls: [{ id: 'provider', name: call.name, args: {} }] } }, [call], { modelCalls: 1, todos: [] })
    store.prepareTools(scope(), [{ callId: call.id, args: {}, authorization: { approval: 'pending' } }], [{
      id: 'approval', generation: 'generation', kind: 'tool', callIds: [call.id], request: {
        actionRequests: [{ name: call.name, args: {}, description: 'Confirm' }],
        reviewConfigs: [{ actionName: call.name, allowedDecisions: ['approve', 'reject'] }]
      }
    }])
    const observed = h.database.messages.observations
    observed.recordModel('run', { id: 'partial-model', status: 'running', text: 'Partial prefix', reasoning: '', toolCallIds: [] })
    observed.recordTool('run', { id: 'partial-tool', name: 'execute', args: { command: 'partial' } }, 'completed', undefined, 'Partial result')
    h.database.summaries.recordContextSummaryStarted('run', 'partial-summary')
    expect(h.database.messages.activities.getModelActivity('run', 'partial-model')).toMatchObject({ status: 'running', completedAt: undefined })
    observed.recordModel('run', { id: 'partial-model', status: 'completed', text: 'Partial prefix', reasoning: '', toolCallIds: [] })
    expect(observed.pendingModel('run', 'partial-model')?.text).toBe('Partial prefix')
    expect(observed.pendingTool('run', 'partial-tool')?.output).toBe('Partial result')
    expect(h.host.cancel(h.owner)).toBe(true)
    await h.host.waitForIdle()
    expect(store.load('thread')?.phase).toBe('cancelled')
    expect(h.database.messages.activities.getRunActivity('run')).toMatchObject({ status: 'cancelled', tools: [], subagents: [] })
    expect(h.database.messages.activities.getRunActivity('run')?.summaries ?? []).toEqual([])
    expect(h.database.messages.activities.getRunActivity('run')?.models).toHaveLength(1)
    expect(observed.pendingModel('run', 'partial-model')).toBeUndefined()
    expect(observed.pendingTool('run', 'partial-tool')).toBeUndefined()
    expect(h.database.readSnapshot('thread').interrupts).toEqual([])
    expect(h.host.isActive(h.owner)).toBe(false)
  } finally { await h.close() }
})

it.each([false, true])('isolates native assembly, execution and disposal from the launching tool (local commit=%s)', async localCommit => {
  const h = fixture(), controller = new AbortController()
  const control: ManagedCallControl = { callId: 'launching-tool', signal: controller.signal, markRunning: vi.fn(), markLocalCommit: vi.fn(),
    markUncertain: vi.fn(), output: vi.fn(), progress: vi.fn(), setOutcome: vi.fn() }
  const observed: Array<{ stage: string; control: unknown; committing: boolean }> = []
  const inspect = (stage: string) => {
    observed.push({ stage, control: currentToolExecution(), committing: toolLocalCommitStarted() })
    checkToolExecutionCancelled(); beginToolEffect()
  }
  const prepare = h.services.prepareModel
  h.services.prepareModel = async (...args) => { inspect('execute'); return prepare(...args) }
  h.instance.dispose.mockImplementation(async () => { inspect('dispose') })
  try {
    await withToolExecution(control, localCommit, async () => {
      if (localCommit) beginToolEffect()
      else controller.abort(new Error('Launching tool stopped'))
      const handle = h.host.start(h.owner, 'input', async context => {
        inspect('prepare'); await Promise.resolve(); inspect('prepared'); context.signal.throwIfAborted(); return h.instance
      })
      expect((await handle.completed).status).toBe('completed'); await handle.drained
      expect(currentToolExecution()).toBe(control); expect(toolLocalCommitStarted()).toBe(localCommit)
    })
    expect(observed).toEqual(['prepare', 'prepared', 'execute', 'dispose'].map(stage => ({ stage, control: undefined, committing: false })))
    expect(control.markRunning).toHaveBeenCalledTimes(localCommit ? 1 : 0)
    expect(control.markLocalCommit).toHaveBeenCalledTimes(localCommit ? 1 : 0)
    expect(h.events.filter(event => event.type === 'run_completed')).toHaveLength(1)
    expect(h.events.some(event => event.type === 'run_failed')).toBe(false)
  } finally { await h.close() }
})
it.each(['initial', 'terminal', 'all'] as const)('releases native work and preserves the reply when %s cleanup report writes fail', async failure => {
  vi.useFakeTimers()
  const h = fixture()
  vi.spyOn(h.database.resources.fileEditStore, 'deleteFileEditRecordsForRequest').mockResolvedValue()
  let aborted = false
  const starting = h.managed.start({ ...h.owner, kind: 'shell', summary: 'Background work', execute: async control => {
    control.markRunning()
    await new Promise<void>(resolve => control.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
    return 'Stopped'
  } })
  const persist = h.database.background.updateRunBackgroundCleanup.bind(h.database.background)
  const report = vi.spyOn(h.database.background, 'updateRunBackgroundCleanup')
  let first = true
  report.mockImplementation((runId, cleanup) => {
    const fail = failure === 'all' || (failure === 'terminal' && cleanup.status !== 'running') || (failure === 'initial' && first)
    first = false
    if (fail) throw new Error('SQLite disk full')
    persist(runId, cleanup)
  })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    const { call_id: callId } = JSON.parse(await starting) as { call_id: string }
    const handle = h.host.start(h.owner, 'input', async () => h.instance)
    await vi.advanceTimersByTimeAsync(10_000)
    expect((await handle.completed).status).toBe('completed')
    await handle.drained
    expect(aborted).toBe(true)
    expect(h.instance.dispose).toHaveBeenCalledOnce()
    expect(h.host.isActive(h.owner)).toBe(false)
    expect(h.database.managed.getManagedCall(callId, 'thread')).toMatchObject({ status: 'cancelled', result: 'Stopped' })
    expect(h.events.filter(event => event.type === 'run_cleanup').at(-1)).toMatchObject({
      cleanup: { status: failure === 'initial' ? 'completed' : 'unconfirmed' }, reply: { content: [{ type: 'text', text: 'Final answer' }] }
    })
    const completed = h.events.find(event => event.type === 'run_completed')
    expect(completed).toMatchObject({ run: { backgroundCleanup: { status: failure === 'initial' ? 'completed' : 'unconfirmed' } } })
    if (completed?.type !== 'run_completed') throw new Error('Missing completion')
    expect(completed.snapshot?.activities.some(activity => activity.backgroundCleanup?.status === 'running')).toBe(false)
    const snapshot = h.host.readSnapshot('thread')
    expect(snapshot.settlingRun).toBeUndefined()
    expect(snapshot.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'Final answer' }])
    expect(snapshot.activities.some(activity => activity.backgroundCleanup?.status === 'running')).toBe(false)
    expect(h.host.readActivityWindow('thread', 'run', 100).backgroundCleanup?.status).not.toBe('running')
  } finally { report.mockRestore(); await h.close() }
})

it.each([
  ['completed', 'model'], ['completed', 'preset'], ['failed', 'model'], ['failed', 'preset'], ['cancelled', 'model'], ['cancelled', 'preset']
] as const)('preserves the user selection changed during native %s disposal (%s)', async (outcome, selection) => {
  const h = fixture(), disposal = deferred(), disposing = deferred(), model = deferred(), entered = deferred()
  h.database.updateThread('thread', { modelConfigId: 'model-a', modelParameterPresetId: 'original' })
  if (outcome !== 'completed') h.services.prepareModel = async () => {
    entered.resolve()
    if (outcome === 'cancelled') await model.promise
    throw new Error('Provider request failed')
  }
  h.instance.dispose.mockImplementation(async () => { disposing.resolve(); await disposal.promise })
  const handle = h.host.start(h.owner, 'input', async () => h.instance)
  try {
    if (outcome === 'cancelled') { await entered.promise; h.host.cancel(h.owner); model.resolve() }
    await disposing.promise
    if (outcome !== 'cancelled') expect(h.host.cancel(h.owner)).toBe(false)
    const updated = h.database.updateThread('thread', selection === 'model'
      ? { modelConfigId: 'model-b', modelParameterPresetId: null }
      : { modelParameterPresetId: 'replacement' })
    disposal.resolve()
    expect((await handle.completed).status).toBe(outcome)
    await handle.drained
    expect(h.host.readSnapshot('thread').thread).toEqual(updated)
    const terminal = h.events.find(event => event.type === `run_${outcome}`)
    expect(terminal).toBeDefined()
    if (terminal?.type === 'run_completed') expect(terminal.snapshot?.thread).toEqual(updated)
  } finally { model.resolve(); disposal.resolve(); await h.close() }
})

it.each([false, true])('retries only the failed model request, withholding results: %s', async withholdToolResults => {
  const h = fixture(), requests: import('../../runtime/conversationMessage').ConversationMessage[][] = []
  const { conversationContextSource } = await import('./conversationModelExecution')
  const { withheldToolResultText, withholdToolResult } = await import('../../runtime/modelRequestRecovery')
  const calls: ExecutionToolCall[] = ['left', 'right'].map(id => ({ id, providerCallId: `provider-${id}`, name: 'write_file', args: { path: id },
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `${id}:${purpose}`])) as ExecutionToolCall['artifacts'] }))
  const tool = vi.fn(async (call: { id: string; providerCallId?: string }) => ({ kind: 'result' as const,
    message: { id: `${call.id}:result`, value: { id: `${call.id}:result`, kind: 'tool' as const, name: 'write_file', resultFor: call.providerCallId,
      content: [{ type: 'image', mimeType: 'image/png', data: 'original-image-bytes' }], resultStatus: 'success' as const } } }))
  let fail = true
  h.services.prepareModel = async state => ({ kind: 'model', invoke: async () => {
    requests.push(conversationContextSource(state, h.database.runs.store).messages)
    if (state.context.modelCalls && fail) throw Object.assign(new Error('Invalid provider request'), { status: 400 })
    const pending = state.context.modelCalls ? [] : calls
    return { message: { id: `answer-${state.context.modelCalls}`, value: { id: `answer-${state.context.modelCalls}`, kind: 'assistant', content: pending.length ? '' : 'Done',
      calls: pending.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } },
      calls: pending, context: { ...state.context, modelCalls: state.context.modelCalls + 1 } }
  } })
  h.services.prepareTools = async state => ({ calls: state.calls.map(call => ({ callId: call.id, args: call.args })) })
  h.services.executeTool = tool
  try {
    const original = h.host.start(h.owner, 'input', async () => h.instance)
    expect((await original.completed).status).toBe('failed')
    await original.drained
    const retry = h.host.readSnapshot('thread').modelRetries![0]
    expect(retry.canWithholdToolResults).toBe(true)
    const saved = h.database.runs.store.load('thread')!.messages
    await expect(h.host.retryModel({ ...h.owner, expectedRevisionId: 'stale', withholdToolResults }, async () => h.instance)).rejects.toThrow('revision changed')
    expect(h.database.readModel.getRun('run')?.status).toBe('failed')
    fail = false
    const request = { ...h.owner, expectedRevisionId: retry.revisionId, withholdToolResults }
    const resumed = await h.host.retryModel(request, async () => h.instance)
    await expect(h.host.retryModel(request, async () => h.instance)).rejects.toThrow('change its messages')
    expect((await resumed.completed).status).toBe('completed')
    await resumed.drained
    expect(tool).toHaveBeenCalledTimes(2)
    expect(requests).toHaveLength(3)
    const last = requests.at(-1)!
    expect(last.filter(message => message.kind === 'user')).toHaveLength(1)
    expect(last.filter(message => message.kind === 'tool').map(message => message.resultFor)).toEqual(['provider-left', 'provider-right'])
    if (withholdToolResults) {
      expect(last.filter(message => message.kind === 'tool').map(message => message.content)).toEqual([withheldToolResultText, withheldToolResultText])
    } else expect(last).toEqual(requests[1])
    const retained = h.database.runs.store.load('thread')!.messages.slice(0, saved.length)
    expect(retained.map(record => record.value)).toEqual(saved.map(record => withholdToolResults && record.value.kind === 'tool' ? withholdToolResult(record.value) : record.value))
    if (withholdToolResults) expect(h.host.readSnapshot('thread').activities.flatMap(activity => activity.tools).map(tool => tool.output)).toEqual([withheldToolResultText, withheldToolResultText])
    expect(h.events.filter(event => event.type === 'run_started').map(event => event.newUserTurn)).toEqual([true, false])
    expect(h.host.readSnapshot('thread').modelRetries).toBeUndefined()
  } finally { await h.close() }
})

it('does not offer model retry after a tool execution failure', async () => {
  const h = fixture()
  // A post-model business failure is not a failed provider request.
  h.services.afterModel = async () => { throw new Error('Tool assembly failed') }
  try {
    const handle = h.host.start(h.owner, 'input', async () => h.instance)
    await handle.completed; await handle.drained
    const state = h.database.runs.store.load('thread')!
    expect(h.host.readSnapshot('thread').modelRetries).toBeUndefined()
    await expect(h.host.retryModel({ ...h.owner, expectedRevisionId: state.revisionId, withholdToolResults: false }, async () => h.instance))
      .rejects.toThrow('not a retryable model request')
    expect(h.database.readModel.getRun('run')?.status).toBe('failed')
  } finally { await h.close() }
})

it.each([false, true])('confirms historical retry and retains the failed tool batch, withholding: %s', async withholdToolResults => {
  const h = fixture()
  const todos = [{ content: 'Retained plan', status: 'in_progress' as const }]
  const laterTodos = [{ content: 'Discarded plan', status: 'completed' as const }]
  const { conversationContextSource } = await import('./conversationModelExecution')
  const { withheldToolResultText, withholdToolResult } = await import('../../runtime/modelRequestRecovery')
  try {
    await h.database.runs.enter('input', h.owner)
    const scope = () => ({ ...h.owner, expectedRevisionId: h.database.runs.store.load('thread')!.revisionId })
    const call: ExecutionToolCall = { id: 'saved-call', providerCallId: 'provider-call', name: 'write_todos', args: { todos },
      artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `saved:${purpose}`])) as ExecutionToolCall['artifacts'] }
    h.database.runs.store.acceptModel(scope(), { id: 'saved-response', value: { kind: 'assistant', content: '',
      calls: [{ id: call.providerCallId, name: call.name, args: call.args }] } }, [call], { modelCalls: 1, todos: [] })
    h.database.runs.store.prepareTools(scope(), [{ callId: call.id, args: call.args }])
    h.database.runs.store.settleCall(h.owner, call.id, { id: 'saved-result', value: { kind: 'tool', resultFor: call.providerCallId,
      name: call.name, content: 'Already written', resultStatus: 'success', context: { runId: 'run' } } }, { todos })
    h.database.runs.store.finishBatch(scope())
    h.database.runs.store.finish(scope(), 'failed', 'Provider rejected', { modelRequestFailed: true })
    expect(h.host.readSnapshot('thread').todos).toEqual(todos)
    const original = h.database.runs.store.readHistory('thread')!.messages
    const next = { threadId: 'thread', runId: 'later' }
    h.database.runs.createRun({ ...next, operation: 'agent', message: { id: 'later:input', value: { id: 'later:input', kind: 'user',
      content: 'Continue', context: { runId: next.runId } } } })
    await h.database.runs.enter('input', next)
    const laterScope = () => ({ ...next, expectedRevisionId: h.database.runs.store.load('thread')!.revisionId })
    const laterCall = { ...call, id: 'later-call', args: { todos: laterTodos } }
    h.database.runs.store.acceptModel(laterScope(), { id: 'later-response', value: { kind: 'assistant', content: '',
      calls: [{ id: laterCall.providerCallId, name: laterCall.name, args: laterCall.args }] } }, [laterCall], { modelCalls: 1, todos: [] })
    h.database.runs.store.prepareTools(laterScope(), [{ callId: laterCall.id, args: laterCall.args }])
    h.database.runs.store.settleCall(next, laterCall.id, { id: 'later-result', value: { kind: 'tool', resultFor: laterCall.providerCallId,
      name: laterCall.name, content: 'Later plan', resultStatus: 'success', context: { runId: next.runId } } }, { todos: laterTodos })
    h.database.runs.store.finishBatch(laterScope())
    h.database.runs.store.finish({ ...next, expectedRevisionId: h.database.runs.store.load('thread')!.revisionId }, 'failed', 'Provider rejected again', { modelRequestFailed: true })
    expect(h.host.readSnapshot('thread').todos).toEqual(laterTodos)
    const before = h.database.runs.store.readHistory('thread')!
    expect(h.host.readSnapshot('thread').modelRetries).toEqual([
      { runId: 'run', revisionId: before.revisionId, requiresRollback: true, canWithholdToolResults: true },
      { runId: 'later', revisionId: before.revisionId, requiresRollback: false, canWithholdToolResults: true }
    ])
    const request = { ...h.owner, expectedRevisionId: before.revisionId, withholdToolResults }
    await expect(h.host.retryModel(request, async () => h.instance)).rejects.toThrow('Confirm removal')
    await expect(h.host.retryModel({ ...request, discardLaterMessages: true, expectedRevisionId: 'stale' }, async () => h.instance))
      .rejects.toThrow('revision changed')
    expect(h.database.runs.store.readHistory('thread')).toEqual(before)
    expect(h.database.readModel.getRun('later')?.status).toBe('failed')
    if (withholdToolResults) {
      const sql = new Database(join(h.root, 'conversation.sqlite'))
      try {
        sql.exec("CREATE TRIGGER reject_history_retry BEFORE UPDATE OF record_id ON agent_message_payloads BEGIN SELECT RAISE(ABORT,'replacement failed'); END")
        await expect(h.host.retryModel({ ...request, discardLaterMessages: true }, async () => h.instance)).rejects.toThrow('replacement failed')
        expect(h.database.runs.store.readHistory('thread')).toEqual(before)
        expect(h.database.readModel.getRun('later')?.status).toBe('failed')
        expect(h.database.readModel.getRun('run')?.status).toBe('failed')
      } finally { sql.exec('DROP TRIGGER IF EXISTS reject_history_retry'); sql.close() }
    }
    const executeTool = vi.fn(h.services.executeTool)
    h.services.executeTool = executeTool
    h.services.prepareModel = async state => {
      expect(state.context.modelCalls).toBe(1)
      expect(state.context.todos).toEqual(todos)
      const messages = conversationContextSource(state, h.database.runs.store).messages
      expect(messages.filter(message => message.kind === 'user')).toHaveLength(1)
      expect(messages.at(-1)?.content).toBe(withholdToolResults ? withheldToolResultText : 'Already written')
      return { kind: 'model', invoke: async () => ({ message: { id: 'retried-answer', value: { kind: 'assistant', content: 'Recovered', context: { runId: 'run' } } },
        calls: [], context: { ...state.context, modelCalls: 2 } }) }
    }
    const handle = await h.host.retryModel({ ...request, discardLaterMessages: true }, async () => h.instance)
    expect((await handle.completed).status).toBe('completed'); await handle.drained
    expect(h.database.readModel.getRun('later')).toBeNull()
    expect(h.database.runs.store.readHistory('thread')!.messages.slice(0, original.length).map(record => record.value))
      .toEqual(original.map(record => withholdToolResults && record.value.kind === 'tool' ? withholdToolResult(record.value) : record.value))
    expect(executeTool).not.toHaveBeenCalled()
    expect(h.host.readSnapshot('thread').todos).toEqual(todos)
    expect(h.host.readSnapshot('thread').modelRetries).toBeUndefined()
  } finally { await h.close() }
})

it('offers retry for a retained failure after the user deletes later messages', async () => {
  const h = fixture()
  try {
    await h.database.runs.enter('input', h.owner)
    h.database.runs.store.finish({ ...h.owner, expectedRevisionId: h.database.runs.store.load('thread')!.revisionId }, 'failed', 'Provider rejected', { modelRequestFailed: true })
    const next = { threadId: 'thread', runId: 'later' }
    h.database.runs.createRun({ ...next, operation: 'agent', message: { id: 'later:input', value: { id: 'later:input', kind: 'user',
      content: 'Continue', context: { runId: next.runId } } } })
    await h.database.runs.enter('input', next)
    h.database.runs.store.finish({ ...next, expectedRevisionId: h.database.runs.store.load('thread')!.revisionId }, 'failed', 'Failed again', { modelRequestFailed: true })
    await h.host.truncateMessages({ threadId: 'thread', messageId: 'later:input' })
    expect(h.database.runs.store.load('thread')).toBeUndefined()
    const retry = h.host.readSnapshot('thread').modelRetries![0]
    expect(retry).toMatchObject({ runId: 'run', requiresRollback: false, canWithholdToolResults: false })
    const handle = await h.host.retryModel({ ...h.owner, expectedRevisionId: retry.revisionId, withholdToolResults: false }, async () => h.instance)
    expect((await handle.completed).status).toBe('completed'); await handle.drained
    expect(h.database.runs.store.readHistory('thread')!.messages.map(message => message.id)).toEqual(['run:input', 'answer'])
  } finally { await h.close() }
})

it('can remove a later failed compression with no messages without losing the earlier model error', async () => {
  const h = fixture()
  try {
    await h.database.runs.enter('input', h.owner)
    h.database.runs.store.finish({ ...h.owner, expectedRevisionId: h.database.runs.store.load('thread')!.revisionId }, 'failed', 'Provider rejected', { modelRequestFailed: true })
    const compression = { threadId: 'thread', runId: 'compression' }
    h.database.runs.createRun({ ...compression, operation: 'compression' })
    await h.database.runs.enter('input', compression)
    h.database.runs.store.finish({ ...compression, expectedRevisionId: h.database.runs.store.load('thread')!.revisionId }, 'failed', 'Compression failed')
    const retry = h.host.readSnapshot('thread').modelRetries![0]
    expect(retry).toMatchObject({ runId: 'run', requiresRollback: true })
    const handle = await h.host.retryModel({ ...h.owner, expectedRevisionId: retry.revisionId, withholdToolResults: false, discardLaterMessages: true }, async () => h.instance)
    expect((await handle.completed).status).toBe('completed'); await handle.drained
    expect(h.database.readModel.getRun('compression')).toBeNull()
    expect(h.database.runs.store.readHistory('thread')!.messages.map(message => message.id)).toEqual(['run:input', 'answer'])
  } finally { await h.close() }
})

it('keeps non-model failures ineligible after later input and history deletion', async () => {
  const h = fixture()
  try {
    await h.database.runs.enter('input', h.owner)
    h.database.runs.store.finish({ ...h.owner, expectedRevisionId: h.database.runs.store.load('thread')!.revisionId }, 'failed', 'Tool configuration failed')
    const later = { threadId: 'thread', runId: 'later' }
    h.database.runs.createRun({ ...later, operation: 'agent', message: { id: 'later:input', value: { id: 'later:input', kind: 'user',
      content: 'Continue', context: { runId: later.runId } } } })
    await h.database.runs.enter('input', later)
    h.database.runs.store.finish({ ...later, expectedRevisionId: h.database.runs.store.load('thread')!.revisionId }, 'failed', 'Provider rejected', { modelRequestFailed: true })
    expect(h.host.readSnapshot('thread').modelRetries?.map(retry => retry.runId)).toEqual(['later'])
    await h.host.truncateMessages({ threadId: 'thread', messageId: 'later:input' })
    expect(h.host.readSnapshot('thread').modelRetries).toBeUndefined()
  } finally { await h.close() }
})
