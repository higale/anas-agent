import { parseRunConfiguration, serializeRunConfiguration, type RunConfiguration } from '../../shared/agentCapabilities'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { isAgentThreadLocked, type AgentRun, type AgentThreadStatus } from '../../shared/agentTypes'
import { AgentThreadLockedError } from './agentErrors'
import type { ArchivedAgentAttachment } from './agentAttachmentStore'

/** Creates the product run, saved input and archived attachment references in
 * one transaction. Input encoding belongs to the execution boundary. */
export class RunSubmissionStore {
  constructor(private readonly database: Database.Database) {}

  getRunConfiguration(runId: string): RunConfiguration | undefined {
    const row = this.database.prepare(`
      SELECT configuration_json FROM agent_runs WHERE id = ?
    `).get(runId) as { configuration_json: string | null } | undefined
    if (!row) throw new Error(`Run ${runId} was not found.`)
    return row.configuration_json === null ? undefined : parseRunConfiguration(JSON.parse(row.configuration_json))
  }

  resolveRunConfiguration(runId: string, value: RunConfiguration): void {
    const serialized = JSON.stringify(serializeRunConfiguration(value))
    // Capture the first resolved configuration before execution. Approval
    // continuations and process recovery must keep the same run-level setting.
    const row = this.database.prepare(`
      UPDATE agent_runs
      SET configuration_json = COALESCE(configuration_json, @serialized)
      WHERE id = @runId
      RETURNING configuration_json
    `).get({ runId, serialized }) as { configuration_json: string } | undefined
    if (!row) throw new Error(`Run ${runId} was not found.`)
    if (row.configuration_json !== serialized) {
      throw new Error(`The configuration for run ${runId} is already fixed.`)
    }
  }

  createRun(
    threadId: string,
    runId: string = randomUUID(),
    operation: AgentRun['operation'] = 'agent',
    attachments: ArchivedAgentAttachment[] = [],
    inputJson?: string,
    submissionId?: string
  ): AgentRun {
    const now = new Date().toISOString()
    const run: AgentRun = {
      id: runId,
      threadId,
      operation,
      status: 'running',
      createdAt: now,
      updatedAt: now
    }
    const create = this.database.transaction((): AgentRun => {
      const thread = this.database.prepare('SELECT status FROM agent_threads WHERE id=?').get(threadId) as { status: AgentThreadStatus } | undefined
      if (!thread) throw new Error(`Thread ${threadId} was not found.`)
      if (isAgentThreadLocked(thread.status)) throw new AgentThreadLockedError(threadId, 'start another run')
      this.database.prepare(`
        INSERT INTO agent_runs (id, submission_id, thread_id, operation, status, created_at, updated_at)
        VALUES (@id, @submissionId, @threadId, @operation, @status, @createdAt, @updatedAt)
      `).run({ ...run, submissionId: submissionId ?? null })
      this.database.prepare(`
        UPDATE agent_threads
        SET status = 'running', updated_at = ?
        WHERE id = ?
      `).run(now, threadId)
      if (inputJson !== undefined) {
        this.database.prepare(`
          INSERT INTO agent_run_input_intents (run_id, input_json)
          VALUES (?, ?)
        `).run(run.id, inputJson)
      }
      if (attachments.some(({ artifact }) => artifact.messageId !== `${runId}:input`)) {
        throw new Error(`Initial attachments do not belong to run input ${runId}.`)
      }
      this.insertAttachments(run, attachments)
      return run
    })
    return create()
  }

  /** The caller owns the run creation/attachment append transaction. */
  insertAttachments(
    run: AgentRun,
    attachments: ArchivedAgentAttachment[]
  ): void {
    const insertAttachment = this.database.prepare(`
      INSERT INTO agent_attachments (
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
      ) VALUES (
        @id,
        @threadId,
        @messageId,
        @runId,
        @name,
        @mimeType,
        @size,
        @kind,
        @storagePath,
        @textTruncated,
        @contextPolicy,
        @createdAt
      )
    `)
    for (const archived of attachments) {
      const artifact = archived.artifact
      if (
        artifact.threadId !== run.threadId
        || artifact.runId !== run.id
        || !artifact.messageId.startsWith(`${run.id}:`)
      ) {
        throw new Error(`Attachment ${artifact.id} does not belong to run ${run.id}.`)
      }
      insertAttachment.run({
        ...artifact,
        storagePath: archived.storagePath,
        textTruncated: artifact.textTruncated ? 1 : 0
      })
    }
  }

}
