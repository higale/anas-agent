import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import type { ExecutionToolCall } from '../../runtime/executionState'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'

async function fixture() {
  const parent = join(process.cwd(), 'tmp'); mkdirSync(parent, { recursive: true })
  const root = mkdtempSync(join(parent, 'native-subagent-projection-')), file = join(root, 'conversation.sqlite')
  const global = new Database(':memory:')
  const options = { attachmentRoot: join(root, 'attachments'), memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file-edits')) }
  let db = NativeConversationDatabase.open(file, options), sql = new Database(file)
  db.runs.createThreadAndRun({ threadId: 'root', runId: 'root-run', thread: {}, submissionId: randomUUID(),
    message: { id: 'root-run:input', value: { id: 'root-run:input', kind: 'user', content: 'Task', context: { runId: 'root-run' } } } })
  await db.runs.enter('input', { threadId: 'root', runId: 'root-run' })
  for (const [id, parentThreadId, parentSubagentId] of [['child', 'root', undefined], ['grandchild', 'child', 'child'], ['sibling', 'root', undefined]] as const) {
    db.runs.createSubagentCall({ id, ownerThreadId: 'root', parentThreadId, parentRunId: `${parentThreadId}-run`, parentSubagentId,
      childThreadId: id, childRunId: `${id}-run`, childThread: {}, description: `Task ${id}`,
      config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
    await db.runs.enter('input', { threadId: id, runId: `${id}-run` })
  }
  const owner = { threadId: 'grandchild', runId: 'grandchild-run' }
  return { get db() { return db }, get sql() { return sql }, owner,
    scope() { return { ...owner, expectedRevisionId: db.runs.store.load(owner.threadId)!.revisionId } },
    reopen() { sql.close(); db.close(); db = NativeConversationDatabase.open(file, options); sql = new Database(file) },
    close() { sql.close(); db.close(); global.close(); rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }) } }
}

it('rolls a descendant tool projection back across every ancestor before publishing its model and result', async () => {
  const h = await fixture(), call = { id: 'tool', name: 'read_file', args: { path: 'README.md' } }
  try {
    const native: ExecutionToolCall = { ...call, id: 'native-tool', providerCallId: call.id,
      artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
    h.db.runs.store.acceptModel(h.scope(), { id: 'canonical-model', value: { kind: 'assistant',
      content: [{ type: 'text', text: 'Nested model output' }, { type: 'reasoning', reasoning: 'Need both files', summary: [{ type: 'summary_text', text: 'Read both files' }] }], calls: [call] } }, [native], { modelCalls: 1, todos: [] })
    h.db.runs.store.prepareTools(h.scope(), [{ callId: native.id, args: call.args }])
    h.db.runs.store.settleCall(h.owner, native.id, { id: 'canonical-result', value: { kind: 'tool', resultFor: call.id, content: 'tool output' } })
    h.db.runs.store.finishBatch(h.scope())
    const observed = { ...call, id: native.id }
    h.sql.exec("CREATE TRIGGER reject_root_tool BEFORE INSERT ON agent_activities WHEN NEW.run_id='root-run' AND NEW.activity_key='tool:grandchild:native-tool' BEGIN SELECT RAISE(ABORT,'ancestor projection failed'); END")
    expect(() => h.db.subagentProjection.recordProjectedToolActivity('grandchild', 'root', observed, 'completed', 'grandchild', 'tool output')).toThrow('ancestor projection failed')
    for (const run of ['child-run', 'root-run']) expect(h.db.messages.activities.getRunActivity(run)?.tools).toEqual([])
    h.sql.exec('DROP TRIGGER reject_root_tool')
    h.db.subagentProjection.recordProjectedModelActivity('grandchild', 'root', { id: 'model', messageId: 'canonical-model', subagentId: 'grandchild',
      status: 'completed', text: 'Ignored notification copy', reasoning: '', toolCallIds: [native.id] })
    h.db.subagentProjection.recordProjectedToolActivity('grandchild', 'root', observed, 'completed', 'grandchild', 'Ignored notification copy')
    for (const run of ['child-run', 'root-run']) {
      const activity = h.db.messages.activities.getRunActivity(run)!
      expect(activity.models).toMatchObject([{ id: 'model', subagentId: 'grandchild', status: 'completed', text: 'Nested model output', reasoning: 'Need both files', reasoningSummary: 'Read both files' }])
      expect(activity.tools).toMatchObject([{ call: observed, subagentId: 'grandchild', status: 'completed', output: 'tool output' }])
    }
    expect(h.sql.prepare("SELECT thread_id,count(*) AS count FROM execution_message_bodies WHERE message_id IN ('canonical-model','canonical-result') GROUP BY thread_id").all())
      .toEqual([{ thread_id: 'grandchild', count: 2 }])
    expect(h.sql.prepare("SELECT output_json FROM agent_activities WHERE kind='tool'").all()).toEqual([{ output_json: null }, { output_json: null }, { output_json: null }])
    h.reopen()
    for (const run of ['child-run', 'root-run']) expect(h.db.messages.activities.getRunActivity(run)?.models[0].reasoningSummary).toBe('Read both files')
  } finally { h.close() }
})

it('persists a descendant approval atomically through every ancestor and reopens it against its native body', async () => {
  const h = await fixture(), call = { id: 'provider-call', name: 'pwsh', args: { command: 'Remove-Item example.txt' } }
  const approval = { status: 'pending_approval' as const, interruptId: 'approval', actionIndex: 0 }
  try {
    h.sql.exec("CREATE TRIGGER reject_root_approval BEFORE INSERT ON agent_tool_approvals WHEN NEW.run_id='root-run' AND NEW.activity_key='tool:grandchild:provider-call' BEGIN SELECT RAISE(ABORT,'ancestor approval failed'); END")
    expect(() => h.db.subagentProjection.recordProjectedToolApproval('grandchild', 'root', call, approval, 'grandchild')).toThrow('ancestor approval failed')
    for (const run of ['child-run', 'root-run']) expect(h.db.messages.activities.getRunActivity(run)?.tools).toEqual([])
    h.sql.exec('DROP TRIGGER reject_root_approval')
    const calls = [call, { ...call, id: 'provider-second', args: { command: 'Remove-Item second.txt' } }]
    const native: ExecutionToolCall[] = calls.map((call, index) => ({ ...call, id: `native-${index}`, providerCallId: call.id,
      artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }))
    h.db.runs.store.acceptModel(h.scope(), { id: 'approval-model', value: { kind: 'assistant', content: '', calls } }, native, { modelCalls: 1, todos: [] })
    h.db.runs.store.prepareTools(h.scope(), native.map((call, index) => ({ callId: call.id, args: calls[index].args, authorization: { approval: 'pending' } })), [{
      id: approval.interruptId, generation: 'generation', kind: 'tool', callIds: native.map(call => call.id), request: {
        actionRequests: calls.map(call => ({ name: call.name, args: call.args, description: 'Confirm' })),
        reviewConfigs: calls.map(call => ({ actionName: call.name, allowedDecisions: ['approve', 'reject'] }))
      }
    }])
    h.db.runs.reconcileSubagent('grandchild', 'root')
    for (let attempt = 0; attempt < 2; attempt++) {
      h.db.runs.reconcileSubagent('grandchild', 'root')
      for (const [index, call] of native.entries()) h.db.subagentProjection.recordProjectedToolApproval('grandchild', 'root', call, { ...approval, actionIndex: index }, 'grandchild')
    }
    const pending = h.db.runs.readInterrupts(h.owner)
    expect(pending).toHaveLength(1)
    for (const reopen of [false, true]) {
      if (reopen) h.reopen()
      expect(h.db.readSnapshot('grandchild').interrupts).toEqual(pending)
      for (const run of ['child-run', 'root-run']) expect(h.db.messages.activities.getRunActivity(run)?.tools).toMatchObject(
        native.map((call, index) => ({ call: { id: call.id, name: call.name, args: call.args }, subagentId: 'grandchild', status: 'running', approval: { ...approval, actionIndex: index } })))
    }
    h.db.runs.saveAnswers(h.scope(), [{ id: approval.interruptId, generation: 'generation', response: { decisions: calls.map(() => ({ type: 'approve' })) } }])
    await h.db.runs.enter('resume', h.owner)
    const resumed = h.db.runs.store.load('grandchild')
    h.sql.exec("CREATE TRIGGER reject_resume_projection BEFORE UPDATE ON agent_activities WHEN OLD.activity_id='grandchild' AND json_extract(NEW.output_json,'$.status')='running' BEGIN SELECT RAISE(ABORT,'resume projection failed'); END")
    expect(() => h.db.runs.reconcileSubagent('grandchild', 'root')).toThrow('resume projection failed')
    expect(h.db.runs.store.load('grandchild')).toEqual(resumed)
    expect(h.db.runs.subagents.require('grandchild', 'root').status).toBe('interrupted')
    for (const run of ['child-run', 'root-run']) expect(h.db.messages.activities.getSubagentActivity(run, 'grandchild')?.status).toBe('interrupted')
    h.sql.exec('DROP TRIGGER reject_resume_projection'); h.reopen(); h.db.recover()
    expect(h.db.runs.store.load('grandchild')).toEqual(resumed)
    expect(h.db.runs.subagents.require('grandchild', 'root').status).toBe('running')
    expect(h.sql.prepare("SELECT * FROM agent_run_resume_intents WHERE run_id='grandchild-run'").all()).toEqual([])
    h.db.runs.store.settleCall(h.owner, native[0].id, { id: 'first-result', value: { kind: 'tool', content: 'Done', resultFor: calls[0].id } })
    h.db.subagentProjection.recordProjectedToolActivity('grandchild', 'root', native[0], 'completed', 'grandchild', 'Done')
    for (const run of ['child-run', 'root-run']) {
      expect(h.db.messages.activities.getToolActivity(run, native[0].id, 'grandchild')?.approval).toBeUndefined()
      expect(h.db.messages.activities.getToolActivity(run, native[1].id, 'grandchild')?.approval).toEqual({ ...approval, actionIndex: 1 })
    }
    h.db.runs.store.finish(h.scope(), 'cancelled'); h.db.runs.reconcileSubagent('grandchild', 'root'); h.reopen()
    for (const run of ['child-run', 'root-run']) {
      const tools = h.db.messages.activities.getRunActivity(run)!.tools
      expect(tools.every(tool => tool.approval === undefined)).toBe(true)
      expect(tools.find(tool => tool.call.id === native[0].id)?.output).toBe('Done')
    }
  } finally { h.close() }
})

it.each((['completed', 'cancelled', 'failed'] as const).flatMap(outcome => ['ancestor', 'tool'].map(failurePoint => ({ outcome, failurePoint }))))(
  'commits one descendant $outcome outcome through all ancestors without settling siblings (failure=$failurePoint)', async ({ outcome, failurePoint }) => {
  const h = await fixture()
  try {
    for (const id of ['grandchild', 'sibling']) {
      h.db.subagentProjection.recordProjectedModelActivity(id, 'root', {
        id: `${id}-model`, subagentId: id, status: 'running', text: 'Partial response', reasoning: '', toolCallIds: [`${id}-tool`]
      })
      h.db.subagentProjection.recordProjectedToolApproval(id, 'root', { id: `${id}-tool`, name: 'write_file', args: {} },
        { status: 'pending_approval', interruptId: `${id}-approval`, actionIndex: 0 }, id)
    }
    h.db.runs.store.acceptModel(h.scope(), { id: 'answer', value: { kind: 'assistant', content: 'Grandchild answer' } }, [], { modelCalls: 1, todos: [] })
    const temporary = h.db.runs.subagents.recordRecoveryFailure('grandchild', 'root', 'Temporary recovery failure')
    expect(temporary).toMatchObject({ call: { status: 'running', error: 'Temporary recovery failure' }, activity: { status: 'running', error: 'Temporary recovery failure' } })
    expect(h.db.runs.subagents.recordRecoveryFailure('grandchild', 'root', 'Temporary recovery failure')).toBeUndefined()
    expect(h.db.runs.reconcileSubagent('grandchild', 'root')).toBeUndefined()
    expect(h.db.runs.subagents.require('grandchild', 'root').error).toBe('Temporary recovery failure')
    expect(h.db.runs.reconcileSubagent('grandchild', 'root')).toBeUndefined()
    h.db.runs.store.finish(h.scope(), outcome, outcome === 'failed' ? 'Child failure' : undefined)
    const before = h.db.runs.store.load('grandchild'), sibling = h.db.runs.subagents.require('sibling', 'root')
    const condition = failurePoint === 'ancestor' ? "NEW.run_id='root-run' AND NEW.activity_id='grandchild' AND NEW.status <> 'running'"
      : "OLD.parent_subagent_id='grandchild' AND NEW.status='completed'"
    h.sql.exec(`CREATE TRIGGER reject_terminal_projection BEFORE UPDATE ON agent_activities WHEN ${condition} BEGIN SELECT RAISE(ABORT,'ancestor terminal failed'); END`)
    expect(() => h.db.runs.reconcileSubagent('grandchild', 'root')).toThrow('ancestor terminal failed')
    expect(h.db.runs.store.load('grandchild')).toEqual(before)
    expect(h.db.runs.subagents.require('grandchild', 'root').status).toBe('running')
    for (const run of ['child-run', 'root-run']) {
      expect(h.db.messages.activities.getSubagentActivity(run, 'grandchild')?.status).toBe('running')
      expect(h.db.messages.activities.getModelActivity(run, 'grandchild-model')?.status).toBe('running')
      expect(h.db.messages.activities.getToolActivity(run, 'grandchild-tool', 'grandchild')).toMatchObject({ status: 'running', approval: { interruptId: 'grandchild-approval' } })
    }
    h.sql.exec('DROP TRIGGER reject_terminal_projection')
    h.db.runs.reconcileSubagent('grandchild', 'root')
    h.reopen()
    const completed = h.db.runs.subagents.require('grandchild', 'root')
    expect(completed.status).toBe(outcome)
    expect(h.db.runs.subagents.require('sibling', 'root')).toEqual(sibling)
    expect(h.db.runs.subagents.require('child', 'root').status).toBe('running')
    const activities = ['child-run', 'root-run'].map(run => h.db.messages.activities.getSubagentActivity(run, 'grandchild'))
    for (const activity of activities) expect(activity).toMatchObject({ status: outcome, completedAt: expect.any(String) })
    for (const run of ['child-run', 'root-run']) {
      const time = h.db.messages.activities.getSubagentActivity(run, 'grandchild')!.completedAt
      expect(h.db.messages.activities.getModelActivity(run, 'grandchild-model')).toMatchObject({ status: 'completed', text: '', completedAt: time })
      const tool = h.db.messages.activities.getToolActivity(run, 'grandchild-tool', 'grandchild')!
      expect(tool).toMatchObject({ status: 'completed', completedAt: time })
      expect(tool.approval).toBeUndefined()
    }
    expect(h.db.messages.activities.getModelActivity('root-run', 'sibling-model')?.status).toBe('running')
    expect(h.db.messages.activities.getToolActivity('root-run', 'sibling-tool', 'sibling')).toMatchObject({ status: 'running', approval: { interruptId: 'sibling-approval' } })
    h.db.runs.reconcileSubagent('grandchild', 'root'); h.reopen()
    expect(h.db.runs.subagents.recordRecoveryFailure('grandchild', 'root', 'Late recovery failure')).toBeUndefined()
    expect(['child-run', 'root-run'].map(run => h.db.messages.activities.getSubagentActivity(run, 'grandchild'))).toEqual(activities)
  } finally { h.close() }
})

it.each(['completed', 'failed', 'cancelled'] as const)('recovers a %s descendant independently while both ancestors remain paused', async outcome => {
  const h = await fixture()
  try {
    for (const threadId of ['root', 'child']) {
      const identity = { threadId, runId: `${threadId}-run` }, scope = () => ({ ...identity, expectedRevisionId: h.db.runs.store.load(threadId)!.revisionId })
      const call: ExecutionToolCall = { id: `${threadId}-call`, providerCallId: `${threadId}-provider`, name: 'write_file', args: {},
        artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
      h.db.runs.store.acceptModel(scope(), { id: `${threadId}-model`, value: { kind: 'assistant', content: '', calls: [{ id: call.providerCallId!, name: call.name, args: {} }] } }, [call], { modelCalls: 1, todos: [] })
      h.db.runs.store.prepareTools(scope(), [{ callId: call.id, args: {}, authorization: { approval: 'pending' } }], [{
        id: `${threadId}-approval`, generation: 'generation', kind: 'tool', callIds: [call.id], request: {
          actionRequests: [{ name: call.name, args: {}, description: 'Confirm' }], reviewConfigs: [{ actionName: call.name, allowedDecisions: ['approve', 'reject'] }]
        }
      }])
    }
    h.db.runs.reconcileSubagent('child', 'root')
    h.db.subagentProjection.recordProjectedModelActivity('grandchild', 'root', {
      id: 'pending-model', subagentId: 'grandchild', status: 'running', text: '', reasoning: '', toolCallIds: ['pending-tool']
    })
    h.db.subagentProjection.recordProjectedToolApproval('grandchild', 'root', { id: 'pending-tool', name: 'write_file', args: {} },
      { status: 'pending_approval', interruptId: 'grandchild-approval', actionIndex: 0 }, 'grandchild')
    h.db.runs.store.acceptModel(h.scope(), { id: 'answer', value: { kind: 'assistant', content: 'Final child answer' } }, [], { modelCalls: 1, todos: [] })
    h.db.runs.store.finish(h.scope(), outcome, outcome === 'failed' ? 'Terminal child failed' : undefined)
    expect(h.db.runs.subagents.require('grandchild', 'root').status).toBe('running')
    const ancestors = ['root', 'child'].map(id => h.db.runs.store.load(id))
    h.reopen()
    expect(h.db.recover()).toEqual([{ threadId: 'sibling', runId: 'sibling-run', command: 'continue' }])
    expect(['root', 'child'].map(id => h.db.runs.store.load(id))).toEqual(ancestors)
    const call = h.db.runs.subagents.require('grandchild', 'root')
    expect(call).toMatchObject({ status: outcome, ...(outcome === 'failed' ? { error: 'Terminal child failed' } : {}) })
    if (outcome !== 'failed') expect(call.error).toBeUndefined()
    if (outcome === 'completed') expect(call.result).toBe('Final child answer')
    for (const run of ['root-run', 'child-run']) {
      expect(h.db.messages.activities.getRun(run)?.status).toBe('interrupted')
      expect(h.db.messages.activities.getModelActivity(run, 'pending-model')).toMatchObject({ status: 'completed', completedAt: expect.any(String) })
      const tool = h.db.messages.activities.getToolActivity(run, 'pending-tool', 'grandchild')!
      expect(tool).toMatchObject({ status: 'completed', completedAt: expect.any(String) }); expect(tool.approval).toBeUndefined()
    }
    const activities = ['root-run', 'child-run'].map(run => h.db.messages.activities.getRunActivity(run))
    h.reopen(); h.db.recover()
    expect(h.db.runs.subagents.require('grandchild', 'root')).toEqual(call)
    expect(['root-run', 'child-run'].map(run => h.db.messages.activities.getRunActivity(run))).toEqual(activities)
  } finally { h.close() }
})

it('recovers missing projections of a third-level task without changing existing ancestor order or timing', async () => {
  const h = await fixture()
  try {
    const leaf = h.db.runs.createSubagentCall({ id: 'leaf', ownerThreadId: 'root', parentThreadId: 'grandchild', parentRunId: 'grandchild-run', parentSubagentId: 'grandchild',
      childThreadId: 'leaf-thread', childRunId: 'leaf-run', childThread: {}, description: 'Third-level task',
      config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
    const identity = { threadId: leaf.childThreadId, runId: leaf.childRunId }
    await h.db.runs.enter('input', identity)
    const original = h.db.messages.activities.getSubagentActivity('grandchild-run', 'leaf')!
    const existing = ['root-run', 'child-run'].map(run => h.db.messages.activities.getRunActivity(run)!.subagents.filter(call => call.id !== 'leaf'))
    for (const run of ['root-run', 'child-run']) {
      h.sql.prepare("DELETE FROM agent_activity_timing WHERE run_id=? AND activity_key='subagent:leaf'").run(run)
      h.sql.prepare("DELETE FROM agent_activities WHERE run_id=? AND activity_key='subagent:leaf'").run(run)
      expect(h.db.messages.activities.getSubagentActivity(run, 'leaf')).toBeUndefined()
    }
    h.db.runs.requestCancellation(identity); h.db.runs.completeCancellation(identity)
    h.reopen(); h.db.recover()
    const direct = h.db.messages.activities.getSubagentActivity('grandchild-run', 'leaf')!
    expect(direct).toMatchObject({ status: 'cancelled', startedAt: original.startedAt, completedAt: expect.any(String) })
    for (const [index, run] of ['root-run', 'child-run'].entries()) {
      expect(h.db.messages.activities.getSubagentActivity(run, 'leaf')).toMatchObject({ parentSubagentId: 'grandchild', status: 'cancelled', startedAt: direct.startedAt, completedAt: direct.completedAt })
      expect(h.db.messages.activities.getRunActivity(run)!.subagents.filter(call => call.id !== 'leaf')).toEqual(existing[index])
    }
    const recovered = ['root-run', 'child-run', 'grandchild-run'].map(run => h.db.messages.activities.getRunActivity(run))
    h.reopen(); h.db.recover()
    expect(['root-run', 'child-run', 'grandchild-run'].map(run => h.db.messages.activities.getRunActivity(run))).toEqual(recovered)
    for (const thread of ['root', 'child', 'grandchild']) expect(h.db.runs.store.load(thread)?.phase).toBe('prepare_model')
  } finally { h.close() }
})

it('does not attach a root result to a pending descendant with the same provider call ID', async () => {
  const h = await fixture(), providerCallId = 'shared-provider-call', root = { threadId: 'root', runId: 'root-run' }
  const tool = (id: string, path: string): ExecutionToolCall => ({ id, providerCallId, name: 'read_file', args: { path },
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] })
  const rootCall = tool('root-call', 'root.txt'), childCall = tool('child-call', 'child.txt')
  try {
    for (const [owner, call] of [[root, rootCall], [h.owner, childCall]] as const) {
      const scope = () => ({ ...owner, expectedRevisionId: h.db.runs.store.load(owner.threadId)!.revisionId })
      h.db.runs.store.acceptModel(scope(), { id: `${owner.runId}:model`, value: { kind: 'assistant', content: '',
        calls: [{ id: providerCallId, name: call.name, args: call.args }], context: { runId: owner.runId } } }, [call], { modelCalls: 1, todos: [] })
      h.db.runs.store.prepareTools(scope(), [{ callId: call.id, args: call.args }])
    }
    h.db.runs.store.settleCall(root, rootCall.id, { id: 'root-result', value: { kind: 'tool', resultFor: providerCallId, content: 'Only the root read completed', context: { runId: root.runId } } })
    h.db.subagentProjection.recordProjectedToolActivity('grandchild', 'root', { id: childCall.id, name: childCall.name, args: { path: 'child.txt' } }, 'running', 'grandchild')
    const check = () => {
      const tools = h.db.messages.activities.getRunActivity(root.runId)!.tools
      expect(tools.find(item => !item.subagentId)).toMatchObject({ status: 'completed', output: 'Only the root read completed' })
      expect(tools.find(item => item.subagentId === 'grandchild')).toMatchObject({ status: 'running', output: undefined, call: { args: { path: 'child.txt' } } })
      expect(h.db.runs.store.load(h.owner.threadId)?.calls[0].result).toBeUndefined()
    }
    check(); h.reopen(); check()
  } finally { h.close() }
})


it('keeps a child process progress separate from its projected descendant work across reopen', async () => {
  const h = await fixture()
  try {
    for (const id of ['child', 'grandchild']) {
      const owner = { threadId: id, runId: id + '-run' }, call = { id: id + '-tool', name: 'read_file', args: { path: id + '.txt' } }
      const scope = () => ({ ...owner, expectedRevisionId: h.db.runs.store.load(id)!.revisionId })
      const native: ExecutionToolCall = { ...call, id: id + '-native', providerCallId: call.id,
        artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
      h.db.runs.store.acceptModel(scope(), { id: id + '-model', value: { kind: 'assistant',
        content: [{ type: 'text', text: id + ' answer' }, { type: 'reasoning', reasoning: id + ' reasoning' }], calls: [call] } }, [native], { modelCalls: 1, todos: [] })
      h.db.runs.store.prepareTools(scope(), [{ callId: native.id, args: call.args }])
      if (id === 'child') {
        h.db.runs.store.settleCall(owner, native.id, { id: 'child-result', value: { kind: 'tool', resultFor: call.id, content: 'Own result' } })
        h.db.runs.store.finishBatch(scope())
      }
      h.db.subagentProjection.recordProjectedModelActivity(id, 'root', { id: id + '-model', subagentId: id, status: 'completed', text: '', reasoning: '', toolCallIds: [call.id] })
      h.db.subagentProjection.recordProjectedToolActivity(id, 'root', call, id === 'child' ? 'completed' : 'running', id)
    }
    h.reopen()
    expect(h.db.messages.activities.getRunActivity('child-run')?.models).toHaveLength(2)
    const progress = h.db.messages.activities.getRunProcessActivity('child-run')
    expect(progress).toMatchObject({ modelRounds: 1, toolCalls: 1, activeTools: [], latestModel: { text: 'child answer', reasoning: 'child reasoning' } })
    expect(h.db.messages.activities.getRunProcessActivity('grandchild-run').activeTools).toHaveLength(1)
  } finally { h.close() }
})

it('rebuilds v1 descendant approval cards from native identities without granting or replaying them', async () => {
  const h = await fixture()
  try {
    const calls: (ExecutionToolCall & { args: { path: string } })[] = ['first', 'second'].map(id => ({ id, providerCallId: 'shared-provider', name: 'write_file', args: { path: id },
      artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }))
    h.db.runs.store.acceptModel(h.scope(), { id: 'model', value: { kind: 'assistant', content: '',
      calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
    h.db.runs.store.prepareTools(h.scope(), calls.map(call => ({ callId: call.id, args: call.args, authorization: { approval: 'pending' } })), [{
      id: 'approval', generation: 'original-generation', kind: 'tool', callIds: calls.map(call => call.id), request: {
        actionRequests: calls.map(call => ({ name: call.name, args: call.args, description: 'Confirm' })),
        reviewConfigs: calls.map(call => ({ actionName: call.name, allowedDecisions: ['approve', 'reject'] }))
      }
    }])
    const original = h.db.runs.store.load(h.owner.threadId)
    h.sql.prepare('DELETE FROM agent_tool_messages WHERE run_id=?').run(h.owner.runId)
    h.sql.prepare("DELETE FROM agent_activities WHERE run_id=? AND kind='tool'").run(h.owner.runId)
    h.sql.prepare('INSERT INTO agent_tool_messages VALUES(?,?,?,?,NULL)').run(h.owner.threadId, h.owner.runId, 'shared-provider', 'model')
    const oldCall = { id: 'shared-provider', name: 'write_file', args: { path: 'second' } }
    h.db.messages.observations.recordTool(h.owner.runId, oldCall, 'running')
    h.db.subagentProjection.recordProjectedModelActivity('grandchild', 'root', { id: 'projected-model', messageId: 'model', subagentId: 'grandchild',
      status: 'completed', text: '', reasoning: '', toolCallIds: ['shared-provider', 'shared-provider'] })
    h.db.subagentProjection.recordProjectedToolApproval('grandchild', 'root', oldCall,
      { status: 'pending_approval', interruptId: 'approval', actionIndex: 1 }, 'grandchild')
    h.reopen(); h.db.recover()
    expect(h.db.runs.store.load(h.owner.threadId)).toEqual(original)
    for (const run of ['grandchild-run', 'child-run', 'root-run']) {
      const tools = h.db.messages.activities.getRunActivity(run)!.tools
      expect(tools.map(tool => [tool.call.id, tool.call.args, tool.approval?.actionIndex]), run)
        .toEqual(calls.map((call, index) => [call.id, call.args, index]))
      expect(tools.every(tool => tool.approval?.interruptId === 'approval')).toBe(true)
    }
    const before = h.db.readSnapshot('root')
    h.reopen(); h.db.recover()
    expect(h.db.readSnapshot('root')).toEqual(before)
    expect(h.db.runs.store.load(h.owner.threadId)).toEqual(original)
  } finally { h.close() }
})
