import type Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { AgentThread, AgentAttachmentArtifact } from '../../shared/agentTypes'
import type { SqliteMemoryStore } from './memoryStore'
import type { FileChangeLedger } from './fileChangeLedger'
import type { FileEditStore } from '../fileEditStore'
import { readThreadRecord } from './conversationThreads'
import { subagentCallFromRow, type SubagentCallRow, type AgentSubagentCallRecord } from './subagentTaskStore'
import type { AttachmentRow } from './historyRevisionResources'

/** Business resources needed to assemble a conversation executor. No execution
 * state or framework storage is exposed through this boundary. */
export interface ConversationResourceAccess {
  readonly memoryStore: SqliteMemoryStore
  readonly fileChanges: FileChangeLedger
  readonly fileEditStore: FileEditStore
  readonly toolResultsRoot: string
  getSubagentCallByChildThreadId(threadId: string): AgentSubagentCallRecord | undefined
  getThread(threadId: string): AgentThread | null
  listAttachmentsForThread(threadId: string): AgentAttachmentArtifact[]
  listSubagentCallsForParentRun(runId: string): AgentSubagentCallRecord[]
  listUnresolvedSubagentCallsForRun(runId: string, limit?: number): AgentSubagentCallRecord[]
  hasUnresolvedManagedCallsForThread(threadId: string): boolean
}

export function conversationAttachmentFromRow(row: AttachmentRow, attachmentRoot: string): AgentAttachmentArtifact {
  const path = resolve(attachmentRoot, row.storage_path)
  const managed = path.startsWith(`${attachmentRoot}${sep}`)
  return {
    id: row.id,
    threadId: row.thread_id,
    messageId: row.message_id,
    runId: row.run_id,
    name: row.name,
    mimeType: row.mime_type,
    size: row.size,
    kind: row.kind,
    path: managed ? path : '',
    available: managed && existsSync(path),
    textTruncated: row.text_truncated === 1,
    contextPolicy: row.context_policy,
    createdAt: row.created_at
  }
}


/** Same business reads for the current product and native conversation storage. */
export class ConversationResourceReader implements ConversationResourceAccess {
  readonly toolResultsRoot: string
  constructor(private readonly database: Database.Database, private readonly attachmentRoot: string,
    readonly memoryStore: SqliteMemoryStore, readonly fileChanges: FileChangeLedger, readonly fileEditStore: FileEditStore) { this.toolResultsRoot = join(dirname(attachmentRoot), 'tool_results') }

  getThread(threadId: string): AgentThread | null { return readThreadRecord(this.database, threadId) }

  listAttachmentsForMessages(threadId: string, messageIds: string[]): AgentAttachmentArtifact[] {
    if (!messageIds.length) return []
    const rows = this.database.prepare('SELECT * FROM agent_attachments WHERE thread_id=? AND message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at,id')
      .all(threadId, JSON.stringify(messageIds)) as AttachmentRow[]
    return rows.map(row => conversationAttachmentFromRow(row, this.attachmentRoot))
  }

  getSubagentCallByChildThreadId(childThreadId: string): AgentSubagentCallRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, owner_thread_id, parent_thread_id, parent_run_id,
             parent_subagent_id, child_thread_id, child_run_id,
             agent_name, config_json, description, status, result_text, error,
             created_at, updated_at
      FROM agent_subagent_calls
      WHERE child_thread_id = ?
    `).get(childThreadId) as SubagentCallRow | undefined
    return row ? subagentCallFromRow(row) : undefined
  }

  listSubagentCallsForParentRun(parentRunId: string): AgentSubagentCallRecord[] {
    const rows = this.database.prepare(`
      SELECT id, owner_thread_id, parent_thread_id, parent_run_id,
             parent_subagent_id, child_thread_id, child_run_id,
             agent_name, config_json, description, status, result_text, error,
             created_at, updated_at
      FROM agent_subagent_calls
      WHERE parent_run_id = ?
      ORDER BY created_at ASC, id ASC
    `).all(parentRunId) as SubagentCallRow[]
    return rows.map(subagentCallFromRow)
  }

  listUnresolvedSubagentCallsForRun(
    parentRunId: string,
    limit?: number
  ): AgentSubagentCallRecord[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error('Subagent query limit must be a positive safe integer.')
    }
    const rows = this.database.prepare(`
      SELECT call.id, call.owner_thread_id, call.parent_thread_id, call.parent_run_id,
             call.parent_subagent_id, call.child_thread_id, call.child_run_id,
             call.agent_name, call.config_json, call.description,
             call.status, call.result_text, call.error,
             call.created_at, call.updated_at
      FROM agent_subagent_calls call
      WHERE call.parent_run_id = ?
        AND NOT EXISTS (SELECT 1 FROM agent_subagent_cleanup cleanup WHERE cleanup.subagent_id = call.id)
        AND NOT EXISTS (
          SELECT 1
          FROM agent_subagent_observations observation
          WHERE observation.subagent_id = call.id
            AND observation.observing_run_id = call.parent_run_id
        )
      ORDER BY call.created_at ASC, call.id ASC
      LIMIT ?
    `).all(parentRunId, limit ?? -1) as SubagentCallRow[]
    return rows.map(subagentCallFromRow)
  }

  hasUnresolvedManagedCallsForThread(threadId: string): boolean {
    return this.database.prepare(`
      SELECT 1
      FROM agent_managed_calls AS call
      WHERE call.thread_id = ?
        AND call.detached_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_managed_call_cleanup cleanup WHERE cleanup.call_id = call.id)
        AND NOT EXISTS (
          SELECT 1
          FROM agent_managed_call_observations AS observation
          WHERE observation.call_id = call.id
        )
      LIMIT 1
    `).get(threadId) !== undefined
  }

  listAttachmentsForThread(threadId: string): AgentAttachmentArtifact[] {
    if (!this.getThread(threadId)) throw new Error(`Thread ${threadId} was not found.`)
    const rows = this.database.prepare(`
      SELECT
        id,
        thread_id,
        message_id,
        run_id,
        name,
        mime_type,
        size,
        kind,
        storage_path,
        text_truncated,
        context_policy,
        created_at
      FROM agent_attachments
      WHERE thread_id = ?
      ORDER BY rowid ASC
    `).all(threadId) as AttachmentRow[]
    return rows.map((row) => conversationAttachmentFromRow(row, this.attachmentRoot))
  }

}
