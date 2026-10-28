import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { conversationMessageRecordId, encodeConversationMessage } from '../../runtime/conversationStorage'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { ExecutionToolCall } from '../../runtime/executionState'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { AgentStorage } from './agentStorage'
import { getAgentConversationDatabaseFile } from '../config/dataDir'
import { NativeExecutionStore } from './nativeExecutionStore'
import { collectNativeMessageBodies } from './nativeMessageCleanup'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-body-cleanup-'))
  const storage = AgentStorage.openNative(root), thread = storage.createThread()
  const product = storage.conversationForThread(thread.id), file = getAgentConversationDatabaseFile(thread.id, root)
  const run = product.runs.createRun({ threadId: thread.id, runId: 'run', operation: 'agent', message: { id: 'input', value: { id: 'input', kind: 'user', content: 'Start', context: { runId: 'run' } } } })
  const sql = new Database(file); sql.pragma('foreign_keys=ON')
  const store = new NativeExecutionStore(sql)
  return { product, thread, run, sql, store,
    scope() { return { threadId: thread.id, runId: run.id, expectedRevisionId: store.load(thread.id)!.revisionId } },
    body(id: string, value: ConversationMessage, threadId = thread.id) {
      const bytes = encodeConversationMessage(value), recordId = conversationMessageRecordId(id, bytes)
      sql.prepare('INSERT INTO execution_message_bodies(thread_id,record_id,message_id,value) VALUES (?,?,?,?)').run(threadId, recordId, id, bytes)
      return recordId
    },
    collect(threadId = thread.id) { return sql.transaction(() => collectNativeMessageBodies(sql, threadId))() },
    dispose() { sql.close(); storage.close(); rmSync(root, { recursive: true, force: true }) } }
}

describe('native message body collection', () => {
  it('retains current history, summary, pending call and journal results independently of product activity indexes', () => {
    const h = fixture()
    try {
      h.store.start({ expectedRevisionId: h.store.readHistory(h.thread.id)!.revisionId, threadId: h.thread.id, runId: 'run', messages: [{ id: 'input', value: { kind: 'user', content: 'Start' } }], context: { modelCalls: 0, todos: [] } })
      h.store.commitSummary(h.scope(), { id: 'summary', summaryText: 'Shown', modelContent: 'Retained model context', cutoffIndex: 1,
        activatedAfterMessageIndex: 0, inputTokensBefore: 20, inputTokensAfter: 5 })
      const calls: ExecutionToolCall[] = ['settled', 'journal'].map(id => ({ id, providerCallId: id, name: 'read_file', args: {},
        artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `${id}:${purpose}`])) as ExecutionToolCall['artifacts'] }))
      h.store.acceptModel(h.scope(), { id: 'response', value: { kind: 'assistant', content: '', calls: calls.map(call => ({ id: call.id, name: call.name, args: {} })) } }, calls, h.store.load(h.thread.id)!.context)
      h.store.prepareTools(h.scope(), calls.map(call => ({ callId: call.id, args: {} })))
      h.store.settleCall(h.scope(), 'settled', { id: 'settled-result', value: { kind: 'tool', resultFor: 'settled', content: 'Accepted' } })
      const key = { threadId: h.thread.id, runId: 'run', callId: 'journal' }
      h.store.prepareEffect(key, 'confirm'); h.store.armEffect(key, { kind: 'fixture-read', target: { path: 'fixture' } })
      h.store.saveEffectResult(key, { id: 'journal-result', value: { kind: 'tool', resultFor: 'journal', content: 'Awaiting acceptance' } })
      const orphan = h.body('orphan', { kind: 'user', content: 'Unused' }), before = h.store.load(h.thread.id), effect = h.store.loadEffect(key)
      expect(() => collectNativeMessageBodies(h.sql, h.thread.id)).toThrow('owning product transaction')
      expect(h.collect()).toBe(1)
      expect(() => h.store.readMessageRecord(h.thread.id, orphan)).toThrow('Missing execution message')
      expect(h.store.load(h.thread.id)).toEqual(before); expect(h.store.loadEffect(key)).toEqual(effect)
      h.store.finish(h.scope(), 'cancelled')
      expect(h.collect()).toBe(0)
      h.sql.prepare('DELETE FROM execution_effects WHERE thread_id=?').run(h.thread.id)
      expect(h.collect()).toBe(1)
      expect(h.store.readHistory(h.thread.id)?.messages.map(message => message.id)).toEqual(['input', 'response', 'settled-result'])
      expect(h.store.readMessageRecord(h.thread.id, before!.context.summary!.messageRecordId).value.content).toBe('Retained model context')
      expect(h.sql.pragma('foreign_key_check')).toEqual([])
    } finally { h.dispose() }
  })

  it('preserves separate same-ID history and activity versions, rolls back collection and never sweeps another conversation', () => {
    const h = fixture()
    try {
      const first = h.body('same', { kind: 'assistant', content: 'History version' }), second = h.body('same', { kind: 'assistant', content: 'Activity version' })
      const orphan = h.body('orphan', { kind: 'user', content: 'Unused' }), other = h.product.createThread()
      const foreign = h.body('foreign', { kind: 'user', content: 'Other conversation' }, other.id)
      h.sql.prepare('INSERT INTO agent_message_index(thread_id,position,record_id,message_id,run_id,visible) VALUES (?,0,?,?,?,1)').run(h.thread.id, first, 'same', 'run')
      h.sql.prepare('INSERT INTO agent_message_payloads(thread_id,message_id,run_id,record_id) VALUES (?,?,?,?)').run(h.thread.id, 'same', 'run', second)
      h.sql.prepare('INSERT INTO execution_model_calls(thread_id,record_id,call_index,call_id) VALUES (?,?,0,?)').run(h.thread.id, orphan, 'unused-call')
      expect(() => h.sql.transaction(() => { expect(collectNativeMessageBodies(h.sql, h.thread.id)).toBe(1); throw new Error('rollback collection') })()).toThrow('rollback collection')
      expect(h.store.readMessageRecord(h.thread.id, orphan).id).toBe('orphan')
      expect(h.sql.prepare('SELECT call_id FROM execution_model_calls').all()).toEqual([{ call_id: 'unused-call' }])
      expect(h.collect()).toBe(1)
      expect(h.sql.prepare('SELECT call_id FROM execution_model_calls').all()).toEqual([])
      expect(h.store.readMessageRecord(h.thread.id, first).value.content).toBe('History version')
      expect(h.store.readMessageRecord(h.thread.id, second).value.content).toBe('Activity version')
      expect(h.store.readMessageRecord(other.id, foreign).value.content).toBe('Other conversation')
      h.sql.prepare('DELETE FROM agent_message_payloads WHERE thread_id=?').run(h.thread.id)
      expect(h.collect()).toBe(1)
      expect(h.store.readMessageRecord(h.thread.id, first).value.content).toBe('History version')
    } finally { h.dispose() }
  })

  it('refuses collection with a missing owned reference or unreadable context instead of losing potentially retained bodies', () => {
    const h = fixture()
    try {
      const orphan = h.body('orphan', { kind: 'user', content: 'Keep on error' })
      h.sql.prepare('INSERT INTO agent_message_payloads(thread_id,message_id,run_id,record_id) VALUES (?,?,?,?)').run(h.thread.id, 'missing', 'run', 'missing-record')
      expect(() => h.collect()).toThrow('Retained execution message body missing-record is missing')
      expect(h.store.readMessageRecord(h.thread.id, orphan).value.content).toBe('Keep on error')
      h.sql.prepare('DELETE FROM agent_message_payloads WHERE thread_id=?').run(h.thread.id)
      h.store.start({ expectedRevisionId: h.store.readHistory(h.thread.id)!.revisionId, threadId: h.thread.id, runId: 'run', messages: [], context: { modelCalls: 0, todos: [] } })
      h.sql.prepare('UPDATE execution_state SET context_value=? WHERE thread_id=?').run(Buffer.from('broken'), h.thread.id)
      expect(() => h.collect()).toThrow()
      expect(h.store.readMessageRecord(h.thread.id, orphan).value.content).toBe('Keep on error')
    } finally { h.dispose() }
  })
})
