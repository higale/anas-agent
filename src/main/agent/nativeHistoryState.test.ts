import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-history-')), file = join(root, 'state.sqlite')
  let database = new Database(file); database.pragma('foreign_keys=ON'); database.exec(nativeExecutionSchema)
  const committed = vi.fn()
  let store = new NativeExecutionStore(database, committed)
  store.start({ threadId: 'thread', runId: 'first', messages: [{ id: 'input', value: { kind: 'user', content: 'First' } }], context: { modelCalls: 0, todos: [] } })
  const scope = () => ({ threadId: 'thread', runId: store.load('thread')!.runId, expectedRevisionId: store.load('thread')!.revisionId })
  store.commitSummary(scope(), { id: 'summary', summaryText: 'Shown', modelContent: 'Summary body', cutoffIndex: 1,
    activatedAfterMessageIndex: 0, inputTokensBefore: 20, inputTokensAfter: 10 })
  store.acceptModel(scope(), { id: 'answer', value: { kind: 'assistant', content: 'Answer' } }, [], { ...store.load('thread')!.context, modelCalls: 1 })
  store.finish(scope(), 'completed')
  return { committed, get database() { return database }, get store() { return store }, scope,
    reopen() { database.close(); database = new Database(file); database.pragma('foreign_keys=ON'); store = new NativeExecutionStore(database, committed) },
    dispose() { database.close(); rmSync(root, { recursive: true, force: true }) } }
}

describe('native history without an active run', () => {
  it('retains exact history and its summary after reopen, then accepts the next run against that revision', () => {
    const h = fixture()
    try {
      const original = h.store.load('thread')!, calls = h.committed.mock.calls.length
      const revision = h.database.transaction(() => h.store.reviseHistory({ threadId: 'thread', expectedRevisionId: original.revisionId,
        retainedCount: 1, summary: original.context.summary }))()
      expect(h.committed).toHaveBeenCalledTimes(calls)
      h.reopen()
      expect(h.store.load('thread')).toBeUndefined()
      expect(h.store.readHistory('thread')).toEqual({ revisionId: revision, messages: original.messages.slice(0, 1),
        context: { modelCalls: 0, todos: [], summary: original.context.summary } })
      expect(h.database.prepare('SELECT run_id,phase FROM execution_state').get()).toEqual({ run_id: null, phase: 'idle' })
      const next = { threadId: 'thread', runId: 'second', messages: [{ id: 'next', value: { kind: 'user' as const, content: 'Continue' } }],
        context: h.store.readHistory('thread')!.context }
      expect(() => h.store.start({ ...next, expectedRevisionId: original.revisionId })).toThrow('revision changed')
      expect(h.store.load('thread')).toBeUndefined()
      h.store.start({ ...next, expectedRevisionId: revision })
      expect(h.store.load('thread')).toMatchObject({ runId: 'second', phase: 'prepare_model', context: { summary: original.context.summary } })
      expect(h.store.load('thread')!.messages.map(record => record.id)).toEqual(['input', 'next'])
    } finally { h.dispose() }
  })

  it('rolls the new history revision back with product cleanup and can repeatedly truncate to empty', () => {
    const h = fixture()
    try {
      const original = h.store.load('thread')!, originalHistory = h.store.readHistory('thread')
      const revision = { threadId: 'thread', expectedRevisionId: original.revisionId, retainedCount: 1 }
      expect(() => h.store.reviseHistory(revision)).toThrow('owning product transaction')
      expect(() => h.database.transaction(() => {
        h.store.reviseHistory(revision)
        throw new Error('resource cleanup failed')
      })()).toThrow('resource cleanup failed')
      expect(h.store.load('thread')).toEqual(original)
      expect(h.store.readHistory('thread')).toEqual(originalHistory)
      const first = h.database.transaction(() => h.store.reviseHistory(revision))()
      expect(() => h.database.transaction(() => h.store.reviseHistory(revision))()).toThrow('history changed')
      const second = h.database.transaction(() => h.store.reviseHistory({ ...revision, expectedRevisionId: first, retainedCount: 0 }))()
      h.reopen()
      expect(h.store.readHistory('thread')).toEqual({ revisionId: second, messages: [], context: { modelCalls: 0, todos: [] } })
      expect(h.store.load('thread')).toBeUndefined()
      expect(h.store.readMessageRecord('thread', original.messages[1].recordId)).toEqual(original.messages[1])
      expect(h.database.pragma('foreign_key_check')).toEqual([])
    } finally { h.dispose() }
  })

  it('rejects active execution, invalid boundaries and a summary covering discarded history', () => {
    const h = fixture()
    try {
      const original = h.store.load('thread')!
      const revise = (retainedCount: number, summary = original.context.summary) => h.database.transaction(() => h.store.reviseHistory({
        threadId: 'thread', expectedRevisionId: h.store.readHistory('thread')!.revisionId, retainedCount, summary }))()
      for (const count of [-1, 0.5, 3]) expect(() => revise(count)).toThrow('boundary')
      expect(() => revise(0)).toThrow('summary does not belong')
      expect(() => revise(1, { id: 'wrong', messageRecordId: original.messages[0].recordId, cutoffIndex: 1 })).toThrow('summary does not belong')
      expect(h.store.load('thread')).toEqual(original)
      h.store.start({ threadId: 'thread', runId: 'next', expectedRevisionId: original.revisionId, messages: [], context: { modelCalls: 0, todos: [] } })
      expect(() => revise(1)).toThrow('still active')
      expect(h.store.load('thread')?.runId).toBe('next')
    } finally { h.dispose() }
  })
})
