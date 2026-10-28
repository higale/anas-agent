import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExecutionMessageInput, ExecutionToolCall } from '../../runtime/executionState'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { AgentStorage } from './agentStorage'
import { getAgentConversationDatabaseFile, getAgentAttachmentsDir } from '../config/dataDir'
import { RunSubmissionStore } from './runSubmissionStore'
import { NativeRunOwner } from './nativeRunOwner'
import { NativeMessageProjection } from './nativeMessageProjection'
import { archiveAgentAttachments } from './agentAttachmentStore'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import type { SubagentSubmission } from './subagentTaskStore'

function fixture(operation: 'agent' | 'compression' = 'agent', createRun = true) {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-intents-'))
  const storage = AgentStorage.openNative(root), thread = storage.createThread()
  const product = storage.conversationForThread(thread.id), file = getAgentConversationDatabaseFile(thread.id, root)
  let sql = new Database(file); sql.pragma('foreign_keys=ON')
  if (createRun) new RunSubmissionStore(sql).createRun(thread.id, 'run', operation)
  let owner = new NativeRunOwner(sql, commit => new NativeMessageProjection(sql).commit(commit))
  const identity = { threadId: thread.id, runId: 'run' }
  return { root, product, identity, attachmentRoot: getAgentAttachmentsDir(thread.id, root), get submissions() { return new RunSubmissionStore(sql) }, get sql() { return sql }, get owner() { return owner },
    scope() { return { ...identity, expectedRevisionId: owner.store.load(thread.id)!.revisionId } },
    // Reopen the native owner without changing its durable execution facts.
    reopen() { sql.close(); sql = new Database(file); sql.pragma('foreign_keys=ON'); owner = new NativeRunOwner(sql, commit => new NativeMessageProjection(sql).commit(commit)) },
    dispose() { sql.close(); storage.close(); rmSync(root, { recursive: true, force: true }) } }
}
const input = (runId = 'run'): ExecutionMessageInput => ({ id: `${runId}:input`, value: { id: `${runId}:input`, kind: 'user', content: '',
  artifact: new Map([['bytes', new Uint8Array([0, 255])]]), context: { runId, displayText: '', createdAt: 'saved-time' } } })
function call(): ExecutionToolCall & { args: Record<string, unknown> } { return { id: 'call', providerCallId: 'provider', name: 'write_file', args: { path: 'fixture' },
  artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `call:${purpose}`])) as ExecutionToolCall['artifacts'] } }
function approval(h: Pick<ReturnType<typeof fixture>, 'owner' | 'scope'>) {
  const pending = call()
  h.owner.store.acceptModel(h.scope(), { id: 'response', value: { id: 'response', kind: 'assistant', content: '',
    calls: [{ id: pending.providerCallId, name: pending.name, args: pending.args }] } }, [pending], { modelCalls: 1, todos: [] })
  h.owner.store.prepareTools(h.scope(), [{ callId: pending.id, args: pending.args, authorization: { approval: 'pending' } }], [
    { id: 'approval', generation: 'generation', kind: 'tool', callIds: [pending.id], request: {
      actionRequests: [{ name: pending.name, args: pending.args, description: 'Approve fixture' }],
      reviewConfigs: [{ actionName: pending.name, allowedDecisions: ['approve', 'reject'] }] } }
  ])
}
const answer = (type: 'approve' | 'reject' = 'approve') => [{ id: 'approval', generation: 'generation', response: { decisions: [{ type }] } }]
function childSubmission(h: ReturnType<typeof fixture>): SubagentSubmission {
  return { id: 'child', ownerThreadId: h.identity.threadId, parentThreadId: h.identity.threadId,
    parentRunId: 'run', childThreadId: 'child-thread', childRunId: 'child-run', description: 'Child task', childThread: {},
    config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'reviewer', enabled: true, builtIn: false, description: 'Review', systemPrompt: 'Review' } }
}

describe('native durable input and resume owner', () => {
  it.each(['missing', 'not-detached', 'queued', 'wrong-owner', 'registered', 'approved-retry', 'completed'] as const)('allows only an owned live background effect during a saved wait: %s', async scenario => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const requested = call(), key = { ...h.identity, callId: requested.id }, boundary = { kind: 'file_patch', target: { path: 'fixture' } }
      h.owner.store.acceptModel(h.scope(), { id: 'response', value: { kind: 'assistant', content: '', calls: [{ id: requested.providerCallId, name: requested.name, args: requested.args }] } }, [requested], { modelCalls: 1, todos: [] })
      h.owner.store.prepareTools(h.scope(), [{ callId: requested.id, args: requested.args }])
      h.owner.store.prepareEffect(key, 'confirm')
      if (scenario === 'approved-retry') {
        h.owner.store.armEffect(key, boundary)
        h.owner.store.retryEffect(key, { kind: 'approved', expectedConfirmationCount: 0 })
      }
      if (scenario !== 'missing') {
        const identity = scenario === 'wrong-owner' ? { threadId: h.owner.createThread().id, runId: 'foreign' } : h.identity
        if (scenario === 'wrong-owner') h.owner.createRun({ ...identity, operation: 'agent', message: input('foreign') })
        const id = requested.artifacts['managed-call']
        h.product.managed.createManagedCall({ id, ...identity, kind: 'builtin', summary: 'Saved work' })
        if (scenario !== 'queued') h.product.managed.markManagedCallRunning(id, identity.threadId)
        if (scenario !== 'not-detached') h.product.managed.markManagedCallDetached(id, identity.threadId)
        if (scenario === 'completed') h.product.managed.finishManagedCall({ callId: id, threadId: identity.threadId, status: 'completed' })
      }
      h.owner.store.wait(h.scope(), [{ id: 'wait', generation: 'generation', kind: 'tool', callIds: [requested.id], request: {
        actionRequests: [{ name: requested.name, args: requested.args, description: 'Wait' }], reviewConfigs: [{ actionName: requested.name, allowedDecisions: ['approve', 'reject'] }] } }])
      h.reopen()
      const before = h.owner.store.loadEffect(key)
      if (['queued', 'registered', 'approved-retry'].includes(scenario)) {
        expect(h.owner.store.armEffect(key, boundary)).toMatchObject({ state: 'intent', effectAttempt: scenario === 'approved-retry' ? 2 : 1 })
        const armed = h.owner.store.loadEffect(key)
        expect(() => h.owner.store.retryEffect(key, { kind: 'approved', expectedConfirmationCount: 99 })).toThrow('ordinal or mode changed')
        expect(h.owner.store.loadEffect(key)).toEqual(armed)
      } else {
        expect(() => h.owner.store.armEffect(key, boundary)).toThrow('Only an owned detached call')
        expect(h.owner.store.loadEffect(key)).toEqual(before)
      }
      expect(h.owner.readInterrupts(h.identity)).toHaveLength(1)
      expect(() => h.owner.store.prepareEffect({ ...key, callId: 'new-call' }, 'confirm')).toThrow('active tool batch')
    } finally { h.dispose() }
  })

  it('accepts existing product approval responses against durable native requests and rejects stale or duplicate submissions', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity); approval(h)
      const pending = h.owner.readInterrupts(h.identity)
      expect(pending).toHaveLength(1)
      expect(h.product.getThread(h.identity.threadId)?.status).toBe('interrupted')
      expect(h.product.readModel.getRun('run')?.status).toBe('interrupted')
      expect(() => h.owner.createRun({ threadId: h.identity.threadId, runId: 'blocked', operation: 'agent', message: input('blocked') })).toThrow('active execution')
      expect(pending[0].value).toEqual(h.owner.store.load(h.identity.threadId)!.approvals[0].request)
      const response = { interruptId: pending[0].id, expectedGeneration: pending[0].approvalGeneration!, decisions: [{ type: 'approve' as const }] }
      expect(() => h.owner.saveResponses({ ...h.identity, responses: [{ ...response, expectedGeneration: 'stale' }] })).toThrow('current approval generation')
      expect(() => h.owner.saveResponses({ ...h.identity, responses: [response, response] })).toThrow('match the current durable root interrupts')
      expect(h.sql.prepare('SELECT * FROM agent_run_resume_intents').all()).toEqual([])
      h.reopen(); expect(h.owner.readInterrupts(h.identity)).toEqual(pending)
      h.owner.saveResponses({ ...h.identity, responses: [response] }); h.owner.saveResponses({ ...h.identity, responses: [response] })
      expect(h.owner.store.load(h.identity.threadId)!.phase).toBe('waiting')
      h.reopen(); await h.owner.enter('resume', h.identity)
      expect(h.owner.store.load(h.identity.threadId)!.calls[0].authorization?.approval).toBe('granted')
      expect(h.owner.readInterrupts(h.identity)).toEqual([])
      expect(() => h.owner.saveResponses({ ...h.identity, responses: [response] })).toThrow('match the current durable root interrupts')
      expect(h.product.readModel.getRun('run')?.status).toBe('running')
      expect(h.product.getThread(h.identity.threadId)?.accessMode).toBe('read_only_allowed')
      h.owner.requestCancellation(h.identity); h.owner.completeCancellation(h.identity)
      expect(h.product.getThread(h.identity.threadId)?.status).toBe('idle')
    } finally { h.dispose() }
  })

  it('keeps product approval identity stable across sibling commits, but changes it when the requested target changes', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const calls = [{ ...call(), name: 'wait_subagent', args: { subagent_id: 'child' } }, { ...call(), id: 'sibling', providerCallId: 'sibling-provider' }]
      h.owner.store.acceptModel(h.scope(), { id: 'response', value: { kind: 'assistant', content: '',
        calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
      h.owner.store.prepareTools(h.scope(), calls.map(call => ({ callId: call.id, args: call.args })))
      const wait = { id: 'wait', generation: 'generation', kind: 'subagent' as const, callIds: ['call'] as [string], subagentId: 'child', childGeneration: 'child-generation', request: {
        actionRequests: [{ name: 'write_file', args: { path: 'original' }, description: 'Child request' }],
        reviewConfigs: [{ actionName: 'write_file', allowedDecisions: ['approve', 'reject'] as Array<'approve' | 'reject'> }] } }
      h.owner.store.wait(h.scope(), [wait])
      const original = h.owner.readInterrupts(h.identity)
      expect(original[0].value).toMatchObject({ anasSubagentApproval: { generation: 'child-generation' } })
      const exposed = h.owner.readInterrupts(h.identity); (exposed[0].value as typeof wait.request).actionRequests[0].args.path = 'local mutation'
      expect(h.owner.readInterrupts(h.identity)).toEqual(original)
      h.owner.store.settleCall(h.identity, 'sibling', { id: 'sibling-result', value: { kind: 'tool', resultFor: 'sibling-provider', content: 'Saved' } })
      expect(h.owner.readInterrupts(h.identity)).toEqual(original)
      h.owner.store.wait(h.scope(), [{ ...wait, request: { ...wait.request,
        actionRequests: [{ ...wait.request.actionRequests[0], args: { path: 'changed' } }] } }])
      expect(h.owner.readInterrupts(h.identity)[0].approvalGeneration).not.toBe(original[0].approvalGeneration)
      expect(() => h.owner.saveResponses({ ...h.identity, responses: [{ interruptId: 'wait', expectedGeneration: original[0].approvalGeneration!, decisions: [{ type: 'approve' }] }] })).toThrow('current approval generation')
    } finally { h.dispose() }
  })

  it('keeps tool-call narration out of the child final answer, matching the visible history', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const task = h.owner.createSubagentCall(childSubmission(h)), child = { threadId: task.childThreadId, runId: task.childRunId }
      await h.owner.enter('input', child)
      const scope = () => ({ ...child, expectedRevisionId: h.owner.store.load(child.threadId)!.revisionId }), pending = call()
      h.owner.store.acceptModel(scope(), { id: 'tool-response', value: { kind: 'assistant', content: 'Calling a tool',
        calls: [{ id: pending.providerCallId, name: pending.name, args: pending.args }] } }, [pending], { modelCalls: 1, todos: [] })
      h.owner.store.prepareTools(scope(), [{ callId: pending.id, args: pending.args }])
      h.owner.store.settleCall(child, pending.id, { id: 'tool-result', value: { kind: 'tool', resultFor: pending.providerCallId, content: 'Tool output' } })
      h.owner.store.finishBatch(scope()); h.owner.store.finish(scope(), 'completed')
      expect(h.owner.reconcileSubagent(task.id, task.ownerThreadId)?.call).toMatchObject({ status: 'completed', result: '' })
    } finally { h.dispose() }
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('settles a %s child once from its own durable execution and closes projected work', async outcome => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const task = h.owner.createSubagentCall(childSubmission(h)), child = { threadId: task.childThreadId, runId: task.childRunId }
      await h.owner.enter('input', child)
      const scope = () => ({ ...child, expectedRevisionId: h.owner.store.load(child.threadId)!.revisionId })
      h.product.subagentProjection.recordProjectedModelActivity(task.id, task.ownerThreadId, { id: 'observed', status: 'running', subagentId: task.id,
        text: 'Observed text is not a saved result', reasoning: '', toolCallIds: [] })
      h.product.subagentProjection.recordProjectedToolActivity(task.id, task.ownerThreadId, { id: 'observed-tool', name: 'read_file', args: {} }, 'running', task.id)
      h.owner.store.acceptModel(scope(), { id: 'final', value: { kind: 'assistant', content: [{ type: 'text', text: 'Saved child answer' }, { type: 'reasoning', text: 'Private reasoning' }] } }, [], { modelCalls: 1, todos: [] })
      h.owner.store.finish(scope(), outcome, outcome === 'failed' ? 'Child provider failure' : undefined)
      expect(h.owner.subagents.find(task.id, task.ownerThreadId)?.status).toBe('running')
      h.sql.exec("CREATE TRIGGER fail_child_terminal BEFORE UPDATE ON agent_activities WHEN NEW.activity_id='child' BEGIN SELECT RAISE(ABORT,'child transition failed'); END")
      expect(() => h.owner.reconcileSubagent(task.id, task.ownerThreadId)).toThrow('child transition failed')
      expect(h.owner.subagents.find(task.id, task.ownerThreadId)?.status).toBe('running')
      h.sql.exec('DROP TRIGGER fail_child_terminal'); h.reopen()
      const transition = h.owner.reconcileSubagent(task.id, task.ownerThreadId)!
      expect(transition.call.status).toBe(outcome)
      expect(transition.call.result).toBe(outcome === 'completed' ? 'Saved child answer' : undefined)
      expect(transition.call.error).toBe(outcome === 'failed' ? 'Child provider failure' : undefined)
      expect(h.product.messages.activities.getRunActivity('run')!.models[0]).toMatchObject({ id: 'observed', status: 'completed' })
      expect(h.product.messages.activities.getRunActivity('run')!.tools[0].status).toBe('completed')
      expect(h.product.readModel.getRun('run')?.status).toBe('running')
      expect(h.owner.reconcileSubagent(task.id, task.ownerThreadId)).toBeUndefined()
      expect(h.owner.subagents.finish({ subagentId: task.id, ownerThreadId: task.ownerThreadId, status: 'completed', result: 'Late update' })).toBeUndefined()
      expect(h.owner.subagents.find(task.id, task.ownerThreadId)).toEqual(transition.call)
    } finally { h.dispose() }
  })

  it('tracks child pause and resume from native state, including a pending idle head', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const parent = h.owner.store.load(h.identity.threadId), task = h.owner.createSubagentCall(childSubmission(h))
      const child = { threadId: task.childThreadId, runId: task.childRunId }
      expect(h.owner.store.readHistory(child.threadId)?.messages).toEqual([])
      h.reopen()
      expect(h.owner.reconcileSubagent(task.id, task.ownerThreadId)).toBeUndefined()
      expect(h.sql.prepare('SELECT 1 FROM agent_run_input_intents WHERE run_id=?').get(child.runId)).toBeDefined()
      expect(h.owner.store.load(child.threadId)).toBeUndefined()
      await h.owner.enter('input', child)
      const scope = () => ({ ...child, expectedRevisionId: h.owner.store.load(child.threadId)!.revisionId })
      approval({ owner: h.owner, scope })
      expect(h.owner.reconcileSubagent(task.id, task.ownerThreadId)?.call.status).toBe('interrupted')
      h.sql.prepare("UPDATE agent_runs SET status='completed' WHERE id=?").run(child.runId)
      expect(() => h.owner.reconcileSubagent(task.id, task.ownerThreadId)).toThrow('disagree about their status')
      expect(h.owner.subagents.find(task.id, task.ownerThreadId)?.status).toBe('interrupted')
      h.sql.prepare("UPDATE agent_runs SET status='interrupted' WHERE id=?").run(child.runId)
      h.owner.subagents.recordRecoveryFailure(task.id, task.ownerThreadId, 'Temporary recovery failure')
      h.owner.saveAnswers(scope(), answer()); await h.owner.enter('resume', child)
      expect(h.owner.reconcileSubagent(task.id, task.ownerThreadId)?.call).toMatchObject({ status: 'running' })
      expect(h.owner.subagents.find(task.id, task.ownerThreadId)?.error).toBeUndefined()
      expect(h.owner.store.load(h.identity.threadId)).toEqual(parent)
    } finally { h.dispose() }
  })

  it('keeps an unreadable completed child recoverable without inventing an empty successful result', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const task = h.owner.createSubagentCall(childSubmission(h)), child = { threadId: task.childThreadId, runId: task.childRunId }
      await h.owner.enter('input', child)
      const scope = () => ({ ...child, expectedRevisionId: h.owner.store.load(child.threadId)!.revisionId })
      h.owner.store.acceptModel(scope(), { id: 'final', value: { kind: 'assistant', content: 'Confirmed answer' } }, [], { modelCalls: 1, todos: [] })
      h.owner.store.finish(scope(), 'completed')
      const row = h.sql.prepare("SELECT record_id,value FROM execution_message_bodies WHERE thread_id=? AND message_id='final'").get(child.threadId) as { record_id: string; value: Buffer }
      h.sql.prepare('UPDATE execution_message_bodies SET value=? WHERE thread_id=? AND record_id=?').run(Buffer.from('broken'), child.threadId, row.record_id)
      const failedRead = h.owner.reconcileSubagent(task.id, task.ownerThreadId)!
      expect(failedRead.call.status).toBe('running'); expect(failedRead.call.result).toBeUndefined()
      expect(failedRead.call.error).toContain('final result could not be read')
      expect(h.product.readModel.getRun(child.runId)?.status).toBe('completed')
      h.sql.prepare('UPDATE execution_message_bodies SET value=? WHERE thread_id=? AND record_id=?').run(row.value, child.threadId, row.record_id)
      h.reopen()
      expect(h.owner.reconcileSubagent(task.id, task.ownerThreadId)?.call).toMatchObject({ status: 'completed', result: 'Confirmed answer' })
      expect(h.owner.subagents.find(task.id, task.ownerThreadId)?.error).toBeUndefined()
    } finally { h.dispose() }
  })

  it('persists failure details with the terminal head and rolls them back if the owning commit fails', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const before = h.owner.store.load(h.identity.threadId), reason = 'Provider rejected this request: invalid model'
      h.sql.exec("CREATE TRIGGER fail_failure_record BEFORE UPDATE ON agent_runs WHEN NEW.status='failed' BEGIN SELECT RAISE(ABORT,'failure save failed'); END")
      expect(() => h.owner.store.finish(h.scope(), 'failed', reason)).toThrow('failure save failed')
      expect(h.owner.store.load(h.identity.threadId)).toEqual(before)
      expect(h.product.readModel.getRun('run')).toMatchObject({ status: 'running', error: undefined })
      expect(h.product.resourceCleanup.listFileEditCleanupRunIds()).not.toContain('run')
      h.sql.exec('DROP TRIGGER fail_failure_record')
      expect(() => h.owner.store.finish(h.scope(), 'completed', reason)).toThrow('Only a failed run')
      h.owner.store.finish(h.scope(), 'failed', reason); h.reopen()
      expect(h.owner.store.load(h.identity.threadId)?.phase).toBe('failed')
      expect(h.product.readModel.getRun('run')).toMatchObject({ status: 'failed', error: reason })
      expect(h.product.getThread(h.identity.threadId)?.status).toBe('failed')
      expect(h.product.messages.activities.getRunActivity('run')).toMatchObject({
        runId: 'run', status: 'failed', error: reason, createdAt: expect.any(String), updatedAt: expect.any(String), models: [], tools: [], subagents: []
      })
    } finally { h.dispose() }
  })

  it.each([false, true])('creates hidden nested tasks with native inputs and preserves their configuration across reopening (custom=%s)', async custom => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const selection = custom ? { modelConfigId: 'review-model', modelParameterPresetId: 'careful' } : {}
      const config = { capabilities: { ...structuredClone(defaultCapabilities), subagents: { mode: 'custom' as const, names: ['researcher'] } },
        index: 0, name: 'reviewer', enabled: false, builtIn: false, description: 'Review changes', systemPrompt: 'Inspect changes', ...selection }
      const expectedConfig = structuredClone(config)
      const submission: SubagentSubmission = { id: 'child', ownerThreadId: h.identity.threadId, parentThreadId: h.identity.threadId,
        parentRunId: 'run', childThreadId: 'child-thread', childRunId: 'child-run', config, description: 'First task',
        childThread: { title: 'Child', ...selection, accessMode: 'strict_approval' } }
      expect(() => h.owner.createSubagentCall({ ...submission, config: { ...config, systemPrompt: '' } })).toThrow('must not be empty')
      expect(h.product.getThread(submission.childThreadId)).toBeNull()
      const child = h.owner.createSubagentCall(submission)
      const nested: SubagentSubmission = { id: 'grandchild', ownerThreadId: h.identity.threadId, parentThreadId: child.childThreadId,
        parentRunId: child.childRunId, parentSubagentId: child.id, childThreadId: 'grandchild-thread', childRunId: 'grandchild-run', config,
        description: 'Nested task', childThread: { title: 'Nested' } }
      h.sql.exec("CREATE TRIGGER fail_projected_child BEFORE INSERT ON agent_activities WHEN NEW.run_id='run' AND NEW.activity_id='grandchild' BEGIN SELECT RAISE(ABORT,'ancestor failed'); END")
      expect(() => h.owner.createSubagentCall(nested)).toThrow('ancestor failed')
      expect(h.product.getThread(nested.childThreadId)).toBeNull()
      expect(h.product.messages.activities.getRunActivity(child.childRunId)!.subagents).toEqual([])
      expect(h.owner.subagents.find(child.id, h.identity.threadId)).toEqual(child)
      h.sql.exec('DROP TRIGGER fail_projected_child')
      const grandchild = h.owner.createSubagentCall(nested)
      config.systemPrompt = 'Changed configuration'
      expect(h.sql.prepare('SELECT id FROM agent_threads WHERE id NOT IN (SELECT thread_id FROM agent_hidden_threads)').all().map(row => (row as { id: string }).id)).toEqual([h.identity.threadId])
      expect(h.product.getThread(child.childThreadId)).toMatchObject({ status: 'running', accessMode: 'strict_approval', ...selection })
      expect(h.owner.store.load(child.childThreadId)).toBeUndefined()
      const activities = h.product.messages.activities.getRunActivity('run')!.subagents
      expect(activities.map(activity => activity.id)).toEqual([child.id, grandchild.id])
      expect(activities[1]).toMatchObject({ parentSubagentId: child.id, status: 'running' })
      expect(activities[1].startedAt).toBe(h.product.messages.activities.getRunActivity(child.childRunId)!.subagents[0].startedAt)
      h.reopen()
      expect(h.owner.subagents.find(child.id, h.identity.threadId)?.config).toEqual(expectedConfig)
      expect(h.product.getThread(child.childThreadId)?.modelConfigId).toBe(selection.modelConfigId)
      expect(h.product.getThread(child.childThreadId)?.modelParameterPresetId).toBe(selection.modelParameterPresetId)
      for (const task of [child, grandchild]) {
        const identity = { threadId: task.childThreadId, runId: task.childRunId }
        await h.owner.enter('continue', identity); await h.owner.enter('continue', identity)
        expect(h.owner.store.load(identity.threadId)?.messages).toMatchObject([{ id: `${identity.runId}:input`,
          value: { kind: 'user', content: task.description, context: { runId: identity.runId } } }])
        expect(h.sql.prepare('SELECT 1 FROM agent_run_input_intents WHERE run_id=?').get(identity.runId)).toBeUndefined()
      }
      expect(h.sql.pragma('foreign_key_check')).toEqual([])
    } finally { h.dispose() }
  })

  it('rolls child identity, native input, ancestor activity and the parent effect back together', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const pending = { ...call(), name: 'task', args: {} }
      h.owner.store.acceptModel(h.scope(), { id: 'response', value: { kind: 'assistant', content: '', calls: [{ id: pending.providerCallId, name: pending.name, args: {} }] } }, [pending], { modelCalls: 1, todos: [] })
      h.owner.store.prepareTools(h.scope(), [{ callId: pending.id, args: {} }])
      const effect = { ...h.identity, callId: pending.id }
      h.owner.store.prepareEffect(effect, 'confirm')
      const submission: SubagentSubmission = { id: 'child', ownerThreadId: h.identity.threadId, parentThreadId: h.identity.threadId,
        parentRunId: 'run', childThreadId: 'child-thread', childRunId: 'child-run', description: 'Child task', childThread: {},
        config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'reviewer', enabled: true, builtIn: false, description: 'Review', systemPrompt: 'Review' } }
      let armCalls = 0
      const arm = () => { armCalls++; h.owner.store.armEffect(effect, { kind: 'subagent-start', target: { subagentId: submission.id,
        childThreadId: submission.childThreadId, childRunId: submission.childRunId }, recoveryMode: 'idempotent' }) }
      const original = h.owner.store.loadEffect(effect)
      for (const table of ['agent_hidden_threads', 'agent_run_input_intents', 'agent_subagent_calls', 'agent_activities']) {
        h.sql.exec(`CREATE TRIGGER fail_child_create BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'child creation failed'); END`)
        expect(() => h.owner.createSubagentCall(submission, arm)).toThrow('child creation failed')
        expect(h.owner.store.loadEffect(effect)).toEqual(original)
        expect(h.product.getThread('child-thread')).toBeNull(); expect(h.product.readModel.getRun('child-run')).toBeNull()
        expect(h.owner.subagents.find('child', h.identity.threadId)).toBeUndefined()
        expect(h.product.messages.activities.getRunActivity('run')!.subagents).toEqual([])
        h.sql.exec('DROP TRIGGER fail_child_create')
      }
      const beforeValidation = armCalls
      expect(() => h.owner.createSubagentCall({ ...submission, childThreadId: h.identity.threadId }, arm)).toThrow('already exists')
      expect(() => h.owner.createSubagentCall({ ...submission, childThread: { projectId: 'foreign-project' } }, arm)).toThrow('owning conversation project')
      expect(armCalls).toBe(beforeValidation)
      expect(h.owner.store.loadEffect(effect)).toEqual(original)
      h.owner.createSubagentCall(submission, arm); h.reopen()
      expect(armCalls).toBe(beforeValidation + 1)
      expect(h.owner.store.loadEffect(effect)).toMatchObject({ state: 'intent', effectKind: 'subagent-start', effectAttempt: 1 })
      expect(() => h.owner.createSubagentCall(submission, arm)).toThrow('already exists')
      expect(armCalls).toBe(beforeValidation + 1)
      expect(h.sql.prepare('SELECT id FROM agent_subagent_calls WHERE owner_thread_id=?').all(h.identity.threadId)).toHaveLength(1)
      expect(h.sql.pragma('foreign_key_check')).toEqual([])
    } finally { h.dispose() }
  })

  it('accepts the next saved input after history no longer has a run owner', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      h.owner.store.finish(h.scope(), 'completed')
      h.sql.transaction(() => h.owner.store.reviseHistory({ threadId: h.identity.threadId,
        expectedRevisionId: h.scope().expectedRevisionId, retainedCount: 0 }))()
      h.reopen()
      const next = { ...h.identity, runId: 'next' }
      h.owner.createRun({ ...next, operation: 'agent', message: input('next') })
      h.reopen(); await h.owner.enter('continue', next)
      expect(h.owner.store.load(next.threadId)?.messages.map(record => record.id)).toEqual(['next:input'])
      expect(h.product.readModel.getRun('next')?.status).toBe('running')
    } finally { h.dispose() }
  })

  it.each(['read_only_allowed', 'strict_approval', 'full_access'] as const)('atomically creates a conversation with the original %s selection and its first input', async accessMode => {
    const h = fixture('agent', false)
    try {
      const identity = { threadId: 'new-thread', runId: 'first-run' }
      const options = { title: '  First\n conversation  ', projectId: 'selected-project', modelConfigId: 'selected-model', modelParameterPresetId: 'selected-preset', accessMode }
      const submission = { ...identity, thread: options, message: input(identity.runId), submissionId: 'new-submission' }
      expect(() => h.owner.createThreadAndRun({ ...submission, submissionId: '' })).toThrow('requires a submission ID')
      for (const table of ['agent_run_input_intents', 'agent_runs']) {
        h.sql.exec(`CREATE TRIGGER fail_new_thread BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'new thread failed'); END`)
        expect(() => h.owner.createThreadAndRun(submission)).toThrow('new thread failed')
        expect(h.product.getThread(identity.threadId)).toBeNull()
        expect(h.product.readModel.getRun(identity.runId)).toBeNull()
        expect(h.sql.prepare('SELECT * FROM agent_run_input_intents').all()).toEqual([])
        h.sql.exec('DROP TRIGGER fail_new_thread')
      }
      const created = h.owner.createThreadAndRun(submission)
      const baseline = h.product.createThread(options)
      expect(created.thread).toEqual({ ...baseline, id: identity.threadId, status: 'running', userTurnCount: 1,
        createdAt: created.thread.createdAt, updatedAt: created.thread.updatedAt })
      expect(created.thread.title).toBe('First conversation')
      expect(h.product.messages.activities.getRunBySubmissionId(submission.submissionId)).toEqual(created.run)
      expect(() => h.owner.createThreadAndRun({ ...submission, threadId: 'duplicate-thread', runId: 'duplicate-run', message: input('duplicate-run') })).toThrow(/UNIQUE/)
      expect(h.product.getThread('duplicate-thread')).toBeNull()
      h.reopen(); await h.owner.enter('continue', identity)
      expect(h.owner.store.load(identity.threadId)?.messages.map(record => record.value)).toEqual([submission.message.value])
      expect(h.product.getThread(identity.threadId)).toMatchObject({ ...options, title: 'First conversation', status: 'running', userTurnCount: 1 })
      expect(h.sql.pragma('foreign_key_check')).toEqual([])
    } finally { h.dispose() }
  })

  it('submits the run, encoded input and archived attachments atomically before execution', async () => {
    const h = fixture('agent', false)
    try {
      const file = join(h.root, 'submission.txt'), bytes = 'Submission attachment'
      writeFileSync(file, bytes)
      const archived = await archiveAgentAttachments([{ path: file, name: 'submission.txt', mimeType: 'text/plain', size: Buffer.byteLength(bytes), kind: 'text', contextPolicy: 'conversation' }],
        { ...h.identity, messageId: 'run:input' }, h.attachmentRoot)
      const original = input(), snapshot = structuredClone(original)
      const submit = () => h.owner.createRun({ ...h.identity, operation: 'agent', message: original, attachments: archived, submissionId: 'submission' })
      const thread = h.product.getThread(h.identity.threadId)
      const foreignAttachment = structuredClone(archived)
      foreignAttachment[0].artifact.threadId = 'foreign'
      expect(() => h.owner.createRun({ ...h.identity, operation: 'agent', message: original, attachments: foreignAttachment })).toThrow('does not belong to run')
      expect(h.product.readModel.getRun('run')).toBeNull()
      expect(h.product.getThread(h.identity.threadId)).toEqual(thread)
      for (const table of ['agent_run_input_intents', 'agent_attachments']) {
        h.sql.exec(`CREATE TRIGGER fail_submission BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'submission failed'); END`)
        expect(submit).toThrow('submission failed')
        expect(h.product.readModel.getRun('run')).toBeNull()
        expect(h.product.getThread(h.identity.threadId)).toEqual(thread)
        expect(h.sql.prepare('SELECT * FROM agent_run_input_intents').all()).toEqual([])
        expect(h.product.resources.listAttachmentsForThread(h.identity.threadId)).toEqual([])
        expect(readFileSync(archived[0].artifact.path, 'utf8')).toBe(bytes)
        h.sql.exec('DROP TRIGGER fail_submission')
      }
      const run = submit()
      expect(h.product.messages.activities.getRunBySubmissionId('submission')).toEqual(run)
      expect(h.product.getThread(h.identity.threadId)).toMatchObject({ status: 'running', userTurnCount: 1 })
      expect(h.owner.store.load(h.identity.threadId)).toBeUndefined()
      expect(() => h.owner.createRun({ ...h.identity, runId: 'duplicate', operation: 'agent', message: input('duplicate') })).toThrow('busy')
      original.value.content = 'Mutated after submission'
      const foreign = h.product.createThread()
      expect(() => h.owner.createRun({ threadId: foreign.id, runId: 'duplicate-submission', operation: 'agent',
        message: input('duplicate-submission'), submissionId: 'submission' })).toThrow(/UNIQUE/)
      expect(h.product.getThread(foreign.id)).toEqual(foreign)
      h.reopen(); await h.owner.enter('continue', h.identity)
      expect(h.owner.store.load(h.identity.threadId)?.messages.map(record => record.value)).toEqual([snapshot.value])
      expect(h.product.resources.listAttachmentsForMessages(h.identity.threadId, ['run:input'])).toMatchObject([{ id: archived[0].artifact.id, available: true }])
      h.reopen(); await h.owner.enter('continue', h.identity)
      expect(h.owner.store.load(h.identity.threadId)?.messages).toHaveLength(1)
      expect(h.sql.prepare('SELECT * FROM agent_run_input_intents').all()).toEqual([])
      expect(h.sql.pragma('foreign_key_check')).toEqual([])
    } finally { h.dispose() }
  })

  it('rejects mismatched inputs and active execution, and submits compression against the completed history', async () => {
    const h = fixture('agent', false)
    try {
      expect(() => h.owner.createRun({ ...h.identity, operation: 'agent' })).toThrow('does not match')
      expect(() => h.owner.createRun({ ...h.identity, operation: 'compression', message: input() })).toThrow('does not match')
      expect(() => h.owner.createRun({ ...h.identity, operation: 'agent', message: input('foreign') })).toThrow('owned user message')
      expect(h.product.getThread(h.identity.threadId)?.status).toBe('idle')
      h.owner.createRun({ ...h.identity, operation: 'agent', message: input() })
      await h.owner.enter('input', h.identity)
      // A contradictory UI status must not allow a second execution owner.
      h.sql.prepare("UPDATE agent_threads SET status='idle' WHERE id=?").run(h.identity.threadId)
      expect(() => h.owner.createRun({ ...h.identity, runId: 'competing', operation: 'agent', message: input('competing') })).toThrow('active execution')
      expect(h.product.readModel.getRun('competing')).toBeNull()
      h.sql.prepare("UPDATE agent_threads SET status='running' WHERE id=?").run(h.identity.threadId)
      h.owner.store.acceptModel(h.scope(), { id: 'answer', value: { kind: 'assistant', content: 'Saved answer' } }, [], { modelCalls: 1, todos: [] })
      h.owner.store.finish(h.scope(), 'completed')
      const history = h.owner.store.load(h.identity.threadId)!.messages
      const next = { ...h.identity, runId: 'compression' }
      h.owner.createRun({ ...next, operation: 'compression' }); h.reopen()
      await h.owner.enter('continue', next)
      expect(h.owner.store.load(next.threadId)).toMatchObject({ runId: next.runId, phase: 'prepare_model', messages: history, context: { modelCalls: 0 } })
      expect(h.product.readModel.getRun(next.runId)?.operation).toBe('compression')
      expect(h.product.getThread(next.threadId)?.userTurnCount).toBe(1)
      h.owner.store.finish({ ...next, expectedRevisionId: h.owner.store.load(next.threadId)!.revisionId }, 'completed')
      h.reopen()
      expect(h.product.getThread(next.threadId)).toMatchObject({ status: 'idle', userTurnCount: 1 })
    } finally { h.dispose() }
  })

  it.each(['completed', 'cancelled', 'failed'] as const)('retires only uncommitted summary activities when the run becomes %s', async status => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const summary = { id: 'confirmed', summaryText: 'Shown', modelContent: 'Saved', cutoffIndex: 1,
        activatedAfterMessageIndex: 0, inputTokensBefore: 20, inputTokensAfter: 10 }
      h.product.summaries.recordContextSummaryStarted('run', summary.id); h.product.summaries.stageContextSummary('run', summary.id, summary)
      h.owner.store.commitSummary(h.scope(), summary)
      h.product.summaries.recordContextSummaryStarted('run', 'provisional')
      const foreign = h.product.createThread(); h.submissions.createRun(foreign.id, 'foreign')
      h.product.summaries.recordContextSummaryStarted('foreign', 'provisional')
      const before = h.owner.store.load(h.identity.threadId), summaries = h.sql.prepare('SELECT * FROM agent_context_summaries').all()
      h.sql.exec("CREATE TRIGGER fail_summary_cleanup AFTER DELETE ON agent_context_summaries WHEN OLD.run_id='run' BEGIN SELECT RAISE(ABORT,'summary cleanup failed'); END")
      expect(() => h.owner.store.finish(h.scope(), status)).toThrow('summary cleanup failed')
      expect(h.owner.store.load(h.identity.threadId)).toEqual(before)
      expect(h.sql.prepare('SELECT * FROM agent_context_summaries').all()).toEqual(summaries)
      h.sql.exec('DROP TRIGGER fail_summary_cleanup'); h.owner.store.finish(h.scope(), status); h.reopen()
      expect(h.sql.prepare('SELECT run_id,summary_id,status FROM agent_context_summaries ORDER BY run_id').all()).toEqual([
        { run_id: 'foreign', summary_id: 'provisional', status: 'running' }, { run_id: 'run', summary_id: 'confirmed', status: 'completed' }
      ])
      expect(h.owner.store.load(h.identity.threadId)?.context.summary?.id).toBe(summary.id)
    } finally { h.dispose() }
  })
  it('accepts an exact saved input once across reopen and commits real run/thread lifecycle together', async () => {
    const h = fixture()
    try {
      const original = input(), snapshot = structuredClone(original)
      h.owner.saveInput(h.identity, original)
      original.value.content = 'changed after submission'
      h.reopen(); await h.owner.enter('continue', h.identity)
      expect(h.owner.store.load(h.identity.threadId)!.messages[0].value).toEqual(snapshot.value)
      expect(h.sql.prepare('SELECT * FROM agent_run_input_intents').all()).toEqual([])
      h.reopen(); await h.owner.enter('input', h.identity)
      expect(h.owner.store.load(h.identity.threadId)!.messages).toHaveLength(1)
      approval(h)
      expect(h.product.readModel.getRun('run')!.status).toBe('interrupted')
      h.owner.saveAnswers(h.scope(), answer('reject'))
      h.reopen(); await h.owner.enter('continue', h.identity)
      expect(h.product.readModel.getRun('run')!.status).toBe('running')
      expect(h.owner.store.load(h.identity.threadId)!.calls[0].result?.value.resultStatus).toBe('error')
      expect(h.sql.prepare('SELECT * FROM agent_run_resume_intents').all()).toEqual([])
      h.owner.store.finishBatch(h.scope()); h.owner.store.finish(h.scope(), 'completed')
      expect(h.product.readModel.getRun('run')!.status).toBe('completed')
      expect(h.product.getThread(h.identity.threadId)!.status).toBe('idle')
      h.reopen(); await h.owner.enter('continue', h.identity)
      const next = h.owner.createRun({ ...h.identity, runId: 'next', operation: 'agent', message: input('next') })
      await h.owner.enter('input', { ...h.identity, runId: next.id })
      expect(h.owner.store.load(h.identity.threadId)!.messages.filter(record => record.value.kind === 'user').map(record => record.id)).toEqual(['run:input', 'next:input'])
    } finally { h.dispose() }
  })

  it('rolls input acceptance back on failed consumption, retaining its original snapshot for retry', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input())
      h.sql.exec("CREATE TRIGGER fail_input BEFORE DELETE ON agent_run_input_intents BEGIN SELECT RAISE(ABORT,'consume failed'); END")
      await expect(h.owner.enter('input', h.identity)).rejects.toThrow('consume failed')
      expect(h.owner.store.load(h.identity.threadId)).toBeUndefined()
      expect(h.sql.prepare('SELECT count(*) AS count FROM execution_message_bodies').get()).toEqual({ count: 0 })
      expect(h.sql.prepare('SELECT count(*) AS count FROM agent_run_input_intents').get()).toEqual({ count: 1 })
      h.sql.exec('DROP TRIGGER fail_input'); h.reopen(); await h.owner.enter('continue', h.identity)
      expect(h.owner.store.load(h.identity.threadId)!.messages).toHaveLength(1)
    } finally { h.dispose() }
  })

  it('keeps grants and saved generations atomic when consuming a saved answer fails', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity); approval(h)
      expect(() => h.owner.saveAnswers(h.scope(), [{ ...answer()[0], generation: 'stale' }])).toThrow('generation changed')
      expect(() => h.owner.saveAnswers(h.scope(), [{ ...answer()[0], response: { decisions: [{ type: 'edit' }] } }])).toThrow('Unexpected human decision')
      expect(h.sql.prepare('SELECT * FROM agent_run_resume_intents').all()).toEqual([])
      h.owner.saveAnswers(h.scope(), answer()); h.owner.saveAnswers(h.scope(), answer())
      expect(() => h.owner.saveAnswers(h.scope(), answer('reject'))).toThrow('different saved answer')
      const before = h.owner.store.load(h.identity.threadId)
      h.sql.exec("CREATE TRIGGER fail_resume BEFORE DELETE ON agent_run_resume_intents BEGIN SELECT RAISE(ABORT,'consume failed'); END")
      await expect(h.owner.enter('resume', h.identity)).rejects.toThrow('consume failed')
      expect(h.owner.store.load(h.identity.threadId)).toEqual(before)
      expect(h.product.readModel.getRun('run')!.status).toBe('interrupted')
      h.sql.exec('DROP TRIGGER fail_resume'); h.reopen(); await h.owner.enter('continue', h.identity)
      expect(h.owner.store.load(h.identity.threadId)!.calls[0].authorization?.approval).toBe('granted')
      const applied = h.owner.store.load(h.identity.threadId)
      h.reopen(); await h.owner.enter('resume', h.identity)
      expect(h.owner.store.load(h.identity.threadId)).toEqual(applied)
      expect(h.sql.prepare('SELECT * FROM agent_run_resume_intents').all()).toEqual([])
    } finally { h.dispose() }
  })

  it('accepts manual compression without adding a synthetic user message and rejects foreign inputs', async () => {
    const h = fixture('compression')
    try {
      expect(() => h.owner.saveInput(h.identity, input())).toThrow('run operation')
      expect(() => h.owner.saveInput({ ...h.identity, threadId: 'foreign' })).toThrow('does not belong')
      h.owner.saveInput(h.identity)
      h.reopen(); await h.owner.enter('continue', h.identity)
      expect(h.owner.store.load(h.identity.threadId)!.messages).toEqual([])
      h.owner.store.finish(h.scope(), 'cancelled')
      expect(h.product.readModel.getRun('run')!.status).toBe('cancelled')
    } finally { h.dispose() }
  })

  it('preserves the existing plan for manual compression but clears it for a new user turn', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const todos = [{ content: 'Finish the existing task', status: 'in_progress' as const }]
      h.owner.store.prepareContext(h.scope(), { modelCalls: 2, todos })
      h.owner.store.finish(h.scope(), 'completed')
      const compression = { threadId: h.identity.threadId, runId: h.submissions.createRun(h.identity.threadId, 'compress', 'compression').id }
      h.owner.saveInput(compression); h.reopen(); await h.owner.enter('input', compression)
      const state = h.owner.store.load(compression.threadId)!
      expect(state.context).toMatchObject({ modelCalls: 0, todos })
      expect(state.messages.map(message => message.id)).toEqual(['run:input'])
      h.owner.store.finish({ ...compression, expectedRevisionId: state.revisionId }, 'completed')
      const next = { threadId: h.identity.threadId, runId: h.submissions.createRun(h.identity.threadId, 'next').id }
      h.owner.saveInput(next, input(next.runId)); h.reopen(); await h.owner.enter('input', next)
      expect(h.owner.store.load(next.threadId)!.context.todos).toEqual([])
    } finally { h.dispose() }
  })

  it.each(['manual', 'automatic'] as const)('confirms a staged %s summary in the same transaction as its native body and execution', async mode => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      let identity = h.identity
      if (mode === 'manual') {
        h.owner.store.finish(h.scope(), 'completed')
        identity = { threadId: h.identity.threadId, runId: h.submissions.createRun(h.identity.threadId, 'compression', 'compression').id }
        h.owner.saveInput(identity); await h.owner.enter('input', identity)
      }
      const staged = h.product.summaries.recordContextSummaryStarted(identity.runId)
      const summary = { id: staged.id, summaryText: 'Shown summary', modelContent: 'Model summary', cutoffIndex: 1,
        activatedAfterMessageIndex: 0, coveredThroughMessageId: 'run:input', inputTokensBefore: 80, inputTokensAfter: 20 }
      h.product.summaries.stageContextSummary(identity.runId, summary.id, summary)
      expect(h.owner.store.load(identity.threadId)!.context.summary).toBeUndefined()
      const before = h.owner.store.load(identity.threadId)!, scope = { ...identity, expectedRevisionId: before.revisionId }
      const save = () => mode === 'manual' ? h.owner.store.commitSummary(scope, summary, { completeRun: true })
        : h.owner.store.acceptModel(scope, { id: 'answer', value: { kind: 'assistant', content: 'Answer using the summary' } }, [], before.context, summary)
      h.sql.exec("CREATE TRIGGER fail_summary_terminal BEFORE UPDATE ON agent_threads BEGIN SELECT RAISE(ABORT,'projection failed'); END")
      expect(save).toThrow('projection failed')
      expect(h.owner.store.load(identity.threadId)).toEqual(before)
      expect(h.product.summaries.getCommittedContextSummary(identity.runId, summary.id)).toBeUndefined()
      h.sql.exec('DROP TRIGGER fail_summary_terminal'); h.reopen()
      const revision = save()
      const committed = h.product.summaries.getCommittedContextSummary(identity.runId, summary.id)
      expect(committed).toMatchObject({ id: summary.id, status: 'completed', committedRevisionId: revision,
        summaryText: summary.summaryText, modelContent: summary.modelContent, sequence: staged.sequence, createdAt: staged.createdAt })
      expect(h.owner.store.load(identity.threadId)!.phase).toBe(mode === 'manual' ? 'completed' : 'model_result')
      h.reopen(); await h.owner.enter('continue', identity)
      expect(h.product.summaries.getCommittedContextSummary(identity.runId, summary.id)).toEqual(committed)
      const retained = h.owner.store.load(identity.threadId)!.context.summary!
      expect(retained.id).toBe(summary.id)
      expect(h.owner.store.readMessageRecord(identity.threadId, retained.messageRecordId).value.content).toBe(summary.modelContent)
    } finally { h.dispose() }
  })

  it('rejects a summary completion whose staged content or owner does not match', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const summary = { id: 'missing', summaryText: 'Shown', modelContent: 'Model', cutoffIndex: 1,
        activatedAfterMessageIndex: 0, inputTokensBefore: 0, inputTokensAfter: 0 }
      const before = h.owner.store.load(h.identity.threadId)
      expect(() => h.owner.store.commitSummary(h.scope(), summary)).toThrow('staged summary')
      const foreignThread = h.product.createThread(), foreignRun = h.submissions.createRun(foreignThread.id, 'foreign')
      h.product.summaries.recordContextSummaryStarted(foreignRun.id, summary.id)
      h.product.summaries.stageContextSummary(foreignRun.id, summary.id, summary)
      expect(() => h.owner.store.commitSummary(h.scope(), summary)).toThrow('staged summary')
      h.product.summaries.recordContextSummaryStarted(h.identity.runId, summary.id)
      h.product.summaries.stageContextSummary(h.identity.runId, summary.id, { ...summary, modelContent: 'Different staged content' })
      expect(() => h.owner.store.commitSummary(h.scope(), summary)).toThrow('staged summary')
      expect(h.owner.store.load(h.identity.threadId)).toEqual(before)
      expect(h.sql.prepare('SELECT count(*) AS count FROM execution_message_bodies').get()).toEqual({ count: 1 })
      h.product.summaries.stageContextSummary(h.identity.runId, summary.id, summary)
      expect(() => h.owner.store.commitSummary(h.scope(), { ...summary, cutoffIndex: 0 })).toThrow('staged summary')
      expect(h.owner.store.load(h.identity.threadId)).toEqual(before)
      h.owner.store.commitSummary(h.scope(), summary)
      expect(h.product.summaries.getCommittedContextSummary(h.identity.runId, summary.id)).toMatchObject({ inputTokensBefore: 0, inputTokensAfter: 0 })
      expect(h.product.summaries.getCommittedContextSummary(foreignRun.id, summary.id)).toBeUndefined()
    } finally { h.dispose() }
  })

  it('cancels a saved but unconsumed approval atomically, without granting it on restart', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity); approval(h)
      h.owner.saveAnswers(h.scope(), answer())
      const before = h.owner.store.load(h.identity.threadId)
      h.sql.exec("CREATE TRIGGER fail_terminal BEFORE UPDATE OF status ON agent_threads WHEN NEW.status='idle' BEGIN SELECT RAISE(ABORT,'thread commit failed'); END")
      expect(() => h.owner.store.finish(h.scope(), 'cancelled')).toThrow('thread commit failed')
      expect(h.owner.store.load(h.identity.threadId)).toEqual(before)
      expect(h.sql.prepare('SELECT count(*) AS count FROM agent_run_resume_intents').get()).toEqual({ count: 1 })
      expect(h.product.readModel.getRun('run')!.status).toBe('interrupted')
      h.sql.exec('DROP TRIGGER fail_terminal')
      h.owner.store.finish(h.scope(), 'cancelled')
      h.reopen(); await h.owner.enter('continue', h.identity)
      expect(h.owner.store.load(h.identity.threadId)!.phase).toBe('cancelled')
      expect(h.sql.prepare('SELECT * FROM agent_run_resume_intents').all()).toEqual([])
      expect(h.product.readModel.getRun('run')!.status).toBe('cancelled')
    } finally { h.dispose() }
  })

  it.each([false, true])('commits and displays a selected direction with its archived attachment (provider IDs=%s)', async providerIds => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      const file = join(h.root, 'source.txt'), text = 'Keep the queued attachment bytes.'
      writeFileSync(file, text)
      const archived = await archiveAgentAttachments([{ path: file, name: 'source.txt', mimeType: 'text/plain', size: Buffer.byteLength(text), kind: 'text', contextPolicy: 'conversation' }],
        { threadId: h.identity.threadId, runId: 'selected', messageId: 'selected' }, h.attachmentRoot)
      h.product.queue.createQueuedInput({ id: 'selected', threadId: h.identity.threadId, text: 'Follow-up', displayText: 'Shown follow-up' }, archived)
      h.product.queue.createQueuedInput({ id: 'unselected', threadId: h.identity.threadId, text: 'Leave queued' }, [])
      expect(h.owner.queueDirection(h.identity, 'selected')).toBe(true)
      expect(h.owner.queueDirection(h.identity, 'selected')).toBe(true)
      h.reopen()
      expect(h.sql.prepare('SELECT queued_input_id FROM execution_queued_directions').all()).toEqual([{ queued_input_id: 'selected' }])
      approval(h)
      expect(h.owner.removeDirection(h.identity, 'selected')).toBe(false)
      expect(h.product.queue.getQueuedInput(h.identity.threadId, 'selected')).not.toBeNull()
      expect(h.owner.queueDirection(h.identity, 'selected')).toBe(false)
      h.owner.saveAnswers(h.scope(), answer('reject')); await h.owner.enter('resume', h.identity)
      expect(h.owner.queueDirection(h.identity, 'selected')).toBe(true)
      const before = h.owner.store.load(h.identity.threadId)!, directions = await h.owner.directions(before)
      expect(directions.map(message => message.id)).toEqual(['run:direction:selected'])
      expect(directions[0].value.context?.directionAfterCallIds).toEqual(['call'])
      h.sql.exec("CREATE TRIGGER fail_direction BEFORE DELETE ON agent_queued_inputs BEGIN SELECT RAISE(ABORT,'queue consume failed'); END")
      expect(() => h.owner.store.finishBatch(h.scope(), directions)).toThrow('queue consume failed')
      expect(h.owner.store.load(h.identity.threadId)).toEqual(before)
      expect(h.product.resources.listAttachmentsForThread(h.identity.threadId)).toEqual([])
      expect(h.product.queue.getQueuedInput(h.identity.threadId, 'selected')!.attachments).toHaveLength(1)
      h.sql.exec('DROP TRIGGER fail_direction'); h.reopen()
      const committed = await h.owner.directions(h.owner.store.load(h.identity.threadId)!)
      if (providerIds) committed[0].value.context!.directionAfterCallIds = h.owner.store.load(h.identity.threadId)!.calls.map(call => call.providerCallId)
      h.owner.store.finishBatch(h.scope(), committed)
      h.reopen()
      expect(h.product.messages.committedDirections(h.identity.threadId, h.identity.runId)[0].message.directionAfterToolCallIds).toEqual(['call'])
      const attachment = h.product.resources.listAttachmentsForMessages(h.identity.threadId, [directions[0].id])[0]
      expect(attachment).toMatchObject({ id: archived[0].artifact.id, runId: 'run', path: archived[0].artifact.path, available: true, contextPolicy: 'conversation' })
      expect(readFileSync(attachment.path, 'utf8')).toBe(text)
      expect(h.product.queue.getQueuedInput(h.identity.threadId, 'selected')).toBeNull()
      expect(h.product.queue.getQueuedInput(h.identity.threadId, 'unselected')).not.toBeNull()
      expect(h.owner.queueDirection(h.identity, 'selected')).toBe(true)
      expect(h.sql.prepare('SELECT * FROM execution_queued_directions').all()).toEqual([])
      expect(h.sql.pragma('foreign_key_check')).toEqual([])
    } finally { h.dispose() }
  })

  it('does not apply a direction removed after preparation, and leaves unsent queue items on cancellation', async () => {
    const h = fixture()
    try {
      h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
      h.product.queue.createQueuedInput({ id: 'selected', threadId: h.identity.threadId, text: 'Do this later' }, [])
      h.owner.queueDirection(h.identity, 'selected')
      approval(h); h.owner.saveAnswers(h.scope(), answer('reject')); await h.owner.enter('resume', h.identity)
      expect(h.owner.queueDirection(h.identity, 'selected')).toBe(true)
      const directions = await h.owner.directions(h.owner.store.load(h.identity.threadId)!)
      expect(h.owner.removeDirection(h.identity, 'selected')).toBe(true)
      expect(() => h.owner.store.finishBatch(h.scope(), directions)).toThrow('no longer matches')
      expect(h.owner.store.load(h.identity.threadId)!.phase).toBe('tools')
      expect(await h.owner.directions(h.owner.store.load(h.identity.threadId)!)).toEqual([])
      h.owner.queueDirection(h.identity, 'selected')
      h.owner.store.finish(h.scope(), 'cancelled'); h.reopen()
      expect(h.product.queue.getQueuedInput(h.identity.threadId, 'selected')).not.toBeNull()
      expect(h.sql.prepare('SELECT * FROM execution_queued_directions').all()).toEqual([])
      expect(h.owner.store.load(h.identity.threadId)!.messages.some(message => message.id === 'run:direction:selected')).toBe(false)
    } finally { h.dispose() }
  })
})

it('retains ordered repeated summaries for each native run while retiring only its unfinished summary', async () => {
  const h = fixture()
  try {
    h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
    for (const [index, id] of ['first-summary', 'second-summary'].entries()) {
      const summary = { id, summaryText: `Visible ${id}`, modelContent: `Model ${id}`, cutoffIndex: index,
        activatedAfterMessageIndex: 0, inputTokensBefore: 100, inputTokensAfter: 30 }
      h.product.summaries.recordContextSummaryStarted('run', id)
      h.product.summaries.stageContextSummary('run', id, summary)
      h.owner.store.commitSummary(h.scope(), summary)
    }
    h.product.summaries.recordContextSummaryStarted('run', 'unfinished')
    h.owner.store.finish(h.scope(), 'completed')
    const first = h.product.messages.activities.getRunActivity('run')!.summaries!
    expect(first).toMatchObject([
      { id: 'first-summary', status: 'completed', summaryText: 'Visible first-summary' },
      { id: 'second-summary', status: 'completed', summaryText: 'Visible second-summary' }
    ])
    expect(first).toHaveLength(2)
    const next = { threadId: h.identity.threadId, runId: 'next' }
    h.owner.createRun({ ...next, operation: 'agent', message: { id: 'next:input', value: { id: 'next:input', kind: 'user', content: 'Next task', context: { runId: next.runId } } } })
    await h.owner.enter('input', next)
    const summary = { id: 'next-summary', summaryText: 'Visible next summary', modelContent: 'Model next summary', cutoffIndex: 1,
      activatedAfterMessageIndex: 1, inputTokensBefore: 100, inputTokensAfter: 30 }
    h.product.summaries.recordContextSummaryStarted(next.runId, summary.id)
    h.product.summaries.stageContextSummary(next.runId, summary.id, summary)
    h.owner.store.commitSummary({ ...next, expectedRevisionId: h.owner.store.load(next.threadId)!.revisionId }, summary, { completeRun: true })
    h.reopen()
    expect(h.product.messages.activities.getRunActivity('run')!.summaries).toEqual(first)
    expect(h.product.messages.activities.getRunActivity(next.runId)!.summaries).toMatchObject([{ id: summary.id, status: 'completed', summaryText: summary.summaryText }])
    expect(h.owner.store.load(next.threadId)!.context.summary?.id).toBe(summary.id)
    for (const [id, cutoff] of [['first-summary', 0], ['second-summary', 1]] as const) {
      expect(h.product.summaries.getCommittedContextSummary('run', id)).toMatchObject({ modelContent: `Model ${id}`, cutoffIndex: cutoff })
    }
  } finally { h.dispose() }
})

it.each([false, true])('activates only an explicitly committed native summary with the matching identity (commit=%s)', async commit => {
  const h = fixture()
  try {
    h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
    const summary = { summaryText: 'Same visible summary', modelContent: 'Same model summary', cutoffIndex: 1, activatedAfterMessageIndex: 0,
      inputTokensBefore: 0, inputTokensAfter: 0 }
    for (const id of ['older', 'current']) {
      h.product.summaries.recordContextSummaryStarted('run', id)
      h.product.summaries.stageContextSummary('run', id, summary)
    }
    h.owner.store.prepareContext(h.scope(), { ...h.owner.store.load(h.identity.threadId)!.context, todos: [{ content: 'Keep staging', status: 'pending' }] })
    h.reopen()
    for (const id of ['older', 'current']) expect(h.product.summaries.getCommittedContextSummary('run', id)).toBeUndefined()
    expect(h.product.messages.activities.getRunActivity('run')!.summaries).toMatchObject([{ id: 'older', status: 'running' }, { id: 'current', status: 'running' }])
    expect(h.owner.store.load(h.identity.threadId)!.context.summary).toBeUndefined()
    if (commit) {
      const revision = h.owner.store.commitSummary(h.scope(), { ...summary, id: 'current' })
      expect(h.product.summaries.getCommittedContextSummary('run', 'current')).toMatchObject({ committedRevisionId: revision, status: 'completed' })
      expect(h.product.summaries.getCommittedContextSummary('run', 'older')).toBeUndefined()
    } else {
      h.owner.store.acceptModel(h.scope(), { id: 'answer', value: { kind: 'assistant', content: summary.modelContent } }, [], { modelCalls: 1, todos: [] })
    }
    h.owner.store.finish(h.scope(), 'completed'); h.reopen()
    expect(h.product.messages.activities.getRunActivity('run')?.summaries ?? []).toEqual(commit ? [expect.objectContaining({ id: 'current', status: 'completed' })] : [])
    expect(h.owner.store.load(h.identity.threadId)!.context.summary?.id).toBe(commit ? 'current' : undefined)
  } finally { h.dispose() }
})

it.each([false, true])('arms cancellation only for an owned live run and preserves it when arming fails (accepted=%s)', async accepted => {
  const h = fixture()
  try {
    h.owner.saveInput(h.identity, input())
    if (accepted) await h.owner.enter('input', h.identity)
    const before = h.owner.store.load(h.identity.threadId)
    let armed = 0
    const arm = () => { armed++ }
    expect(() => h.owner.requestCancellation({ ...h.identity, threadId: 'foreign-thread' }, arm)).toThrow()
    expect(armed).toBe(0)
    expect(() => h.owner.requestCancellation(h.identity, () => { throw new Error('Effect arming failed') })).toThrow('Effect arming failed')
    expect(h.sql.prepare('SELECT status,cancellation_requested FROM agent_runs WHERE id=?').get(h.identity.runId)).toEqual({ status: 'running', cancellation_requested: 0 })
    expect(h.owner.store.load(h.identity.threadId)).toEqual(before)
    expect(h.owner.requestCancellation(h.identity, arm)).toBe(true)
    expect(armed).toBe(1)
    h.owner.completeCancellation(h.identity); h.reopen()
    expect(h.product.readModel.getRun(h.identity.runId)?.status).toBe('cancelled')
    expect(h.owner.requestCancellation(h.identity, arm)).toBe(false)
    expect(armed).toBe(1)
    expect(h.owner.store.readHistory(h.identity.threadId)!.messages).toHaveLength(accepted ? 1 : 0)
  } finally { h.dispose() }
})

it.each([[false, false], [false, true], [true, false], [true, true]])('restores native approval identity and maps reversed answers to their own calls (grouped=%s, reject=%s)', async (grouped, reject) => {
  const h = fixture()
  try {
    h.owner.saveInput(h.identity, input()); await h.owner.enter('input', h.identity)
    const calls = [0, 1].map(index => ({ ...call(), id: `call-${index}`, providerCallId: `provider-${index}`,
      args: { path: `file-${index}` }, artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `call-${index}:${purpose}`])) as ExecutionToolCall['artifacts'] }))
    h.owner.store.acceptModel(h.scope(), { id: 'model', value: { kind: 'assistant', content: '',
      calls: calls.map(call => ({ id: call.providerCallId, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
    const groups = grouped ? [calls] : calls.map(call => [call])
    h.owner.store.prepareTools(h.scope(), calls.map(call => ({ callId: call.id, args: call.args, authorization: { approval: 'pending' as const } })),
      groups.map((group, index) => ({ id: `approval-${index}`, generation: `generation-${index}`, kind: 'tool' as const, callIds: group.map(call => call.id), request: {
        actionRequests: group.map(call => ({ name: call.name, args: call.args, description: 'Confirm' })),
        reviewConfigs: group.map(call => ({ actionName: call.name, allowedDecisions: ['approve', 'reject'] as Array<'approve' | 'reject'> }))
      } })))
    const pending = h.owner.readInterrupts(h.identity)
    expect(pending).toHaveLength(groups.length)
    for (let attempt = 0; attempt < 2; attempt++) {
      h.reopen()
      expect(h.owner.readInterrupts(h.identity)).toEqual(pending)
      expect(h.product.readSnapshot(h.identity.threadId).interrupts).toEqual(pending)
    }
    const responses = pending.map((interrupt, index) => ({ interruptId: interrupt.id, expectedGeneration: interrupt.approvalGeneration!,
      decisions: groups[index].map(call => !reject || call.id === 'call-0' ? { type: 'approve' as const } : { type: 'reject' as const, message: 'Keep this file' }) })).reverse()
    h.owner.saveResponses({ ...h.identity, responses }); h.owner.saveResponses({ ...h.identity, responses })
    expect(h.sql.prepare('SELECT * FROM agent_run_resume_intents').all()).toHaveLength(groups.length)
    h.reopen(); await h.owner.enter('resume', h.identity)
    const resumed = h.owner.store.load(h.identity.threadId)!
    if (reject) {
      expect(resumed.calls.find(call => call.id === 'call-0')?.result?.value.content).toContain('Another action in this batch was rejected')
      expect(resumed.calls.find(call => call.id === 'call-1')?.result?.value.content).toBe('Keep this file')
    } else expect(resumed.calls.map(call => call.authorization?.approval)).toEqual(['granted', 'granted'])
    expect(h.owner.readInterrupts(h.identity)).toEqual([])
    expect(() => h.owner.saveResponses({ ...h.identity, responses })).toThrow('match the current durable root interrupts')
    expect(h.owner.store.load(h.identity.threadId)).toEqual(resumed)
    expect(resumed.calls.filter(call => call.result)).toHaveLength(reject ? 2 : 0)
    if (reject) {
      h.owner.store.finishBatch(h.scope(), [])
      h.reopen()
      expect(h.owner.store.readHistory(h.identity.threadId)?.messages.filter(message => message.value.kind === 'tool')).toHaveLength(2)
    }
  } finally { h.dispose() }
})
