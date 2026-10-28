import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import type { ExecutionMessageInput, ExecutionToolCall } from '../../runtime/executionState'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { AgentStorage } from './agentStorage'
import { getAgentConversationDatabaseFile } from '../config/dataDir'
import { RunSubmissionStore } from './runSubmissionStore'
import { NativeRunOwner } from './nativeRunOwner'
import { NativeMessageProjection } from './nativeMessageProjection'
import { NativeMessageReader } from './nativeMessageReader'
import { NativeExecutionStore } from './nativeExecutionStore'

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'anas-native-message-projection-'))
  const storage = AgentStorage.openNative(directory), thread = storage.createThread()
  const product = storage.conversationForThread(thread.id), file = getAgentConversationDatabaseFile(thread.id, directory)
  let database = new Database(file); database.pragma('foreign_keys=ON')
  let projection = new NativeMessageProjection(database), owner = new NativeRunOwner(database, commit => projection.commit(commit))
  const run = new RunSubmissionStore(database).createRun(thread.id, 'run')
  const identity = { threadId: thread.id, runId: run.id }
  const input: ExecutionMessageInput = { id: 'input', value: { id: 'input', kind: 'user', content: 'Instruction', context: { runId: run.id } } }
  owner.saveInput(identity, input)
  return { product, identity, get database() { return database }, get submissions() { return new RunSubmissionStore(database) }, get owner() { return owner },
    reader() { return new NativeMessageReader(database) },
    scope() { return { ...identity, expectedRevisionId: owner.store.load(thread.id)!.revisionId } },
    reopen() { database.close(); database = new Database(file); database.pragma('foreign_keys=ON'); projection = new NativeMessageProjection(database); owner = new NativeRunOwner(database, commit => projection.commit(commit)) },
    dispose() { database.close(); storage.close(); rmSync(directory, { recursive: true, force: true }) } }
}
function call(id: string, provider = true): ExecutionToolCall & { args: { path: string } } {
  return { id, ...(provider ? { providerCallId: `provider:${id}` } : {}), name: 'read_file', args: { path: id },
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `${id}:${purpose}`])) as ExecutionToolCall['artifacts'] }
}

describe('native message publication transaction', () => {
  it('displays transport observations until exact durable bodies supersede them, without using the cache as execution evidence', async () => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      const reader = h.reader(), observed = reader.observations, requested = call('read', false)
      observed.recordModel('run', { id: 'stream', messageId: 'response', status: 'completed', text: 'Observed answer', reasoning: 'Observed thought', toolCallIds: [requested.id] })
      observed.recordTool('run', { id: requested.id, name: requested.name, args: { path: 'observed' } }, 'completed', undefined, 'Observed output')
      expect(reader.activities.getModelActivity('run', 'stream')).toMatchObject({ text: 'Observed answer', reasoning: 'Observed thought' })
      expect(reader.activities.getToolActivity('run', requested.id)).toMatchObject({ call: { args: { path: 'observed' } }, output: 'Observed output' })
      expect(reader.rootActivityEvidence('run')).toEqual({ models: [], tools: [] })
      expect(h.product.readSnapshot(h.identity.threadId).activities[0]).toMatchObject({ models: [], tools: [] })
      const response = { id: 'response', value: { kind: 'assistant' as const, content: 'Saved answer', calls: [{ name: requested.name, args: requested.args }] } }
      h.database.exec("CREATE TRIGGER fail_observed_commit BEFORE INSERT ON agent_message_index WHEN NEW.message_id='response' BEGIN SELECT RAISE(ABORT,'observation commit failed'); END")
      expect(() => h.owner.store.acceptModel(h.scope(), response, [requested], { modelCalls: 1, todos: [] })).toThrow('observation commit failed')
      expect(reader.activities.getModelActivity('run', 'stream')?.text).toBe('Observed answer')
      expect(reader.rootActivityEvidence('run')).toEqual({ models: [], tools: [] })
      h.database.exec('DROP TRIGGER fail_observed_commit')
      h.owner.store.acceptModel(h.scope(), response, [requested], { modelCalls: 1, todos: [] })
      h.owner.store.prepareTools(h.scope(), [{ callId: requested.id, args: { path: 'canonical' } }])
      expect(reader.activities.getModelActivity('run', 'stream')).toMatchObject({ text: 'Saved answer', reasoning: '', toolCallIds: [requested.id] })
      expect(reader.activities.getToolActivity('run', requested.id)).toMatchObject({ call: { args: { path: 'canonical' } }, output: 'Observed output' })
      expect(reader.rootActivityEvidence('run').tools).toEqual([])
      expect(h.product.readSnapshot(h.identity.threadId).activities[0].tools).toMatchObject([
        { call: { id: requested.id, args: { path: 'canonical' } }, status: 'running', output: undefined }
      ])
      h.owner.store.settleCall(h.identity, requested.id, { id: 'result', value: { kind: 'tool', resultFor: requested.id, content: 'Saved output' } })
      expect(reader.activities.getToolActivity('run', requested.id)?.output).toBe('Saved output')
      expect(reader.rootActivityEvidence('run').tools).toMatchObject([{ output: 'Saved output' }])
      observed.releaseRun('run')
      expect(reader.activities.getModelActivity('run', 'stream')?.text).toBe('Saved answer')
      expect(reader.activities.getToolActivity('run', requested.id)?.output).toBe('Saved output')
      h.reopen()
      expect(h.reader().activities.getToolActivity('run', requested.id)?.output).toBe('Saved output')
    } finally { h.dispose() }
  })

  it('discards retry observations and releases one run without retaining or leaking its cached payloads', async () => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      const reader = h.reader(), observed = reader.observations
      const thread = h.product.createThread(), other = h.submissions.createRun(thread.id, 'other')
      const model = { id: 'reused', status: 'completed' as const, text: 'Transient', reasoning: '', toolCallIds: [] }
      observed.recordModel('run', model); observed.recordModel(other.id, { ...model, text: 'Other run' })
      expect(observed.discardModel('run', model.id)).toBe(true)
      expect(observed.discardModel('run', model.id)).toBe(false)
      expect(h.database.prepare("SELECT 1 FROM agent_activity_timing WHERE run_id='run' AND activity_key='model:reused'").get()).toBeUndefined()
      observed.recordModel('run', { ...model, status: 'running', text: '' })
      expect(reader.activities.getModelActivity('run', model.id)?.text).toBe('')
      observed.recordModel('run', model)
      observed.recordTool('run', { id: 'tool', name: 'read_file', args: { path: 'temporary' } }, 'completed', undefined, 'Unsaved')
      observed.releaseRun('run')
      expect(reader.activities.getModelActivity('run', model.id)?.text).toBe('')
      expect(reader.activities.getToolActivity('run', 'tool')).toMatchObject({ call: { args: {} } })
      expect(reader.activities.getToolActivity('run', 'tool')?.output).toBeUndefined()
      expect(reader.activities.getModelActivity(other.id, model.id)?.text).toBe('Other run')
      expect(h.reader().activities.getModelActivity(other.id, model.id)?.text).toBe('')
      expect(reader.rootActivityEvidence('run')).toEqual({ models: [], tools: [] })
    } finally { h.dispose() }
  })

  it('rejects activity references reassigned to another run instead of showing that run\'s body', async () => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      h.owner.store.acceptModel(h.scope(), { id: 'response', value: { kind: 'assistant', content: 'Answer' } }, [], { modelCalls: 1, todos: [] })
      const original = h.reader().activities.getRunActivity('run')!
      const childThread = h.product.createThread(), other = h.submissions.createRun(childThread.id, 'other-run')
      h.database.prepare("UPDATE agent_message_payloads SET run_id=? WHERE message_id='response'").run(other.id)
      expect(() => h.reader().activities.getRunActivity('run')).toThrow('belongs to another run')
      expect(() => h.reader().activities.getModelActivity('run', original.models[0].id)).toThrow('belongs to another run')
    } finally { h.dispose() }
  })

  it('retains canonical child progress and restores ancestor metadata without treating observation as completion', async () => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      const config = { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false,
        description: 'Fixture helper', systemPrompt: 'Inspect the fixture' }
      const child = h.owner.createSubagentCall({ id: 'child', ownerThreadId: h.identity.threadId, parentThreadId: h.identity.threadId,
        parentRunId: 'run', childThreadId: 'child-thread', childRunId: 'child-run', config, description: 'Inspect', childThread: { title: 'Child' } })
      const grandchild = h.owner.createSubagentCall({ id: 'grandchild', ownerThreadId: h.identity.threadId, parentThreadId: child.childThreadId,
        parentRunId: child.childRunId, parentSubagentId: child.id, childThreadId: 'grandchild-thread', childRunId: 'grandchild-run',
        config, description: 'Inspect further', childThread: { title: 'Grandchild' } })
      const projection = new NativeMessageProjection(h.database), owner = new NativeRunOwner(h.database, commit => projection.commit(commit))
      const identity = { threadId: child.childThreadId, runId: child.childRunId }
      await owner.enter('input', identity)
      const scope = () => ({ ...identity, expectedRevisionId: owner.store.load(identity.threadId)!.revisionId })
      const calls = [call('saved-child'), call('pending-child')]
      owner.store.acceptModel(scope(), { id: 'child-response', value: { kind: 'assistant', content: 'Child response',
        calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
      owner.store.prepareTools(scope(), calls.map(call => ({ callId: call.id, args: call.args })))
      owner.store.settleCall(identity, calls[0].id, { id: 'child-result', value: { kind: 'tool', resultFor: calls[0].providerCallId!, content: 'Saved child result' } })
      h.product.messages.observations.recordModel('run', { id: 'child-model', messageId: 'child-response', subagentId: child.id, status: 'completed', text: '', reasoning: '', toolCallIds: [] })
      h.product.messages.observations.recordModel('run', { id: 'uncommitted-child-model', messageId: 'missing', subagentId: child.id, status: 'completed', text: 'Observed only', reasoning: '', toolCallIds: [] })
      for (const requested of calls) h.product.messages.observations.recordTool('run', { id: requested.id, name: requested.name, args: requested.args }, 'completed', child.id)
      const childState = owner.store.load(identity.threadId)
      const originalTiming = h.database.prepare("SELECT started_at,completed_at FROM agent_activity_timing WHERE run_id=? AND activity_key='subagent:grandchild'").get(child.childRunId)
      h.database.prepare("DELETE FROM agent_activities WHERE run_id='run' AND activity_key='subagent:grandchild'").run()
      h.database.prepare("DELETE FROM agent_activity_timing WHERE run_id='run' AND activity_key='subagent:grandchild'").run()
      h.database.exec("CREATE TRIGGER fail_ancestor BEFORE INSERT ON agent_activities WHEN NEW.run_id='run' AND NEW.activity_id='grandchild' BEGIN SELECT RAISE(ABORT,'ancestor failed'); END")
      expect(() => h.owner.store.finish(h.scope(), 'cancelled')).toThrow('ancestor failed')
      expect(h.owner.store.load(h.identity.threadId)?.phase).toBe('prepare_model')
      expect(owner.store.load(identity.threadId)).toEqual(childState)
      h.database.exec('DROP TRIGGER fail_ancestor'); h.owner.store.finish(h.scope(), 'cancelled'); h.reopen()
      expect(h.database.prepare("SELECT activity_id FROM agent_activities WHERE run_id='run' AND kind='subagent' ORDER BY sequence").all())
        .toEqual([{ activity_id: child.id }, { activity_id: grandchild.id }])
      expect(h.database.prepare("SELECT started_at,completed_at FROM agent_activity_timing WHERE run_id='run' AND activity_key='subagent:grandchild'").get()).toEqual(originalTiming)
      expect(h.database.prepare("SELECT model_id FROM agent_model_activities WHERE run_id='run'").all()).toEqual([{ model_id: 'child-model' }])
      expect(h.database.prepare("SELECT activity_id,status FROM agent_activities WHERE run_id='run' AND kind='tool' ORDER BY sequence").all())
        .toEqual([{ activity_id: calls[0].id, status: 'completed' }, { activity_id: calls[1].id, status: 'running' }])
      expect(h.database.prepare("SELECT completed_at FROM agent_activity_timing WHERE run_id='run' AND activity_key=?").get(`tool:child:${calls[1].id}`)).toEqual({ completed_at: null })
      expect(new NativeRunOwner(h.database).store.load(identity.threadId)).toEqual(childState)
      expect(h.database.prepare('SELECT status FROM agent_runs WHERE id=?').get(child.childRunId)).toEqual({ status: 'running' })
      const activities = h.reader().activities
      expect(activities.getRunActivity('run')).toMatchObject({
        models: [{ id: 'child-model', text: 'Child response', toolCallIds: calls.map(call => call.id) }],
        tools: [
          { call: { id: calls[0].id, args: calls[0].args }, output: 'Saved child result', status: 'completed' },
          { call: { id: calls[1].id, args: calls[1].args }, status: 'running' }
        ]
      })
      expect(activities.getToolActivity('run', calls[0].id, child.id)?.output).toBe('Saved child result')
      expect(activities.getSubagentActivity('run', grandchild.id)?.parentSubagentId).toBe(child.id)
    } finally { h.dispose() }
  })

  it.each([
    { outcome: 'completed', paused: false }, { outcome: 'cancelled', paused: false }, { outcome: 'failed', paused: false },
    { outcome: 'cancelled', paused: true }, { outcome: 'failed', paused: true }
  ] as const)('reconciles $outcome from durable results and rolls cleanup back with the terminal commit (paused=$paused)', async ({ outcome, paused }) => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      const calls = outcome === 'completed' ? [call('saved')] : [call('saved'), call('unfinished')]
      h.owner.store.acceptModel(h.scope(), { id: 'response', value: { kind: 'assistant', content: '',
        calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
      h.owner.store.prepareTools(h.scope(), calls.map(call => ({ callId: call.id, args: call.args })))
      h.owner.store.settleCall(h.identity, calls[0].id, { id: 'result', value: { kind: 'tool', resultFor: calls[0].providerCallId!, content: 'Durable result' } })
      if (outcome === 'completed') h.owner.store.finishBatch(h.scope(), [])
      if (paused) h.owner.store.wait(h.scope(), [{ id: 'wait', generation: 'generation', kind: 'tool', callIds: [calls[1].id], request: {
        actionRequests: [{ name: calls[1].name, args: calls[1].args, description: 'Confirm' }],
        reviewConfigs: [{ actionName: calls[1].name, allowedDecisions: ['approve', 'reject'] }]
      } }])
      h.product.messages.observations.recordModel('run', { id: 'uncommitted', messageId: 'missing', status: 'completed', text: 'Partial observer text', reasoning: '', toolCallIds: [] })
      h.product.messages.observations.recordTool('run', { id: 'uncommitted', name: 'read_file', args: {} }, 'completed', undefined, 'Observed only')
      h.product.messages.observations.recordToolApproval('run', 'uncommitted', { status: 'pending_approval', interruptId: 'obsolete', actionIndex: 0 })
      expect(h.product.messages.observations.pendingModel('run', 'uncommitted')?.text).toBe('Partial observer text')
      expect(h.product.messages.observations.pendingTool('run', 'uncommitted')?.output).toBe('Observed only')
      h.product.runs.subagents.activity('run', 'child', 'general-purpose', 'running')
      h.product.messages.observations.recordModel('run', { id: 'child-model', subagentId: 'child', status: 'running', text: '', reasoning: '', toolCallIds: [] })
      h.product.messages.observations.recordTool('run', { id: 'child-tool', name: 'read_file', args: {} }, 'running', 'child')
      const tables = ['agent_model_activities', 'agent_activities', 'agent_activity_timing', 'agent_tool_approvals']
      const rows = () => tables.map(table => h.database.prepare(`SELECT * FROM ${table}`).all())
      const before = rows(), state = h.owner.store.load(h.identity.threadId)
      h.database.exec("CREATE TRIGGER fail_activity_cleanup BEFORE DELETE ON agent_model_activities BEGIN SELECT RAISE(ABORT,'cleanup failed'); END")
      expect(() => h.owner.store.finish(h.scope(), outcome)).toThrow('cleanup failed')
      expect(rows()).toEqual(before); expect(h.owner.store.load(h.identity.threadId)).toEqual(state)
      expect(h.database.prepare("SELECT status FROM agent_runs WHERE id='run'").get()).toEqual({ status: paused ? 'interrupted' : 'running' })
      h.database.exec('DROP TRIGGER fail_activity_cleanup'); h.owner.store.finish(h.scope(), outcome); h.reopen()
      const finalRows = rows()
      expect(h.database.prepare("SELECT model_id FROM agent_model_activities WHERE subagent_id IS NULL").all()).toEqual([{ model_id: 'message:response' }])
      expect(h.database.prepare("SELECT activity_id,status FROM agent_activities WHERE kind='tool' AND parent_subagent_id IS NULL").all())
        .toEqual([{ activity_id: calls[0].id, status: 'completed' }])
      expect(h.database.prepare("SELECT * FROM agent_tool_approvals").all()).toEqual([])
      // Full reconciliation now validates child ownership too. These observed
      // rows have no actual child call or messages, unlike the canonical test.
      expect(h.database.prepare("SELECT status FROM agent_model_activities WHERE model_id='child-model'").get()).toBeUndefined()
      expect(h.database.prepare("SELECT status FROM agent_activities WHERE parent_subagent_id='child'").all()).toEqual([])
      expect(h.reader().rootActivityEvidence('run').tools).toMatchObject([{ output: 'Durable result' }])
      await h.owner.enter('continue', h.identity); expect(rows()).toEqual(finalRows)
    } finally { h.dispose() }
  })

  it('completes existing timeline metadata atomically without changing sequence or start time', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-11T08:50:58.000Z'))
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      const streaming = h.product.messages.observations.recordModel('run', { id: 'streaming', status: 'running', text: '', reasoning: '', toolCallIds: [] })
      const requested = call('read', false)
      const accept = () => h.owner.store.acceptModel(h.scope(), { id: 'response', value: { kind: 'assistant', content: '',
        calls: [{ name: requested.name, args: requested.args }] } }, [requested], { modelCalls: 1, todos: [] })
      h.database.exec("CREATE TRIGGER fail_model_metadata BEFORE INSERT ON agent_model_messages BEGIN SELECT RAISE(ABORT,'metadata failed'); END")
      expect(accept).toThrow('metadata failed')
      expect(h.reader().runMessages('run').map(message => message.id)).toEqual(['input'])
      expect(h.database.prepare("SELECT status FROM agent_model_activities WHERE model_id='streaming'").get()).toEqual({ status: 'running' })
      h.database.exec('DROP TRIGGER fail_model_metadata'); accept(); h.reopen()
      expect(h.database.prepare('SELECT model_id,sequence,status FROM agent_model_activities WHERE run_id=?').all('run'))
        .toEqual([{ model_id: 'streaming', sequence: streaming.sequence, status: 'completed' }])
      const timing = h.database.prepare("SELECT started_at,completed_at FROM agent_activity_timing WHERE activity_key='model:streaming'").get() as { started_at: string; completed_at: string }
      expect(timing.started_at).toBe(streaming.startedAt); expect(timing.completed_at).toBeTruthy()
      h.owner.store.prepareTools(h.scope(), [{ callId: requested.id, args: { path: 'canonical' } }])
      expect(h.database.prepare("SELECT started_at,completed_at FROM agent_activity_timing WHERE activity_key='model:streaming'").get()).toEqual(timing)
      h.product.messages.observations.recordToolApproval('run', requested.id, { status: 'pending_approval', interruptId: 'approval', actionIndex: 0 })
      const activity = h.database.prepare("SELECT sequence,status FROM agent_activities WHERE activity_key='tool:root:read'").get() as { sequence: number; status: string }
      expect(activity.status).toBe('running')
      expect(h.reader().activities.getModelActivity('run', 'streaming')).toMatchObject({ toolCallIds: [requested.id], sequence: streaming.sequence })
      expect(h.reader().activities.getToolActivity('run', requested.id)).toMatchObject({
        call: { id: requested.id, args: { path: 'canonical' } },
        approval: { status: 'pending_approval', interruptId: 'approval', actionIndex: 0 }, status: 'running'
      })
      h.database.exec("CREATE TRIGGER fail_tool_metadata BEFORE UPDATE ON agent_activities BEGIN SELECT RAISE(ABORT,'tool metadata failed'); END")
      vi.setSystemTime(new Date('2026-10-11T08:50:58.140Z'))
      const settle = () => h.owner.store.settleCall(h.identity, requested.id, { id: 'result', value: { kind: 'tool', content: 'Done', resultFor: requested.id } })
      expect(settle).toThrow('tool metadata failed')
      expect(h.owner.store.load(h.identity.threadId)!.calls[0].result).toBeUndefined()
      expect(h.database.prepare('SELECT * FROM agent_tool_approvals').all()).toHaveLength(1)
      h.database.exec('DROP TRIGGER fail_tool_metadata'); settle(); h.reopen()
      expect(h.database.prepare("SELECT sequence,status,name FROM agent_activities WHERE activity_key='tool:root:read'").get())
        .toEqual({ sequence: activity.sequence, status: 'completed', name: 'read_file' })
      expect(h.database.prepare('SELECT * FROM agent_tool_approvals').all()).toEqual([])
      expect(h.database.prepare("SELECT tool_message_id FROM agent_tool_messages WHERE call_id='read'").get()).toEqual({ tool_message_id: 'result' })
      expect(h.reader().activities.getToolActivity('run', requested.id)).toMatchObject({
        call: { id: requested.id, args: { path: 'canonical' } }, output: 'Done', status: 'completed'
      })
      expect(h.reader().activities.getToolActivity('run', requested.id)?.approval).toBeUndefined()
      const completed = h.reader().activities.getToolActivity('run', requested.id)!
      expect(completed.completedAt).toBe('2026-10-11T08:50:58.140Z')
      vi.setSystemTime(new Date('2026-10-11T08:52:34.000Z'))
      h.owner.store.finishBatch(h.scope())
      expect(h.reader().activities.getToolActivity('run', requested.id)).toEqual(completed)
      vi.setSystemTime(new Date('2026-10-11T08:52:58.000Z'))
      h.owner.store.finish(h.scope(), 'completed'); h.reopen()
      expect(h.reader().activities.getToolActivity('run', requested.id)).toEqual(completed)
    } finally { h.dispose(); vi.useRealTimers() }
  })

  it('rolls message indexes, payloads and input acceptance back together when publication fails', async () => {
    const h = fixture()
    try {
      h.database.exec("CREATE TRIGGER fail_index BEFORE INSERT ON agent_message_index BEGIN SELECT RAISE(ABORT,'index failed'); END")
      await expect(h.owner.enter('input', h.identity)).rejects.toThrow('index failed')
      expect(h.owner.store.load(h.identity.threadId)).toBeUndefined()
      expect(h.database.prepare('SELECT * FROM agent_message_payloads').all()).toEqual([])
      expect(h.database.prepare('SELECT * FROM execution_message_bodies').all()).toEqual([])
      expect(h.database.prepare('SELECT count(*) AS count FROM agent_run_input_intents').get()).toEqual({ count: 1 })
      h.database.exec('DROP TRIGGER fail_index'); h.reopen(); await h.owner.enter('input', h.identity)
      expect(h.reader().window(h.identity.threadId).messages).toMatchObject([{ id: 'input', role: 'user' }])
      h.reopen(); await h.owner.enter('continue', h.identity)
      expect(h.reader().runMessages(h.identity.runId)).toHaveLength(1)
    } finally { h.dispose() }
  })

  it.each([true, false])('publishes complete results before their batch history and preserves tool links with provider IDs=%s', async provider => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      const calls = [call('first', provider), call('second', provider)]
      h.owner.store.acceptModel(h.scope(), { id: 'response', value: { kind: 'assistant', content: '',
        calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
      h.owner.store.prepareTools(h.scope(), calls.map(call => ({ callId: call.id, args: call.args })))
      const result: ExecutionMessageInput = { id: 'first-result', value: { kind: 'tool', content: 'Saved result', resultFor: calls[0].providerCallId ?? calls[0].id,
        artifact: { bytes: new Uint8Array([0, 255]) } } }
      h.owner.store.settleCall(h.identity, calls[0].id, result)
      h.reopen()
      expect(h.reader().payload(h.identity.threadId, result.id)?.artifact).toEqual(result.value.artifact)
      expect(h.reader().runMessages(h.identity.runId).find(message => message.id === 'response')?.toolCalls)
        .toEqual(calls.map(call => ({ id: call.id, name: call.name, args: call.args })))
      expect(h.reader().payload(h.identity.threadId, 'response')?.calls?.map(call => call.id)).toEqual(calls.map(call => call.providerCallId))
      const evidence = h.reader().rootActivityEvidence(h.identity.runId)
      expect(evidence.models).toMatchObject([{ messageId: 'response', toolCalls: calls.map(call => ({ id: call.id })) }])
      expect(evidence.tools).toMatchObject([{ call: { id: calls[0].id }, output: 'Saved result' }])
      expect(h.owner.store.load(h.identity.threadId)!.messages.map(record => record.id)).toEqual(['input', 'response'])
      expect(h.database.prepare('SELECT message_id FROM agent_message_index ORDER BY position').all()).toEqual([{ message_id: 'input' }, { message_id: 'response' }])
      expect(h.reader().window(h.identity.threadId).messages.map(message => message.id)).toEqual(['input'])
      expect(h.reader().runMessages(h.identity.runId).map(message => message.id)).toEqual(['input', 'response', 'first-result'])
      const before = h.owner.store.load(h.identity.threadId)
      h.database.exec("CREATE TRIGGER fail_cancel_index BEFORE INSERT ON agent_message_index WHEN NEW.message_id='first-result' BEGIN SELECT RAISE(ABORT,'cancel projection failed'); END")
      expect(() => h.owner.store.finish(h.scope(), 'cancelled')).toThrow('cancel projection failed')
      expect(h.owner.store.load(h.identity.threadId)).toEqual(before)
      h.database.exec('DROP TRIGGER fail_cancel_index')
      h.owner.store.finish(h.scope(), 'cancelled'); h.reopen()
      expect(h.owner.store.load(h.identity.threadId)?.calls).toEqual([])
      expect(h.reader().rootActivityEvidence(h.identity.runId)).toEqual(evidence)
      expect(h.reader().activities.getRunActivity(h.identity.runId)).toMatchObject({
        models: [{ toolCallIds: calls.map(call => call.id) }],
        tools: [{ call: { id: calls[0].id, args: calls[0].args }, output: 'Saved result' }]
      })
      expect(h.database.prepare('SELECT message_id FROM agent_message_index ORDER BY position').all()).toEqual([
        { message_id: 'input' }, { message_id: 'response' }, { message_id: 'first-result' }
      ])
      expect(h.database.prepare('SELECT model_message_id,tool_message_id FROM agent_tool_messages WHERE call_id=?').get(calls[0].id))
        .toEqual({ model_message_id: 'response', tool_message_id: 'first-result' })
      expect(h.reader().window(h.identity.threadId).messages.map(message => message.id)).toEqual(['input'])
    } finally { h.dispose() }
  })

  it('rolls stable model call identities back with the response and refuses missing identities after completion', async () => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      const calls = [call('first', false), call('second', false)], before = h.owner.store.load(h.identity.threadId)
      const accept = () => h.owner.store.acceptModel(h.scope(), { id: 'response', value: { kind: 'assistant', content: '',
        calls: calls.map(call => ({ name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
      h.database.exec("CREATE TRIGGER fail_call_identity BEFORE INSERT ON execution_model_calls WHEN NEW.call_index=1 BEGIN SELECT RAISE(ABORT,'identity failed'); END")
      expect(accept).toThrow('identity failed')
      expect(h.owner.store.load(h.identity.threadId)).toEqual(before)
      expect(h.database.prepare('SELECT * FROM execution_model_calls').all()).toEqual([])
      expect(h.database.prepare("SELECT * FROM execution_message_bodies WHERE message_id='response'").all()).toEqual([])
      h.database.exec('DROP TRIGGER fail_call_identity'); accept()
      const state = h.owner.store.load(h.identity.threadId)!
      h.owner.store.finish(h.scope(), 'cancelled'); h.reopen()
      expect(h.owner.store.readModelCallIds(h.identity.threadId, state.response!.recordId)).toEqual(['first', 'second'])
      expect(h.reader().rootActivityEvidence(h.identity.runId).tools).toEqual([])
      h.database.prepare('DELETE FROM execution_model_calls WHERE call_index=1').run()
      expect(() => h.reader().rootActivityEvidence(h.identity.runId)).toThrow('no complete application call identities')
      expect(h.reader().payload(h.identity.threadId, 'response')?.calls).toHaveLength(2)
    } finally { h.dispose() }
  })

  it('publishes canonical preflight arguments with stable call identities while retaining the original body', async () => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      const requested = call('read', false)
      h.owner.store.acceptModel(h.scope(), { id: 'response', value: { kind: 'assistant', content: '',
        calls: [{ name: requested.name, args: requested.args }] } }, [requested], { modelCalls: 1, todos: [] })
      const original = h.owner.store.load(h.identity.threadId)!.response!
      const args = { path: 'canonical/path' }
      h.database.exec("CREATE TRIGGER fail_preflight_index BEFORE INSERT ON agent_message_index WHEN NEW.message_id='response' BEGIN SELECT RAISE(ABORT,'preflight projection failed'); END")
      expect(() => h.owner.store.prepareTools(h.scope(), [{ callId: requested.id, args }])).toThrow('preflight projection failed')
      expect(h.owner.store.load(h.identity.threadId)!.response).toEqual(original)
      expect(h.reader().payload(h.identity.threadId, 'response')?.calls?.[0].args).toEqual(requested.args)
      expect(h.database.prepare('SELECT count(*) AS count FROM execution_model_calls').get()).toEqual({ count: 1 })
      h.database.exec('DROP TRIGGER fail_preflight_index')
      h.owner.store.prepareTools(h.scope(), [{ callId: requested.id, args }])
      const prepared = h.owner.store.load(h.identity.threadId)!.response!
      expect(prepared.recordId).not.toBe(original.recordId)
      expect(h.owner.store.readMessageRecord(h.identity.threadId, original.recordId)).toEqual(original)
      expect(h.owner.store.readModelCallIds(h.identity.threadId, original.recordId)).toEqual([requested.id])
      expect(h.owner.store.readModelCallIds(h.identity.threadId, prepared.recordId)).toEqual([requested.id])
      h.owner.store.finish(h.scope(), 'cancelled'); h.reopen()
      expect(h.reader().rootActivityEvidence(h.identity.runId).models).toMatchObject([
        { messageId: 'response', toolCalls: [{ id: requested.id, name: requested.name, args }] }
      ])
      expect(h.reader().payload(h.identity.threadId, 'response')?.calls?.[0].args).toEqual(args)
    } finally { h.dispose() }
  })

  it('commits a complete text response and summary without adding the summary as a user turn', async () => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      const summary = { id: 'summary', summaryText: 'Summary', modelContent: 'Model summary', cutoffIndex: 1,
        activatedAfterMessageIndex: 0, inputTokensBefore: 80, inputTokensAfter: 20 }
      h.product.summaries.recordContextSummaryStarted(h.identity.runId, summary.id); h.product.summaries.stageContextSummary(h.identity.runId, summary.id, summary)
      h.owner.store.acceptModel(h.scope(), { id: 'answer', value: { kind: 'assistant', content: 'Complete answer' } }, [], { modelCalls: 1, todos: [] }, summary)
      h.owner.store.finish(h.scope(), 'completed'); h.reopen()
      expect(h.reader().window(h.identity.threadId).messages.map(message => message.id)).toEqual(['input', 'answer'])
      expect(h.reader().payload(h.identity.threadId, summary.id)).toBeUndefined()
      expect(h.reader().runMessages(h.identity.runId).map(message => message.id)).toEqual(['input', 'answer'])
      expect(h.product.summaries.getCommittedContextSummary(h.identity.runId, summary.id)?.modelContent).toBe(summary.modelContent)
    } finally { h.dispose() }
  })
})

it('reads only the latest native activity body while polling beside megabytes of completed history', async () => {
  const h = fixture()
  try {
    await h.owner.enter('input', h.identity)
    const old = call('old'), active = call('active')
    h.owner.store.acceptModel(h.scope(), { id: 'old-model', value: { kind: 'assistant', content: 'x'.repeat(1024 * 1024),
      calls: [{ id: old.providerCallId!, name: old.name, args: old.args }] } }, [old], { modelCalls: 1, todos: [] })
    h.owner.store.prepareTools(h.scope(), [{ callId: old.id, args: old.args }])
    h.owner.store.settleCall(h.identity, old.id, { id: 'old-result', value: { kind: 'tool', resultFor: old.providerCallId!, content: 'x'.repeat(1024 * 1024) } })
    h.owner.store.finishBatch(h.scope())
    h.owner.store.acceptModel(h.scope(), { id: 'latest-model', value: { kind: 'assistant', content: 'Current progress',
      calls: [{ id: active.providerCallId!, name: active.name, args: active.args }] } }, [active], { modelCalls: 2, todos: [] })
    h.reopen()
    const reader = h.reader(), read = vi.spyOn(NativeExecutionStore.prototype, 'readMessageRecord')
    try {
      const progress = reader.activities.getRunProcessActivity('run')
      expect(progress).toMatchObject({ modelRounds: 2, toolCalls: 2, latestModel: { text: 'Current progress' },
        activeTools: [{ call: { id: active.id, name: active.name, args: active.args } }] })
      expect(read).toHaveBeenCalled()
      expect(read.mock.results.every(result => result.type === 'return' && result.value.id === 'latest-model')).toBe(true)
      expect(reader.activities.getMessageActivitySequence('run', 'latest-model')).toBe(progress.latestModel?.sequence)
    } finally { read.mockRestore() }
  } finally { h.dispose() }
})

it('preserves the exact memory recall prompt once in native activity across reopening', async () => {
  const h = fixture()
  try {
    await h.owner.enter('input', h.identity)
    const recall = { id: 'recall', query: 'How should this project build?',
      promptText: '<relevant_memories>\nnpm run build\n</relevant_memories>', memoryCount: 1, agentName: 'general-purpose' }
    const observations = h.reader().observations
    const first = observations.recordMemoryRecall('run', recall)
    expect(observations.recordMemoryRecall('run', recall)).toEqual(first)
    expect(h.reader().activities.getRunActivity('run')?.memoryRecalls).toEqual([{ ...first, ...recall }])
    h.reopen()
    expect(h.reader().activities.getRunActivity('run')?.memoryRecalls).toEqual([{ ...first, ...recall }])
  } finally { h.dispose() }
})

it.each([false, true])('reopens canonical root replies and activity before or after terminal publication (completed=%s)', async completed => {
  const h = fixture()
  try {
    await h.owner.enter('input', h.identity)
    const requested = call('lookup')
    h.owner.store.acceptModel(h.scope(), { id: 'model', value: { kind: 'assistant', content: 'Checking first', calls: [{ id: requested.providerCallId, name: requested.name, args: requested.args }] } }, [requested], { modelCalls: 1, todos: [] })
    h.owner.store.prepareTools(h.scope(), [{ callId: requested.id, args: requested.args }])
    h.owner.store.settleCall(h.identity, requested.id, { id: 'result', value: { kind: 'tool', content: 'Lookup result', resultFor: requested.providerCallId } })
    h.owner.store.finishBatch(h.scope(), [])
    h.owner.store.acceptModel(h.scope(), { id: 'answer', value: { kind: 'assistant', content: 'Final answer', context: { runId: h.identity.runId, createdAt: '2026-08-09T02:00:01.000Z' } } }, [], { modelCalls: 2, todos: [] })
    if (completed) h.owner.store.finish(h.scope(), 'completed')
    h.reopen()
    const snapshot = h.product.readSnapshot(h.identity.threadId)
    expect(snapshot.messages.map(message => message.id)).toEqual(['input', 'answer'])
    expect(snapshot.messages[1]).toMatchObject({ role: 'assistant', runId: h.identity.runId, createdAt: '2026-08-09T02:00:01.000Z', content: [{ type: 'text', text: 'Final answer' }] })
    expect(snapshot.pendingRun?.status).toBe(completed ? undefined : 'running')
    expect(snapshot.activities[0]).toMatchObject({ status: completed ? 'completed' : 'running',
      models: [{ messageId: 'model', text: 'Checking first', status: 'completed' }, { messageId: 'answer', text: 'Final answer', status: 'completed' }],
      tools: [{ call: { id: requested.id }, status: 'completed', output: 'Lookup result' }] })
  } finally { h.dispose() }
})

it('never completes a new native call with an older run result that reused the provider call ID', async () => {
  const h = fixture()
  try {
    for (const runId of ['run', 'next']) {
      const identity = { ...h.identity, runId }, scope = () => ({ ...identity, expectedRevisionId: h.owner.store.load(identity.threadId)!.revisionId })
      if (runId === 'next') h.owner.createRun({ ...identity, operation: 'agent', message: { id: 'next:input', value: { id: 'next:input', kind: 'user', content: 'Next', context: { runId } } } })
      await h.owner.enter('input', identity)
      const requested = { ...call(`lookup-${runId}`), providerCallId: 'shared-provider-id' }
      h.owner.store.acceptModel(scope(), { id: `model-${runId}`, value: { kind: 'assistant', content: 'Lookup', calls: [{ id: requested.providerCallId, name: requested.name, args: requested.args }] } }, [requested], { modelCalls: 1, todos: [] })
      h.owner.store.prepareTools(scope(), [{ callId: requested.id, args: requested.args }])
      const observed = { id: requested.id, name: requested.name, args: requested.args }
      h.product.messages.observations.recordTool(runId, observed, 'completed')
      if (runId === 'next') {
        h.reopen()
        const current = h.product.readSnapshot(identity.threadId).activities.find(activity => activity.runId === runId)!
        expect(current.tools.some(tool => tool.status === 'completed' || tool.output !== undefined)).toBe(false)
        expect(h.reader().rootActivityEvidence(runId).tools).toEqual([])
      }
      h.owner.store.settleCall(identity, requested.id, { id: `result-${runId}`, value: { kind: 'tool', content: `Output ${runId}`, resultFor: requested.providerCallId } })
      h.owner.store.finishBatch(scope(), []); h.owner.store.finish(scope(), 'completed'); h.reopen()
      expect(h.reader().activities.getToolActivity(runId, requested.id)?.output).toBe(`Output ${runId}`)
    }
    expect(h.reader().activities.getToolActivity('run', 'lookup-run')?.output).toBe('Output run')
  } finally { h.dispose() }
})


it.each([false, true])('keeps every application call when provider IDs repeat (same batch=%s)', async sameBatch => {
  const h = fixture()
  try {
    await h.owner.enter('input', h.identity)
    const calls = [call('first'), call('second')].map(call => ({ ...call, providerCallId: 'reused-provider-id' }))
    const batches = sameBatch ? [calls] : calls.map(call => [call])
    for (const [round, batch] of batches.entries()) {
      h.owner.store.acceptModel(h.scope(), { id: `model-${round}`, value: { kind: 'assistant', content: 'Read files',
        calls: batch.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, batch, { modelCalls: round + 1, todos: [] })
      h.owner.store.prepareTools(h.scope(), batch.map(call => ({ callId: call.id, args: call.args })))
      for (const requested of [...batch].reverse()) {
        h.owner.store.settleCall(h.identity, requested.id, { id: `result-${requested.id}`, value: {
          kind: 'tool', resultFor: requested.providerCallId, content: `Output ${requested.id}` } })
      }
      h.owner.store.finishBatch(h.scope())
    }
    h.owner.store.finish(h.scope(), 'completed')
    h.reopen()
    const snapshot = h.product.readSnapshot(h.identity.threadId)
    expect(snapshot.activities[0].tools.map(tool => ({ id: tool.call.id, args: tool.call.args, output: tool.output })))
      .toEqual(calls.map(call => ({ id: call.id, args: call.args, output: `Output ${call.id}` })))
    const history = h.owner.store.readHistory(h.identity.threadId)!.messages
    expect(history.filter(record => record.value.kind === 'tool').map(record => record.value.resultFor)).toEqual(['reused-provider-id', 'reused-provider-id'])
    expect(history.filter(record => record.value.kind === 'assistant').flatMap(record => record.value.calls!.map(call => call.id)))
      .toEqual(['reused-provider-id', 'reused-provider-id'])
  } finally { h.dispose() }
})

it.each([false, true])('rebuilds colliding v1 links without rewriting native history (same batch=%s)', async sameBatch => {
  const h = fixture()
  try {
    await h.owner.enter('input', h.identity)
    const calls = ['first', 'second'].map(id => ({ ...call(id), providerCallId: 'reused-provider-id' }))
    for (const batch of sameBatch ? [calls] : calls.map(call => [call])) {
      const modelId = `model-${batch.at(-1)!.id}`
      h.owner.store.acceptModel(h.scope(), { id: modelId, value: { kind: 'assistant', content: 'Read',
        calls: batch.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, batch, { modelCalls: 1, todos: [] })
      h.owner.store.prepareTools(h.scope(), batch.map(call => ({ callId: call.id, args: call.args })))
      for (const requested of [...batch].reverse()) {
        h.owner.store.settleCall(h.identity, requested.id, { id: `result-${requested.id}`, value: {
          kind: 'tool', resultFor: requested.providerCallId, content: requested.id } })
      }
      h.owner.store.finishBatch(h.scope())
    }
    h.owner.store.finish(h.scope(), 'completed')
    const original = h.owner.store.readHistory(h.identity.threadId)
    // v1 recorded provider IDs in the derived timeline and overwrote the first link.
    h.database.prepare('DELETE FROM agent_tool_messages WHERE run_id=?').run(h.identity.runId)
    h.database.prepare("DELETE FROM agent_activities WHERE run_id=? AND kind='tool'").run(h.identity.runId)
    h.database.prepare("DELETE FROM agent_activity_timing WHERE run_id=? AND activity_key LIKE 'tool:%'").run(h.identity.runId)
    h.database.prepare('INSERT INTO agent_tool_messages VALUES(?,?,?,?,?)')
      .run(h.identity.threadId, h.identity.runId, 'reused-provider-id', 'model-second', 'result-second')
    h.product.messages.observations.recordTool(h.identity.runId, { id: 'reused-provider-id', name: 'read_file', args: { path: 'second' } }, 'completed')
    h.reopen()
    h.database.exec("CREATE TRIGGER reject_reindex BEFORE INSERT ON agent_activities WHEN NEW.activity_id='first' BEGIN SELECT RAISE(ABORT,'reindex failed'); END")
    expect(() => h.product.recover()).toThrow('reindex failed')
    expect(h.database.prepare('SELECT call_id FROM agent_tool_messages').all()).toEqual([{ call_id: 'reused-provider-id' }])
    expect(h.owner.store.readHistory(h.identity.threadId)).toEqual(original)
    h.database.exec('DROP TRIGGER reject_reindex')
    expect(h.product.recover()).toEqual([])
    const snapshot = h.product.readSnapshot(h.identity.threadId)
    expect(snapshot.activities[0].tools.map(tool => [tool.call.id, tool.output])).toEqual([['first', 'first'], ['second', 'second']])
    expect(h.owner.store.readHistory(h.identity.threadId)).toEqual(original)
    expect(h.database.pragma('user_version', { simple: true })).toBe(1)
    h.reopen(); expect(h.product.recover()).toEqual([])
    expect(h.product.readSnapshot(h.identity.threadId)).toEqual(snapshot)
  } finally { h.dispose() }
})
