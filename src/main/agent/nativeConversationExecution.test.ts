import { requireObjectToolCall } from '../../runtime/toolInput'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { conversationExecution, type ConversationExecutionServices, type ConversationModelResult } from '../../runtime/conversationExecution'
import type { ExecutionState, ExecutionToolCall } from '../../runtime/executionState'
import type { RunObserver } from '../../runtime/runExecution'
import { ModelRequestChangedError } from '../../runtime/errors'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { NativeExecutionStore, nativeExecutionSchema, type NativeExecutionCommit } from './nativeExecutionStore'

const databases: Database.Database[] = []
afterEach(() => { for (const database of databases.splice(0)) database.close() })
const request = (signal = new AbortController().signal) => ({ threadId: 'thread', runId: 'run', signal })
function call(id: string): ExecutionToolCall {
  return { id, name: 'fixture', providerCallId: `provider:${id}`, args: { limit: 0 },
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `${id}:${purpose}`])) as ExecutionToolCall['artifacts'] }
}
function modelResult(state: ExecutionState, calls: ExecutionToolCall[] = []): ConversationModelResult {
  const count = state.context.modelCalls + 1
  return { message: { id: `model-${count}`, value: { kind: 'assistant', content: calls.length ? '' : 'done',
    calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, calls,
    context: { ...state.context, modelCalls: count } }
}
function harness(onCommit?: (commit: NativeExecutionCommit) => void) {
  const database = new Database(':memory:')
  databases.push(database)
  database.pragma('foreign_keys = ON')
  database.exec(nativeExecutionSchema)
  const store = new NativeExecutionStore(database, onCommit)
  const observer: RunObserver = { started: vi.fn(), startModel: vi.fn(() => 'model'), discardModel: vi.fn(), model: vi.fn(),
    tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
  const services: ConversationExecutionServices = {
    store, enter: async command => {
      if (command === 'input') store.start({ threadId: 'thread', runId: 'run', messages: [{ id: 'input', value: { kind: 'user', content: 'start' } }], context: { modelCalls: 0, todos: [] } })
    },
    prepareModel: async state => ({ kind: 'model', invoke: async () => modelResult(state) }),
    afterModel: async () => ({ kind: 'complete' }),
    prepareTools: async state => ({ calls: state.calls.filter(call => !call.result && !call.prepared).map(call => ({ callId: call.id, args: call.args })) }),
    executeTool: async call => ({ kind: 'result', message: { id: `${call.id}:result`, value: {
      kind: 'tool', resultFor: call.providerCallId ?? call.id, content: 'result'
    } } }), directions: async () => [], drain: vi.fn(async () => {}), retry: { maxRetries: 0, initialDelayMs: 0 }
  }
  return { database, store, services, observer }
}
const scope = (state: ExecutionState) => ({ threadId: state.threadId, runId: state.runId, expectedRevisionId: state.revisionId })
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('native conversation execution with the owning SQLite store', () => {
  it('waits for commit observation to drain without making its mutable view authoritative', async () => {
    const { store, services, observer } = harness(), release = deferred()
    let finished = false
    observer.committed = vi.fn(async commit => {
      await release.promise
      commit.messageIds.splice(0)
    })
    const task = conversationExecution(services).execute('input', request(), observer).finally(() => { finished = true })
    try {
      await vi.waitFor(() => expect(store.load('thread')?.phase).toBe('completed'))
      expect(finished).toBe(false)
      release.resolve()
      expect((await task).result.status).toBe('fulfilled')
      expect(observer.committed).toHaveBeenCalledTimes(3)
      expect(store.load('thread')!.messages.map(record => record.id)).toEqual(['input', 'model-1'])
    } finally { release.resolve(); await task }
  })

  it.each(['model', 'drain', 'both'] as const)('records the %s failure after draining, independently of observer errors', async stage => {
    const commits: NativeExecutionCommit[] = [], { services, observer } = harness(commit => commits.push(commit))
    let drained = false
    if (stage !== 'drain') services.prepareModel = async () => { throw new Error('Model failed') }
    services.drain = async () => { drained = true; if (stage !== 'model') throw { detail: 'Drain failed', code: 0 } }
    observer.committed = async () => { throw new Error('Observer failed') }
    const finish = services.store.finish.bind(services.store)
    services.store.finish = (...args) => { expect(drained).toBe(true); return finish(...args) }
    const result = await conversationExecution(services).execute('input', request(), observer)
    expect(result.result.status).toBe('rejected')
    expect(commits.at(-1)).toMatchObject({ phase: 'failed', error: stage === 'drain' ? '{"detail":"Drain failed","code":0}' : 'Model failed' })
    expect(result.observationErrors).toContainEqual(new Error('Observer failed'))
  })

  it.each([false, true])('waits during tool preflight and handles cancellation=%s without dispatching early', async cancel => {
    const { store, services, observer } = harness()
    const rules = { runId: 'run', roots: [], trustedFolders: [], documents: [], directories: [], initialScopes: [], activeScopes: [],
      blockedCalls: [], rejectedCalls: [], checkedWrites: [], blockedReason: '', fatalError: '' }
    const invoke = vi.fn(async (state: ExecutionState) => modelResult(state, state.context.modelCalls ? [] : [call('read')]))
    services.prepareModel = async state => ({ kind: 'model', invoke: () => invoke(state) })
    const ordinary = services.prepareTools
    services.prepareTools = async (state, request) => state.context.rulePreparation?.reads.length ? ordinary(state, request) : {
      kind: 'wait', context: { ...state.context, projectRules: rules, rulePreparation: { runId: 'run', initialized: true, reads: [] } },
      approval: { id: 'rule-read', generation: 'first', kind: 'context_read', callIds: [], path: '/fixture/AGENTS.md', resumePhase: 'tools',
        request: { actionRequests: [{ name: 'read_file', args: { path: '/fixture/AGENTS.md' }, description: 'Read rules' }],
          reviewConfigs: [{ actionName: 'read_file', allowedDecisions: ['approve', 'reject'] }] } }
    }
    services.executeTool = vi.fn(services.executeTool)
    const execution = conversationExecution(services)
    expect((await execution.execute('input', request(), observer)).interrupted).toBe(true)
    const waiting = store.load('thread')!
    expect(waiting.phase).toBe('waiting_context')
    expect(waiting.calls).toHaveLength(1)
    expect(services.executeTool).not.toHaveBeenCalled()
    expect(invoke).toHaveBeenCalledOnce()
    if (cancel) {
      const abort = new AbortController(); abort.abort(new Error('cancelled while reading rules'))
      expect((await execution.execute('continue', request(abort.signal), observer)).result.status).toBe('rejected')
      expect(store.load('thread')!.phase).toBe('cancelled')
      expect(services.executeTool).not.toHaveBeenCalled()
      expect(store.load('thread')!.messages).toHaveLength(2)
    } else {
      store.resolveContextWait(scope(waiting), 'rule-read', 'first', 'approve')
      expect((await execution.execute('continue', request(), observer)).result.status).toBe('fulfilled')
      expect(services.executeTool).toHaveBeenCalledOnce()
      expect(invoke).toHaveBeenCalledTimes(2)
      expect(store.load('thread')!.phase).toBe('completed')
    }
  })

  it('executes one tool batch, appends queued directions and continues the same conversation', async () => {
    const { store, services, observer } = harness()
    const histories: string[][] = []
    const directions = vi.fn(async (state: ExecutionState) => {
      expect(state.calls.map(call => call.providerCallId)).toEqual(['provider:left', 'provider:right'])
      expect(state.calls.every(call => call.result !== undefined)).toBe(true)
      return [{ id: 'direction', value: { kind: 'user' as const, content: 'keep going' } }]
    })
    services.directions = directions
    services.prepareModel = async state => {
      histories.push(state.messages.map(message => message.id))
      expect(directions).toHaveBeenCalledTimes(state.context.modelCalls ? 1 : 0)
      return { kind: 'model', invoke: async () => modelResult(state, state.context.modelCalls ? [] : [call('left'), call('right')]) }
    }
    const result = await conversationExecution(services).execute('input', request(), observer)
    expect(result.result.status).toBe('fulfilled')
    expect(result.interrupted).toBe(false)
    expect(histories).toEqual([['input'], ['input', 'model-1', 'left:result', 'right:result', 'direction']])
    expect(store.load('thread')).toMatchObject({ phase: 'completed', context: { modelCalls: 2 }, calls: [] })
    expect(observer.committed).toHaveBeenLastCalledWith(expect.objectContaining({ messageIds: [...histories[1], 'model-2'] }))
    expect(services.drain).toHaveBeenCalledOnce()
    expect(directions).toHaveBeenCalledOnce()
  })

  it('resumes a saved answer with the completion check, without another model request', async () => {
    const { store, services, observer } = harness()
    await services.enter('input', request())
    const state = store.load('thread')!, result = modelResult(state)
    store.acceptModel(scope(state), result.message, [], result.context)
    services.prepareModel = vi.fn(async () => { throw new Error('must not repeat model') })
    const executed = await conversationExecution(services).execute('continue', request(), observer)
    expect(executed.result.status).toBe('fulfilled')
    expect(services.prepareModel).not.toHaveBeenCalled()
    expect(store.load('thread')!.phase).toBe('completed')
    const abort = new AbortController()
    abort.abort(new Error('late cancellation'))
    expect((await conversationExecution(services).execute('continue', request(abort.signal), observer)).result.status).toBe('fulfilled')
  })

  it('persists a waiting call and its completed sibling, then resumes only the unanswered call', async () => {
    const { store, services, observer } = harness()
    services.prepareModel = async state => ({ kind: 'model', invoke: async () => modelResult(state, state.context.modelCalls ? [] : [call('left'), call('right')]) })
    const normalTool = services.executeTool, invoked: string[] = []
    let resumed = false
    services.executeTool = async (call, ...args) => {
      invoked.push(call.id)
      if (call.id === 'left' && !resumed) return { kind: 'wait', approval: { id: 'approval', generation: 'generation',
        kind: 'effect_recovery', callIds: ['left'], request: {
          actionRequests: [{ name: 'fixture', args: requireObjectToolCall(call).args, description: 'uncertain' }],
          reviewConfigs: [{ actionName: 'fixture', allowedDecisions: ['approve', 'reject'] }]
        } } }
      return normalTool(call, ...args)
    }
    const execution = conversationExecution(services)
    expect((await execution.execute('input', request(), observer)).interrupted).toBe(true)
    const waiting = store.load('thread')!
    expect(waiting.calls[1].result!.id).toBe('right:result')
    services.enter = async command => {
      expect(command).toBe('resume')
      store.resolveWait(scope(store.load('thread')!), { approval: 'generation' }, () => { resumed = true })
    }
    expect((await execution.execute('resume', request(), observer)).result.status).toBe('fulfilled')
    expect(invoked).toEqual(['left', 'right', 'left'])
    expect(store.load('thread')!.messages.map(message => message.id)).toEqual(['input', 'model-1', 'left:result', 'right:result', 'model-2'])
  })

  it('waits for entered siblings and cleanup before persisting cancellation', async () => {
    let drained = false
    const { store, services, observer } = harness(commit => {
      if (commit.phase === 'cancelled') { expect(drained).toBe(true); expect(commit.error).toBeUndefined() }
    })
    const started = deferred(), finishSibling = deferred(), abort = new AbortController()
    const normalTool = services.executeTool
    services.prepareModel = async state => ({ kind: 'model', invoke: async () => modelResult(state, [call('left'), call('right')]) })
    services.executeTool = async (call, ...args) => {
      if (call.id === 'left') { started.resolve(); await finishSibling.promise; return normalTool(call, ...args) }
      throw new Error('sibling failed')
    }
    services.drain = async () => { drained = true }
    const pending = conversationExecution(services).execute('input', request(abort.signal), observer)
    await started.promise
    abort.abort(new Error('cancel'))
    expect(store.load('thread')!.phase).toBe('tools')
    expect(drained).toBe(false)
    finishSibling.resolve()
    expect((await pending).result.status).toBe('rejected')
    expect(store.load('thread')).toMatchObject({ phase: 'cancelled', calls: [] })
    expect(store.load('thread')!.messages.at(-1)!.id).toBe('left:result')
  })

  it('reprepares on configuration changes but never retries a failed durable response commit', async () => {
    let failCommit = false
    const { store, services, observer } = harness(commit => {
      if (failCommit && commit.phase === 'model_result') throw new Error('commit failed')
    })
    let prepared = 0, invoked = 0
    services.retry = { maxRetries: 2, initialDelayMs: 0 }
    services.prepareModel = async state => {
      prepared++
      if (prepared === 1) throw new ModelRequestChangedError()
      return { kind: 'model', invoke: async () => { invoked++; failCommit = true; return modelResult(state) } }
    }
    const result = await conversationExecution(services).execute('input', request(), observer)
    expect(result.result).toMatchObject({ status: 'rejected', reason: new Error('commit failed') })
    expect(prepared).toBe(2)
    expect(invoked).toBe(1)
    expect(store.load('thread')!.messages.map(message => message.id)).toEqual(['input'])
    expect(store.load('thread')!.phase).toBe('failed')
  })

  it('completes manual compression without a normal model turn', async () => {
    const { store, services, observer } = harness()
    services.prepareModel = async () => ({ kind: 'manual_summary', invoke: async () => ({ id: 'summary', summaryText: 'visible', modelContent: 'retained',
      cutoffIndex: 1, activatedAfterMessageIndex: 0, inputTokensBefore: 30, inputTokensAfter: 10 }) })
    services.afterModel = vi.fn(async () => { throw new Error('must not run after-model logic') })
    expect((await conversationExecution(services).execute('input', request(), observer)).result.status).toBe('fulfilled')
    expect(services.afterModel).not.toHaveBeenCalled()
    expect(store.load('thread')).toMatchObject({ phase: 'completed', context: { modelCalls: 0, summary: { id: 'summary' } } })
    expect(store.load('thread')!.messages.map(message => message.id)).toEqual(['input'])
  })

  it('keeps observer failures separate from durable completion and continues observing later commits', async () => {
    const { store, services, observer } = harness()
    observer.started = () => { throw new Error('start display failed') }
    observer.model = () => { throw new Error('model display failed') }
    observer.committed = vi.fn(async () => { throw new Error('commit display failed') })
    services.prepareModel = async (state, _request, observe) => ({ kind: 'model', invoke: async () => {
      for (let index = 0; index < 5; index++) observe.model({ kind: 'delta', modelId: 'model', channel: 'text', text: 'x' })
      return modelResult(state)
    } })
    const result = await conversationExecution(services).execute('input', request(), observer)
    expect(result.result.status).toBe('fulfilled')
    expect(result.observationErrors).toHaveLength(3)
    expect(observer.committed).toHaveBeenCalledTimes(3)
    expect(store.load('thread')!.phase).toBe('completed')
  })

  it('rejects concurrent execution while keeping the original invocation alive', async () => {
    const { services, observer } = harness(), started = deferred(), release = deferred()
    services.prepareModel = async state => { started.resolve(); await release.promise; return { kind: 'model', invoke: async () => modelResult(state) } }
    const execution = conversationExecution(services), first = execution.execute('input', request(), observer)
    await started.promise
    expect((await execution.execute('continue', request(), observer)).result).toMatchObject({ status: 'rejected', reason: new Error('This conversation executor is already running.') })
    release.resolve()
    expect((await first).result.status).toBe('fulfilled')
  })

  it('exposes a committed planning update to the next model preparation', async () => {
    const { services, observer } = harness()
    const todos = [{ content: 'Continue implementation', status: 'in_progress' as const }]
    const normalTool = services.executeTool
    services.prepareModel = async state => {
      if (state.context.modelCalls) expect(state.context.todos).toEqual(todos)
      return { kind: 'model', invoke: async () => modelResult(state, state.context.modelCalls ? [] : [call('plan')]) }
    }
    services.executeTool = async (...args) => ({ ...await normalTool(...args), update: { todos } })
    expect((await conversationExecution(services).execute('input', request(), observer)).result.status).toBe('fulfilled')
  })

  it('does not terminate an existing run when accepting another input is refused', async () => {
    const { services, store, observer } = harness()
    await services.enter('input', request())
    const original = store.load('thread')
    expect((await conversationExecution(services).execute('input', request(), observer)).result.status).toBe('rejected')
    expect(store.load('thread')).toEqual(original)
  })
})
