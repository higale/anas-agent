import type Database from 'better-sqlite3'
import type { AgentRun, AgentRunStatus, AgentRunActivity, AgentSubagentActivity, AgentModelActivity,
  AgentToolActivity, AgentToolCall, AgentContextSummary, AgentMemoryRecall } from '../../shared/agentTypes'
import { modelRoundSql } from './runActivityMetadata'

export interface ActivityPayloadReader {
  model(runId: string, modelId: string, messageId: string | undefined, subagentId?: string): Pick<AgentModelActivity, 'text' | 'reasoning' | 'reasoningSummary' | 'toolCallIds'>
  tool(runId: string, callId: string, name: string, subagentId?: string): { call: AgentToolCall; output?: unknown }
}

type ActivityRow = {
  run_id: string
  sequence: number
  kind: 'tool' | 'subagent'
  activity_id: string
  parent_subagent_id: string | null
  name: string
  status: 'running' | 'completed'
  output_json: string | null
  approval_interrupt_id: string | null
  approval_action_index: number | null
  subagent_name: string | null
  subagent_parent_id: string | null
  subagent_status: AgentSubagentActivity['status'] | null
  subagent_result_text: string | null
  subagent_error: string | null
  subagent_updated_at: string | null
  started_at: string | null
  completed_at: string | null
}

export type SubagentActivityPayload = {
  status: AgentSubagentActivity['status']
  result?: unknown
  error?: string
}

function parseSubagentActivityPayload(value: string | null): SubagentActivityPayload {
  const payload: unknown = value === null ? undefined : JSON.parse(value)
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('Stored subagent activity payload is invalid.')
  }
  const record = payload as Record<string, unknown>
  if (
    record.status !== 'running'
    && record.status !== 'interrupted'
    && record.status !== 'completed'
    && record.status !== 'failed'
    && record.status !== 'cancelled'
  ) {
    throw new Error('Stored subagent activity status is invalid.')
  }
  if (record.error !== undefined && typeof record.error !== 'string') {
    throw new Error('Stored subagent activity error is invalid.')
  }
  return {
    status: record.status,
    ...(record.result === undefined ? {} : { result: record.result }),
    ...(record.error === undefined ? {} : { error: record.error })
  }
}

type ModelActivityRow = {
  run_id: string
  model_id: string
  message_id: string | null
  sequence: number
  model_round: number
  subagent_id: string | null
  status: 'running' | 'completed'
  started_at: string
  completed_at: string | null
}

type ActivityRunRow = {
  run_id: string
  run_operation: AgentRun['operation']
  run_status: AgentRunStatus
  run_error: string | null
  run_created_at: string
  run_updated_at: string
}

export type ContextSummaryRow = {
  run_id: string
  summary_id: string
  sequence: number
  status: 'running' | 'completed'
  summary_text: string
  model_content: string
  committed_checkpoint_id: string | null
  cutoff_index: number | null
  activated_after_message_index: number | null
  covered_through_message_id: string | null
  first_preserved_message_id: string | null
  input_tokens_before: number | null
  input_tokens_after: number | null
  created_at: string
}

export type MemoryRecallRow = {
  run_id: string
  recall_id: string
  sequence: number
  query: string
  prompt_text: string
  memory_count: number
  agent_name: string | null
  created_at: string
}

export function contextSummaryFromRow(row: ContextSummaryRow): AgentContextSummary {
  return {
    id: row.summary_id,
    sequence: row.sequence,
    status: row.status,
    summaryText: row.summary_text,
    activatedAfterMessageIndex: row.activated_after_message_index ?? undefined,
    coveredThroughMessageId: row.covered_through_message_id ?? undefined,
    firstPreservedMessageId: row.first_preserved_message_id ?? undefined,
    inputTokensBefore: row.input_tokens_before ?? undefined,
    inputTokensAfter: row.input_tokens_after ?? undefined,
    createdAt: row.created_at
  }
}

export function memoryRecallFromRow(row: MemoryRecallRow): AgentMemoryRecall {
  return {
    id: row.recall_id,
    sequence: row.sequence,
    query: row.query,
    promptText: row.prompt_text,
    memoryCount: row.memory_count,
    agentName: row.agent_name ?? undefined,
    createdAt: row.created_at
  }
}


/** Product timeline queries over native message projections.
 * Payload ownership and decoding belong to the supplied message reader. */
export class RunActivityReader {
  constructor(private readonly database: Database.Database, private readonly payload: ActivityPayloadReader) {}

  private requireThread(threadId: string): void {
    if (!this.database.prepare('SELECT 1 FROM agent_threads WHERE id=?').get(threadId)) throw new Error(`Thread ${threadId} was not found.`)
  }

  getRun(runId: string): AgentRun | null {
    const row = this.database.prepare('SELECT id,thread_id,operation,status,created_at,updated_at,error FROM agent_runs WHERE id=?').get(runId) as {
      id: string; thread_id: string; operation: AgentRun['operation']; status: AgentRunStatus; created_at: string; updated_at: string; error: string | null
    } | undefined
    if (!row) return null
    const backgroundCleanup = this.readBackgroundCleanup(runId)
    return { id: row.id, threadId: row.thread_id, operation: row.operation, status: row.status,
      createdAt: row.created_at, updatedAt: row.updated_at, error: row.error ?? undefined, ...(backgroundCleanup ? { backgroundCleanup } : {}) }
  }

  getLatestRunForThread(threadId: string): AgentRun | null {
    this.requireThread(threadId)
    const row = this.database.prepare('SELECT id FROM agent_runs WHERE thread_id=? ORDER BY rowid DESC LIMIT 1').get(threadId) as { id: string } | undefined
    return row ? this.getRun(row.id) : null
  }

  getRunBySubmissionId(submissionId: string): AgentRun | null {
    const row = this.database.prepare('SELECT id FROM agent_runs WHERE submission_id=?').get(submissionId) as { id: string } | undefined
    return row ? this.getRun(row.id) : null
  }

  private requireRun(runId: string) {
    const run = this.getRun(runId)
    if (!run) throw new Error(`Run ${runId} was not found.`)
    return run
  }

  private readBackgroundCleanup(runId: string): AgentRun['backgroundCleanup'] {
    return this.database.prepare('SELECT status, report FROM agent_run_background_cleanup WHERE run_id=?').get(runId) as AgentRun['backgroundCleanup']
  }

  getActivitiesForRuns(threadId: string, runIds: string[], options: {includeUnanchored?:number} = {}): AgentRunActivity[] {
    const selected = new Set(runIds)
    if (options.includeUnanchored) {
      for (const row of this.database.prepare(`SELECT id FROM agent_runs WHERE thread_id=? AND operation='compression'
        ORDER BY sequence DESC LIMIT ?`).all(threadId,options.includeUnanchored) as Array<{id:string}>) selected.add(row.id)
    }
    return this.readActivities(threadId,[...selected])
  }

  getRunActivity(runId: string): AgentRunActivity|undefined {
    const run = this.getRun(runId)
    return run ? this.readActivities(run.threadId,[runId])[0] : undefined
  }

  getRunActivityWindow(runId: string, options: { beforeSequence?: number } = {}): AgentRunActivity {
    const run = this.requireRun(runId)
    const before = options.beforeSequence ?? Number.MAX_SAFE_INTEGER
    if (!Number.isSafeInteger(before) || before < 0) throw new Error('The activity window cursor is invalid.')
    return this.readActivities(run.threadId, [runId], before)[0]
  }

  getModelActivity(runId: string, modelId: string): AgentModelActivity | undefined {
    const row = this.database.prepare(`
      SELECT model.run_id, model.model_id, message.message_id, model.sequence, ${modelRoundSql} AS model_round,
        model.subagent_id, model.status, timing.started_at, timing.completed_at
      FROM agent_model_activities model
      JOIN agent_activity_timing timing ON timing.run_id = model.run_id
        AND timing.activity_key = 'model:' || model.model_id
      LEFT JOIN agent_model_messages message ON message.run_id = model.run_id AND message.model_id = model.model_id
      WHERE model.run_id = ? AND model.model_id = ?
    `).get(runId, modelId) as ModelActivityRow | undefined
    return row ? {
      id: row.model_id, messageId: row.message_id ?? undefined, sequence: row.sequence, round: row.model_round,
      status: row.status, subagentId: row.subagent_id ?? undefined,
      ...this.payload.model(runId, modelId, row.message_id ?? undefined, row.subagent_id ?? undefined),
      startedAt: row.started_at ?? undefined, completedAt: row.completed_at ?? undefined
    } : undefined
  }

  getSubagentActivity(runId: string, subagentId: string): AgentSubagentActivity | undefined {
    const row = this.database.prepare(`
      SELECT activity.activity_id, activity.name, activity.sequence, activity.parent_subagent_id, activity.output_json,
        timing.started_at, timing.completed_at, call.agent_name AS subagent_name, call.status AS subagent_status,
        call.parent_subagent_id AS subagent_parent_id, call.result_text AS subagent_result_text,
        call.error AS subagent_error, call.updated_at AS subagent_updated_at
      FROM agent_activities activity LEFT JOIN agent_activity_timing timing
        ON timing.run_id = activity.run_id AND timing.activity_key = activity.activity_key
      LEFT JOIN agent_subagent_calls call ON call.id = activity.activity_id
      WHERE activity.run_id = ? AND activity.kind = 'subagent' AND activity.activity_id = ?
    `).get(runId, subagentId) as ActivityRow | undefined
    if (!row) return undefined
    const projected = parseSubagentActivityPayload(row.output_json)
    const status = row.subagent_status ?? projected.status
    const result = row.subagent_status ? row.subagent_result_text ?? undefined : projected.result
    const error = row.subagent_status ? row.subagent_error ?? undefined : projected.error
    return {
      id: subagentId, name: row.subagent_name ?? row.name, sequence: row.sequence, status,
      parentSubagentId: (row.subagent_status ? row.subagent_parent_id : row.parent_subagent_id) ?? undefined,
      ...(result === undefined ? {} : { result }), ...(error === undefined ? {} : { error }),
      startedAt: row.started_at ?? undefined,
      completedAt: status === 'running' || status === 'interrupted' ? undefined : row.completed_at ?? row.subagent_updated_at ?? undefined
    }
  }

  listRootToolActivityIds(runId: string, status: 'running' | 'completed'): string[] {
    return (this.database.prepare(`SELECT activity_id FROM agent_activities
      WHERE run_id = ? AND kind = 'tool' AND parent_subagent_id IS NULL AND status = ?
        AND (status = 'running' OR EXISTS (SELECT 1 FROM agent_tool_messages tool
          WHERE tool.run_id = agent_activities.run_id AND tool.call_id = agent_activities.activity_id
            AND tool.tool_message_id IS NOT NULL)) ORDER BY sequence`)
      .all(runId, status) as Array<{ activity_id: string }>).map((row) => row.activity_id)
  }

  getRunProcessActivity(runId: string) {
    const count = this.database.prepare(`SELECT
      (SELECT COUNT(*) FROM agent_model_activities WHERE run_id = ? AND subagent_id IS NULL) AS models,
      (SELECT COUNT(*) FROM agent_activities WHERE run_id = ? AND kind = 'tool' AND parent_subagent_id IS NULL) AS tools
    `).get(runId, runId) as { models: number; tools: number }
    const latest = this.database.prepare(`SELECT model_id FROM agent_model_activities
      WHERE run_id = ? AND subagent_id IS NULL ORDER BY sequence DESC LIMIT 1`).get(runId) as { model_id: string } | undefined
    return {
      modelRounds: count.models, toolCalls: count.tools,
      latestModel: latest ? this.getModelActivity(runId, latest.model_id) : undefined,
      activeTools: this.listRootToolActivityIds(runId, 'running')
        .flatMap((callId) => this.getToolActivity(runId, callId) ?? [])
    }
  }

  getMessageActivitySequence(runId: string, messageId: string): number | undefined {
    const row = this.database.prepare(`
      SELECT model.sequence FROM agent_model_activities model JOIN agent_model_messages message
        ON message.run_id = model.run_id AND message.model_id = model.model_id
      WHERE model.run_id = ? AND model.subagent_id IS NULL AND message.message_id = ?
      UNION ALL
      SELECT activity.sequence FROM agent_activities activity JOIN agent_tool_messages tool
        ON tool.run_id = activity.run_id AND tool.call_id = activity.activity_id
      WHERE activity.run_id = ? AND activity.kind = 'tool' AND activity.parent_subagent_id IS NULL
        AND tool.tool_message_id = ? LIMIT 1
    `).get(runId, messageId, runId, messageId) as { sequence: number } | undefined
    return row?.sequence
  }

  getToolActivity(runId: string, callId: string, subagentId?: string): AgentToolActivity | undefined {
    const row = this.database.prepare(`
      SELECT activity.sequence, activity.name, activity.status,
        timing.started_at, timing.completed_at,
        approval.interrupt_id AS approval_interrupt_id,
        approval.action_index AS approval_action_index
      FROM agent_activities activity
      LEFT JOIN agent_activity_timing timing
        ON timing.run_id = activity.run_id AND timing.activity_key = activity.activity_key
      LEFT JOIN agent_tool_approvals approval
        ON approval.run_id = activity.run_id AND approval.activity_key = activity.activity_key
      WHERE activity.run_id = ? AND activity.activity_key = ? AND activity.kind = 'tool'
    `).get(runId, `tool:${subagentId ?? 'root'}:${callId}`) as Pick<ActivityRow,
      'sequence' | 'name' | 'status' | 'started_at' | 'completed_at' | 'approval_interrupt_id' | 'approval_action_index'> | undefined
    if (!row) return undefined
    return {
      ...this.payload.tool(runId, callId, row.name, subagentId),
      sequence: row.sequence,
      status: row.status,
      subagentId,
      startedAt: row.started_at ?? undefined,
      completedAt: row.status === 'completed' ? row.completed_at ?? undefined : undefined,
      ...(row.approval_interrupt_id !== null && row.approval_action_index !== null
        ? { approval: { status: 'pending_approval' as const, interruptId: row.approval_interrupt_id, actionIndex: row.approval_action_index } }
        : {})
    }
  }

  getActivitiesForThread(threadId: string): AgentRunActivity[] {
    return this.readActivities(threadId)
  }

  private readActivities(threadId: string, runIds?: string[], beforeSequence = Number.MAX_SAFE_INTEGER): AgentRunActivity[] {
    this.requireThread(threadId)
    const runRows = this.database.prepare(`
      SELECT
        run.id AS run_id,
        run.operation AS run_operation,
        run.status AS run_status,
        run.error AS run_error,
        run.created_at AS run_created_at,
        run.updated_at AS run_updated_at
      FROM agent_runs run
      WHERE run.thread_id = @threadId AND (@runIds IS NULL OR run.id IN (SELECT value FROM json_each(@runIds)))
      ORDER BY run.rowid ASC
    `).all({threadId,runIds:runIds === undefined ? null : JSON.stringify(runIds)}) as ActivityRunRow[]
    const runs = new Map<string, AgentRunActivity>(runRows.map((row) => [
      row.run_id,
      {
        runId: row.run_id,
        operation: row.run_operation,
        status: row.run_status,
        error: row.run_error ?? undefined,
        backgroundCleanup: this.readBackgroundCleanup(row.run_id),
        createdAt: row.run_created_at,
        updatedAt: row.run_updated_at,
        models: [],
        tools: [],
        subagents: []
      }
    ]))
    const windows = runRows.map((run) => {
      const source = `SELECT sequence FROM agent_activities WHERE run_id=@runId
        UNION ALL SELECT sequence FROM agent_model_activities WHERE run_id=@runId
        UNION ALL SELECT sequence FROM agent_context_summaries WHERE run_id=@runId
        UNION ALL SELECT sequence FROM agent_memory_recalls WHERE run_id=@runId`
      const candidates = this.database.prepare(`SELECT sequence FROM (${source})
        WHERE sequence < @before ORDER BY sequence DESC LIMIT 101`).all({ runId: run.run_id, before: beforeSequence }) as Array<{ sequence: number }>
      const selected = candidates.slice(0, 100)
      const total = this.database.prepare(`SELECT count(*) AS count FROM (${source})`).get({ runId: run.run_id }) as { count: number }
      const start = selected.at(-1)?.sequence ?? beforeSequence
      runs.get(run.run_id)!.activityWindow = {
        startSequence: selected.length ? start : null, endSequence: selected[0]?.sequence ?? null,
        totalCount: total.count, hasEarlier: candidates.length > selected.length
      }
      return { runId: run.run_id, start, before: beforeSequence }
    })
    const windowParameters = { threadId, runIds: runIds === undefined ? null : JSON.stringify(runIds), windows: JSON.stringify(windows) }
    const rows = this.database.prepare(`
      SELECT
        activity.run_id,
        activity.sequence,
        activity.kind,
        activity.activity_id,
        activity.parent_subagent_id,
        activity.name,
        activity.status,
        activity.output_json,
        approval.interrupt_id AS approval_interrupt_id,
        approval.action_index AS approval_action_index,
        subagent.agent_name AS subagent_name,
        subagent.parent_subagent_id AS subagent_parent_id,
        subagent.status AS subagent_status,
        subagent.result_text AS subagent_result_text,
        subagent.error AS subagent_error,
        subagent.updated_at AS subagent_updated_at,
        timing.started_at,
        timing.completed_at
      FROM agent_activities activity
      INNER JOIN agent_runs run ON run.id = activity.run_id
      INNER JOIN json_each(@windows) page_window ON json_extract(page_window.value, '$.runId')=run.id
        AND activity.sequence >= json_extract(page_window.value, '$.start')
        AND activity.sequence < json_extract(page_window.value, '$.before')
      LEFT JOIN agent_activity_timing timing
        ON timing.run_id = activity.run_id
        AND timing.activity_key = activity.activity_key
      LEFT JOIN agent_tool_approvals approval
        ON approval.run_id = activity.run_id
        AND approval.activity_key = activity.activity_key
      LEFT JOIN agent_subagent_calls subagent
        ON activity.kind = 'subagent'
        AND subagent.id = activity.activity_id
      WHERE run.thread_id = @threadId AND (@runIds IS NULL OR run.id IN (SELECT value FROM json_each(@runIds)))
      ORDER BY run.rowid ASC, activity.sequence ASC
    `).all(windowParameters) as ActivityRow[]

    for (const row of rows) {
      const run = runs.get(row.run_id)
      if (!run) throw new Error(`Activity run ${row.run_id} was not loaded.`)
      if (row.kind === 'tool') {
        run.tools.push({
          ...this.payload.tool(row.run_id,row.activity_id,row.name,row.parent_subagent_id ?? undefined),
          sequence: row.sequence,
          status: row.status,
          ...(row.approval_interrupt_id !== null && row.approval_action_index !== null
            ? {
                approval: {
                  status: 'pending_approval' as const,
                  interruptId: row.approval_interrupt_id,
                  actionIndex: row.approval_action_index
                }
              }
            : {}),
          subagentId: row.parent_subagent_id ?? undefined,
          startedAt: row.started_at ?? undefined,
          completedAt: row.completed_at ?? undefined
        })
      } else {
        const projected = parseSubagentActivityPayload(row.output_json)
        const status = row.subagent_status ?? projected.status
        const result = row.subagent_status
          ? row.subagent_result_text ?? undefined
          : projected.result
        const error = row.subagent_status
          ? row.subagent_error ?? undefined
          : projected.error
        const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
        run.subagents.push({
          id: row.activity_id,
          name: row.subagent_name ?? row.name,
          sequence: row.sequence,
          status,
          parentSubagentId: row.subagent_status
            ? row.subagent_parent_id ?? undefined
            : row.parent_subagent_id ?? undefined,
          ...(result === undefined ? {} : { result }),
          ...(error === undefined ? {} : { error }),
          startedAt: row.started_at ?? undefined,
          completedAt: terminal
            ? row.completed_at ?? row.subagent_updated_at ?? undefined
            : undefined
        })
      }
    }

    const modelRows = this.database.prepare(`
      SELECT
        model.run_id,
        model.model_id,
        message.message_id,
        model.sequence,
        ${modelRoundSql} AS model_round,
        model.subagent_id,
        model.status,
        timing.started_at,
        timing.completed_at
      FROM agent_model_activities model
      INNER JOIN agent_runs run ON run.id = model.run_id
      INNER JOIN json_each(@windows) page_window ON json_extract(page_window.value, '$.runId')=run.id
        AND model.sequence >= json_extract(page_window.value, '$.start')
        AND model.sequence < json_extract(page_window.value, '$.before')
      INNER JOIN agent_activity_timing timing
        ON timing.run_id = model.run_id
        AND timing.activity_key = 'model:' || model.model_id
      LEFT JOIN agent_model_messages message
        ON message.run_id = model.run_id
        AND message.model_id = model.model_id
      WHERE run.thread_id = @threadId AND (@runIds IS NULL OR run.id IN (SELECT value FROM json_each(@runIds)))
      ORDER BY run.rowid ASC, model.sequence ASC
    `).all(windowParameters) as ModelActivityRow[]
    for (const row of modelRows) {
      const run = runs.get(row.run_id)
      if (!run) throw new Error(`Model activity run ${row.run_id} was not loaded.`)
      run.models.push({
        id: row.model_id,
        messageId: row.message_id ?? undefined,
        sequence: row.sequence,
        status: row.status,
        subagentId: row.subagent_id ?? undefined,
        round: row.model_round,
        ...this.payload.model(row.run_id,row.model_id,row.message_id ?? undefined,row.subagent_id ?? undefined),
        startedAt: row.started_at ?? undefined,
        completedAt: row.completed_at ?? undefined
      })
    }

    const memoryRecallRows = this.database.prepare(`
      SELECT
        recall.run_id,
        recall.recall_id,
        recall.sequence,
        recall.query,
        recall.prompt_text,
        recall.memory_count,
        recall.agent_name,
        recall.created_at
      FROM agent_memory_recalls recall
      INNER JOIN agent_runs run ON run.id = recall.run_id
      INNER JOIN json_each(@windows) page_window ON json_extract(page_window.value, '$.runId')=run.id
        AND recall.sequence >= json_extract(page_window.value, '$.start')
        AND recall.sequence < json_extract(page_window.value, '$.before')
      WHERE run.thread_id = @threadId AND (@runIds IS NULL OR run.id IN (SELECT value FROM json_each(@runIds)))
      ORDER BY run.rowid ASC, recall.sequence ASC
    `).all(windowParameters) as MemoryRecallRow[]
    for (const row of memoryRecallRows) {
      const run = runs.get(row.run_id)
      if (!run) throw new Error(`Memory recall run ${row.run_id} was not loaded.`)
      const recalls = run.memoryRecalls ?? []
      recalls.push(memoryRecallFromRow(row))
      run.memoryRecalls = recalls
    }

    const summaryRows = this.database.prepare(`
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
      INNER JOIN agent_runs run ON run.id = summary.run_id
      INNER JOIN json_each(@windows) page_window ON json_extract(page_window.value, '$.runId')=run.id
        AND summary.sequence >= json_extract(page_window.value, '$.start')
        AND summary.sequence < json_extract(page_window.value, '$.before')
      WHERE run.thread_id = @threadId AND (@runIds IS NULL OR run.id IN (SELECT value FROM json_each(@runIds)))
      ORDER BY run.rowid ASC, summary.sequence ASC
    `).all(windowParameters) as ContextSummaryRow[]
    for (const row of summaryRows) {
      const run = runs.get(row.run_id)
      if (!run) throw new Error(`Context summary run ${row.run_id} was not loaded.`)
      const summaries = run.summaries ?? []
      summaries.push(contextSummaryFromRow(row))
      run.summaries = summaries
    }
    for (const run of runs.values()) {
      const seeds = [...run.models.flatMap((model) => model.subagentId ? [model.subagentId] : []),
        ...run.tools.flatMap((tool) => tool.subagentId ? [tool.subagentId] : []), ...run.subagents.map((subagent) => subagent.id)]
      const headers = this.database.prepare(`
        WITH RECURSIVE needed(id) AS (
          SELECT value FROM json_each(@seeds)
          UNION
          SELECT activity.activity_id FROM agent_activities activity
          LEFT JOIN agent_subagent_calls call ON call.id=activity.activity_id
          WHERE activity.run_id=@runId AND activity.kind='subagent'
            AND COALESCE(call.status,json_extract(activity.output_json,'$.status')) IN ('running','interrupted')
          UNION
          SELECT COALESCE(call.parent_subagent_id,activity.parent_subagent_id)
          FROM agent_activities activity JOIN needed ON needed.id=activity.activity_id
          LEFT JOIN agent_subagent_calls call ON call.id=activity.activity_id
          WHERE activity.run_id=@runId AND activity.kind='subagent'
            AND COALESCE(call.parent_subagent_id,activity.parent_subagent_id) IS NOT NULL
        )
        SELECT activity.activity_id AS id,COALESCE(call.agent_name,activity.name) AS name,activity.sequence,
          COALESCE(call.status,json_extract(activity.output_json,'$.status')) AS status,
          COALESCE(call.parent_subagent_id,activity.parent_subagent_id) AS parentId,
          timing.started_at AS startedAt,COALESCE(timing.completed_at,call.updated_at) AS completedAt
        FROM agent_activities activity JOIN needed ON needed.id=activity.activity_id
        LEFT JOIN agent_activity_timing timing ON timing.run_id=activity.run_id AND timing.activity_key=activity.activity_key
        LEFT JOIN agent_subagent_calls call ON call.id=activity.activity_id
        WHERE activity.run_id=@runId AND activity.kind='subagent'
        ORDER BY activity.sequence
      `).all({ runId: run.runId, seeds: JSON.stringify(seeds) }) as Array<{
        id: string; name: string; sequence: number; status: AgentSubagentActivity['status'];
        parentId: string | null; startedAt: string; completedAt: string | null
      }>
      const selected = new Set(run.subagents.map((subagent) => subagent.id))
      for (const header of headers) if (!selected.has(header.id)) run.subagents.push({
        id: header.id, name: header.name, sequence: header.sequence, status: header.status,
        parentSubagentId: header.parentId ?? undefined, startedAt: header.startedAt,
        completedAt: header.status === 'running' || header.status === 'interrupted' ? undefined : header.completedAt ?? undefined,
        detailsDeferred: true
      })
      run.subagents.sort((left, right) => left.sequence - right.sequence)
    }
    return [...runs.values()]
  }

}
