import type Database from 'better-sqlite3'
import { NativeExecutionStore } from './nativeExecutionStore'

/** Called only with a complete native product schema and inside its resource
 * mutation transaction. Constructors and v0 readers never invoke collection. */
export function collectNativeMessageBodies(database: Database.Database, threadId: string): number {
  if (!database.inTransaction) throw new Error('Body collection requires the owning product transaction.')
  const rows = database.prepare(`SELECT record_id FROM agent_message_payloads WHERE thread_id=?
    UNION SELECT record_id FROM agent_message_index WHERE thread_id=?
    UNION SELECT record_id FROM execution_managed_results WHERE thread_id=?`).all(threadId, threadId, threadId) as { record_id: string }[]
  return new NativeExecutionStore(database).collectBodies(threadId, rows.map(row => row.record_id))
}
