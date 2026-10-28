import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import type { ExecutionToolCall } from '../../runtime/executionState'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-recovery-')), file = join(root, 'conversation.sqlite')
  const global = new Database(':memory:'), options = { attachmentRoot: join(root, 'attachments'),
    memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) }
  let database = NativeConversationDatabase.open(file, options)
  return { get db() { return database },
    submit(id: string) {
      const identity = { threadId: id, runId: `${id}-run` }
      database.runs.createThreadAndRun({ ...identity, thread: {}, submissionId: id,
        message: { id: `${identity.runId}:input`, value: { id: `${identity.runId}:input`, kind: 'user', content: 'Task', context: { runId: identity.runId } } } })
      return identity
    },
    child(id: string, parent: { threadId: string; runId: string }, ownerThreadId = parent.threadId, parentSubagentId?: string) {
      database.runs.createSubagentCall({ id, ownerThreadId, parentThreadId: parent.threadId, parentRunId: parent.runId, parentSubagentId,
        childThreadId: id, childRunId: `${id}-run`, childThread: {}, description: 'Child task',
        config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
      return { threadId: id, runId: `${id}-run` }
    },
    complete(identity: { threadId: string; runId: string }, text = 'Completed answer') {
      const scope = () => ({ ...identity, expectedRevisionId: database.runs.store.load(identity.threadId)!.revisionId })
      database.runs.store.acceptModel(scope(), { id: `${identity.runId}:answer`, value: { kind: 'assistant', content: text } }, [], { modelCalls: 1, todos: [] })
      database.runs.store.finish(scope(), 'completed')
    },
    sql(action: (sql: Database.Database) => void) { const sql = new Database(file); try { action(sql) } finally { sql.close() } },
    reopen() { database.close(); database = NativeConversationDatabase.open(file, options) },
    close() { database.close(); global.close(); rmSync(root, { recursive: true, force: true }) } }
}

describe('native startup ownership recovery', () => {
  it('leaves unanswered approvals waiting and returns saved answers for explicit resume without consuming them', async () => {
    const h = fixture()
    try {
      for (const id of ['waiting', 'answered']) {
        const identity = h.submit(id); await h.db.runs.enter('input', identity)
        const scope = () => ({ ...identity, expectedRevisionId: h.db.runs.store.load(id)!.revisionId })
        const call: ExecutionToolCall = { id: 'call', providerCallId: 'call', name: 'write_file', args: {},
          artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `${id}:${purpose}`])) as ExecutionToolCall['artifacts'] }
        h.db.runs.store.acceptModel(scope(), { id: 'model', value: { kind: 'assistant', content: '', calls: [{ id: call.id, name: call.name, args: {} }] } }, [call], { modelCalls: 1, todos: [] })
        h.db.runs.store.prepareTools(scope(), [{ callId: call.id, args: {}, authorization: { approval: 'pending' } }], [
          { id: 'approval', generation: 'generation', kind: 'tool', callIds: [call.id], request: {
            actionRequests: [{ name: call.name, args: {}, description: 'Confirm' }],
            reviewConfigs: [{ actionName: call.name, allowedDecisions: ['approve', 'reject'] }] } }
        ])
        if (id === 'answered') h.db.runs.saveAnswers(scope(), [{ id: 'approval', generation: 'generation', response: { decisions: [{ type: 'approve' }] } }])
      }
      h.reopen()
      expect(h.db.recover()).toEqual([{ threadId: 'answered', runId: 'answered-run', command: 'resume' }])
      expect(h.db.readSnapshot('waiting')).toMatchObject({ pendingRun: { status: 'interrupted' }, interrupts: [{ id: 'approval' }] })
      expect(h.db.readSnapshot('answered')).toMatchObject({ pendingRun: { status: 'interrupted' }, interrupts: [] })
      expect(h.db.runs.store.load('waiting')!.phase).toBe('waiting')
      expect(h.db.runs.store.load('answered')!.phase).toBe('waiting')
      h.reopen()
      expect(h.db.recover()).toEqual([{ threadId: 'answered', runId: 'answered-run', command: 'resume' }])
      await h.db.runs.enter('resume', { threadId: 'answered', runId: 'answered-run' })
      expect(h.db.recover()).toEqual([{ threadId: 'answered', runId: 'answered-run', command: 'continue' }])
      expect(h.db.runs.store.load('waiting')!.phase).toBe('waiting')
    } finally { h.close() }
  })

  it('classifies abandoned tasks once, preserves saved outputs, and returns unstarted and accepted work without dispatch', async () => {
    const h = fixture()
    try {
      const pending = h.submit('pending'), active = h.submit('active')
      await h.db.runs.enter('input', active)
      for (const id of ['prepared', 'running', 'completed']) h.db.managed.createManagedCall({ id, ...active, kind: 'builtin', summary: id })
      h.db.managed.markManagedCallRunning('running', active.threadId)
      h.db.managed.appendManagedCallOutput({ callId: 'running', threadId: active.threadId, stream: 'stdout', text: 'Already produced output' })
      h.db.managed.finishManagedCall({ callId: 'completed', threadId: active.threadId, status: 'completed', result: 'Saved result' })
      h.sql(sql => sql.prepare("INSERT INTO agent_run_background_cleanup VALUES (?,'running','Original report')").run(active.runId))
      h.reopen()
      expect(h.db.managed.getManagedCall('running', active.threadId)!.status).toBe('running')
      const candidates = h.db.recover()
      expect(candidates).toEqual([{ ...pending, command: 'input' }, { ...active, command: 'continue' }])
      expect(h.db.runs.store.load(pending.threadId)).toBeUndefined()
      expect(h.db.managed.getManagedCall('prepared', active.threadId)).toMatchObject({ status: 'failed', error: expect.stringContaining('before the operation was dispatched') })
      const running = h.db.managed.getManagedCall('running', active.threadId)!
      expect(running).toMatchObject({ status: 'uncertain', outputChars: 23, detachedAt: expect.any(String) })
      expect(h.db.managed.getManagedCall('completed', active.threadId)).toMatchObject({ status: 'completed', result: 'Saved result' })
      h.reopen(); expect(h.db.recover()).toEqual(candidates)
      expect(h.db.managed.getManagedCall('running', active.threadId)).toEqual(running)
      h.sql(sql => expect(sql.prepare('SELECT status,report FROM agent_run_background_cleanup').get()).toEqual({ status: 'unconfirmed',
        report: 'Original report\nBackground cleanup finished with unconfirmed outcomes.' }))
    } finally { h.close() }
  })

  it('settles saved cancellation and the entire orphaned child chain without accepting pending child inputs', async () => {
    const h = fixture()
    try {
      const parent = h.submit('parent'); await h.db.runs.enter('input', parent)
      const child = h.child('child', parent); await h.db.runs.enter('input', child)
      h.child('grandchild', child, 'parent', 'child')
      h.db.runs.requestCancellation(parent); h.reopen()
      expect(h.db.recover()).toEqual([])
      expect(h.db.runs.store.load('parent')!.phase).toBe('cancelled')
      expect(h.db.runs.store.load('child')!.phase).toBe('cancelled')
      expect(h.db.runs.store.load('grandchild')).toBeUndefined()
      expect(h.db.runs.subagents.require('grandchild', 'parent').status).toBe('cancelled')
      expect(h.db.runs.subagents.require('child', 'parent').status).toBe('cancelled')
      h.reopen(); expect(h.db.recover()).toEqual([])
    } finally { h.close() }
  })

  it('preserves a completed child answer while cancelling another child of an already completed parent', async () => {
    const h = fixture()
    try {
      const parent = h.submit('parent'); await h.db.runs.enter('input', parent)
      const done = h.child('done', parent); await h.db.runs.enter('input', done)
      h.complete(done, 'Durable child answer')
      h.child('pending-child', parent)
      h.complete(parent); h.reopen()
      expect(h.db.recover()).toEqual([])
      expect(h.db.runs.subagents.require('done', 'parent')).toMatchObject({ status: 'completed', result: 'Durable child answer' })
      expect(h.db.runs.subagents.require('pending-child', 'parent').status).toBe('cancelled')
      expect(h.db.runs.store.load('parent')!.phase).toBe('completed')
    } finally { h.close() }
  })

  it('rolls back task recovery together with a failed cancellation, then safely retries', () => {
    const h = fixture()
    try {
      const parent = h.submit('parent')
      h.db.managed.createManagedCall({ id: 'task', ...parent, kind: 'shell', summary: 'Pending task' })
      h.db.runs.requestCancellation(parent)
      h.sql(sql => sql.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON agent_file_edit_cleanup_outbox BEGIN SELECT RAISE(ABORT,'cleanup failed'); END"))
      expect(() => h.db.recover()).toThrow('cleanup failed')
      expect(h.db.managed.getManagedCall('task', parent.threadId)!.status).toBe('preparing')
      expect(h.db.readCatalogSnapshot('parent')!.thread.status).toBe('running')
      h.sql(sql => sql.exec('DROP TRIGGER fail_recovery')); h.reopen()
      expect(h.db.recover()).toEqual([])
      expect(h.db.managed.getManagedCall('task', parent.threadId)!.status).toBe('failed')
    } finally { h.close() }
  })

  it('rejects a run with missing durable input rather than silently resetting it', () => {
    const h = fixture()
    try {
      const parent = h.submit('parent')
      h.db.managed.createManagedCall({ id: 'task', ...parent, kind: 'builtin', summary: 'Task' })
      h.sql(sql => sql.exec('DELETE FROM agent_run_input_intents'))
      expect(() => h.db.recover()).toThrow('neither saved input nor its own execution')
      expect(h.db.managed.getManagedCall('task', parent.threadId)!.status).toBe('preparing')
      expect(h.db.readCatalogSnapshot('parent')!.thread.status).toBe('running')
    } finally { h.close() }
  })
})

it('recovers an abandoned child without losing completed results or retaining uncommitted approvals', async () => {
  const h = fixture()
  try {
    const parent = h.submit('parent'); await h.db.runs.enter('input', parent)
    const child = h.child('child', parent); await h.db.runs.enter('input', child)
    const scope = () => ({ ...child, expectedRevisionId: h.db.runs.store.load(child.threadId)!.revisionId })
    const call: ExecutionToolCall = { id: 'saved', providerCallId: 'provider-saved', name: 'read_file', args: { path: 'complete.txt' },
      artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `saved:${purpose}`])) as ExecutionToolCall['artifacts'] }
    h.db.runs.store.acceptModel(scope(), { id: 'completed-model', value: { kind: 'assistant', content: 'Complete child response',
      calls: [{ id: call.providerCallId!, name: call.name, args: call.args }] } }, [call], { modelCalls: 1, todos: [] })
    h.db.runs.store.prepareTools(scope(), [{ callId: call.id, args: call.args }])
    h.db.runs.store.settleCall(child, call.id, { id: 'completed-result', value: { kind: 'tool', resultFor: call.providerCallId!, content: 'Complete tool result' } })
    h.db.runs.store.finishBatch(scope())
    h.db.subagentProjection.recordProjectedModelActivity('child', parent.threadId, {
      id: 'completed-child-model', messageId: 'completed-model', subagentId: 'child', status: 'completed',
      text: 'Complete child response', reasoning: '', toolCallIds: [call.id]
    })
    h.db.subagentProjection.recordProjectedToolActivity('child', parent.threadId,
      { id: call.id, name: call.name, args: call.args }, 'completed', 'child', 'Complete tool result')
    const observations = h.db.messages.observations
    observations.recordModel(child.runId, { id: 'uncommitted-model', status: 'running', text: 'Partial response', reasoning: '', toolCallIds: ['uncommitted-tool'] })
    observations.recordTool(child.runId, { id: 'uncommitted-tool', name: 'apply_patch', args: {} }, 'running')
    observations.recordToolApproval(child.runId, 'uncommitted-tool', { status: 'pending_approval', interruptId: 'uncommitted-approval', actionIndex: 0 })
    h.db.subagentProjection.recordProjectedModelActivity('child', parent.threadId, {
      id: 'uncommitted-child-model', subagentId: 'child', status: 'running', text: 'Partial response', reasoning: '', toolCallIds: ['uncommitted-tool']
    })
    h.db.subagentProjection.recordProjectedToolActivity('child', parent.threadId, { id: 'uncommitted-tool', name: 'apply_patch', args: {} }, 'running', 'child')
    const history = h.db.runs.store.readHistory(child.threadId)!.messages
    h.db.runs.store.finish({ ...parent, expectedRevisionId: h.db.runs.store.load(parent.threadId)!.revisionId }, 'completed')
    h.reopen()
    expect(h.db.recover()).toEqual([])
    expect(h.db.runs.store.load(child.threadId)?.phase).toBe('cancelled')
    expect(h.db.getThread(child.threadId)?.status).toBe('idle')
    expect(h.db.runs.subagents.require('child', parent.threadId)).toMatchObject({ status: 'cancelled' })
    expect(h.db.runs.store.readHistory(child.threadId)!.messages).toEqual(history)
    const activity = h.db.messages.activities.getRunActivity(parent.runId)!
    expect(activity.subagents).toMatchObject([{ id: 'child', status: 'cancelled' }])
    expect(activity.models).toMatchObject([{ subagentId: 'child', status: 'completed', text: 'Complete child response', completedAt: expect.any(String) }])
    expect(activity.models).toHaveLength(1)
    expect(activity.tools).toMatchObject([{ subagentId: 'child', status: 'completed', output: 'Complete tool result' }])
    expect(activity.tools).toHaveLength(1)
    h.sql(sql => expect(sql.prepare('SELECT count(*) AS count FROM agent_tool_approvals').get()).toEqual({ count: 0 }))
    h.reopen(); expect(h.db.recover()).toEqual([])
    expect(h.db.messages.activities.getRunActivity(parent.runId)).toEqual(activity)
  } finally { h.close() }
})
