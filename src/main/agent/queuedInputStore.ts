import type Database from 'better-sqlite3'
import { existsSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import type { AgentQueuedInput, AgentQueuedInputCreate, AgentAttachmentArtifact } from '../../shared/agentTypes'
import type { SelectedAttachment } from '../../shared/types'
import type { ArchivedAgentAttachment } from './agentAttachmentStore'
import { readThreadRecord } from './conversationThreads'

type QueuedInputRow = {
  id: string
  thread_id: string
  text: string
  display_text: string
  status: AgentQueuedInput['status']
  error: string | null
  created_at: string
}

type QueuedAttachmentRow = {
  id: string
  queued_input_id: string
  name: string
  mime_type: string
  size: number
  kind: SelectedAttachment['kind']
  storage_path: string
  text_truncated: number
  context_policy: SelectedAttachment['contextPolicy']
  created_at: string
}

function timestamp(): string { return new Date().toISOString() }

/** Product queue and attachment ownership. Reading or retrying an item never
 * starts a run; delivery belongs to the authoritative execution owner. */
export class QueuedInputStore {
  constructor(private readonly database: Database.Database, private readonly attachmentRoot: string,
    private readonly changed: () => void = () => {}) {}

  createQueuedInput(
    input: AgentQueuedInputCreate,
    attachments: ArchivedAgentAttachment[]
  ): AgentQueuedInput {
    this.changed()
    if (!readThreadRecord(this.database, input.threadId)) throw new Error(`Thread ${input.threadId} was not found.`)
    const createdAt = timestamp()
    const create = this.database.transaction(() => {
      this.database.prepare(`
        INSERT INTO agent_queued_inputs (
          id, thread_id, text, display_text, status, error, created_at
        ) VALUES (?, ?, ?, ?, 'queued', NULL, ?)
      `).run(input.id, input.threadId, input.text, input.displayText ?? input.text, createdAt)
      const insertAttachment = this.database.prepare(`
        INSERT INTO agent_queued_attachments (
          id,
          queued_input_id,
          name,
          mime_type,
          size,
          kind,
          storage_path,
          text_truncated,
          context_policy,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      for (const archived of attachments) {
        const artifact = archived.artifact
        if (
          artifact.threadId !== input.threadId
          || artifact.runId !== input.id
          || artifact.messageId !== input.id
        ) {
          throw new Error(`Queued attachment ${artifact.id} does not belong to input ${input.id}.`)
        }
        insertAttachment.run(
          artifact.id,
          input.id,
          artifact.name,
          artifact.mimeType,
          artifact.size,
          artifact.kind,
          archived.storagePath,
          artifact.textTruncated ? 1 : 0,
          artifact.contextPolicy,
          artifact.createdAt
        )
      }
    })
    create()
    return this.requireQueuedInput(input.threadId, input.id)
  }

  listQueuedInputs(): AgentQueuedInput[] {
    const rows = this.database.prepare(`
      SELECT id, thread_id, text, display_text, status, error, created_at
      FROM agent_queued_inputs
      ORDER BY created_at ASC, rowid ASC
    `).all() as QueuedInputRow[]
    const attachmentRows = this.database.prepare(`
      SELECT
        id,
        queued_input_id,
        name,
        mime_type,
        size,
        kind,
        storage_path,
        text_truncated,
        context_policy,
        created_at
      FROM agent_queued_attachments
      ORDER BY created_at ASC, rowid ASC
    `).all() as QueuedAttachmentRow[]
    const attachmentsByInput = new Map<string, SelectedAttachment[]>()
    for (const row of attachmentRows) {
      const attachments = attachmentsByInput.get(row.queued_input_id) ?? []
      attachments.push(this.queuedAttachmentFromRow(row))
      attachmentsByInput.set(row.queued_input_id, attachments)
    }
    return rows.map((row) => this.queuedInputFromRow(
      row,
      attachmentsByInput.get(row.id) ?? []
    ))
  }

  getQueuedInput(threadId: string, queuedInputId: string): AgentQueuedInput | null {
    const row = this.database.prepare(`
      SELECT id, thread_id, text, display_text, status, error, created_at
      FROM agent_queued_inputs
      WHERE id = ? AND thread_id = ?
    `).get(queuedInputId, threadId) as QueuedInputRow | undefined
    if (!row) return null
    const attachments = this.database.prepare(`
      SELECT
        id,
        queued_input_id,
        name,
        mime_type,
        size,
        kind,
        storage_path,
        text_truncated,
        context_policy,
        created_at
      FROM agent_queued_attachments
      WHERE queued_input_id = ?
      ORDER BY created_at ASC, rowid ASC
    `).all(queuedInputId) as QueuedAttachmentRow[]
    return this.queuedInputFromRow(row, attachments.map((item) => this.queuedAttachmentFromRow(item)))
  }

  listQueuedInputAttachmentArtifacts(
    threadId: string,
    queuedInputId: string
  ): Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>> {
    if (!this.getQueuedInput(threadId, queuedInputId)) return []
    const rows = this.database.prepare(`
      SELECT id, storage_path
      FROM agent_queued_attachments
      WHERE queued_input_id = ?
      ORDER BY rowid ASC
    `).all(queuedInputId) as Array<{ id: string; storage_path: string }>
    return rows.map((row) => ({
      id: row.id,
      path: resolve(this.attachmentRoot, row.storage_path)
    }))
  }

  deleteQueuedInput(threadId: string, queuedInputId: string): boolean {
    this.changed()
    return this.database.transaction(() => {
      this.database.prepare(`INSERT OR IGNORE INTO agent_attachment_file_cleanup_outbox(attachment_id,thread_id,storage_path)
        SELECT attachment.id,queued.thread_id,attachment.storage_path FROM agent_queued_attachments attachment
        JOIN agent_queued_inputs queued ON queued.id=attachment.queued_input_id WHERE queued.id=? AND queued.thread_id=?`)
        .run(queuedInputId, threadId)
      return this.database.prepare('DELETE FROM agent_queued_inputs WHERE id=? AND thread_id=?').run(queuedInputId, threadId).changes > 0
    })()
  }

  markQueuedInputFailed(
    threadId: string,
    queuedInputId: string,
    error: string
  ): AgentQueuedInput {
    this.changed()
    const changed = this.database.prepare(`
      UPDATE agent_queued_inputs
      SET status = 'failed', error = ?
      WHERE id = ? AND thread_id = ?
    `).run(error, queuedInputId, threadId).changes
    if (changed === 0) throw new Error(`Queued input ${queuedInputId} was not found.`)
    return this.requireQueuedInput(threadId, queuedInputId)
  }

  retryQueuedInput(threadId: string, queuedInputId: string): AgentQueuedInput {
    this.changed()
    const changed = this.database.prepare(`
      UPDATE agent_queued_inputs
      SET status = 'queued', error = NULL
      WHERE id = ? AND thread_id = ?
    `).run(queuedInputId, threadId).changes
    if (changed === 0) throw new Error(`Queued input ${queuedInputId} was not found.`)
    return this.requireQueuedInput(threadId, queuedInputId)
  }
  private requireQueuedInput(threadId: string, queuedInputId: string): AgentQueuedInput {
    const queued = this.getQueuedInput(threadId, queuedInputId)
    if (!queued) throw new Error(`Queued input ${queuedInputId} was not found.`)
    return queued
  }

  private queuedInputFromRow(
    row: QueuedInputRow,
    attachments: SelectedAttachment[]
  ): AgentQueuedInput {
    return {
      id: row.id,
      threadId: row.thread_id,
      text: row.text,
      displayText: row.display_text,
      attachments,
      status: row.status,
      ...(row.error ? { error: row.error } : {}),
      createdAt: row.created_at
    }
  }

  private queuedAttachmentFromRow(row: QueuedAttachmentRow): SelectedAttachment {
    const path = resolve(this.attachmentRoot, row.storage_path)
    const managed = path.startsWith(`${this.attachmentRoot}${sep}`)
    const available = managed && existsSync(path)
    return {
      path: managed ? path : '',
      name: row.name,
      mimeType: row.mime_type,
      size: row.size,
      kind: row.kind,
      contextPolicy: row.context_policy,
      ...(row.text_truncated === 1 ? { truncated: true } : {}),
      ...(!available ? { skippedReason: 'Queued attachment is no longer available.' } : {})
    }
  }

}
