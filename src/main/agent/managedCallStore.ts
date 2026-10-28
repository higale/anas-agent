import type Database from 'better-sqlite3'

export type AgentManagedCallKind = 'shell' | 'http' | 'builtin' | 'mcp' | 'custom'
export type AgentManagedCallStatus =
  | 'preparing'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'uncertain'

export interface AgentManagedCallRecord {
  id: string
  threadId: string
  runId: string
  kind: AgentManagedCallKind
  summary: string
  status: AgentManagedCallStatus
  result?: string
  outcome?: Record<string, unknown>
  error?: string
  outputChars: number
  progressCurrent?: number
  progressTotal?: number
  progressUnit?: string
  dispatchedAt?: string
  detachedAt?: string
  createdAt: string
  updatedAt: string
}

export interface AgentManagedCallOutputChunk {
  sequence: number
  stream: 'stdout' | 'stderr' | 'progress'
  startOffset: number
  endOffset: number
  text: string
}

type ManagedCallRow = {
  id: string
  thread_id: string
  run_id: string
  kind: AgentManagedCallKind
  summary: string
  status: AgentManagedCallStatus
  result_text: string | null
  outcome_json: string | null
  error: string | null
  output_chars: number
  progress_current: number | null
  progress_total: number | null
  progress_unit: string | null
  dispatched_at: string | null
  detached_at: string | null
  created_at: string
  updated_at: string
}

type ManagedCallOutputRow = {
  sequence: number
  stream: AgentManagedCallOutputChunk['stream']
  start_offset: number
  end_offset: number
  text: string
}

type ManagedCallOutputStateRow = {
  status: AgentManagedCallStatus
  output_chars: number
  next_output_sequence: number
}

const terminalManagedCallStatuses = new Set<AgentManagedCallStatus>([
  'completed',
  'failed',
  'cancelled',
  'uncertain'
])

function isTerminalManagedCallStatus(status: AgentManagedCallStatus): boolean {
  return terminalManagedCallStatuses.has(status)
}

function managedCallFromRow(row: ManagedCallRow): AgentManagedCallRecord {
  return {
    id: row.id,
    threadId: row.thread_id,
    runId: row.run_id,
    kind: row.kind,
    summary: row.summary,
    status: row.status,
    ...(row.result_text === null ? {} : { result: row.result_text }),
    ...(row.outcome_json === null
      ? {}
      : { outcome: parseValue(row.outcome_json) as Record<string, unknown> }),
    ...(row.error === null ? {} : { error: row.error }),
    outputChars: row.output_chars,
    ...(row.progress_current === null ? {} : { progressCurrent: row.progress_current }),
    ...(row.progress_total === null ? {} : { progressTotal: row.progress_total }),
    ...(row.progress_unit === null ? {} : { progressUnit: row.progress_unit }),
    ...(row.dispatched_at === null ? {} : { dispatchedAt: row.dispatched_at }),
    ...(row.detached_at === null ? {} : { detachedAt: row.detached_at }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function serializeValue(value: unknown): string | null {
  if (value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify(String(value))
  }
}

function parseValue(value: string | null): unknown {
  if (value === null) return undefined
  return JSON.parse(value) as unknown
}

function timestamp(): string { return new Date().toISOString() }

/** Persistent managed task lifecycle, independent of the conversation executor.
 * The result owner validates and retains its exact reference in the same transaction. */
export class ManagedCallStore {
  constructor(private readonly database: Database.Database, private readonly commitResult: (call: AgentManagedCallRecord) => void) {}

  /** Startup only, before any task service dispatch. Never reports an old
   * process as cancelled successfully or retries its external effects. */
  recoverAbandonedCalls(): void {
    this.database.exec(`
      UPDATE agent_run_background_cleanup
      SET status = 'unconfirmed',
          report = report || char(10) || 'Background cleanup finished with unconfirmed outcomes.'
      WHERE status = 'running';

      UPDATE agent_managed_calls
      SET status = CASE WHEN status = 'preparing' THEN 'failed' ELSE 'uncertain' END,
          error = CASE
            WHEN status = 'preparing' THEN 'The application stopped before the operation was dispatched.'
            ELSE 'The application stopped while the operation was running; its final outcome is unknown.'
          END,
          detached_at = CASE
            WHEN status = 'running' THEN COALESCE(
              detached_at,
              strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
            )
            ELSE detached_at
          END,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE status IN ('preparing', 'running');
    `)
  }

  createManagedCall(input: {
    id: string
    threadId: string
    runId: string
    kind: AgentManagedCallKind
    summary: string
  }): AgentManagedCallRecord {
    const run = this.requireRun(input.runId)
    if (run.threadId !== input.threadId) {
      throw new Error(`Run ${input.runId} does not belong to thread ${input.threadId}.`)
    }
    const now = timestamp()
    this.database.prepare(`
      INSERT INTO agent_managed_calls (
        id, thread_id, run_id, kind, summary, status,
        result_text, outcome_json, error, output_chars,
        progress_current, progress_total, progress_unit,
        next_output_sequence, dispatched_at, detached_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, 'preparing', NULL, NULL, NULL, 0, NULL, NULL, NULL, 1, NULL, NULL, ?, ?)
    `).run(input.id, input.threadId, input.runId, input.kind, input.summary, now, now)
    return this.requireManagedCall(input.id, input.threadId)
  }

  getManagedCall(callId: string, threadId: string): AgentManagedCallRecord | undefined {
    const row = this.database.prepare(`
      SELECT id, thread_id, run_id, kind, summary, status,
             result_text, outcome_json, error, output_chars,
             progress_current, progress_total, progress_unit, dispatched_at,
             detached_at, created_at, updated_at
      FROM agent_managed_calls
      WHERE id = ? AND thread_id = ?
    `).get(callId, threadId) as ManagedCallRow | undefined
    return row ? managedCallFromRow(row) : undefined
  }

  listUnresolvedManagedCalls(runId: string): AgentManagedCallRecord[] {
    const rows = this.database.prepare(`
      SELECT id, thread_id, run_id, kind, summary, status,
             result_text, outcome_json, error, output_chars,
             progress_current, progress_total, progress_unit, dispatched_at,
             detached_at, created_at, updated_at
      FROM agent_managed_calls AS call
      WHERE call.run_id = ?
        AND call.detached_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_managed_call_cleanup cleanup WHERE cleanup.call_id = call.id)
        AND NOT EXISTS (
          SELECT 1
          FROM agent_managed_call_observations AS observation
          WHERE observation.call_id = call.id
        )
      ORDER BY call.created_at ASC, call.id ASC
    `).all(runId) as ManagedCallRow[]
    return rows.map(managedCallFromRow)
  }

  listUnresolvedManagedCallsForThread(
    threadId: string,
    limit?: number
  ): AgentManagedCallRecord[] {
    if (limit !== undefined && (!Number.isSafeInteger(limit) || limit <= 0)) {
      throw new Error('Managed call query limit must be a positive safe integer.')
    }
    const rows = this.database.prepare(`
      SELECT id, thread_id, run_id, kind, summary, status,
             result_text, outcome_json, error, output_chars,
             progress_current, progress_total, progress_unit, dispatched_at,
             detached_at, created_at, updated_at
      FROM agent_managed_calls AS call
      WHERE call.thread_id = ?
        AND call.detached_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_managed_call_cleanup cleanup WHERE cleanup.call_id = call.id)
        AND NOT EXISTS (
          SELECT 1
          FROM agent_managed_call_observations AS observation
          WHERE observation.call_id = call.id
        )
      ORDER BY call.created_at ASC, call.id ASC
      LIMIT ?
    `).all(threadId, limit ?? -1) as ManagedCallRow[]
    return rows.map(managedCallFromRow)
  }

  listThreadIdsWithUnresolvedManagedCalls(): string[] {
    const rows = this.database.prepare(`
      SELECT DISTINCT call.thread_id
      FROM agent_managed_calls AS call
      WHERE call.detached_at IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM agent_managed_call_cleanup cleanup WHERE cleanup.call_id = call.id)
        AND NOT EXISTS (
          SELECT 1
          FROM agent_managed_call_observations AS observation
          WHERE observation.call_id = call.id
        )
      ORDER BY call.thread_id ASC
    `).all() as Array<{ thread_id: string }>
    return rows.map((row) => row.thread_id)
  }

  markManagedCallDetached(callId: string, threadId: string): AgentManagedCallRecord {
    const call = this.requireManagedCall(callId, threadId)
    if (!call.detachedAt) {
      const now = timestamp()
      this.database.prepare(`
        UPDATE agent_managed_calls
        SET detached_at = ?, updated_at = ?
        WHERE id = ? AND thread_id = ? AND detached_at IS NULL
      `).run(now, now, callId, threadId)
    }
    return this.requireManagedCall(callId, threadId)
  }

  resolveManagedCall(
    callId: string,
    threadId: string,
    observingRunId: string
  ): AgentManagedCallRecord {
    const call = this.requireManagedCall(callId, threadId)
    if (!isTerminalManagedCallStatus(call.status)) {
      throw new Error(`Managed call ${callId} is still ${call.status}.`)
    }
    if (!call.detachedAt) {
      throw new Error(`Managed call ${callId} has not returned a background handle.`)
    }
    const observingRun = this.requireRun(observingRunId)
    if (observingRun.threadId !== threadId) {
      throw new Error(`Run ${observingRunId} does not belong to thread ${threadId}.`)
    }
    this.database.prepare(`
      INSERT OR IGNORE INTO agent_managed_call_observations (
        call_id, thread_id, run_id, observed_at
      ) VALUES (?, ?, ?, ?)
    `).run(callId, threadId, observingRunId, timestamp())
    return call
  }

  markManagedCallRunning(callId: string, threadId: string): AgentManagedCallRecord {
    const now = timestamp()
    const changed = this.database.prepare(`
      UPDATE agent_managed_calls
      SET status = 'running', dispatched_at = ?, updated_at = ?
      WHERE id = ? AND thread_id = ? AND status = 'preparing'
    `).run(now, now, callId, threadId)
    if (changed.changes !== 1) {
      const call = this.getManagedCall(callId, threadId)
      if (!call) throw new Error(`Managed call ${callId} was not found.`)
      if (call.status !== 'running') throw new Error(`Managed call ${callId} is already ${call.status}.`)
      return call
    }
    return this.requireManagedCall(callId, threadId)
  }

  appendManagedCallOutput(input: {
    callId: string
    threadId: string
    stream: AgentManagedCallOutputChunk['stream']
    text: string
  }): AgentManagedCallOutputChunk | undefined {
    return this.appendManagedCallOutputBatch({
      callId: input.callId,
      threadId: input.threadId,
      chunks: [{ stream: input.stream, text: input.text }]
    })[0]
  }

  appendManagedCallOutputBatch(input: {
    callId: string
    threadId: string
    chunks: ReadonlyArray<Pick<AgentManagedCallOutputChunk, 'stream' | 'text'>>
  }): AgentManagedCallOutputChunk[] {
    const chunks = input.chunks.filter((chunk) => chunk.text.length > 0)
    if (chunks.length === 0) return []
    const append = this.database.transaction(() => {
      const state = this.database.prepare(`
        SELECT status, output_chars, next_output_sequence
        FROM agent_managed_calls
        WHERE id = ? AND thread_id = ?
      `).get(input.callId, input.threadId) as ManagedCallOutputStateRow | undefined
      if (!state) throw new Error(`Managed call ${input.callId} was not found.`)
      if (state.status !== 'preparing' && state.status !== 'running') return []

      const insert = this.database.prepare(`
        INSERT INTO agent_managed_call_output (
          call_id, sequence, stream, start_offset, end_offset, text
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      const stored: AgentManagedCallOutputChunk[] = []
      let outputChars = state.output_chars
      let nextSequence = state.next_output_sequence
      for (const chunk of chunks) {
        const startOffset = outputChars
        const endOffset = startOffset + chunk.text.length
        insert.run(
          input.callId,
          nextSequence,
          chunk.stream,
          startOffset,
          endOffset,
          chunk.text
        )
        stored.push({
          sequence: nextSequence,
          stream: chunk.stream,
          startOffset,
          endOffset,
          text: chunk.text
        })
        outputChars = endOffset
        nextSequence += 1
      }
      this.database.prepare(`
        UPDATE agent_managed_calls
        SET output_chars = ?,
            next_output_sequence = ?,
            updated_at = ?
        WHERE id = ? AND thread_id = ?
      `).run(
        outputChars,
        nextSequence,
        timestamp(),
        input.callId,
        input.threadId
      )
      return stored
    })
    return append()
  }

  readManagedCallOutputRange(
    callId: string,
    threadId: string,
    requestedOffset: number,
    length: number
  ): {
    chunks: AgentManagedCallOutputChunk[]
    startOffset: number
    endOffset: number
    totalChars: number
    hasBefore: boolean
    hasAfter: boolean
  } {
    const call = this.requireManagedCall(callId, threadId)
    const startOffset = requestedOffset < 0
      ? Math.max(0, call.outputChars + requestedOffset)
      : Math.min(call.outputChars, requestedOffset)
    const endOffset = Math.min(call.outputChars, startOffset + length)
    const rows = this.database.prepare(`
      SELECT sequence, stream, start_offset, end_offset, text
      FROM agent_managed_call_output
      WHERE call_id = ?
        AND end_offset > ?
        AND start_offset < ?
      ORDER BY sequence ASC
    `).all(callId, startOffset, endOffset) as ManagedCallOutputRow[]
    const chunks = rows.map((row) => {
      const chunkStart = Math.max(startOffset, row.start_offset)
      const chunkEnd = Math.min(endOffset, row.end_offset)
      return {
        sequence: row.sequence,
        stream: row.stream,
        startOffset: chunkStart,
        endOffset: chunkEnd,
        text: row.text.slice(chunkStart - row.start_offset, chunkEnd - row.start_offset)
      }
    })
    return {
      chunks,
      startOffset,
      endOffset,
      totalChars: call.outputChars,
      hasBefore: startOffset > 0,
      hasAfter: endOffset < call.outputChars
    }
  }

  updateManagedCallProgress(input: {
    callId: string
    threadId: string
    current: number
    total?: number
    unit: string
  }): AgentManagedCallRecord {
    if (!Number.isFinite(input.current) || input.current < 0) {
      throw new Error('Managed call progress must be a non-negative finite number.')
    }
    if (input.total !== undefined && (!Number.isFinite(input.total) || input.total < 0)) {
      throw new Error('Managed call progress total must be a non-negative finite number.')
    }
    const changed = this.database.prepare(`
      UPDATE agent_managed_calls
      SET progress_current = ?, progress_total = ?, progress_unit = ?, updated_at = ?
      WHERE id = ? AND thread_id = ? AND status IN ('preparing', 'running')
    `).run(
      input.current,
      input.total ?? null,
      input.unit,
      timestamp(),
      input.callId,
      input.threadId
    )
    if (changed.changes !== 1) return this.requireManagedCall(input.callId, input.threadId)
    return this.requireManagedCall(input.callId, input.threadId)
  }

  finishManagedCall(input: {
    callId: string
    threadId: string
    status: Exclude<AgentManagedCallStatus, 'preparing' | 'running'>
    result?: string
    outcome?: Record<string, unknown>
    error?: string
  }): AgentManagedCallRecord {
    return this.database.transaction(() => {
      const changed = this.database.prepare(`
        UPDATE agent_managed_calls
        SET status = @status,
            result_text = @result,
            outcome_json = @outcome,
            error = @error,
            updated_at = @updatedAt
        WHERE id = @id
          AND thread_id = @threadId
          AND status IN ('preparing', 'running')
      `).run({
        id: input.callId,
        threadId: input.threadId,
        status: input.status,
        result: input.result ?? null,
        outcome: serializeValue(input.outcome),
        error: input.error ?? null,
        updatedAt: timestamp()
      })
      const call = this.getManagedCall(input.callId, input.threadId)
      if (!call) throw new Error(`Managed call ${input.callId} was not found.`)
      if (changed.changes !== 1 && (call.status === 'preparing' || call.status === 'running')) {
        throw new Error(`Managed call ${input.callId} could not be completed.`)
      }
      if (changed.changes === 1) this.commitResult(call)
      return call
    })()
  }

  deleteManagedCall(callId: string, threadId: string): boolean {
    return this.database.prepare(`
      DELETE FROM agent_managed_calls
      WHERE id = ? AND thread_id = ?
        AND status IN ('completed', 'failed', 'cancelled', 'uncertain')
    `).run(callId, threadId).changes === 1
  }

  private requireRun(runId: string): { threadId: string } {
    const row = this.database.prepare('SELECT thread_id AS threadId FROM agent_runs WHERE id=?').get(runId) as { threadId: string } | undefined
    if (!row) throw new Error(`Run ${runId} was not found.`)
    return row
  }

  private requireManagedCall(callId: string, threadId: string): AgentManagedCallRecord {
    const call = this.getManagedCall(callId, threadId)
    if (!call) throw new Error(`Managed call ${callId} was not found.`)
    return call
  }
}
