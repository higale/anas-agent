import type Database from 'better-sqlite3'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { encodeConversationMessage, conversationMessageRecordId } from '../../runtime/conversationStorage'
import { managedToolResultReference } from '../../runtime/toolResultMessage'
import { NativeExecutionStore } from './nativeExecutionStore'

/** Installed during database creation, after the task tables and native
 * message schema. Construction alone never changes the product database. */
export const nativeManagedResultSchema = `
  CREATE TABLE execution_managed_results (
    thread_id TEXT NOT NULL, call_id TEXT NOT NULL, record_id TEXT NOT NULL,
    PRIMARY KEY (thread_id,call_id),
    FOREIGN KEY (call_id,thread_id) REFERENCES agent_managed_calls(id,thread_id) ON DELETE CASCADE,
    FOREIGN KEY (thread_id,record_id) REFERENCES execution_message_bodies(thread_id,record_id)
  );
`

export function validateNativeManagedResult(database: Database.Database, call: { id: string; threadId: string; result: string }): void {
  const reference = managedToolResultReference(call.result, call.threadId)
  const owned = database.prepare('SELECT record_id FROM execution_managed_results WHERE thread_id=? AND call_id=?')
    .get(call.threadId, call.id) as { record_id: string } | undefined
  if (owned?.record_id !== reference.record_id) throw new Error('Managed result is not retained by this call.')
  const message = new NativeExecutionStore(database).readMessageRecord(call.threadId, reference.record_id).value
  if (message.kind !== 'tool' || message.partial) throw new Error('A managed result must be a complete tool message.')
}

/** The task, not the active parent turn, retains the result. A detached task may
 * finish after a new parent run starts; deleting the task releases only its own
 * exact body reference, never another version with the same message ID. */
export class NativeManagedResults {
  readonly format = 'conversation' as const
  private readonly messages: NativeExecutionStore
  constructor(private readonly database: Database.Database) { this.messages = new NativeExecutionStore(database) }

  validateCallResult(call: { id: string; threadId: string; result?: string; outcome?: Record<string, unknown> }): void {
    const format = call.outcome?.result_format
    if (format !== undefined && format !== 'conversation') throw new Error('Managed result does not use the native conversation format.')
    if (call.result && format === 'conversation') validateNativeManagedResult(this.database, { ...call, result: call.result })
  }

  async save(message: ConversationMessage, owner: { threadId: string; runId: string; managedCallId: string }): Promise<string> {
    return this.database.transaction(() => {
      const call = this.database.prepare('SELECT run_id,status,created_at FROM agent_managed_calls WHERE id=? AND thread_id=?')
        .get(owner.managedCallId, owner.threadId) as { run_id: string; status: string; created_at: string } | undefined
      if (!call || call.run_id !== owner.runId || !['preparing', 'running'].includes(call.status)) throw new Error('The active managed call does not own this result.')
      if (message.kind !== 'tool' || message.partial || typeof message.resultFor !== 'string'
        || message.context?.runId !== undefined && message.context.runId !== owner.runId) throw new Error('A managed result requires a complete message for its run.')
      const id = message.id ?? `${owner.managedCallId}:result`
      if (!id) throw new Error('A managed result requires a message identity.')
      const value: ConversationMessage = { ...message, id, context: { ...message.context, runId: owner.runId,
        createdAt: message.context?.createdAt ?? call.created_at } }
      const bytes = encodeConversationMessage(value), recordId = conversationMessageRecordId(id, bytes)
      const existing = this.database.prepare('SELECT record_id FROM execution_managed_results WHERE thread_id=? AND call_id=?')
        .get(owner.threadId, owner.managedCallId) as { record_id: string } | undefined
      if (existing && existing.record_id !== recordId) throw new Error('The managed call already retained a different result.')
      this.database.prepare('INSERT OR IGNORE INTO execution_message_bodies(thread_id,record_id,message_id,value) VALUES (?,?,?,?)')
        .run(owner.threadId, recordId, id, bytes)
      this.database.prepare('INSERT OR IGNORE INTO execution_managed_results(thread_id,call_id,record_id) VALUES (?,?,?)')
        .run(owner.threadId, owner.managedCallId, recordId)
      const result = JSON.stringify({ type: 'message_record', thread_id: owner.threadId, record_id: recordId })
      validateNativeManagedResult(this.database, { id: owner.managedCallId, threadId: owner.threadId, result })
      return result
    })()
  }
  async read(reference: string, threadId: string): Promise<ConversationMessage> { return this.readSync(reference, threadId) }
  readSync(value: string, threadId: string): ConversationMessage {
    const reference = managedToolResultReference(value, threadId)
    const message = this.messages.readMessageRecord(threadId, reference.record_id).value
    if (message.kind !== 'tool' || message.partial) throw new Error('A managed result must be a complete tool message.')
    return message
  }
}
