import type Database from 'better-sqlite3'
import type { AgentAttachmentArtifact } from '../../shared/agentTypes'
import type { ContextSummaryRow } from './runActivityReader'

export type AttachmentRow = {
  id: string; thread_id: string; message_id: string; run_id: string; name: string; mime_type: string;
  size: number; kind: AgentAttachmentArtifact['kind']; storage_path: string; text_truncated: number;
  context_policy: AgentAttachmentArtifact['contextPolicy']; created_at: string
}

/** Product resources discarded by a history revision. Execution heads and
 * file-effect recovery are handled by their owners in the same transaction. */
export class HistoryRevisionResources {
  constructor(private readonly database: Database.Database) {}

  runIdsFrom(threadId: string, fromRunId: string): string[] {
    const boundary = this.database.prepare('SELECT thread_id FROM agent_runs WHERE id=?').get(fromRunId) as { thread_id: string } | undefined
    if (!boundary) throw new Error(`Run ${fromRunId} was not found.`)
    if (boundary.thread_id !== threadId) throw new Error('History boundary belongs to another conversation.')
    return (this.database.prepare(`SELECT id FROM agent_runs WHERE thread_id=?
      AND sequence >= (SELECT sequence FROM agent_runs WHERE id=?) ORDER BY sequence`).all(threadId, fromRunId) as { id: string }[]).map(run => run.id)
  }

  prepare(threadId: string, fromRunId: string, retainedCount: number, preservedMessageId?: string) {
    const runIds = this.runIdsFrom(threadId, fromRunId)
    const children = this.database.prepare(`WITH RECURSIVE descendants(id) AS (
      SELECT id FROM agent_subagent_calls WHERE owner_thread_id=@threadId AND parent_run_id IN (SELECT value FROM json_each(@runs))
      UNION SELECT call.id FROM agent_subagent_calls call JOIN descendants parent ON call.parent_subagent_id=parent.id
        WHERE call.owner_thread_id=@threadId
    ) SELECT call.id,call.child_thread_id AS threadId,call.child_run_id AS runId
      FROM agent_subagent_calls call JOIN descendants ON descendants.id=call.id ORDER BY call.created_at,call.id`)
      .all({ threadId, runs: JSON.stringify(runIds) }) as { id: string; threadId: string; runId: string }[]
    const summary = this.database.prepare(`SELECT summary.* FROM agent_context_summaries summary
      JOIN agent_runs run ON run.id=summary.run_id
      WHERE run.thread_id=? AND run.sequence < (SELECT sequence FROM agent_runs WHERE id=?)
        AND summary.status='completed' AND summary.cutoff_index <= ? AND summary.activated_after_message_index <= ?
      ORDER BY run.sequence DESC,summary.sequence DESC LIMIT 1`).get(threadId, fromRunId, retainedCount, retainedCount) as ContextSummaryRow | undefined
    const preserved = preservedMessageId ? this.database.prepare('SELECT * FROM agent_attachments WHERE thread_id=? AND message_id=?')
      .all(threadId, preservedMessageId) as AttachmentRow[] : []
    const attachments = this.database.prepare('SELECT * FROM agent_attachments WHERE run_id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...runIds, ...children.map(child => child.runId)])) as AttachmentRow[]
    return { threadId, runIds, children, summary, preserved, attachments }
  }

  remove(plan: ReturnType<HistoryRevisionResources['prepare']>): void {
    if (!this.database.inTransaction) throw new Error('History cleanup requires the owning revision transaction.')
    for (const child of [...plan.children].reverse()) {
      this.database.prepare('INSERT OR IGNORE INTO agent_attachment_cleanup_outbox(thread_id) VALUES (?)').run(child.threadId)
      this.database.prepare('DELETE FROM agent_threads WHERE id=?').run(child.threadId)
    }
    for (const runId of plan.runIds) this.database.prepare('INSERT OR IGNORE INTO agent_file_edit_cleanup_outbox(run_id) VALUES (?)').run(runId)
    this.database.prepare('DELETE FROM agent_runs WHERE id IN (SELECT value FROM json_each(?))').run(JSON.stringify(plan.runIds))
    this.database.prepare('DELETE FROM agent_context_status WHERE thread_id=?').run(plan.threadId)
    this.database.prepare("UPDATE agent_threads SET status='idle',updated_at=? WHERE id=?").run(new Date().toISOString(), plan.threadId)
    const preservedIds = new Set(plan.preserved.map(row => row.id))
    const enqueue = this.database.prepare(`INSERT INTO agent_attachment_file_cleanup_outbox(attachment_id,thread_id,storage_path)
      VALUES (?,?,?) ON CONFLICT(attachment_id) DO NOTHING`)
    for (const attachment of plan.attachments) if (!preservedIds.has(attachment.id)) enqueue.run(attachment.id, attachment.thread_id, attachment.storage_path)
  }

  restoreAttachments(plan: ReturnType<HistoryRevisionResources['prepare']>, runId: string): void {
    if (!this.database.inTransaction) throw new Error('History attachment transfer requires the owning revision transaction.')
    if (!this.database.prepare('SELECT 1 FROM agent_runs WHERE id=? AND thread_id=?').get(runId, plan.threadId)) throw new Error('Replacement run belongs to another conversation.')
    const insert = this.database.prepare(`INSERT INTO agent_attachments(id,thread_id,message_id,run_id,name,mime_type,size,kind,storage_path,text_truncated,context_policy,created_at)
      VALUES (@id,@thread_id,@message_id,@run_id,@name,@mime_type,@size,@kind,@storage_path,@text_truncated,@context_policy,@created_at)`)
    for (const row of plan.preserved) insert.run({ ...row, run_id: runId })
  }
}
