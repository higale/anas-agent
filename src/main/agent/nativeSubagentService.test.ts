import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import { defaultModelConfig } from '../../shared/modelConfig'
import type { AgentRuntimeEvent } from '../../shared/agentTypes'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import { subagentApprovalGenerationFromInterrupt, tagSubagentApprovalResponse } from '../../runtime/approvalRecovery'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeRunHost } from './nativeRunHost'
import { NativeSubagentService, type NativeSubagentServices } from './nativeSubagentService'
import { ManagedCallService } from './managedCallService'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { maximumConcurrentSubagents, maximumSubagentDepth, subagentToolDefinitions, type SubagentProcessSnapshot } from './subagentTools'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
afterEach(() => vi.useRealTimers())
const config = { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help with the task.' }
const identity = () => ({ subagentId: randomUUID(), childThreadId: randomUUID(), childRunId: randomUUID() })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
async function fixture(approval: boolean | ((childId: string) => number) = false) {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-subagents-')), file = join(root, 'conversation.sqlite'), global = new Database(':memory:')
  const options = { attachmentRoot: join(root, 'attachments'), memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) }
  let database = NativeConversationDatabase.open(file, options)
  const owner = { threadId: 'thread', runId: 'run' }, finish = deferred(), events: AgentRuntimeEvent[] = [], requested: string[] = []
  const configuration = vi.fn<NativeSubagentServices['configuration']>(async () => ({ providers: [], defaultModel: undefined }))
  let host: NativeRunHost, service: NativeSubagentService
  let create: ReturnType<typeof vi.fn<NativeSubagentServices['create']>>
  const assemble = () => {
    host = new NativeRunHost(database, new ManagedCallService(database.managed, database.results), { push: event => events.push(event) })
    service = new NativeSubagentService(database, host, {
      configuration,
      snapshot: threadId => database.readSnapshotWithPreviews(threadId, root),
      create: create = vi.fn<NativeSubagentServices['create']>(async call => {
        const services: ConversationExecutionServices = { store: database.runs.store, enter: database.execution.enter,
          prepareModel: async (state, request) => {
            const reads = state.context.rulePreparation?.reads ?? []
            const expectedApprovals = typeof approval === 'function' ? approval(call.id) : approval ? 1 : 0
            const path = join(root, reads.length ? 'SECOND_RULES.md' : 'AGENTS.md')
            if (reads.length < expectedApprovals) return { kind: 'wait', context: { ...state.context,
              projectRules: { runId: state.runId, roots: [], trustedFolders: [], documents: [], directories: [], initialScopes: [], activeScopes: [],
                blockedCalls: [], rejectedCalls: [], checkedWrites: [], blockedReason: '', fatalError: '' },
              rulePreparation: { runId: state.runId, initialized: true, reads } },
            approval: { id: 'rules', generation: reads.length ? 'second' : 'first', kind: 'context_read', callIds: [], path, resumePhase: 'prepare_model',
              request: { actionRequests: [{ name: 'read_file', args: { path }, description: 'Read project rules' }],
                reviewConfigs: [{ actionName: 'read_file', allowedDecisions: ['approve', 'reject'] }] } } }
            return { kind: 'model', invoke: async () => {
              requested.push(call.id)
              await new Promise<void>((resolve, reject) => {
                const aborted = () => { request.signal.removeEventListener('abort', aborted); reject(request.signal.reason) }
                request.signal.addEventListener('abort', aborted, { once: true })
                void finish.promise.then(() => { request.signal.removeEventListener('abort', aborted); resolve() })
                if (request.signal.aborted) aborted()
              })
              request.signal.throwIfAborted()
              return { message: { id: `${call.childRunId}:answer`, value: { kind: 'assistant', content: 'Child answer', context: { runId: state.runId } } },
                calls: [], context: { ...state.context, modelCalls: state.context.modelCalls + 1 } }
            } }
          }, afterModel: async () => ({ kind: 'complete' }), prepareTools: async () => ({ calls: [] }),
          executeTool: async () => { throw new Error('No tool expected') }, directions: async () => [], drain: async () => {}, retry: { maxRetries: 0 } }
        return { execution: conversationExecution(services), dispose: async () => {} }
      })
    })
  }
  assemble()
  database.runs.createThreadAndRun({ ...owner, thread: {}, submissionId: 'submission',
    message: { id: 'run:input', value: { id: 'run:input', kind: 'user', content: 'Delegate task', context: { runId: 'run' } } } })
  await database.runs.enter('input', owner)
  return { owner, finish, requested, events, configuration, get create() { return create }, get database() { return database }, get host() { return host }, get service() { return service },
    async reopen() { await host.waitForIdle(); database.close(); database = NativeConversationDatabase.open(file, options); assemble() },
    async close() { finish.resolve(); await host.waitForIdle(); database.validate(); database.close(); global.close(); rmSync(root, { recursive: true, force: true }) } }
}

it.each([false, true])('starts the selected native child independently of the built-in default enabled=%s', async defaultEnabled => {
  const h = await fixture()
  const runtime = h.service.forRun(h.owner), tools = subagentToolDefinitions({ subagents: [config,
    { ...config, name: 'general-purpose', builtIn: true, enabled: defaultEnabled }], runtime })
  const invoke = async (name: string, args: Record<string, unknown>) => JSON.parse(String((await tools.find(tool => tool.name === name)!.execute(args, {})).content))
  try {
    const started = await invoke('start_subagent', { agent: 'helper', description: 'Independent task' })
    expect(started).toMatchObject({ status: 'running', terminal: false })
    const id = started.subagent_id as string
    expect(await invoke('read_subagent', { subagent_id: id })).toMatchObject({ subagent_id: id, status: 'running' })
    const waiting = invoke('wait_subagent', { subagent_id: id })
    h.finish.resolve()
    expect(await waiting).toMatchObject({ status: 'completed', result: 'Child answer' })
    await h.host.waitForIdle()
    expect(h.requested).toEqual([id])
    expect(runtime.unresolvedForRun()).toMatchObject([{ id, status: 'completed' }])
    runtime.resolveObserved(id)
    expect(runtime.unresolvedForRun()).toEqual([])
    expect(h.events.filter(event => event.type === 'subagent_updated').at(-1)).toMatchObject({ runId: 'run', subagent: { id, result: 'Child answer' } })
  } finally { await h.close() }
})

it('reuses saved start identities and starts an unaccepted child once after reopening', async () => {
  const h = await fixture(), ids = identity()
  try {
    h.database.runs.createSubagentCall({ id: ids.subagentId, ownerThreadId: 'thread', parentThreadId: 'thread', parentRunId: 'run',
      childThreadId: ids.childThreadId, childRunId: ids.childRunId, config, description: 'Saved task', childThread: {} })
    await h.reopen()
    const runtime = h.service.forRun(h.owner), arm = vi.fn()
    await runtime.start({ agentName: 'helper', config: { ...config, enabled: false, systemPrompt: 'Changed live instructions' } }, 'Saved task', ids, arm)
    await runtime.start({ agentName: 'helper' }, 'Saved task', ids, arm)
    expect(arm).not.toHaveBeenCalled()
    await expect(runtime.start({ agentName: 'helper' }, 'Changed task', ids, arm)).rejects.toThrow('identity changed')
    h.finish.resolve(); await h.host.waitForIdle()
    expect((await runtime.read(ids.subagentId) as SubagentProcessSnapshot).call.result).toBe('Child answer')
    expect(h.requested).toEqual([ids.subagentId])
    expect(h.create.mock.calls[0][0].config).toEqual(config)
    expect(h.database.background.listDescendantSubagentCalls('thread')).toHaveLength(1)
  } finally { await h.close() }
})

it('keeps wait cancellation separate from child cancellation and rejects cross-parent access', async () => {
  const h = await fixture(), ids = identity(), runtime = h.service.forRun(h.owner)
  try {
    await runtime.start({ agentName: 'helper', config }, 'Running task', ids, () => {})
    const abort = new AbortController()
    const waiting = runtime.wait(ids.subagentId, 30_000, abort.signal)
    abort.abort(new Error('Stop waiting'))
    await expect(waiting).rejects.toThrow('Stop waiting')
    expect((await runtime.read(ids.subagentId) as SubagentProcessSnapshot).call.status).toBe('running')
    const nested = h.service.forRun({ threadId: ids.childThreadId, runId: ids.childRunId })
    await expect(nested.read(ids.subagentId)).rejects.toThrow('not found in this run')
    const arm = vi.fn()
    expect((await runtime.cancel(ids.subagentId, arm)).call.status).toBe('cancelled')
    expect((await runtime.cancel(ids.subagentId, arm)).call.status).toBe('cancelled')
    expect(arm).toHaveBeenCalledOnce()
  } finally { await h.close() }
})

it('surfaces native child approvals through the existing wait tool and resumes the same generation', async () => {
  const h = await fixture(true), ids = identity(), runtime = h.service.forRun(h.owner)
  const approval = vi.fn(async (request: unknown) => tagSubagentApprovalResponse({ decisions: [{ type: 'approve' }] }, subagentApprovalGenerationFromInterrupt(request)))
  const wait = subagentToolDefinitions({ subagents: [config], runtime, requestApproval: approval }).find(tool => tool.name === 'wait_subagent')!
  try {
    await runtime.start({ agentName: 'helper', config }, 'Needs rules', ids, () => {})
    await h.host.waitForIdle()
    const pending = await runtime.read(ids.subagentId) as SubagentProcessSnapshot
    expect(pending.call.status).toBe('interrupted')
    await expect(runtime.resume(ids.subagentId, [{ interruptId: pending.interrupts[0].id, expectedGeneration: 'stale', decisions: [{ type: 'approve' }] }])).rejects.toThrow('current approval generation')
    h.finish.resolve()
    const result = await wait.execute({ subagent_id: ids.subagentId }, { callId: 'wait-call' })
    expect(JSON.parse(String(result.content))).toMatchObject({ subagent_id: ids.subagentId, status: 'completed', result: 'Child answer' })
    await h.host.waitForIdle()
    expect(approval).toHaveBeenCalledOnce()
    expect(h.requested).toEqual([ids.subagentId])
    expect(h.database.background.listDescendantSubagentCalls('thread')).toHaveLength(1)
  } finally { await h.close() }
})

it('keeps the existing conversation concurrency limit and releases cancelled slots', async () => {
  const h = await fixture(), runtime = h.service.forRun(h.owner), ids = Array.from({ length: maximumConcurrentSubagents + 1 }, identity)
  try {
    for (const id of ids.slice(0, -1)) await runtime.start({ agentName: 'helper', config }, 'Parallel task', id, () => {})
    await expect(runtime.start({ agentName: 'helper', config }, 'Too many', ids.at(-1)!, () => {})).rejects.toThrow(`At most ${maximumConcurrentSubagents}`)
    await runtime.cancel(ids[0].subagentId, () => {})
    await runtime.start({ agentName: 'helper', config }, 'Available slot', ids.at(-1)!, () => {})
    await runtime.cancelRun('Fixture shutdown')
    expect(h.database.background.listDescendantSubagentCalls('thread').every(call => call.status === 'cancelled')).toBe(true)
  } finally { await h.close() }
})

it('keeps the existing nesting limit without creating an extra child', async () => {
  const h = await fixture()
  let owner = h.owner
  try {
    for (let depth = 0; depth < maximumSubagentDepth; depth++) {
      const ids = identity(), parent = h.database.resources.getSubagentCallByChildThreadId(owner.threadId)
      h.database.runs.createSubagentCall({ id: ids.subagentId, ownerThreadId: 'thread', parentThreadId: owner.threadId, parentRunId: owner.runId,
        parentSubagentId: parent?.id, childThreadId: ids.childThreadId, childRunId: ids.childRunId, config, description: 'Nested task', childThread: {} })
      const scope = () => ({ ...owner, expectedRevisionId: h.database.runs.store.load(owner.threadId)!.revisionId })
      h.database.runs.store.acceptModel(scope(), { id: `${owner.runId}:done`, value: { kind: 'assistant', content: 'Finished', context: { runId: owner.runId } } }, [], { modelCalls: 1, todos: [] })
      h.database.runs.store.finish(scope(), 'completed')
      if (parent) h.database.runs.reconcileSubagent(parent.id, 'thread')
      owner = { threadId: ids.childThreadId, runId: ids.childRunId }
      await h.database.runs.enter('input', owner)
    }
    // A saved descendant can outlive its ancestors before startup cleanup.
    // Keep only the deepest child live so depth is tested independently of concurrency.
    await expect(h.service.forRun(owner).start({ agentName: 'helper', config }, 'Too deep', identity(), () => {})).rejects.toThrow('limited to 8')
    expect(h.database.background.listDescendantSubagentCalls('thread')).toHaveLength(maximumSubagentDepth)
  } finally { await h.close() }
})

it.each([false, true])('keeps sequential child approval generations separate and completed siblings stable (reopen=%s)', async reopen => {
  const child = identity(), sibling = identity(), h = await fixture(id => id === child.subagentId ? 2 : 0)
  const runtime = () => h.service.forRun(h.owner)
  try {
    h.finish.resolve()
    await runtime().start({ agentName: 'helper', config }, 'Two rule reads', child, () => {})
    await runtime().start({ agentName: 'helper', config }, 'Sibling task', sibling, () => {})
    await h.host.waitForIdle()
    const first = await runtime().read(child.subagentId) as SubagentProcessSnapshot
    const completed = await runtime().read(sibling.subagentId) as SubagentProcessSnapshot
    expect(completed.call).toMatchObject({ status: 'completed', result: 'Child answer' })
    expect(first.interrupts).toHaveLength(1)
    const firstGeneration = first.interrupts[0].approvalGeneration
    await runtime().resume(child.subagentId, [{ interruptId: first.interrupts[0].id, expectedGeneration: firstGeneration, decisions: [{ type: 'approve' }] }])
    await h.host.waitForIdle()
    const second = await runtime().read(child.subagentId) as SubagentProcessSnapshot
    expect(second.call.status).toBe('interrupted')
    expect(second.interrupts).toHaveLength(1)
    const secondGeneration = second.interrupts[0].approvalGeneration
    expect(secondGeneration).not.toBe(firstGeneration)
    expect(h.requested).toEqual([sibling.subagentId])
    if (reopen) await h.reopen()
    const saved = h.database.runs.store.load(child.childThreadId), eventCount = h.events.length
    await expect(runtime().resume(child.subagentId, [{ interruptId: second.interrupts[0].id, expectedGeneration: firstGeneration, decisions: [{ type: 'approve' }] }]))
      .rejects.toThrow('current approval generation')
    expect(h.database.runs.store.load(child.childThreadId)).toEqual(saved)
    expect(h.events).toHaveLength(eventCount)
    expect(h.host.readSnapshot(child.childThreadId).interrupts).toHaveLength(1)
    await runtime().resume(child.subagentId, [{ interruptId: second.interrupts[0].id, expectedGeneration: secondGeneration, decisions: [{ type: 'approve' }] }])
    await h.host.waitForIdle()
    expect((await runtime().read(child.subagentId) as SubagentProcessSnapshot).call).toMatchObject({ status: 'completed', result: 'Child answer' })
    expect((await runtime().read(sibling.subagentId) as SubagentProcessSnapshot).call).toEqual(completed.call)
    expect(h.requested).toEqual([sibling.subagentId, child.subagentId])
  } finally { await h.close() }
})

it.each([false, true])('binds a configured child model before arming or launching native work (missing=%s)', async missing => {
  const h = await fixture(), ids = identity(), arm = vi.fn()
  const provider = { id: 'provider', name: 'Provider', index: 0, protocol: 'openai_chat_completions' as const,
    baseUrl: 'https://example.invalid/v1', modelListUrl: '', parameters: {},
    models: [{ ...structuredClone(defaultModelConfig), id: 'child-model', index: 0, model: 'child-model', displayName: 'Child model',
      parameterPresetMode: 'custom' as const, defaultParameterPresetId: 'careful',
      parameterPresets: [{ id: 'careful', name: 'Careful', parameters: { temperature: 0.1 } }] }] }
  h.configuration.mockResolvedValue({ providers: missing ? [] : [provider], defaultModel: undefined })
  try {
    const starting = h.service.forRun(h.owner).start({ agentName: config.name, config: { ...config, modelConfigId: 'child-model' } }, 'Review.', ids, arm)
    if (missing) {
      await expect(starting).rejects.toThrow('no longer exists')
      expect(arm).not.toHaveBeenCalled()
      expect(h.database.resources.getThread(ids.childThreadId)).toBeNull()
      expect(h.database.runs.subagents.find(ids.subagentId, h.owner.threadId)).toBeUndefined()
      expect(h.requested).toEqual([])
      expect(h.events).toEqual([])
    } else {
      const started = await starting
      expect(arm).toHaveBeenCalledTimes(1)
      expect(started.call.config.modelConfigId).toBe('child-model')
      expect(h.database.resources.getThread(ids.childThreadId)).toMatchObject({ modelConfigId: 'child-model', modelParameterPresetId: 'careful' })
      h.finish.resolve(); await h.host.waitForIdle(); await h.reopen()
      expect(h.database.resources.getThread(ids.childThreadId)).toMatchObject({ modelConfigId: 'child-model', modelParameterPresetId: 'careful' })
      expect(h.requested).toEqual([ids.subagentId])
    }
  } finally { await h.close() }
})

it('rejects invalid native subagent names and targets without starting or cancelling work', async () => {
  const h = await fixture(), runtime = h.service.forRun(h.owner)
  const tools = subagentToolDefinitions({ subagents: [config], runtime })
  const invoke = (name: string, args: Record<string, unknown>) => tools.find(tool => tool.name === name)!.execute(args, {})
  const cancel = vi.spyOn(h.host, 'cancel'), start = vi.spyOn(h.host, 'start')
  try {
    await expect(invoke('start_subagent', { agent: 'missing', description: 'Task' })).rejects.toThrow('missing')
    for (const name of ['read_subagent', 'wait_subagent', 'cancel_subagent']) await expect(invoke(name, { subagent_id: randomUUID() })).rejects.toThrow('not found')
    expect(JSON.parse(String((await invoke('read_subagent', {})).content))).toMatchObject({ ok: true, subagents: [] })
    expect(h.create).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled(); expect(cancel).not.toHaveBeenCalled()
    expect(h.database.background.listDescendantSubagentCalls('thread')).toEqual([])
  } finally { start.mockRestore(); cancel.mockRestore(); await h.close() }
})

it('limits native child operations to direct children of the owning run', async () => {
  const h = await fixture(), root = h.service.forRun(h.owner), parent = identity(), sibling = identity(), grand = identity()
  try {
    await root.start({ agentName: 'helper', config }, 'Parent', parent, () => {})
    await root.start({ agentName: 'helper', config }, 'Sibling', sibling, () => {})
    const nested = h.service.forRun({ threadId: parent.childThreadId, runId: parent.childRunId })
    await nested.start({ agentName: 'helper', config }, 'Grandchild', grand, () => {})
    const arm = vi.fn()
    for (const [runtime, target] of [[root, grand.subagentId], [nested, sibling.subagentId]] as const) {
      await expect(runtime.read(target)).rejects.toThrow('not found in this run')
      await expect(runtime.wait(target, 1)).rejects.toThrow('not found in this run')
      await expect(runtime.cancel(target, arm)).rejects.toThrow('not found in this run')
      await expect(runtime.resume(target, [])).rejects.toThrow('not found in this run')
      expect(() => runtime.resolveObserved(target)).toThrow('not found in this run')
    }
    expect(arm).not.toHaveBeenCalled()
    expect(root.unresolvedForRun().map(call => call.id).sort()).toEqual([parent.subagentId, sibling.subagentId].sort())
    expect(nested.unresolvedForRun().map(call => call.id)).toEqual([grand.subagentId])
    await nested.cancelRun('Owner requested cancellation')
    expect((await nested.read(grand.subagentId) as SubagentProcessSnapshot).call.status).toBe('cancelled')
    expect((await root.read(parent.subagentId) as SubagentProcessSnapshot).call.status).toBe('running')
    expect((await root.read(sibling.subagentId) as SubagentProcessSnapshot).call.status).toBe('running')
  } finally { await h.close() }
})

it('returns promptly for repeated native child recovery failures before wait registration', async () => {
  vi.useFakeTimers()
  const h = await fixture(), ids = identity()
  try {
    h.database.runs.createSubagentCall({ id: ids.subagentId, ownerThreadId: 'thread', parentThreadId: 'thread', parentRunId: 'run',
      childThreadId: ids.childThreadId, childRunId: ids.childRunId, config, description: 'Saved task', childThread: {} })
    const create = h.create.getMockImplementation()!
    h.create.mockRejectedValue(new Error('Configuration unavailable'))
    const runtime = h.service.forRun(h.owner)
    for (let attempt = 0; attempt < 2; attempt++) {
      let settled = false
      const waiting = runtime.wait(ids.subagentId, 10_000).then(result => { settled = true; return result })
      await vi.advanceTimersByTimeAsync(1)
      expect(settled).toBe(true)
      expect((await waiting).call).toMatchObject({ status: 'running', error: 'Configuration unavailable' })
      await h.host.waitForIdle()
    }
    expect(h.create).toHaveBeenCalledTimes(2)
    expect(h.requested).toEqual([])
    h.create.mockImplementation(create)
    await runtime.read(ids.subagentId)
    await vi.advanceTimersByTimeAsync(1)
    expect(h.database.runs.subagents.require(ids.subagentId, 'thread').error).toBeUndefined()
    h.finish.resolve()
    await h.host.waitForIdle()
    expect((await runtime.read(ids.subagentId) as SubagentProcessSnapshot).call).toMatchObject({ status: 'completed', result: 'Child answer' })
    expect(h.requested).toEqual([ids.subagentId])
  } finally { await h.close() }
})


it.each(['completed', 'failed', 'cancelled'] as const)('reconciles concurrent reads of a saved %s descendant exactly once through inactive ancestors', async outcome => {
  const h = await fixture(), parent = identity(), grand = identity()
  try {
    for (const [ids, owner, parentSubagentId] of [[parent, h.owner, undefined], [grand, { threadId: parent.childThreadId, runId: parent.childRunId }, parent.subagentId]] as const) {
      h.database.runs.createSubagentCall({ id: ids.subagentId, ownerThreadId: 'thread', parentThreadId: owner.threadId, parentRunId: owner.runId,
        parentSubagentId, childThreadId: ids.childThreadId, childRunId: ids.childRunId, config, description: 'Saved task', childThread: {} })
      const child = { threadId: ids.childThreadId, runId: ids.childRunId }
      await h.database.runs.enter('input', child)
    }
    const child = { threadId: grand.childThreadId, runId: grand.childRunId }
    const scope = () => ({ ...child, expectedRevisionId: h.database.runs.store.load(child.threadId)!.revisionId })
    h.database.runs.store.acceptModel(scope(), { id: 'answer', value: { kind: 'assistant', content: 'Saved descendant answer' } }, [], { modelCalls: 1, todos: [] })
    h.database.runs.store.finish(scope(), outcome, outcome === 'failed' ? 'Saved failure' : undefined)
    await h.reopen()
    const runtime = h.service.forRun({ threadId: parent.childThreadId, runId: parent.childRunId })
    const reads = await Promise.all([runtime.read(grand.subagentId), runtime.read(grand.subagentId), runtime.wait(grand.subagentId, 10_000)])
    for (const result of reads) expect(result).toMatchObject({ call: { status: outcome, ...(outcome === 'completed' ? { result: 'Saved descendant answer' } : {}) } })
    await runtime.cancel(grand.subagentId, () => {})
    expect(h.create).not.toHaveBeenCalled()
    expect(h.events.filter(event => event.type === 'subagent_updated' && event.subagent.id === grand.subagentId && event.subagent.status === outcome)).toHaveLength(1)
    expect(h.database.messages.activities.getSubagentActivity('run', grand.subagentId)?.status).toBe(outcome)
    expect(h.database.runs.subagents.require(parent.subagentId, 'thread').status).toBe('running')
  } finally { await h.close() }
})

it('waits for a completed child disposal before exposing its terminal projection', async () => {
  const h = await fixture(), ids = identity(), disposal = deferred(), disposing = deferred()
  const create = h.create.getMockImplementation()!
  h.create.mockImplementation(async (...args) => ({ ...await create(...args), dispose: async () => { disposing.resolve(); await disposal.promise } }))
  try {
    const runtime = h.service.forRun(h.owner)
    await runtime.start({ agentName: 'helper', config }, 'Task', ids, () => {})
    h.finish.resolve(); await disposing.promise
    let settled = false
    const waiting = runtime.wait(ids.subagentId, 10_000).then(result => { settled = true; return result })
    await Promise.resolve(); await Promise.resolve()
    expect(settled).toBe(false)
    expect(h.database.runs.subagents.require(ids.subagentId, 'thread').status).toBe('running')
    disposal.resolve()
    expect(await waiting).toMatchObject({ call: { status: 'completed', result: 'Child answer' } })
    await h.host.waitForIdle()
  } finally { disposal.resolve(); await h.close() }
})


it.each([false, true])('cancels inactive child and grandchild owners once without replaying them (accepted=%s)', async accepted => {
  const h = await fixture(), parent = identity(), grand = identity()
  try {
    for (const [ids, owner, parentSubagentId] of [[parent, h.owner, undefined], [grand, { threadId: parent.childThreadId, runId: parent.childRunId }, parent.subagentId]] as const) {
      h.database.runs.createSubagentCall({ id: ids.subagentId, ownerThreadId: 'thread', parentThreadId: owner.threadId, parentRunId: owner.runId,
        parentSubagentId, childThreadId: ids.childThreadId, childRunId: ids.childRunId, config, description: 'Saved task', childThread: {} })
      if (accepted) await h.database.runs.enter('input', { threadId: ids.childThreadId, runId: ids.childRunId })
    }
    const runtime = h.service.forRun(h.owner)
    expect(await runtime.cancel(parent.subagentId, () => {})).toMatchObject({ call: { status: 'cancelled' } })
    await h.host.waitForIdle()
    await runtime.cancel(parent.subagentId, () => {})
    for (const ids of [parent, grand]) {
      expect(h.database.runs.subagents.require(ids.subagentId, 'thread').status).toBe('cancelled')
      expect(h.events.filter(event => event.type === 'subagent_updated' && event.subagent.id === ids.subagentId && event.subagent.status === 'cancelled')).toHaveLength(1)
    }
    expect(h.create).not.toHaveBeenCalled()
    expect(h.requested).toEqual([])
  } finally { await h.close() }
})
