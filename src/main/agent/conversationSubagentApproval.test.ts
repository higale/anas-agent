import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultCapabilities } from '@shared/agentCapabilities'
import type { ExecutionState, ExecutionToolCall } from '../../runtime/executionState'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import type { RunObserver } from '../../runtime/runExecution'
import type { ToolDefinition } from '../../runtime/toolDefinition'
import { toolResultMessage } from '../../runtime/toolResultMessage'
import { ToolRunScope } from '../../runtime/toolEvents'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { subagentToolDefinitions, type SubagentProcessSnapshot, type SubagentToolRuntime } from './subagentTools'
import { createConversationSubagentApproval } from './conversationSubagentApproval'
import { createConversationToolExecutor, resolveConversationToolWaits } from './conversationToolExecution'
import { prepareConversationToolBatch } from './conversationToolPreparation'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'
import { armCurrentAgentToolEffect } from './toolEffectScope'
import { subagentApprovalInterruptMetadata } from '../../runtime/approvalRecovery'

const databases: Database.Database[] = [], roots: string[] = []
afterEach(() => { for (const db of databases.splice(0)) if (db.open) db.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const request = () => ({ threadId: 'parent', runId: 'parent-run', signal: new AbortController().signal })
const scope = (state: ExecutionState) => ({ threadId: state.threadId, runId: state.runId, expectedRevisionId: state.revisionId })
function observer(): RunObserver { return { started: vi.fn(), startModel: vi.fn(() => 'model'), discardModel: vi.fn(),
  model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) } }
function toolCall(id: string, name: string, args: Record<string, unknown>): ExecutionToolCall {
  return { id, name, args, providerCallId: `provider-${id}`,
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
}
function child(generation = 'child-generation-1'): SubagentProcessSnapshot {
  return { call: { id: '11111111-1111-8111-8111-111111111111', ownerThreadId: 'parent', parentThreadId: 'parent', parentRunId: 'parent-run',
    childThreadId: 'child', childRunId: 'child-run', agentName: 'fixture', description: 'Child task', status: 'interrupted', createdAt: '', updatedAt: '',
    config: { index: 0, name: 'fixture', enabled: true, builtIn: false, description: '', systemPrompt: '', capabilities: structuredClone(defaultCapabilities) } },
    modelRounds: 1, toolCalls: 2, activeTools: [], approvalGeneration: generation,
    interrupts: ['write_file', 'delete_file'].map((name, index) => ({ id: `${generation}:${index}`, approvalGeneration: generation,
      value: { actionRequests: [{ name, args: { path: `file-${index}` }, description: `Approve ${name}` }],
        reviewConfigs: [{ actionName: name, allowedDecisions: ['approve', 'reject'] }] } })) }
}
function fixture(effectfulSibling = false) {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-child-')); roots.push(root)
  const file = join(root, 'state.sqlite'); let db = new Database(file); databases.push(db); db.pragma('foreign_keys=ON'); db.exec(nativeExecutionSchema)
  let release!: () => void
  const paused = new Promise<void>(resolve => { release = resolve })
  let store = new NativeExecutionStore(db, commit => { if (commit.phase === 'waiting') release() }), current = child()
  const resume = vi.fn<SubagentToolRuntime['resume']>(async (_id, decisions) => {
    expect(decisions.map(item => item.expectedGeneration)).toEqual([current.approvalGeneration, current.approvalGeneration])
    current = { ...current, call: { ...current.call, status: 'completed' }, interrupts: [] }
  })
  const runtime: SubagentToolRuntime = { start: vi.fn(async () => current), read: vi.fn(async () => current), wait: vi.fn(async () => current),
    cancel: vi.fn(async () => current), resume, unresolvedForRun: () => [current.call], resolveObserved: vi.fn(), cancelRun: vi.fn(async () => {}) }
  const sibling = vi.fn(async () => {
    if (effectfulSibling) {
      await paused
      expect(store.load('parent')!.phase).toBe('waiting')
      armCurrentAgentToolEffect({ kind: 'fixture', target: { operation: 'sibling' } })
    }
    return { content: 'Independent saved result' }
  })
  const remote = vi.fn(() => {
    armCurrentAgentToolEffect({ kind: 'fixture', target: { operation: 'remote' } })
    throw new Error('Remote result lost')
  })
  const siblingName = effectfulSibling ? 'mcp_sibling' : 'read_file'
  const definitions = (): ToolDefinition[] => [...subagentToolDefinitions({ runtime, subagents: [], requestApproval: createConversationSubagentApproval(store, request()) }),
    { name: siblingName, description: '', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, execute: sibling },
    { name: 'mcp_remote', description: '', inputSchema: { type: 'object', properties: {} }, execute: remote }]
  const operations = new ToolRunScope()
  const preparation = () => ({ runId: 'parent-run', primaryFolder: root, folders: [root], accessMode: () => 'full_access' as const, includeRules: false, definitions: definitions() })
  const executeTool = () => createConversationToolExecutor({ store, operations, planning: false, persistFileChange: vi.fn(), preparation: preparation(),
    definitions: definitions().map(definition => ({ ...definition, async execute(args, context) {
      const call = store.load('parent')!.calls.find(call => call.id === context.callId)!
      return toolResultMessage(await definition.execute(args, context), { name: definition.name, callId: call.providerCallId! })
    } })) })
  const services = (): ConversationExecutionServices => ({ store, enter: async () => {},
    prepareModel: async state => ({ kind: 'model', invoke: async () => ({ message: { id: 'final', value: { kind: 'assistant', content: 'Finished' } }, calls: [], context: state.context }) }),
    afterModel: async () => ({ kind: 'complete' }), prepareTools: state => prepareConversationToolBatch(state, preparation()),
    executeTool: executeTool(), directions: async () => [], drain: () => operations.drain() })
  function begin(withSibling = true, withRemote = false) {
    store.start({ ...request(), messages: [{ id: 'user', value: { kind: 'user', content: 'Delegate' } }], context: { modelCalls: 0, todos: [] } })
    const calls = [toolCall('wait', 'wait_subagent', { subagent_id: current.call.id }),
      ...(withSibling ? [toolCall('read', siblingName, { path: join(root, 'input.txt') })] : []),
      ...(withRemote ? [toolCall('remote', 'mcp_remote', {})] : [])]
    store.acceptModel(scope(store.load('parent')!), { id: 'model', value: { kind: 'assistant', content: '',
      calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
  }
  return { begin, resume, sibling, remote, runtime, executeTool, services, get store() { return store }, get db() { return db },
    setChild(value: SubagentProcessSnapshot) { current = value },
    reopen() { db.close(); db = new Database(file); databases.push(db); db.pragma('foreign_keys=ON'); store = new NativeExecutionStore(db) } }
}

describe('native parent waits for child approval', () => {
  it('resumes one answered child while retaining an unanswered recovery wait across reopen', async () => {
    const h = fixture(true); h.begin(true, true)
    await conversationExecution(h.services()).execute('continue', request(), observer())
    const waiting = h.store.load('parent')!, childApproval = waiting.approvals.find(approval => approval.kind === 'subagent')!
    const answer = [{ id: childApproval.id, generation: childApproval.generation,
      response: { decisions: childApproval.request.actionRequests.map(() => ({ type: 'approve' })) } }]
    expect(() => resolveConversationToolWaits(h.store, scope(waiting), answer, () => { throw new Error('Partial consume failed') })).toThrow('Partial consume failed')
    expect(h.store.load('parent')).toEqual(waiting)
    resolveConversationToolWaits(h.store, scope(waiting), answer)
    h.reopen()
    const first = await conversationExecution(h.services()).execute('continue', request(), observer())
    expect(first.result.status).toBe('fulfilled'); expect(first.interrupted).toBe(true)
    expect(h.resume).toHaveBeenCalledOnce(); expect(h.remote).toHaveBeenCalledOnce(); expect(h.sibling).toHaveBeenCalledOnce()
    const remaining = h.store.load('parent')!
    expect(remaining.approvals).toEqual(waiting.approvals.filter(approval => approval.kind === 'effect_recovery'))
    expect(() => resolveConversationToolWaits(h.store, scope(remaining), answer)).toThrow('generation changed')
    h.reopen()
    await conversationExecution(h.services()).execute('continue', request(), observer())
    expect(h.resume).toHaveBeenCalledOnce()
    const current = h.store.load('parent')!, approval = current.approvals[0]
    resolveConversationToolWaits(h.store, scope(current), [{ id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'reject' }] } }])
    expect((await conversationExecution(h.services()).execute('continue', request(), observer())).result.status).toBe('fulfilled')
    expect(h.store.load('parent')!.phase).toBe('completed')
    expect(h.remote).toHaveBeenCalledOnce(); expect(h.resume).toHaveBeenCalledOnce()
  })

  it('keeps mixed child and uncertain-effect decisions atomic while an authorized sibling finishes', async () => {
    const h = fixture(true); h.begin(true, true)
    expect((await conversationExecution(h.services()).execute('continue', request(), observer())).interrupted).toBe(true)
    const waiting = h.store.load('parent')!
    expect(waiting.approvals.map(approval => approval.kind).sort()).toEqual(['effect_recovery', 'subagent'])
    expect(waiting.calls[1].result?.value.content).toBe('Independent saved result')
    const answers = waiting.approvals.map(approval => ({ id: approval.id, generation: approval.generation,
      response: { decisions: approval.request.actionRequests.map(() => ({ type: approval.kind === 'subagent' ? 'approve' : 'reject' })) } }))
    expect(() => resolveConversationToolWaits(h.store, scope(waiting), answers, () => { throw new Error('Consume failed') })).toThrow('Consume failed')
    expect(h.store.load('parent')).toEqual(waiting)
    expect(h.store.loadEffect({ ...request(), callId: 'remote' })!.state).toBe('intent')
    resolveConversationToolWaits(h.store, scope(waiting), answers)
    h.reopen()
    expect((await conversationExecution(h.services()).execute('continue', request(), observer())).result.status).toBe('fulfilled')
    expect(h.store.load('parent')!.phase).toBe('completed')
    expect(h.remote).toHaveBeenCalledOnce()
    expect(h.sibling).toHaveBeenCalledOnce()
    expect(h.resume).toHaveBeenCalledOnce()
  })

  it('rejects approval requests from a different parent run, call or child', async () => {
    const h = fixture(); h.begin(false)
    await conversationExecution(h.services()).execute('continue', request(), observer())
    const approval = h.store.load('parent')!.approvals[0]
    const payload = { ...approval.request, ...subagentApprovalInterruptMetadata('child-generation-1') }
    for (const [owner, call] of [
      [{ threadId: 'parent', runId: 'other-run' }, { callId: 'wait', subagentId: child().call.id }],
      [request(), { callId: 'other-call', subagentId: child().call.id }],
      [request(), { callId: 'wait', subagentId: 'other-child' }]
    ] as const) {
      expect(() => createConversationSubagentApproval(h.store, owner)(payload, call)).toThrow('does not belong')
    }
    expect(h.resume).not.toHaveBeenCalled()
  })

  it.each(['approve', 'reject'] as const)('persists %s across restart, resumes the same child, and skips an answered sibling', async type => {
    const h = fixture(); h.begin(); const observed = observer()
    const first = await conversationExecution(h.services()).execute('continue', request(), observed)
    expect(first.interrupted).toBe(true)
    expect(first.result.status).toBe('fulfilled')
    expect(h.resume).not.toHaveBeenCalled()
    expect(observed.tool).not.toHaveBeenCalledWith(expect.objectContaining({ succeeded: false }))
    const waiting = h.store.load('parent')!, approval = waiting.approvals[0]
    expect(approval).toMatchObject({ kind: 'subagent', callIds: ['wait'], childGeneration: 'child-generation-1' })
    expect(approval.request.actionRequests).toHaveLength(2)
    expect(waiting.calls[1].result?.value.content).toBe('Independent saved result')
    h.reopen()
    resolveConversationToolWaits(h.store, scope(h.store.load('parent')!), [{ id: approval.id, generation: approval.generation,
      response: { decisions: [{ type }, { type, ...(type === 'reject' ? { message: 'Leave it alone' } : {}) }] } }])
    expect(h.resume).not.toHaveBeenCalled()
    h.reopen()
    expect((await conversationExecution(h.services()).execute('continue', request(), observer())).result.status).toBe('fulfilled')
    expect(h.resume).toHaveBeenCalledExactlyOnceWith(child().call.id, [
      { interruptId: 'child-generation-1:0', decisions: [{ type }], expectedGeneration: 'child-generation-1' },
      { interruptId: 'child-generation-1:1', decisions: [{ type, ...(type === 'reject' ? { message: 'Leave it alone' } : {}) }], expectedGeneration: 'child-generation-1' }
    ])
    expect(h.sibling).toHaveBeenCalledOnce()
    expect(h.store.load('parent')!.phase).toBe('completed')
  })

  it('rejects incomplete, stale or invalid answers and rolls the answer back with input consumption', async () => {
    const h = fixture(); h.begin(false)
    await conversationExecution(h.services()).execute('continue', request(), observer())
    const waiting = h.store.load('parent')!, approval = waiting.approvals[0]
    const answer = { id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'approve' }, { type: 'reject', message: 'No' }] } }
    for (const invalid of [[], [{ ...answer, generation: 'old' }], [{ ...answer, response: { decisions: [{ type: 'approve' }] } }],
      [{ ...answer, response: { decisions: [{ type: 'approve' }, { type: 'reject', message: 0 }] } }]]) {
      expect(() => resolveConversationToolWaits(h.store, scope(waiting), invalid)).toThrow()
    }
    h.db.exec('CREATE TABLE intent(consumed INTEGER); INSERT INTO intent VALUES(0)')
    expect(() => resolveConversationToolWaits(h.store, scope(waiting), [answer], () => {
      h.db.exec('UPDATE intent SET consumed=1'); throw new Error('Intent transaction failed')
    })).toThrow('Intent transaction failed')
    expect(h.store.load('parent')).toEqual(waiting)
    expect(h.db.prepare('SELECT consumed FROM intent').get()).toEqual({ consumed: 0 })
    resolveConversationToolWaits(h.store, scope(waiting), [answer])
    h.setChild(child('child-generation-2'))
    const next = await conversationExecution(h.services()).execute('continue', request(), observer())
    expect(next.interrupted).toBe(true)
    expect(h.store.load('parent')!.approvals[0]).toMatchObject({ childGeneration: 'child-generation-2' })
    expect(h.resume).not.toHaveBeenCalled()
    expect(() => resolveConversationToolWaits(h.store, scope(h.store.load('parent')!), [answer])).toThrow()
  })

  it('does not resume the child again after child resume succeeded but the parent result was lost', async () => {
    const h = fixture(); h.begin(false)
    await conversationExecution(h.services()).execute('continue', request(), observer())
    const waiting = h.store.load('parent')!, approval = waiting.approvals[0]
    resolveConversationToolWaits(h.store, scope(waiting), [{ id: approval.id, generation: approval.generation,
      response: { decisions: [{ type: 'approve' }, { type: 'approve' }] } }])
    h.resume.mockImplementationOnce(async () => {
      h.setChild({ ...child(), call: { ...child().call, status: 'completed' }, interrupts: [] })
      throw new Error('Parent process lost after child resume')
    })
    const state = h.store.load('parent')!
    await expect(h.executeTool()(state.calls[0], state, request(), observer())).rejects.toThrow('Parent process lost')
    h.reopen()
    expect((await conversationExecution(h.services()).execute('continue', request(), observer())).result.status).toBe('fulfilled')
    expect(h.resume).toHaveBeenCalledOnce()
  })
})
