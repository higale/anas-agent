import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import { decodeExecutionInput } from '../../runtime/executionInput'
import { NativeExecutionStore } from './nativeExecutionStore'
import { validateNativeManagedResult } from './nativeManagedResults'

export const nativeConversationSchemaVersion = 1

/** Execution-specific validation shared by native storage creation
 * and recovery. It neither mutates data nor depends on a previous format.
 * Attachment files and other product resources need their own validation. */
export function validateNativeExecutionStorage(database: Database.Database): void {
  database.transaction(() => {
    const fail = (detail: string): never => { throw new Error(`Invalid native execution storage: ${detail}.`) }
    if (!isDeepStrictEqual(database.pragma('quick_check'), [{ quick_check: 'ok' }])
      || (database.pragma('foreign_key_check') as unknown[]).length) fail('SQLite integrity failure')
    const store = new NativeExecutionStore(database)
    const threads = database.prepare('SELECT id FROM agent_threads ORDER BY id').all() as Array<{ id: string }>
    if (!isDeepStrictEqual(database.prepare('SELECT thread_id AS id FROM execution_state ORDER BY thread_id').all(), threads)) fail('execution heads do not cover exactly the conversations')
    if (database.prepare(`SELECT 1 FROM execution_message_bodies body LEFT JOIN agent_threads thread ON thread.id=body.thread_id
      WHERE thread.id IS NULL LIMIT 1`).get()) fail('message body has no conversation owner')
    for (const thread of threads) {
      const history = store.readHistory(thread.id)!, state = store.load(thread.id)
      if (state && !database.prepare('SELECT 1 FROM agent_runs WHERE id=? AND thread_id=?').get(state.runId, thread.id)) fail('head has no owning run')
      const index = database.prepare('SELECT position,record_id,message_id,visible FROM agent_message_index WHERE thread_id=? ORDER BY position').all(thread.id)
      if (!isDeepStrictEqual(index, history.messages.map((message, position) => ({ position, record_id: message.recordId, message_id: message.id,
        visible: Number(message.value.kind === 'user' || message.value.kind === 'assistant' && !message.value.calls?.length) })))) fail('history index differs from the execution head')
      const owners = database.prepare('SELECT run_id FROM agent_message_index WHERE thread_id=? ORDER BY position').all(thread.id) as Array<{ run_id: string | null }>
      if (owners.some((row, position) => row.run_id !== null && !database.prepare('SELECT 1 FROM agent_runs WHERE id=? AND thread_id=?').get(row.run_id, thread.id)
        || history.messages[position].value.context?.runId !== undefined && history.messages[position].value.context!.runId !== row.run_id)) fail('history index has invalid run ownership')
      for (const body of database.prepare('SELECT record_id FROM execution_message_bodies WHERE thread_id=?').all(thread.id) as Array<{ record_id: string }>) {
        const message = store.readMessageRecord(thread.id, body.record_id)
        if (message.value.calls?.length && store.readModelCallIds(thread.id, body.record_id)?.length !== message.value.calls.length) fail('model body has no complete call identities')
      }
    }
    for (const row of database.prepare('SELECT thread_id,message_id,run_id,record_id,body_sequence FROM agent_message_payloads').all() as Array<{
      thread_id: string; message_id: string; run_id: string | null; record_id: string; body_sequence: number | null
    }>) {
      const message = store.readMessageRecord(row.thread_id, row.record_id)
      if (message.id !== row.message_id || row.body_sequence === null || !Number.isSafeInteger(row.body_sequence) || row.body_sequence < 0
        || row.run_id !== null && !database.prepare('SELECT 1 FROM agent_runs WHERE id=? AND thread_id=?').get(row.run_id, row.thread_id)
        || message.value.context?.runId !== undefined && message.value.context.runId !== row.run_id) fail('activity body has invalid ownership or ordering')
    }
    for (const row of database.prepare(`SELECT intent.run_id,intent.input_json,run.thread_id,run.operation,run.status
      FROM agent_run_input_intents intent JOIN agent_runs run ON run.id=intent.run_id`).all() as Array<{
      run_id: string; input_json: string; thread_id: string; operation: string; status: string
    }>) {
      const message = decodeExecutionInput(row.input_json)
      if (row.status !== 'running' || (row.operation === 'compression') !== (message === undefined)
        || message && message.value.context?.runId !== row.run_id || store.load(row.thread_id)?.runId === row.run_id) fail('saved input contradicts its owner or acceptance')
    }
    for (const row of database.prepare(`SELECT intent.run_id,intent.interrupt_id,intent.response_json,run.thread_id
      FROM agent_run_resume_intents intent JOIN agent_runs run ON run.id=intent.run_id`).all() as Array<{
      run_id: string; interrupt_id: string; response_json: string; thread_id: string
    }>) {
      const state = store.load(row.thread_id), answer = JSON.parse(row.response_json) as { generation?: unknown; response?: unknown } | null
      if (state?.runId !== row.run_id || !answer || !Object.hasOwn(answer, 'response')
        || !state.approvals.some(approval => approval.id === row.interrupt_id && approval.generation === answer.generation)) fail('saved answer has no matching approval generation')
    }
    for (const row of database.prepare('SELECT thread_id,run_id,call_id FROM execution_effects').all() as Array<{ thread_id: string; run_id: string; call_id: string }>) {
      if (!database.prepare('SELECT 1 FROM agent_runs WHERE id=? AND thread_id=?').get(row.run_id, row.thread_id)
        || !store.loadEffect({ threadId: row.thread_id, runId: row.run_id, callId: row.call_id })) fail('effect has no owning run')
    }
    for (const row of database.prepare('SELECT id,thread_id,result_text,outcome_json FROM agent_managed_calls').all() as Array<{
      id: string; thread_id: string; result_text: string | null; outcome_json: string | null
    }>) {
      const outcome = row.outcome_json === null ? {} : JSON.parse(row.outcome_json)
      if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) fail('invalid managed result outcome')
      if (outcome.result_format !== undefined) {
        if (outcome.result_format !== 'conversation' || typeof row.result_text !== 'string') fail('unsupported managed result encoding')
        validateNativeManagedResult(database, { id: row.id, threadId: row.thread_id, result: row.result_text! })
      }
    }
  })()
}
