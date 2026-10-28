import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { NativeRunOwner } from './nativeRunOwner'
import { NativeMessageProjection } from './nativeMessageProjection'
import { initializeNativeConversationStorage } from './nativeDatabaseSchema'
import { validateNativeExecutionStorage } from './nativeStorageValidation'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import type { ExecutionToolCall } from '../../runtime/executionState'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-cancel-')), file = join(root, 'conversation.sqlite')
  let database = new Database(file)
  const assemble = () => { initializeNativeConversationStorage(database); const projection = new NativeMessageProjection(database)
    return new NativeRunOwner(database, commit => projection.commit(commit)) }
  let owner = assemble()
  const identity = { threadId: 'thread', runId: 'run' }
  owner.createThreadAndRun({ ...identity, thread: {}, submissionId: 'submission',
    message: { id: 'run:input', value: { id: 'run:input', kind: 'user', content: 'Task', context: { runId: 'run' } } } })
  return { identity, get owner() { return owner }, get sql() { return database },
    scope: () => ({ ...identity, expectedRevisionId: owner.store.load('thread')!.revisionId }),
    reopen() { database.close(); database = new Database(file); owner = assemble() },
    close() { database.close(); rmSync(root, { recursive: true, force: true }) } }
}
function call(id: string): ExecutionToolCall {
  return { id, providerCallId: id, name: 'apply_patch', args: {},
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `${id}:${purpose}`])) as ExecutionToolCall['artifacts'] }
}

describe('native durable cancellation', () => {
  it('rejects dispatch after a saved cancellation and discards only the unaccepted input across reopen', async () => {
    const h = fixture()
    try {
      expect(() => h.owner.completeCancellation(h.identity)).toThrow('saved request')
      expect(() => h.owner.requestCancellation({ ...h.identity, threadId: 'other' })).toThrow('does not belong')
      expect(() => h.owner.requestCancellation(h.identity, () => { throw new Error('effect failed') })).toThrow('effect failed')
      expect(h.sql.prepare('SELECT cancellation_requested FROM agent_runs').get()).toEqual({ cancellation_requested: 0 })
      h.owner.requestCancellation(h.identity); h.reopen()
      await expect(h.owner.enter('input', h.identity)).rejects.toThrow('cancellation must be settled')
      expect(h.owner.store.load('thread')).toBeUndefined()
      expect(h.owner.completeCancellation(h.identity)).toBe(true)
      expect(h.owner.completeCancellation(h.identity)).toBe(false)
      h.reopen(); validateNativeExecutionStorage(h.sql)
      expect(h.owner.store.readHistory('thread')!.messages).toEqual([])
      expect(h.sql.prepare('SELECT * FROM agent_run_input_intents').all()).toEqual([])
      expect(h.sql.prepare('SELECT status FROM agent_threads').get()).toEqual({ status: 'idle' })
      expect(h.sql.prepare('SELECT status FROM agent_runs').get()).toEqual({ status: 'cancelled' })
    } finally { h.close() }
  })

  it('keeps accepted sibling results and uncertain recovery materials, atomically with cancellation', async () => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      const calls = [call('accepted'), call('uncertain')]
      h.owner.store.acceptModel(h.scope(), { id: 'model', value: { kind: 'assistant', content: '',
        calls: calls.map(call => ({ id: call.id, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
      h.owner.store.prepareTools(h.scope(), calls.map(call => ({ callId: call.id, args: call.args })))
      const effect = { ...h.identity, callId: 'uncertain' }
      h.owner.store.prepareEffect(effect, 'confirm')
      h.owner.store.armEffect(effect, { kind: 'file_patch', target: { requestId: 'run', operationId: 'operation', path: '/fixture' } })
      h.owner.requestCancellation(h.identity)
      // An already-entered sibling may finish while the host drains cancellation.
      h.owner.store.settleCall(h.identity, 'accepted', { id: 'accepted-result', value: { kind: 'tool', resultFor: 'accepted', content: 'Saved before drain' } })
      h.reopen()
      const before = h.owner.store.load('thread')
      h.sql.exec("CREATE TRIGGER fail_cancel BEFORE INSERT ON agent_file_edit_cleanup_outbox BEGIN SELECT RAISE(ABORT,'cleanup failed'); END")
      expect(() => h.owner.completeCancellation(h.identity)).toThrow('cleanup failed')
      expect(h.owner.store.load('thread')).toEqual(before)
      expect(h.sql.prepare('SELECT status FROM agent_runs').get()).toEqual({ status: 'running' })
      h.sql.exec('DROP TRIGGER fail_cancel')
      expect(h.owner.completeCancellation(h.identity)).toBe(true)
      h.reopen(); validateNativeExecutionStorage(h.sql)
      expect(h.owner.store.load('thread')!.phase).toBe('cancelled')
      expect(h.owner.store.readHistory('thread')!.messages.filter(message => message.value.kind === 'tool').map(message => message.value.content)).toEqual(['Saved before drain'])
      expect(h.owner.store.loadEffect(effect)!.state).toBe('intent')
      expect(h.sql.prepare('SELECT request_id,operation_id FROM agent_file_edit_retained_operations').all()).toEqual([{ request_id: 'run', operation_id: 'operation' }])
    } finally { h.close() }
  })

  it('does not replace a committed completion with late cancellation', async () => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      h.owner.store.acceptModel(h.scope(), { id: 'answer', value: { kind: 'assistant', content: 'Final answer' } }, [], { modelCalls: 1, todos: [] })
      h.owner.requestCancellation(h.identity)
      h.owner.store.finish(h.scope(), 'completed')
      expect(h.owner.completeCancellation(h.identity)).toBe(false)
      expect(h.owner.requestCancellation(h.identity, () => { throw new Error('must not arm') })).toBe(false)
      h.reopen(); await h.owner.enter('continue', h.identity)
      expect(h.owner.store.load('thread')!.phase).toBe('completed')
      expect(h.sql.prepare('SELECT cancellation_requested FROM agent_runs').get()).toEqual({ cancellation_requested: 0 })
    } finally { h.close() }
  })

  it('reconciles a cancelled child whose input never started without inventing a child execution', async () => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      const child = h.owner.createSubagentCall({ id: 'child', ownerThreadId: 'thread', parentThreadId: 'thread', parentRunId: 'run',
        childThreadId: 'child-thread', childRunId: 'child-run', childThread: {}, description: 'Child task',
        config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
      const identity = { threadId: child.childThreadId, runId: child.childRunId }
      h.owner.requestCancellation(identity); h.owner.completeCancellation(identity); h.reopen()
      expect(h.owner.reconcileSubagent('child', 'thread')).toMatchObject({ call: { status: 'cancelled' } })
      expect(h.owner.reconcileSubagent('child', 'thread')).toBeUndefined()
      expect(h.owner.store.load('child-thread')).toBeUndefined()
      expect(h.owner.store.load('thread')!.phase).toBe('prepare_model')
      validateNativeExecutionStorage(h.sql)
    } finally { h.close() }
  })

  it('cancels a later unaccepted input without changing the preceding completed history', async () => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      h.owner.store.acceptModel(h.scope(), { id: 'answer', value: { kind: 'assistant', content: 'Keep this answer' } }, [], { modelCalls: 1, todos: [] })
      h.owner.store.finish(h.scope(), 'completed')
      const before = h.owner.store.readHistory('thread'), next = { threadId: 'thread', runId: 'next' }
      h.owner.createRun({ ...next, operation: 'agent', message: { id: 'next:input', value: { id: 'next:input', kind: 'user', content: 'Cancelled follow-up', context: { runId: 'next' } } } })
      h.owner.requestCancellation(next); h.reopen(); h.owner.completeCancellation(next)
      expect(h.owner.store.readHistory('thread')).toEqual(before)
      validateNativeExecutionStorage(h.sql)
      expect(h.sql.prepare('SELECT status FROM agent_runs WHERE id=?').get('next')).toEqual({ status: 'cancelled' })
    } finally { h.close() }
  })

  it('cancels an approval wait and removes its saved answers without approving the tool', async () => {
    const h = fixture()
    try {
      await h.owner.enter('input', h.identity)
      const pending = call('write')
      h.owner.store.acceptModel(h.scope(), { id: 'model', value: { kind: 'assistant', content: '',
        calls: [{ id: pending.id, name: pending.name, args: pending.args }] } }, [pending], { modelCalls: 1, todos: [] })
      h.owner.store.prepareTools(h.scope(), [{ callId: pending.id, args: {}, authorization: { approval: 'pending' } }], [
        { id: 'approval', generation: 'generation', kind: 'tool', callIds: [pending.id], request: {
          actionRequests: [{ name: pending.name, args: {}, description: 'Confirm' }],
          reviewConfigs: [{ actionName: pending.name, allowedDecisions: ['approve', 'reject'] }] } }
      ])
      h.owner.saveAnswers(h.scope(), [{ id: 'approval', generation: 'generation', response: { decisions: [{ type: 'approve' }] } }])
      h.owner.requestCancellation(h.identity); h.reopen()
      await expect(h.owner.enter('resume', h.identity)).rejects.toThrow('cancellation must be settled')
      h.owner.completeCancellation(h.identity)
      expect(h.owner.readInterrupts(h.identity)).toEqual([])
      expect(h.sql.prepare('SELECT * FROM agent_run_resume_intents').all()).toEqual([])
      expect(h.sql.prepare('SELECT * FROM execution_effects').all()).toEqual([])
      validateNativeExecutionStorage(h.sql)
    } finally { h.close() }
  })
})
