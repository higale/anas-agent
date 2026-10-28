import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExecutionMessageInput, ExecutionToolCall } from '../../runtime/executionState'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { AgentStorage } from './agentStorage'
import { getAgentConversationDatabaseFile } from '../config/dataDir'
import { NativeRunOwner } from './nativeRunOwner'
import { NativeHistoryOwner } from './nativeHistoryOwner'
import { NativeMessageProjection } from './nativeMessageProjection'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-file-cleanup-'))
  const storage = AgentStorage.openNative(root), thread = storage.createThread()
  const product = storage.conversationForThread(thread.id), file = getAgentConversationDatabaseFile(thread.id, root)
  let sql = new Database(file); sql.pragma('foreign_keys=ON')
  let projection = new NativeMessageProjection(sql), owner = new NativeRunOwner(sql, commit => projection.commit(commit))
  const identity = { threadId: thread.id, runId: 'run' }
  owner.createRun({ ...identity, operation: 'agent', message: { id: 'input', value: { id: 'input', kind: 'user', content: 'Edit file', context: { runId: 'run' } } } })
  return { product, identity, get sql() { return sql }, get owner() { return owner },
    scope() { return { ...identity, expectedRevisionId: owner.store.load(identity.threadId)!.revisionId } },
    reopen() { sql.close(); sql = new Database(file); sql.pragma('foreign_keys=ON'); projection = new NativeMessageProjection(sql); owner = new NativeRunOwner(sql, commit => projection.commit(commit)) },
    dispose() { sql.close(); storage.close(); rmSync(root, { recursive: true, force: true }) } }
}
function call(id: string, name = 'apply_patch', args: Record<string, unknown> = {}): ExecutionToolCall {
  return { id, name, args, providerCallId: id,
    artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `${id}:${purpose}`])) as ExecutionToolCall['artifacts'] }
}
async function start(h: ReturnType<typeof fixture>, calls: ExecutionToolCall[]) {
  await h.owner.enter('input', h.identity)
  h.owner.store.acceptModel(h.scope(), { id: 'response', value: { kind: 'assistant', content: '',
    calls: calls.map(call => ({ id: call.id, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
  h.owner.store.prepareTools(h.scope(), calls.map(call => ({ callId: call.id, args: call.args })))
}
const result = (id: string): ExecutionMessageInput => ({ id: `${id}:result`, value: { kind: 'tool', resultFor: id, content: 'Saved output' } })
function arm(h: ReturnType<typeof fixture>, id: string, requestId = 'run', operationId = id) {
  const key = { ...h.identity, callId: id }
  h.owner.store.prepareEffect(key, 'confirm')
  h.owner.store.armEffect(key, { kind: 'file_patch', target: { requestId, operationId, path: '/isolated-fixture' } })
  return key
}

describe('native file-edit recovery handoff', () => {
  it.each(['cancelled', 'failed'] as const)('retains only unaccepted effects on %s and rolls cleanup back with execution', async outcome => {
    const h = fixture()
    try {
      await start(h, [call('uncertain'), call('journal-only'), call('accepted')])
      arm(h, 'uncertain')
      h.owner.store.saveEffectResult(arm(h, 'journal-only'), result('journal-only'))
      h.owner.store.saveEffectResult(arm(h, 'accepted'), result('accepted'))
      h.owner.store.settleCall(h.identity, 'accepted', result('accepted'))
      h.sql.prepare('INSERT INTO agent_file_edit_retained_operations(request_id,operation_id) VALUES (?,?)').run('foreign', 'unrelated')
      const before = h.owner.store.load(h.identity.threadId)
      h.sql.exec("CREATE TRIGGER fail_cleanup BEFORE INSERT ON agent_file_edit_cleanup_outbox BEGIN SELECT RAISE(ABORT,'cleanup failed'); END")
      expect(() => h.owner.store.finish(h.scope(), outcome)).toThrow('cleanup failed')
      expect(h.owner.store.load(h.identity.threadId)).toEqual(before)
      expect(h.product.resourceCleanup.listRetainedFileEditOperationIds('run')).toEqual([])
      expect(h.product.readModel.getRun('run')?.status).toBe('running')
      h.sql.exec('DROP TRIGGER fail_cleanup'); h.owner.store.finish(h.scope(), outcome); h.reopen()
      expect(h.product.resourceCleanup.listRetainedFileEditOperationIds('run').sort()).toEqual(['journal-only', 'uncertain'])
      expect(h.product.resourceCleanup.listRetainedFileEditOperationIds('foreign')).toEqual(['unrelated'])
      expect(h.product.resourceCleanup.listFileEditCleanupRunIds()).toEqual(['run'])
      expect(h.owner.store.load(h.identity.threadId)?.messages.map(record => record.id)).toEqual(['input', 'response', 'accepted:result'])
      h.product.resourceCleanup.acknowledgeFileEditCleanup('run'); await h.owner.enter('continue', h.identity)
      expect(h.product.resourceCleanup.listFileEditCleanupRunIds()).toEqual([])
      expect(h.product.resourceCleanup.listRetainedFileEditOperationIds('run').sort()).toEqual(['journal-only', 'uncertain'])
    } finally { h.dispose() }
  })

  it('enqueues completed file cleanup without retaining accepted transaction records', async () => {
    const h = fixture()
    try {
      await start(h, [call('accepted')])
      h.owner.store.saveEffectResult(arm(h, 'accepted'), result('accepted'))
      h.owner.store.settleCall(h.identity, 'accepted', result('accepted'))
      h.owner.store.finishBatch(h.scope()); h.owner.store.finish(h.scope(), 'completed'); h.reopen()
      expect(h.product.resourceCleanup.listRetainedFileEditOperationIds('run')).toEqual([])
      expect(h.product.resourceCleanup.listFileEditCleanupRunIds()).toEqual(['run'])
    } finally { h.dispose() }
  })

  it.each([false, true])('hands a restore to file evidence cleanup after acceptance or cancellation=%s', async cancel => {
    const h = fixture()
    try {
      const requested = call('restore', 'restore_file_edit', { request_id: ' original ', operation_id: 'operation' })
      h.sql.prepare('INSERT INTO agent_file_edit_retained_operations(request_id,operation_id) VALUES (?,?)').run('original', 'operation')
      await start(h, [requested])
      h.owner.store.saveEffectResult(arm(h, requested.id, 'original', 'operation'), result(requested.id))
      h.reopen()
      expect(h.product.resourceCleanup.listRetainedFileEditOperationIds('original')).toEqual(['operation'])
      expect(h.product.resourceCleanup.listFileEditCleanupRunIds()).toEqual([])
      if (cancel) {
        h.owner.store.finish(h.scope(), 'cancelled'); h.reopen()
        expect(h.product.resourceCleanup.listRetainedFileEditOperationIds('original')).toEqual([])
        expect(h.product.resourceCleanup.listFileEditCleanupRunIds()).toEqual(['original', 'run'])
        h.product.resourceCleanup.acknowledgeFileEditCleanup('original'); h.product.resourceCleanup.acknowledgeFileEditCleanup('run')
        const history = new NativeHistoryOwner(h.sql, h.owner)
        history.commit(history.prepare({ threadId: h.identity.threadId, messageId: 'input', kind: 'truncate' }))
        h.reopen()
        expect(h.product.resourceCleanup.listRetainedFileEditOperationIds('original')).toEqual([])
        expect(h.product.resourceCleanup.listFileEditCleanupRunIds()).toEqual(['original', 'run'])
        expect(h.sql.prepare('SELECT 1 FROM execution_effects').all()).toEqual([])
      } else {
        const before = h.owner.store.load(h.identity.threadId)
        h.sql.exec("CREATE TRIGGER fail_restore_cleanup BEFORE INSERT ON agent_file_edit_cleanup_outbox BEGIN SELECT RAISE(ABORT,'restore cleanup failed'); END")
        expect(() => h.owner.store.settleCall(h.identity, requested.id, result(requested.id))).toThrow('restore cleanup failed')
        expect(h.product.resourceCleanup.listRetainedFileEditOperationIds('original')).toEqual(['operation'])
        expect(h.owner.store.load(h.identity.threadId)).toEqual(before)
        h.sql.exec('DROP TRIGGER fail_restore_cleanup'); h.owner.store.settleCall(h.identity, requested.id, result(requested.id)); h.reopen()
        expect(h.product.resourceCleanup.listRetainedFileEditOperationIds('original')).toEqual([])
        expect(h.product.resourceCleanup.listFileEditCleanupRunIds()).toEqual(['original'])
        h.product.resourceCleanup.acknowledgeFileEditCleanup('original')
        h.owner.store.finishBatch(h.scope()); h.owner.store.finish(h.scope(), 'completed')
        expect(h.product.resourceCleanup.listFileEditCleanupRunIds()).toEqual(['run'])
      }
    } finally { h.dispose() }
  })
})
