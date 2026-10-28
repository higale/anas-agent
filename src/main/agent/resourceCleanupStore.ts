import type Database from 'better-sqlite3'
import { resolve } from 'node:path'
import type { AgentAttachmentArtifact } from '../../shared/agentTypes'
import type { FileChangeLedger } from './fileChangeLedger'
import { assertCleanupStorageIntegrity } from './conversationResources'

function requireNonEmptyText(value: string, label: string): void {
  if (typeof value !== 'string' || !value.trim()) throw new Error(label + ' must be non-empty.')
}

/** Durable deletion handoff shared by the product and native conversation owner. */
export class ResourceCleanupStore {
  constructor(private readonly database: Database.Database, readonly attachmentRoot: string,
    readonly fileChanges: FileChangeLedger) {}

  hasFileEditCleanup(runId: string): boolean {
    return !!this.database.prepare('SELECT 1 FROM agent_file_edit_cleanup_outbox WHERE run_id=?').get(runId)
  }

  listFileEditCleanupRunIds(): string[] {
    const rows = this.database.prepare(`
      SELECT run_id
      FROM agent_file_edit_cleanup_outbox
      ORDER BY rowid ASC
    `).all() as Array<{ run_id: string }>
    return rows.map((row) => row.run_id)
  }

  listAttachmentCleanupThreadIds(): string[] {
    const rows = this.database.prepare(`
      SELECT thread_id
      FROM agent_attachment_cleanup_outbox
      ORDER BY rowid ASC
    `).all() as Array<{ thread_id: string }>
    return rows.map((row) => row.thread_id)
  }

  acknowledgeAttachmentCleanup(threadId: string): void {
    requireNonEmptyText(threadId, 'Attachment cleanup thread ID')
    this.database.prepare(`
      DELETE FROM agent_attachment_cleanup_outbox
      WHERE thread_id = ?
    `).run(threadId)
    this.database.prepare('DELETE FROM agent_attachment_file_cleanup_outbox WHERE thread_id = ?').run(threadId)
  }

  listAttachmentFileCleanup(): Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>> {
    assertCleanupStorageIntegrity(this.database)
    const rows = this.database.prepare('SELECT attachment_id, storage_path FROM agent_attachment_file_cleanup_outbox ORDER BY rowid')
      .all() as Array<{ attachment_id: string; storage_path: string }>
    return rows.map((row) => ({ id: row.attachment_id, path: resolve(this.attachmentRoot, row.storage_path) }))
  }

  acknowledgeAttachmentFileCleanup(attachmentId: string): void {
    this.database.prepare('DELETE FROM agent_attachment_file_cleanup_outbox WHERE attachment_id = ?').run(attachmentId)
  }

  listRetainedFileEditOperationIds(requestId: string): string[] {
    requireNonEmptyText(requestId, 'File edit request ID')
    const rows = this.database.prepare(`
      SELECT operation_id
      FROM agent_file_edit_retained_operations
      WHERE request_id = ?
      ORDER BY rowid ASC
    `).all(requestId) as Array<{ operation_id: string }>
    return rows.map((row) => row.operation_id)
  }

  acknowledgeFileEditCleanup(runId: string): void {
    const result = this.database.prepare(`
      DELETE FROM agent_file_edit_cleanup_outbox
      WHERE run_id = ?
    `).run(runId)
    if (result.changes) this.fileChanges.notifyChanged(runId)
  }
}
