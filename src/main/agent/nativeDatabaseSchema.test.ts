import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { initializeNativeConversationStorage, validateNativeConversationSchema } from './nativeDatabaseSchema'
import { validateNativeExecutionStorage } from './nativeStorageValidation'
import { validateConversationResources } from './conversationResources'
import { NativeRunOwner } from './nativeRunOwner'
import { NativeMessageProjection } from './nativeMessageProjection'
import { NativeMessageReader } from './nativeMessageReader'
import { NativeHistoryOwner } from './nativeHistoryOwner'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '../../shared/types'
import { defaultCapabilities } from '../../shared/agentCapabilities'

describe('native conversation database creation', () => {
  it.each([
    ...[['agent_runs', 'error'], ['agent_threads', 'title'], ['execution_state', 'context_value'],
      ['execution_calls', 'call_value'], ['execution_message_bodies', 'value']].map(([table, column]) => ({
        table, sql: `ALTER TABLE ${table} RENAME COLUMN ${column} TO renamed_${column}` })),
    { table: 'execution_calls', sql: 'DROP TABLE execution_calls' }
  ])('rejects damaged $table structure without rewriting it', ({ table, sql }) => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-schema-fields-')), file = join(root, 'conversation.sqlite')
    let database = new Database(file)
    try {
      initializeNativeConversationStorage(database)
      database.exec(sql); database.close()
      const before = readFileSync(file); database = new Database(file, { readonly: true })
      expect(() => validateNativeConversationSchema(database)).toThrow(`Invalid native conversation schema: ${table}`)
      database.close(); expect(readFileSync(file)).toEqual(before)
    } finally { if (database.open) database.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it('rejects a changed native column type without rebuilding the inspected table', () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-schema-type-')), file = join(root, 'conversation.sqlite')
    let database = new Database(file)
    try {
      initializeNativeConversationStorage(database)
      const row = database.prepare("SELECT sql FROM sqlite_schema WHERE name='execution_calls'").get() as { sql: string }
      database.exec('DROP TABLE execution_calls'); database.exec(row.sql.replace('call_value BLOB', 'call_value TEXT')); database.close()
      const before = readFileSync(file); database = new Database(file, { readonly: true })
      expect(() => validateNativeConversationSchema(database)).toThrow('Invalid native conversation schema: execution_calls')
      database.close(); expect(readFileSync(file)).toEqual(before)
    } finally { if (database.open) database.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it.each([0, 2, 99])('rejects unsupported version %i without replacing existing content', version => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-schema-version-')), file = join(root, 'conversation.sqlite')
    let database = new Database(file)
    try {
      initializeNativeConversationStorage(database)
      new NativeRunOwner(database).createThread({ title: 'Preserve this data' }, 'thread')
      database.pragma(`user_version=${version}`); database.close()
      const before = readFileSync(file); database = new Database(file)
      expect(() => initializeNativeConversationStorage(database)).toThrow('Unsupported native conversation database version')
      expect(database.prepare('SELECT title FROM agent_threads WHERE id=?').get('thread')).toEqual({ title: 'Preserve this data' })
      database.close(); expect(readFileSync(file)).toEqual(before)
    } finally { if (database.open) database.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it('creates only native execution storage and preserves pending input, child ownership and history across reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-schema-')), file = join(root, 'conversation.sqlite')
    let database = new Database(file)
    const services = () => {
      const projection = new NativeMessageProjection(database), owner = new NativeRunOwner(database, commit => projection.commit(commit))
      return { owner, reader: new NativeMessageReader(database), history: new NativeHistoryOwner(database, owner) }
    }
    const reopen = () => { database.close(); database = new Database(file); initializeNativeConversationStorage(database); return services() }
    try {
      initializeNativeConversationStorage(database)
      expect(database.pragma('user_version', { simple: true })).toBe(1)
      expect(database.prepare("SELECT name FROM sqlite_schema WHERE name IN ('current_state','message_bodies','agent_effect_journal','pending_writes')").all()).toEqual([])
      expect(database.prepare("SELECT name FROM pragma_table_info('agent_runs') WHERE name LIKE '%checkpoint%'").all()).toEqual([])
      let current = services()
      const identity = { threadId: 'thread', runId: 'first' }, message = { id: 'first:input', value: { id: 'first:input', kind: 'user' as const, content: 'Question', context: { runId: 'first' } } }
      current.owner.createThreadAndRun({ ...identity, thread: { title: 'Native conversation', modelConfigId: 'model' }, message, submissionId: 'submission' })
      validateNativeExecutionStorage(database)
      current = reopen()
      expect(current.owner.store.load('thread')).toBeUndefined()
      await current.owner.enter('input', identity)
      const child = current.owner.createSubagentCall({ id: 'child', ownerThreadId: 'thread', parentThreadId: 'thread', parentRunId: 'first',
        childThreadId: 'child-thread', childRunId: 'child-run', description: 'Child input', childThread: {},
        config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
      validateNativeExecutionStorage(database)
      current = reopen()
      expect(current.owner.reconcileSubagent(child.id, 'thread')).toBeUndefined()
      await current.owner.enter('input', { threadId: child.childThreadId, runId: child.childRunId })
      current.owner.store.finish({ threadId: child.childThreadId, runId: child.childRunId, expectedRevisionId: current.owner.store.load(child.childThreadId)!.revisionId }, 'cancelled')
      current.owner.reconcileSubagent(child.id, 'thread')
      const scope = () => ({ ...identity, expectedRevisionId: current.owner.store.load('thread')!.revisionId })
      current.owner.store.acceptModel(scope(), { id: 'answer', value: { id: 'answer', kind: 'assistant', content: 'Saved answer' } }, [], { modelCalls: 1, todos: [] })
      current.owner.store.finish(scope(), 'completed')
      current = reopen()
      expect(current.reader.window('thread').messages).toHaveLength(2)
      validateNativeExecutionStorage(database)
      validateConversationResources(database, join(root, 'attachments'), new Set([DEFAULT_WORKSPACE_PROJECT_ID]), 'thread')
      const revision = current.history.prepare({ threadId: 'thread', messageId: message.id, kind: 'regenerate', runId: 'replacement' })
      const replacement = current.history.commit(revision).run!
      current = reopen(); await current.owner.enter('input', { threadId: 'thread', runId: replacement.id })
      expect(current.reader.window('thread').messages).toHaveLength(1)
      expect(database.prepare('SELECT 1 FROM agent_subagent_calls').get()).toBeUndefined()
      validateNativeExecutionStorage(database)
    } finally { database.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it('atomically rolls back a failed first submission including its history head', () => {
    const database = new Database(':memory:')
    try {
      initializeNativeConversationStorage(database)
      database.exec("CREATE TRIGGER fail_input BEFORE INSERT ON agent_run_input_intents BEGIN SELECT RAISE(ABORT,'input failed'); END")
      const owner = new NativeRunOwner(database), input = { threadId: 'thread', runId: 'run', thread: {}, submissionId: 'submission',
        message: { id: 'run:input', value: { id: 'run:input', kind: 'user' as const, content: 'Question', context: { runId: 'run' } } } }
      expect(() => owner.createThreadAndRun(input)).toThrow('input failed')
      expect(database.prepare('SELECT * FROM agent_threads').all()).toEqual([])
      expect(database.prepare('SELECT * FROM execution_state').all()).toEqual([])
      database.exec('DROP TRIGGER fail_input'); owner.createThreadAndRun(input)
      validateNativeExecutionStorage(database)
    } finally { database.close() }
  })

  it.each(['legacy', 'unrelated', 'future', 'damaged', 'missing index', 'missing trigger'] as const)('does not initialize or repair %s storage', kind => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-schema-reject-')), file = join(root, 'conversation.sqlite')
    let database = new Database(file)
    try {
      if (kind === 'legacy') database.exec('CREATE TABLE current_state(value TEXT)')
      else if (kind === 'unrelated') database.exec("CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('keep')")
      else if (kind === 'future') database.pragma('user_version=42')
      else {
        initializeNativeConversationStorage(database)
        database.exec(kind === 'damaged' ? 'DROP TABLE agent_queued_attachments'
          : kind === 'missing index' ? 'DROP INDEX agent_managed_calls_id_thread_idx' : 'DROP TRIGGER agent_release_message_payload')
      }
      database.close(); const before = readFileSync(file); database = new Database(file)
      expect(() => initializeNativeConversationStorage(database)).toThrow(kind === 'legacy' || kind === 'unrelated' || kind === 'future' ? /version/ : 'Invalid native conversation schema')
      database.close(); expect(readFileSync(file)).toEqual(before); database = new Database(file)
      if (kind === 'damaged') expect(() => validateNativeConversationSchema(database)).toThrow('agent_queued_attachments')
    } finally { database.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
