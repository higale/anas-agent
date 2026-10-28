import { defaultCapabilities } from '../../shared/agentCapabilities'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AgentRuntimeEvent } from '../../shared/agentTypes'
import type { ExecutionToolCall } from '../../runtime/executionState'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import { ProjectRulesRequestBudgetError, ModelSelectionError, ModelRequestChangedError } from '../../runtime/errors'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeAgentRuntime } from './nativeAgentRuntime'
import { NativeRunHost } from './nativeRunHost'
import { ManagedCallService } from './managedCallService'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { runtimeLog } from '../runtimeLogger'
import { createConversationToolExecutor } from './conversationToolExecution'
import { ToolRunScope } from '../../runtime/toolEvents'
import type { RunObserver } from '../../runtime/runExecution'
import { z } from 'zod'
import { createManagedToolRuntime } from './managedToolRuntime'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-runtime-recovery-')), global = new Database(':memory:')
  const file = join(root, 'conversation.sqlite'), options = { attachmentRoot: join(root, 'attachments'),
    memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) }
  let database = NativeConversationDatabase.open(file, options)
  const identity = { threadId: randomUUID(), runId: randomUUID() }, events: AgentRuntimeEvent[] = []
  database.runs.createThreadAndRun({ ...identity, thread: {}, submissionId: randomUUID(),
    message: { id: 'input', value: { id: 'input', kind: 'user', content: 'Task', context: { runId: identity.runId } } } })
  const hosts: NativeRunHost[] = []
  const scope = () => ({ ...identity, expectedRevisionId: database.runs.store.load(identity.threadId)!.revisionId })
  return { root, identity, scope, events, fileEdits: options.fileEditStore, get db() { return database },
    host(startup = false) {
      const sink = { push: (event: AgentRuntimeEvent) => { events.push(event) } }
      const host = startup ? new NativeAgentRuntime(database, root, sink)
        : new NativeRunHost(database, new ManagedCallService(database.managed, database.results), sink)
      hosts.push(host); return host
    },
    services(): ConversationExecutionServices {
      return { store: database.runs.store, enter: database.execution.enter,
        prepareModel: async state => ({ kind: 'model', invoke: async () => ({
          message: { id: 'answer', value: { kind: 'assistant', content: 'Final answer' } }, calls: [],
          context: { ...state.context, modelCalls: state.context.modelCalls + 1 } }) }),
        afterModel: async () => ({ kind: 'complete' }), prepareTools: async () => ({ calls: [] }),
        executeTool: async () => { throw new Error('Saved results must not execute again') },
        directions: async () => [], drain: async () => {}, retry: { maxRetries: 0 } }
    },
    model(calls: ExecutionToolCall[]) {
      database.runs.store.acceptModel(scope(), { id: 'calling', value: { kind: 'assistant', content: '', context: { runId: identity.runId },
        calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
    },
    complete() { database.runs.store.acceptModel(scope(), { id: 'answer', value: { kind: 'assistant', content: 'Answer' } }, [], { modelCalls: 1, todos: [] }); database.runs.store.finish(scope(), 'completed') },
    sql(action: (raw: Database.Database) => void) { const raw = new Database(file); try { action(raw) } finally { raw.close() } },
    async reopen() { for (const host of hosts.splice(0)) await host.shutdown(); database.close(); database = NativeConversationDatabase.open(file, options) },
    async close() { for (const host of hosts.splice(0)) await host.shutdown(); database.close(); global.close(); vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }) }
  }
}
function call(id: string): ExecutionToolCall & { args: Record<string, unknown> } {
  return { id, providerCallId: id, name: 'lookup', args: { query: id },
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, id + ':' + purpose])) as ExecutionToolCall['artifacts'] }
}
const instance = (services: ConversationExecutionServices) => async () => ({ execution: conversationExecution(services), dispose: async () => {} })

describe('native runtime durable recovery', () => {
  it.each(['inline completed', 'detached completed', 'detached running', 'detached uncertain', 'queued cancelled'] as const)('recovers a %s managed effect through real storage without invoking it again', async scenario => {
    const h = fixture()
    let service: ManagedCallService | undefined
    try {
      await h.db.runs.enter('input', h.identity)
      const requested = { ...call('managed'), name: 'mcp_write' }; h.model([requested])
      h.db.runs.store.prepareTools(h.scope(), [{ callId: requested.id, args: requested.args }])
      const key = { ...h.identity, callId: requested.id }, managedId = requested.artifacts['managed-call']
      h.db.runs.store.prepareEffect(key, 'confirm')
      const queued = scenario === 'queued cancelled', detached = scenario !== 'inline completed'
      if (!queued) h.db.runs.store.armEffect(key, { kind: 'mcp_call', target: requested.args })
      h.db.managed.createManagedCall({ id: managedId, ...h.identity, kind: 'mcp', summary: 'Mutation' })
      if (detached) h.db.managed.markManagedCallDetached(managedId, h.identity.threadId)
      if (!queued) h.db.managed.markManagedCallRunning(managedId, h.identity.threadId)
      const message = { id: 'managed-result', kind: 'tool' as const, name: requested.name, resultFor: requested.providerCallId,
        resultStatus: 'success' as const, content: 'Durable managed output', artifact: { bytes: new Uint8Array([0, 255]) } }
      const reference = await h.db.results.save(message, { ...h.identity, managedCallId: managedId })
      if (scenario !== 'detached running') h.db.managed.finishManagedCall({ callId: managedId, threadId: h.identity.threadId,
        status: queued ? 'cancelled' : scenario === 'detached uncertain' ? 'uncertain' : 'completed', result: reference, outcome: { result_format: 'conversation' } })
      await h.reopen()
      const execute = vi.fn(async () => { throw new Error('Must not execute a recovered managed call') })
      const definition = { name: requested.name, description: 'Mutation', inputSchema: z.object({ query: z.string() }), execute }
      const owner = h.db.execution, operations = new ToolRunScope()
      service = new ManagedCallService(h.db.managed, h.db.results)
      const managed = createManagedToolRuntime(definition, { service, results: h.db.results, ...h.identity, allowBackground: true,
        providerCallId: () => requested.providerCallId! })
      const dispatch = createConversationToolExecutor({ store: owner.store, definitions: [managed], operations, planning: false,
        preparation: { runId: h.identity.runId, primaryFolder: h.root, folders: [h.root], accessMode: () => 'full_access', includeRules: false,
          definitions: [definition], fileEditStore: h.fileEdits }, managed: owner.managed, persistFileChange: owner.persistFileChange })
      const observer: RunObserver = { started: vi.fn(), startModel: vi.fn(() => 'model'), discardModel: vi.fn(), model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
      const state = owner.store.load(h.identity.threadId)!
      const result = await dispatch(state.calls[0], state, { ...h.identity, signal: new AbortController().signal }, observer)
      expect(execute).not.toHaveBeenCalled()
      if (scenario === 'detached uncertain') {
        expect(result.kind).toBe('wait')
        expect(owner.store.loadEffect(key)?.state).toBe('intent')
      } else {
        if (result.kind !== 'result') throw new Error('Expected recovered managed result')
        if (detached) expect(JSON.parse(String(result.message.value.content))).toMatchObject({ call_id: managedId, status: queued ? 'cancelled' : scenario === 'detached running' ? 'running' : 'completed' })
        else expect(result.message.value).toMatchObject(message)
        expect(owner.store.loadEffect(key)).toMatchObject({ state: scenario === 'detached running' ? 'intent' : 'result', effectAttempt: queued ? 0 : 1 })
      }
      expect(Boolean(h.db.managed.getManagedCall(managedId, h.identity.threadId))).toBe(detached)
      await operations.drain(); await service.shutdown(); service = undefined; await h.reopen()
      if (scenario === 'inline completed') expect(h.db.runs.store.loadEffect(key)?.result?.value).toMatchObject(message)
    } finally { await service?.shutdown(); await h.close() }
  })

  it.each(['completed', 'failed', 'cancelled', 'requested cancellation', 'waiting'] as const)('preserves effect evidence across %s recovery without dispatching terminal or unanswered work', async outcome => {
    const h = fixture()
    try {
      await h.db.runs.enter('input', h.identity)
      const requested = call('effect'); h.model([requested])
      h.db.runs.store.prepareTools(h.scope(), [{ callId: requested.id, args: requested.args }])
      const key = { ...h.identity, callId: requested.id }
      h.db.runs.store.prepareEffect(key, 'confirm')
      h.db.runs.store.armEffect(key, { kind: 'http_mutation', target: { method: 'POST', url: 'https://fixture.invalid' } })
      if (outcome === 'completed') {
        const saved = h.db.runs.store.saveEffectResult(key, { id: 'effect-result', value: { kind: 'tool', resultFor: requested.id, content: 'Durable output' } })
        h.db.runs.store.settleCall(h.scope(), requested.id, saved.result!)
        h.db.runs.store.finishBatch(h.scope()); h.complete()
      } else if (outcome === 'requested cancellation') h.db.runs.requestCancellation(h.identity)
      else if (outcome === 'waiting') h.db.runs.store.wait(h.scope(), [{ id: 'approval', generation: 'generation', kind: 'effect_recovery', callIds: [requested.id], request: {
        actionRequests: [{ name: requested.name, args: requested.args, description: 'Confirm uncertain effect' }],
        reviewConfigs: [{ actionName: requested.name, allowedDecisions: ['approve', 'reject'] }] } }])
      else h.db.runs.store.finish(h.scope(), outcome)
      const evidence = h.db.runs.store.loadEffect(key)
      for (let restart = 0; restart < 2; restart++) {
        await h.reopen()
        expect(h.db.recover()).toEqual([])
        expect(h.db.runs.store.loadEffect(key)).toEqual(evidence)
        const create = vi.fn(instance(h.services()))
        expect(h.host().recoverRun(h.identity.threadId, create)).toBeUndefined()
        expect(create).not.toHaveBeenCalled()
        expect(h.db.readModel.getRun(h.identity.runId)?.status).toBe(outcome === 'requested cancellation' ? 'cancelled' : outcome === 'waiting' ? 'interrupted' : outcome)
        if (outcome === 'completed') expect(h.db.runs.store.readHistory(h.identity.threadId)?.messages.find(message => message.id === 'effect-result')?.value.content).toBe('Durable output')
        if (outcome === 'waiting') expect(h.db.readSnapshot(h.identity.threadId).interrupts).toMatchObject([{ id: 'approval' }])
      }
    } finally { await h.close() }
  })

  it('retains a rule-budget failure after a saved tool result and does not offer terminal work after reopening', async () => {
    const h = fixture()
    try {
      await h.db.runs.enter('input', h.identity)
      const requested = call('saved'); h.model([requested])
      h.db.runs.store.prepareTools(h.scope(), [{ callId: requested.id, args: requested.args }])
      h.db.runs.store.settleCall(h.identity, requested.id, { id: 'saved-result', value: { kind: 'tool', resultFor: requested.id, content: 'Already executed' } })
      h.db.runs.store.finishBatch(h.scope())
      const services = h.services(), execute = vi.fn(services.executeTool)
      services.executeTool = execute
      services.prepareModel = async () => { throw new ProjectRulesRequestBudgetError(2000, 1500) }
      const handle = h.host().recoverRun(h.identity.threadId, instance(services))!
      expect((await handle.completed).status).toBe('failed'); await handle.drained
      expect(execute).not.toHaveBeenCalled()
      expect(h.events.find(event => event.type === 'run_failed')).toMatchObject({ type: 'run_failed', run: { status: 'failed' } })
      await h.reopen()
      expect(h.db.recover()).toEqual([])
      expect(h.db.readModel.getRun(h.identity.runId)).toMatchObject({ status: 'failed', error: expect.stringContaining('1500') })
      expect(h.db.runs.store.readHistory(h.identity.threadId)?.messages.at(-1)).toMatchObject({ id: 'saved-result', value: { content: 'Already executed' } })
    } finally { await h.close() }
  })

  it('reopens a saved tool result and completes its batch without dispatching it again', async () => {
    const h = fixture()
    try {
      await h.db.runs.enter('input', h.identity)
      const requested = call('saved'); h.model([requested])
      h.db.runs.store.prepareTools(h.scope(), [{ callId: requested.id, args: requested.args }])
      h.db.runs.store.settleCall(h.identity, requested.id, { id: 'saved-result', value: { kind: 'tool', resultFor: requested.id, content: 'Durable result' } })
      await h.reopen()
      expect(h.db.recover()).toEqual([{ ...h.identity, command: 'continue' }])
      const services = h.services(), execute = vi.fn(services.executeTool), model = vi.fn(services.prepareModel)
      services.executeTool = execute; services.prepareModel = model
      const host = h.host(), handle = host.recoverRun(h.identity.threadId, instance(services))!
      expect(host.recoverRun(h.identity.threadId, instance(services))).toBeUndefined()
      expect((await handle.completed).status).toBe('completed'); await handle.drained
      expect(execute).not.toHaveBeenCalled(); expect(model).toHaveBeenCalledOnce()
      expect(h.events.filter(event => event.type === 'run_started')).toMatchObject([{ newUserTurn: false }])
      expect(h.db.messages.activities.getToolActivity(h.identity.runId, requested.id)).toMatchObject({ output: 'Durable result', status: 'completed' })
      expect(h.db.runs.store.readHistory(h.identity.threadId)?.messages.map(message => message.id)).toEqual(['input', 'calling', 'saved-result', 'answer'])
    } finally { await h.close() }
  })

  it('rolls durable result and activity publication back together and drops transient completion on reopen', async () => {
    const h = fixture()
    try {
      await h.db.runs.enter('input', h.identity)
      const requested = call('lookup'); h.model([requested])
      h.db.runs.store.prepareTools(h.scope(), [{ callId: requested.id, args: requested.args }])
      h.db.messages.observations.recordTool(h.identity.runId, requested, 'completed', undefined, 'Transient output')
      h.sql(raw => raw.exec("CREATE TRIGGER fail_result BEFORE INSERT ON agent_message_payloads WHEN NEW.message_id='result' BEGIN SELECT RAISE(ABORT,'publication failed'); END"))
      expect(() => h.db.runs.store.settleCall(h.identity, requested.id,
        { id: 'result', value: { kind: 'tool', resultFor: requested.id, content: 'Uncommitted output' } })).toThrow('publication failed')
      expect(h.db.messages.activities.getToolActivity(h.identity.runId, requested.id)?.output).toBe('Transient output')
      h.sql(raw => { expect(raw.prepare("SELECT * FROM execution_message_bodies WHERE message_id='result'").all()).toEqual([]); raw.exec('DROP TRIGGER fail_result') })
      await h.reopen(); h.db.recover()
      expect(h.db.runs.store.load(h.identity.threadId)!.calls[0].result).toBeUndefined()
      expect(h.db.readSnapshot(h.identity.threadId).activities[0].tools).toEqual([expect.objectContaining({
        call: expect.objectContaining({ id: requested.id }), status: 'running', output: undefined, completedAt: undefined
      })])
      expect(h.db.runs.store.readHistory(h.identity.threadId)?.messages.map(message => message.id)).toEqual(['input', 'calling'])
    } finally { await h.close() }
  })

  it('retains both saved approval decisions through a failed consume and applies them exactly once after reopening', async () => {
    const h = fixture()
    try {
      await h.db.runs.enter('input', h.identity)
      const calls = [call('left'), call('right')]; h.model(calls)
      h.db.runs.store.prepareTools(h.scope(), calls.map(call => ({ callId: call.id, args: call.args, authorization: { approval: 'pending' as const } })),
        calls.map(call => ({ id: call.id, generation: call.id + '-generation', kind: 'tool' as const, callIds: [call.id], request: {
          actionRequests: [{ name: call.name, args: call.args, description: 'Confirm' }], reviewConfigs: [{ actionName: call.name, allowedDecisions: ['approve', 'reject'] }] } })))
      h.db.runs.saveAnswers(h.scope(), calls.map((call, index) => ({ id: call.id, generation: call.id + '-generation',
        response: { decisions: [index ? { type: 'reject', message: 'Skip right' } : { type: 'approve' }] } })))
      h.sql(raw => raw.exec("CREATE TRIGGER fail_consume BEFORE DELETE ON agent_run_resume_intents BEGIN SELECT RAISE(ABORT,'consume failed'); END"))
      await expect(h.db.runs.enter('resume', h.identity)).rejects.toThrow('consume failed')
      expect(h.db.runs.store.load(h.identity.threadId)!.phase).toBe('waiting')
      h.sql(raw => raw.exec('DROP TRIGGER fail_consume')); await h.reopen()
      expect(h.db.recover()).toEqual([{ ...h.identity, command: 'resume' }])
      await h.db.runs.enter('resume', h.identity)
      const resumed = h.db.runs.store.load(h.identity.threadId)!
      expect(resumed.calls[0].result?.value.content).toContain('Another action in this batch was rejected')
      expect(resumed.calls[1].result?.value.content).toBe('Skip right')
      expect(resumed.calls.every(call => call.authorization?.approval !== 'granted')).toBe(true)
      await h.reopen(); await h.db.runs.enter('resume', h.identity)
      expect(h.db.runs.store.load(h.identity.threadId)).toEqual(resumed)
      h.sql(raw => expect(raw.prepare('SELECT * FROM agent_run_resume_intents').all()).toEqual([]))
    } finally { await h.close() }
  })

  it('keeps committed manual compression terminal on restart without regenerating its summary or calling the model', async () => {
    const h = fixture()
    try {
      await h.db.runs.enter('input', h.identity); h.complete()
      const compression = { threadId: h.identity.threadId, runId: randomUUID() }
      h.db.runs.createRun({ ...compression, operation: 'compression' }); await h.db.runs.enter('input', compression)
      const staged = h.db.summaries.recordContextSummaryStarted(compression.runId)
      const summary = { id: staged.id, summaryText: 'Saved summary', modelContent: 'Summary for model', cutoffIndex: 1,
        activatedAfterMessageIndex: 1, coveredThroughMessageId: 'input', inputTokensBefore: 80, inputTokensAfter: 30 }
      h.db.summaries.stageContextSummary(compression.runId, staged.id, summary)
      h.db.runs.store.commitSummary({ ...compression, expectedRevisionId: h.db.runs.store.load(compression.threadId)!.revisionId }, summary, { completeRun: true })
      await h.reopen(); expect(h.db.recover()).toEqual([])
      const create = vi.fn(instance(h.services()))
      expect(h.host().recoverRun(compression.threadId, create)).toBeUndefined(); expect(create).not.toHaveBeenCalled()
      expect(h.db.readModel.getRun(compression.runId)).toMatchObject({ operation: 'compression', status: 'completed' })
      expect(h.db.summaries.getCommittedContextSummary(compression.runId, staged.id)).toMatchObject({ status: 'completed', summaryText: 'Saved summary' })
      const retained = h.db.runs.store.load(compression.threadId)!.context.summary!
      expect(h.db.runs.store.readMessageRecord(compression.threadId, retained.messageRecordId).value.content).toBe('Summary for model')
    } finally { await h.close() }
  })

  it.each([false, true])('drains startup file cleanup and retries persisted failures after history deletion=%s', async deleted => {
    const h = fixture()
    try {
      await h.db.runs.enter('input', h.identity); h.complete()
      if (deleted) {
        h.db.history.commit(h.db.history.prepare({ threadId: h.identity.threadId, messageId: 'input', kind: 'truncate' }))
        expect(h.db.readModel.getRun(h.identity.runId)).toBeNull()
      }
      await h.reopen()
      const clean = vi.spyOn(h.fileEdits, 'deleteFileEditRecordsForRequest')
      if (deleted) {
        clean.mockRejectedValue(new Error('File system temporarily unavailable'))
        const failing = h.host(true) as NativeAgentRuntime; await failing.waitForStartupCleanup(); await failing.shutdown()
        expect(h.db.resourceCleanup.listFileEditCleanupRunIds()).toEqual([h.identity.runId])
        expect(runtimeLog).toHaveBeenCalledWith('warn', 'agent', 'Failed to clean file edit records.', { runId: h.identity.runId, error: 'File system temporarily unavailable' })
        await h.reopen(); clean.mockRestore()
      }
      const successful = vi.spyOn(h.fileEdits, 'deleteFileEditRecordsForRequest')
      const runtime = h.host(true) as NativeAgentRuntime; await runtime.waitForStartupCleanup(); await runtime.shutdown()
      expect(successful).toHaveBeenCalledWith(h.identity.runId, undefined)
      expect(h.db.resourceCleanup.listFileEditCleanupRunIds()).toEqual([])
      expect(h.events.some(event => event.type === 'run_started')).toBe(false)
    } finally { await h.close() }
  })
})

it.each(['selection', 'changed'].flatMap(kind => [false, true].map(wrapped => ({ kind, wrapped }))))('ends accepted recovery on $kind model errors (wrapped=$wrapped) while retaining saved work', async ({ kind, wrapped }) => {
  const h = fixture()
  try {
    await h.db.runs.enter('input', h.identity)
    const requested = call('saved'); h.model([requested])
    h.db.runs.store.prepareTools(h.scope(), [{ callId: requested.id, args: requested.args }])
    h.db.runs.store.settleCall(h.identity, requested.id, { id: 'saved-result', value: { kind: 'tool', resultFor: requested.id, content: 'External operation completed' } })
    await h.reopen()
    const error = kind === 'selection' ? new ModelSelectionError('The selected model no longer exists.') : new ModelRequestChangedError()
    const host = h.host(), handle = host.recoverRun(h.identity.threadId, async () => { throw wrapped ? new Error(error.message, { cause: error }) : error })!
    expect((await handle.completed).status).toBe('failed'); await handle.drained
    expect(h.events.find(event => event.type === 'run_failed')).toMatchObject({ run: { id: h.identity.runId }, error: error.message })
    expect(host.recoverRun(h.identity.threadId, async () => { throw new Error('Must not restart terminal work') })).toBeUndefined()
    expect(h.db.runs.store.readHistory(h.identity.threadId)?.messages.map(message => message.id)).toEqual(['input', 'calling', 'saved-result'])
    await h.reopen()
    expect(h.db.recover()).toEqual([])
    const next = { ...h.identity, runId: randomUUID() }, id = `${next.runId}:input`
    h.db.runs.createRun({ ...next, operation: 'agent', message: { id, value: { id, kind: 'user', content: 'Continue with a valid model', context: { runId: next.runId } } } })
    const services = h.services(), execute = vi.fn(services.executeTool); services.executeTool = execute
    const continued = h.host().start(next, 'input', instance(services))
    expect((await continued.completed).status).toBe('completed'); await continued.drained
    expect(execute).not.toHaveBeenCalled()
    expect(h.db.runs.store.readHistory(next.threadId)?.messages.filter(message => message.value.kind === 'tool').map(message => message.value.content)).toEqual(['External operation completed'])
  } finally { await h.close() }
})

it.each([false, true].flatMap(codingMode => [false, true].map(cancel => ({ codingMode, cancel }))))('retains coding mode $codingMode after temporary assembly failure (cancel=$cancel)', async ({ codingMode, cancel }) => {
  const h = fixture()
  try {
    h.db.runs.resolveRunConfiguration(h.identity, { customTools: [], codingMode, capabilities: structuredClone(defaultCapabilities) })
    await h.db.runs.enter('input', h.identity)
    const original = h.db.runs.store.load(h.identity.threadId), saved = h.db.runs.getRunConfiguration(h.identity)
    await h.reopen()
    const host = h.host(), create = vi.fn(async () => { throw new Error('Temporary configuration read failure') })
    const failed = host.recoverRun(h.identity.threadId, create)!
    expect(host.recoverRun(h.identity.threadId, create)).toBeUndefined()
    expect((await failed.completed).status).toBe('running'); await failed.drained
    expect(h.events.find(event => event.type === 'run_recovery_failed')).toMatchObject({ run: { id: h.identity.runId }, error: 'Temporary configuration read failure' })
    expect(h.db.runs.store.load(h.identity.threadId)).toEqual(original)
    expect(() => h.db.runs.resolveRunConfiguration(h.identity, { customTools: [], codingMode: !codingMode, capabilities: structuredClone(defaultCapabilities) })).toThrow('already fixed')
    expect(h.db.runs.getRunConfiguration(h.identity)).toEqual(saved)
    await h.reopen()
    if (cancel) {
      const cancelling = h.host()
      expect(cancelling.cancel(h.identity)).toBe(true)
      await cancelling.waitForIdle()
      expect(h.db.readModel.getRun(h.identity.runId)?.status).toBe('cancelled')
      expect(h.db.runs.store.readHistory(h.identity.threadId)?.messages.map(message => message.id)).toEqual(['input'])
      expect(h.events.some(event => event.type === 'run_cancelled')).toBe(true)
      expect(h.db.resourceCleanup.listFileEditCleanupRunIds()).toEqual([])
      expect(h.db.recover()).toEqual([])
      return
    }
    const services = h.services(), model = vi.fn(services.prepareModel); services.prepareModel = model
    const retried = h.host().recoverRun(h.identity.threadId, instance(services))!
    expect((await retried.completed).status).toBe('completed'); await retried.drained
    expect(model).toHaveBeenCalledOnce()
    expect(h.db.runs.getRunConfiguration(h.identity)?.codingMode).toBe(codingMode)
    expect(h.events.filter(event => event.type === 'run_started')).toMatchObject([{ newUserTurn: false }])
    expect(h.db.runs.store.readHistory(h.identity.threadId)?.messages.filter(message => message.value.kind === 'user')).toHaveLength(1)
  } finally { await h.close() }
})

it.each(['completed', 'cancelled', 'commit failure', 'snapshot failure'] as const)('preserves manual compression staging and durable publication through %s', async outcome => {
  const h = fixture()
  let release!: () => void, markStaged!: () => void, summaryId = ''
  const gate = new Promise<void>(resolve => { release = resolve }), staged = new Promise<void>(resolve => { markStaged = resolve })
  try {
    await h.db.runs.enter('input', h.identity); h.complete()
    const messages = h.db.readSnapshot(h.identity.threadId).messages, before = h.db.runs.store.readHistory(h.identity.threadId)!
    const host = h.host(), runId = randomUUID()
    const summary = { summaryText: 'Generated summary', modelContent: 'Summary model content', cutoffIndex: 1,
      activatedAfterMessageIndex: 1, coveredThroughMessageId: 'input', firstPreservedMessageId: 'answer', inputTokensBefore: 80, inputTokensAfter: 30 }
    const { handle } = await host.startCompression(h.identity.threadId, async context => {
      const services = h.services()
      services.prepareModel = async () => {
        summaryId = context.onCompressionStart!()!
        context.onCompressionCompleted!(summaryId, summary.summaryText, summary)
        markStaged(); await gate
        return { kind: 'manual_summary', summary: { ...summary, id: summaryId } }
      }
      return { execution: conversationExecution(services), dispose: async () => {} }
    }, runId)
    await staged
    for (let read = 0; read < 2; read++) {
      const snapshot = host.readSnapshot(h.identity.threadId)
      expect(snapshot.messages).toEqual(messages)
      expect(snapshot.activities.find(activity => activity.runId === runId)?.summaries).toMatchObject([{ id: summaryId, status: 'running' }])
      expect(h.db.summaries.getCommittedContextSummary(runId, summaryId)).toBeUndefined()
      expect(h.db.runs.store.readHistory(h.identity.threadId)?.context.summary).toEqual(before.context.summary)
    }
    if (outcome === 'cancelled') host.cancel({ threadId: h.identity.threadId, runId })
    if (outcome === 'commit failure') h.sql(raw => raw.exec("CREATE TRIGGER reject_summary_commit BEFORE UPDATE ON execution_state WHEN NEW.phase='completed' BEGIN SELECT RAISE(ABORT,'Summary commit failed'); END"))
    const snapshotRead = outcome === 'snapshot failure' ? vi.spyOn(host, 'readSnapshot').mockImplementation(() => { throw new Error('Snapshot unavailable') }) : undefined
    release()
    const status = outcome === 'cancelled' ? 'cancelled' : outcome === 'commit failure' ? 'failed' : 'completed'
    expect((await handle.completed).status).toBe(status); await handle.drained
    snapshotRead?.mockRestore()
    if (outcome === 'commit failure') h.sql(raw => raw.exec('DROP TRIGGER reject_summary_commit'))
    expect(h.events.find(event => event.type === 'run_started' && event.run.id === runId)).toMatchObject({ newUserTurn: false, run: { operation: 'compression' } })
    expect(h.events.filter(event => event.type === 'context_compression_completed')).toHaveLength(status === 'completed' ? 1 : 0)
    if (outcome === 'snapshot failure') expect(h.events.find(event => event.type === 'run_completed')).toMatchObject({ snapshot: undefined })
    await h.reopen()
    expect(h.db.readSnapshot(h.identity.threadId).messages).toEqual(messages)
    expect(h.db.runs.store.readHistory(h.identity.threadId)?.context.summary?.id).toBe(status === 'completed' ? summaryId : undefined)
    expect(h.db.messages.activities.getRunActivity(runId)?.summaries ?? []).toEqual(status === 'completed' ? [expect.objectContaining({ id: summaryId, status: 'completed' })] : [])
    expect(h.db.getThread(h.identity.threadId)?.userTurnCount).toBe(1)
  } finally { release(); await h.close() }
})
