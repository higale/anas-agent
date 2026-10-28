import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentContextSummary } from '../../shared/agentTypes'
import type { CompressionTrackingCallbacks } from '../../runtime/compression'
import { RunActivityMetadata } from './runActivityMetadata'
import { contextSummaryFromRow, type ContextSummaryRow } from './runActivityReader'

export interface StoredContextSummary extends AgentContextSummary {
  runId: string
  modelContent: string
  committedRevisionId: string
  cutoffIndex: number
  activatedAfterMessageIndex: number
}


export interface StagedContextSummaryDetails {
  summaryText: string
  modelContent?: string
  cutoffIndex?: number
  activatedAfterMessageIndex?: number
  coveredThroughMessageId?: string
  firstPreservedMessageId?: string
  inputTokensBefore?: number
  inputTokensAfter?: number
}

export function createCompressionTracking(
  storage: Pick<ContextSummaryStore, 'recordContextSummaryStarted' | 'stageContextSummary' | 'deleteContextSummary'>,
  runId: string,
  events: { started?(summary: AgentContextSummary): void; discarded?(summaryId: string): void } = {}
): CompressionTrackingCallbacks {
  return {
    onCompressionStart: () => {
      const summary = storage.recordContextSummaryStarted(runId)
      events.started?.(summary)
      return summary.id
    },
    onCompressionCompleted: (summaryId, summaryText, completion) => {
      storage.stageContextSummary(runId, summaryId, { summaryText, ...completion })
    },
    onCompressionFailed: summaryId => {
      storage.deleteContextSummary(runId, summaryId)
      events.discarded?.(summaryId)
    }
  }
}

export function storedContextSummaryFromRow(row: ContextSummaryRow): StoredContextSummary {
  if (
    row.status !== 'completed'
    || row.committed_checkpoint_id === null
    || row.cutoff_index === null
    || row.activated_after_message_index === null
  ) {
    throw new Error(`Context summary ${row.summary_id} has not been committed to an execution revision.`)
  }
  return {
    ...contextSummaryFromRow(row),
    runId: row.run_id,
    modelContent: row.model_content,
    // v1 keeps its persisted column name; its value is a native revision ID.
    committedRevisionId: row.committed_checkpoint_id,
    cutoffIndex: row.cutoff_index,
    activatedAfterMessageIndex: row.activated_after_message_index
  }
}

function timestamp(): string { return new Date().toISOString() }

/** Generation only stages a summary; the execution owner's transaction confirms
 * its exact content and boundary in native storage. */
export class ContextSummaryStore {
  private readonly activityMetadata: RunActivityMetadata
  constructor(private readonly database: Database.Database) { this.activityMetadata = new RunActivityMetadata(database) }
  private requireRun(runId: string): void {
    if (!this.database.prepare('SELECT 1 FROM agent_runs WHERE id=?').get(runId)) throw new Error(`Run ${runId} was not found.`)
  }

  recordContextSummaryStarted(runId: string, summaryId: string = randomUUID()): AgentContextSummary {
    this.requireRun(runId)
    const sequence = this.activityMetadata.nextSequence(runId)
    const createdAt = timestamp()
    this.database.prepare(`
      INSERT INTO agent_context_summaries (
        run_id,
        summary_id,
        sequence,
        status,
        created_at
      ) VALUES (?, ?, ?, 'running', ?)
    `).run(runId, summaryId, sequence, createdAt)
    return {
      id: summaryId,
      sequence,
      status: 'running',
      summaryText: '',
      createdAt
    }
  }

  stageContextSummary(
    runId: string,
    summaryId: string,
    details: StagedContextSummaryDetails
  ): AgentContextSummary {
    this.requireRun(runId)
    const result = this.database.prepare(`
      UPDATE agent_context_summaries
      SET summary_text = @summaryText,
          model_content = @modelContent,
          cutoff_index = @cutoffIndex,
          activated_after_message_index = @activatedAfterMessageIndex,
          covered_through_message_id = @coveredThroughMessageId,
          first_preserved_message_id = @firstPreservedMessageId,
          input_tokens_before = @inputTokensBefore,
          input_tokens_after = @inputTokensAfter
      WHERE run_id = @runId
        AND summary_id = @summaryId
        AND status = 'running'
        AND committed_checkpoint_id IS NULL
    `).run({
      runId,
      summaryId,
      summaryText: details.summaryText,
      modelContent: details.modelContent ?? '',
      cutoffIndex: details.cutoffIndex ?? null,
      activatedAfterMessageIndex: details.activatedAfterMessageIndex ?? null,
      coveredThroughMessageId: details.coveredThroughMessageId ?? null,
      firstPreservedMessageId: details.firstPreservedMessageId ?? null,
      inputTokensBefore: details.inputTokensBefore ?? null,
      inputTokensAfter: details.inputTokensAfter ?? null
    })
    if (result.changes !== 1) {
      throw new Error(`Context summary ${summaryId} is not available for staging in run ${runId}.`)
    }
    return this.requireContextSummary(runId, summaryId)
  }

  getCommittedContextSummary(runId: string, summaryId: string): StoredContextSummary|undefined {
    const row=this.database.prepare("SELECT * FROM agent_context_summaries WHERE run_id=? AND summary_id=? AND status='completed'").get(runId,summaryId) as ContextSummaryRow|undefined
    return row ? storedContextSummaryFromRow(row) : undefined
  }

  deleteContextSummary(runId: string, summaryId: string): void {
    this.requireRun(runId)
    this.database.prepare(`
      DELETE FROM agent_context_summaries
      WHERE run_id = ? AND summary_id = ?
    `).run(runId, summaryId)
  }

  private requireContextSummaryRow(runId: string, summaryId: string): ContextSummaryRow {
    const row = this.database.prepare(`
      SELECT
        summary.run_id,
        summary.summary_id,
        summary.sequence,
        summary.status,
        summary.summary_text,
        summary.model_content,
        summary.committed_checkpoint_id,
        summary.cutoff_index,
        summary.activated_after_message_index,
        summary.covered_through_message_id,
        summary.first_preserved_message_id,
        summary.input_tokens_before,
        summary.input_tokens_after,
        summary.created_at
      FROM agent_context_summaries summary
      WHERE summary.run_id = ? AND summary.summary_id = ?
    `).get(runId, summaryId) as ContextSummaryRow | undefined
    if (!row) throw new Error(`Context summary ${summaryId} was not found for run ${runId}.`)
    return row
  }

  private requireContextSummary(runId: string, summaryId: string): AgentContextSummary {
    return contextSummaryFromRow(this.requireContextSummaryRow(runId, summaryId))
  }

}
