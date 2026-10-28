import type Database from 'better-sqlite3'
import type { AgentModelActivity, AgentToolCall } from '../../shared/agentTypes'

import type { CanonicalChildActivityEvidence, DurableRootActivityEvidence } from '../../runtime/runActivities'

interface ActivityWriter {
  recordModel(runId: string, model: Omit<AgentModelActivity, 'sequence' | 'startedAt' | 'completedAt'>): void
  recordTool(runId: string, call: AgentToolCall, status: 'running' | 'completed', subagentId?: string, output?: unknown): void
  recordSubagent(runId: string, id: string, name: string, status: 'running'): void
}

export const modelRoundSql = `(SELECT COUNT(*) FROM agent_model_activities previous
  WHERE previous.run_id = model.run_id AND previous.subagent_id IS model.subagent_id
    AND previous.sequence <= model.sequence)`

/** Shared product timeline metadata. Message bodies and execution remain owned
 * by their stores; these rows only retain display order, links and timing. */
export class RunActivityMetadata {
  constructor(private readonly database: Database.Database) {}

  /** Root-only cleanup from durable evidence. Child relationships and their
   * canonical message validation belong to the subagent owner. */
  pruneRoot(runId: string, messageIds: ReadonlySet<string>, callIds: ReadonlySet<string>): Map<string, string> {
    if (!this.database.inTransaction) throw new Error('Activity reconciliation requires the owning transaction.')
    const existing = new Map<string, string>()
    const models = this.database.prepare(`SELECT model.model_id,message.message_id FROM agent_model_activities model
      LEFT JOIN agent_model_messages message ON message.run_id=model.run_id AND message.model_id=model.model_id
      WHERE model.run_id=? AND model.subagent_id IS NULL ORDER BY model.sequence`)
      .all(runId) as { model_id: string; message_id: string | null }[]
    const timing = this.database.prepare('DELETE FROM agent_activity_timing WHERE run_id=? AND activity_key=?')
    for (const model of models) {
      if (model.message_id && messageIds.has(model.message_id) && !existing.has(model.message_id)) {
        existing.set(model.message_id, model.model_id)
      } else {
        this.database.prepare('DELETE FROM agent_model_activities WHERE run_id=? AND model_id=?').run(runId, model.model_id)
        timing.run(runId, `model:${model.model_id}`)
      }
    }
    const tools = this.database.prepare("SELECT activity_key,activity_id FROM agent_activities WHERE run_id=? AND kind='tool' AND parent_subagent_id IS NULL")
      .all(runId) as { activity_key: string; activity_id: string }[]
    for (const tool of tools) if (!callIds.has(tool.activity_id)) {
      this.database.prepare('DELETE FROM agent_activities WHERE run_id=? AND activity_key=?').run(runId, tool.activity_key)
      timing.run(runId, tool.activity_key)
    }
    return existing
  }

  nextSequence(runId: string): number {
    const row = this.database.prepare(`SELECT MAX(sequence) AS sequence FROM (
      SELECT MAX(sequence) AS sequence FROM agent_activities WHERE run_id=? UNION ALL
      SELECT MAX(sequence) AS sequence FROM agent_model_activities WHERE run_id=? UNION ALL
      SELECT MAX(sequence) AS sequence FROM agent_context_summaries WHERE run_id=? UNION ALL
      SELECT MAX(sequence) AS sequence FROM agent_memory_recalls WHERE run_id=?)`)
      .get(runId, runId, runId, runId) as { sequence: number | null }
    return (row.sequence ?? -1) + 1
  }

  private timing(runId: string, key: string, status: 'running' | 'completed') {
    const now = new Date().toISOString()
    this.database.prepare(`INSERT INTO agent_activity_timing(run_id,activity_key,started_at,completed_at) VALUES(?,?,?,?)
      ON CONFLICT(run_id,activity_key) DO UPDATE SET completed_at=COALESCE(agent_activity_timing.completed_at,excluded.completed_at)`)
      .run(runId, key, now, status === 'completed' ? now : null)
    const row = this.database.prepare('SELECT started_at,completed_at FROM agent_activity_timing WHERE run_id=? AND activity_key=?')
      .get(runId, key) as { started_at: string; completed_at: string | null }
    return { startedAt: row.started_at, completedAt: row.completed_at ?? undefined }
  }

  model(runId: string, model: Pick<AgentModelActivity, 'id' | 'messageId' | 'status' | 'subagentId'>) {
    this.database.prepare(`INSERT INTO agent_model_activities(run_id,model_id,sequence,subagent_id,status) VALUES(?,?,?,?,?)
      ON CONFLICT(run_id,model_id) DO UPDATE SET subagent_id=excluded.subagent_id,status=excluded.status`)
      .run(runId, model.id, this.nextSequence(runId), model.subagentId ?? null, model.status)
    if (model.messageId) this.database.prepare(`INSERT INTO agent_model_messages(run_id,model_id,message_id) VALUES(?,?,?)
      ON CONFLICT(run_id,model_id) DO UPDATE SET message_id=excluded.message_id`).run(runId, model.id, model.messageId)
    const row = this.database.prepare(`SELECT model.sequence,${modelRoundSql} AS model_round
      FROM agent_model_activities model WHERE model.run_id=? AND model.model_id=?`).get(runId, model.id) as { sequence: number; model_round: number }
    return { sequence: row.sequence, round: row.model_round, ...this.timing(runId, `model:${model.id}`, model.status) }
  }

  upsert(activity: { runId: string; key: string; kind: 'tool' | 'subagent'; id: string; parentSubagentId?: string;
    name: string; status: 'running' | 'completed'; outputJson?: string | null }) {
    if (!this.database.prepare('SELECT 1 FROM agent_runs WHERE id=?').get(activity.runId)) throw new Error(`Run ${activity.runId} was not found.`)
    this.database.prepare(`INSERT INTO agent_activities(run_id,activity_key,sequence,kind,activity_id,parent_subagent_id,name,status,output_json)
      VALUES(@runId,@key,@sequence,@kind,@id,@parentSubagentId,@name,@status,@outputJson)
      ON CONFLICT(run_id,activity_key) DO UPDATE SET parent_subagent_id=excluded.parent_subagent_id,name=excluded.name,
        status=excluded.status,output_json=COALESCE(excluded.output_json,agent_activities.output_json)`)
      .run({ ...activity, sequence: this.nextSequence(activity.runId), parentSubagentId: activity.parentSubagentId ?? null, outputJson: activity.outputJson ?? null })
    const row = this.database.prepare('SELECT sequence FROM agent_activities WHERE run_id=? AND activity_key=?')
      .get(activity.runId, activity.key) as { sequence: number }
    return { sequence: row.sequence, ...this.timing(activity.runId, activity.key, activity.status) }
  }

  reconcileAncestors(targetRunId?: string): void {
    const projections = this.database.prepare(`
      WITH RECURSIVE ancestor_projections (
        subagent_id,
        ancestor_subagent_id,
        target_run_id,
        depth
      ) AS (
        SELECT
          child.id,
          parent.id,
          parent.parent_run_id,
          1
        FROM agent_subagent_calls AS child
        INNER JOIN agent_subagent_calls AS parent
          ON parent.id = child.parent_subagent_id

        UNION ALL

        SELECT
          projection.subagent_id,
          parent.id,
          parent.parent_run_id,
          projection.depth + 1
        FROM ancestor_projections AS projection
        INNER JOIN agent_subagent_calls AS ancestor
          ON ancestor.id = projection.ancestor_subagent_id
        INNER JOIN agent_subagent_calls AS parent
          ON parent.id = ancestor.parent_subagent_id
      )
      SELECT
        projection.target_run_id,
        call.id AS subagent_id,
        call.parent_subagent_id,
        call.agent_name,
        call.status AS call_status,
        call.result_text,
        call.error,
        call.created_at,
        call.updated_at,
        source_timing.started_at AS source_started_at,
        source_timing.completed_at AS source_completed_at,
        target.sequence AS target_sequence,
        target_timing.started_at AS target_started_at
      FROM ancestor_projections AS projection
      INNER JOIN agent_subagent_calls AS call
        ON call.id = projection.subagent_id
      LEFT JOIN agent_activities AS source
        ON source.run_id = call.parent_run_id
        AND source.activity_key = 'subagent:' || call.id
        AND source.kind = 'subagent'
      LEFT JOIN agent_activity_timing AS source_timing
        ON source_timing.run_id = source.run_id
        AND source_timing.activity_key = source.activity_key
      LEFT JOIN agent_activities AS target
        ON target.run_id = projection.target_run_id
        AND target.activity_key = 'subagent:' || call.id
      LEFT JOIN agent_activity_timing AS target_timing
        ON target_timing.run_id = target.run_id
        AND target_timing.activity_key = target.activity_key
      WHERE (? IS NULL OR projection.target_run_id = ?)
        AND (
          target.activity_key IS NULL
          OR target_timing.activity_key IS NULL
        )
      ORDER BY
        projection.target_run_id ASC,
        call.created_at ASC,
        call.rowid ASC,
        projection.depth ASC
    `).all(targetRunId ?? null, targetRunId ?? null) as Array<{
      target_run_id: string
      subagent_id: string
      parent_subagent_id: string
      agent_name: string
      call_status: string
      result_text: string | null
      error: string | null
      created_at: string
      updated_at: string
      source_started_at: string | null
      source_completed_at: string | null
      target_sequence: number | null
      target_started_at: string | null
    }>
    const insertActivity = this.database.prepare(`
      INSERT INTO agent_activities (
        run_id,
        activity_key,
        sequence,
        kind,
        activity_id,
        parent_subagent_id,
        name,
        status,
        output_json
      ) VALUES (?, ?, ?, 'subagent', ?, ?, ?, ?, ?)
      ON CONFLICT (run_id, activity_key) DO NOTHING
    `)
    const insertTiming = this.database.prepare(`
      INSERT INTO agent_activity_timing (
        run_id,
        activity_key,
        started_at,
        completed_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (run_id, activity_key) DO NOTHING
    `)
    for (const projection of projections) {
      const activityKey = `subagent:${projection.subagent_id}`
      const terminal = projection.call_status === 'completed'
        || projection.call_status === 'failed'
        || projection.call_status === 'cancelled'
      const activityStatus = terminal ? 'completed' : 'running'
      const outputJson = JSON.stringify({ status: projection.call_status })
      if (projection.target_sequence === null) {
        insertActivity.run(
          projection.target_run_id,
          activityKey,
          this.nextSequence(projection.target_run_id),
          projection.subagent_id,
          projection.parent_subagent_id,
          projection.agent_name,
          activityStatus,
          outputJson
        )
      }
      if (projection.target_started_at === null) {
        insertTiming.run(
          projection.target_run_id,
          activityKey,
          projection.source_started_at ?? projection.created_at,
          projection.source_completed_at ?? (terminal ? projection.updated_at : null)
        )
      }
    }
  }

  canonicalChildren(runId: string): CanonicalChildActivityEvidence {
    const calls = this.database.prepare(`
      WITH RECURSIVE descendants(id, child_run_id) AS (
        SELECT id, child_run_id FROM agent_subagent_calls WHERE parent_run_id = ?
        UNION
        SELECT child.id, child.child_run_id FROM agent_subagent_calls child
        JOIN descendants parent ON child.parent_run_id = parent.child_run_id
      ) SELECT id FROM descendants
    `).all(runId) as Array<{ id: string }>
    const subagentIds = new Set(calls.map((call) => call.id))
    const selected = JSON.stringify([...subagentIds])
    const models = this.database.prepare(`
      SELECT model.model_id FROM agent_model_activities model
      JOIN agent_subagent_calls call ON call.id = model.subagent_id
      JOIN agent_model_messages message ON message.run_id = model.run_id AND message.model_id = model.model_id
      JOIN agent_message_payloads payload ON payload.thread_id = call.child_thread_id
        AND payload.run_id = call.child_run_id AND payload.message_id = message.message_id
      WHERE model.run_id = ? AND call.id IN (SELECT value FROM json_each(?))
    `).all(runId, selected) as Array<{ model_id: string }>
    const tools = this.database.prepare(`
      SELECT activity.activity_id, activity.parent_subagent_id, tool.tool_message_id
      FROM agent_activities activity
      JOIN agent_subagent_calls call ON call.id = activity.parent_subagent_id
      JOIN agent_tool_messages tool ON tool.thread_id = call.child_thread_id
        AND tool.run_id = call.child_run_id AND tool.call_id = activity.activity_id
      WHERE activity.run_id = ? AND activity.kind = 'tool' AND tool.model_message_id IS NOT NULL
        AND call.id IN (SELECT value FROM json_each(?))
    `).all(runId, selected) as Array<{ activity_id: string; parent_subagent_id: string; tool_message_id: string | null }>
    return {
      subagentIds,
      modelIds: new Set(models.map((model) => model.model_id)),
      tools: new Map(tools.map((tool) => [
        JSON.stringify([tool.parent_subagent_id, tool.activity_id]),
        { completed: tool.tool_message_id !== null }
      ]))
    }
  }

  reconcile(
    runId: string,
    evidence: DurableRootActivityEvidence,
    writer: ActivityWriter = this.durableWriter()
  ): void {
    if (!this.database.prepare('SELECT 1 FROM agent_runs WHERE id=?').get(runId)) throw new Error(`Run ${runId} was not found.`)
    const durableModels = new Map(evidence.models.map((model) => [model.messageId, model]))
    const durableTools = new Map(evidence.tools.map((tool) => [tool.call.id, tool]))
    const canonicalChildren = this.canonicalChildren(runId)
    const reconcile = this.database.transaction(() => {
      const existingModelIds = this.pruneRoot(runId, new Set(durableModels.keys()), new Set(durableTools.keys()))
      const deleteModel = this.database.prepare('DELETE FROM agent_model_activities WHERE run_id=? AND model_id=?')
      const deleteTiming = this.database.prepare('DELETE FROM agent_activity_timing WHERE run_id=? AND activity_key=?')
      for (const model of evidence.models) {
        writer.recordModel(runId, {
          id: existingModelIds.get(model.messageId) ?? `message:${model.messageId}`,
          messageId: model.messageId,
          status: 'completed',
          text: model.text,
          reasoning: model.reasoning,
          toolCallIds: model.toolCalls.map((call) => call.id)
        })
      }

      const existingDurableRootSubagents = new Set((this.database.prepare(`
        SELECT activity_id
        FROM agent_activities
        WHERE run_id = ? AND kind = 'subagent' AND parent_subagent_id IS NULL
      `).all(runId) as Array<{ activity_id: string }>).map((row) => row.activity_id))
      for (const durable of evidence.tools) {
        if (
          !durable.subagentName
          || !durable.subagentId
          || existingDurableRootSubagents.has(durable.subagentId)
        ) continue
        writer.recordSubagent(
          runId,
          durable.subagentId,
          durable.subagentName,
          'running'
        )
        existingDurableRootSubagents.add(durable.subagentId)
      }

      // Restore missing descendant metadata while preserving existing order
      // and timing. Their bodies are validated against child messages below.
      this.reconcileAncestors(runId)
      const activityRows = this.database.prepare(`
        SELECT activity_key, kind, activity_id, parent_subagent_id, name
        FROM agent_activities
        WHERE run_id = ?
        ORDER BY sequence ASC
      `).all(runId) as Array<{
        activity_key: string
        kind: 'tool' | 'subagent'
        activity_id: string
        parent_subagent_id: string | null
        name: string
      }>
      // A committed child call proves the relationship independently of the
      // later parent tool result. Child model/tool bodies still need their own
      // canonical messages; retaining a relationship never validates partial output.
      const allowedSubagents = new Set(evidence.tools.flatMap((tool) =>
        tool.subagentId ? [tool.subagentId] : []
      ))
      let discoveredSubagent = true
      while (discoveredSubagent) {
        discoveredSubagent = false
        for (const row of activityRows) {
          if (
            row.kind === 'subagent'
            && row.parent_subagent_id
            && allowedSubagents.has(row.parent_subagent_id)
            && !allowedSubagents.has(row.activity_id)
          ) {
            allowedSubagents.add(row.activity_id)
            discoveredSubagent = true
          }
        }
      }
      const nestedModelRows = this.database.prepare(`
        SELECT model_id, subagent_id
        FROM agent_model_activities
        WHERE run_id = ? AND subagent_id IS NOT NULL
      `).all(runId) as Array<{ model_id: string; subagent_id: string }>
      for (const row of nestedModelRows) {
        if (canonicalChildren.subagentIds.has(row.subagent_id)
          ? canonicalChildren.modelIds.has(row.model_id)
          : allowedSubagents.has(row.subagent_id)) continue
        deleteModel.run(runId, row.model_id)
        deleteTiming.run(runId, `model:${row.model_id}`)
      }
      const deleteActivity = this.database.prepare(`
        DELETE FROM agent_activities
        WHERE run_id = ? AND activity_key = ?
      `)
      for (const row of activityRows) {
        if (row.kind === 'subagent' && canonicalChildren.subagentIds.has(row.activity_id)) continue
        if (row.kind === 'tool' && row.parent_subagent_id && canonicalChildren.subagentIds.has(row.parent_subagent_id)) {
          const canonicalTool = canonicalChildren.tools.get(JSON.stringify([row.parent_subagent_id, row.activity_id]))
          if (canonicalTool) {
            this.database.prepare('UPDATE agent_activities SET status = ? WHERE run_id = ? AND activity_key = ?')
              .run(canonicalTool.completed ? 'completed' : 'running', runId, row.activity_key)
            if (!canonicalTool.completed) this.database.prepare(`
              UPDATE agent_activity_timing SET completed_at = NULL WHERE run_id = ? AND activity_key = ?
            `).run(runId, row.activity_key)
            continue
          }
          deleteActivity.run(runId, row.activity_key)
          deleteTiming.run(runId, row.activity_key)
          continue
        }
        if (
          !row.parent_subagent_id
          || allowedSubagents.has(row.parent_subagent_id)
        ) continue
        deleteActivity.run(runId, row.activity_key)
        deleteTiming.run(runId, row.activity_key)
      }
      const existingRootTools = new Set<string>()
      const existingRootSubagents = new Set<string>()
      for (const row of activityRows) {
        if (row.parent_subagent_id) continue
        const durable = durableTools.get(row.activity_id)
        const durableSubagent = evidence.tools.find((tool) => tool.subagentId === row.activity_id)
        if (!durable && !durableSubagent && !(row.kind === 'subagent' && canonicalChildren.subagentIds.has(row.activity_id))) {
          deleteActivity.run(runId, row.activity_key)
          deleteTiming.run(runId, row.activity_key)
          continue
        }
        if (row.kind === 'tool') {
          if (!durable) continue
          existingRootTools.add(row.activity_id)
          writer.recordTool(runId, durable.call, 'completed', undefined, durable.output)
        } else {
          existingRootSubagents.add(row.activity_id)
        }
      }
      for (const durable of evidence.tools) {
        if (!existingRootTools.has(durable.call.id)) {
          writer.recordTool(runId, durable.call, 'completed', undefined, durable.output)
        }
        if (durable.subagentName && durable.subagentId && !existingRootSubagents.has(durable.subagentId)) {
          writer.recordSubagent(
            runId,
            durable.subagentId,
            durable.subagentName,
            'running'
          )
        }
      }
    })
    reconcile()
  }

  private durableWriter(): ActivityWriter {
    return {
      recordModel: (runId, model) => { this.model(runId, model) },
      recordTool: (runId, call, status, subagentId) => {
        const key = `tool:${subagentId ?? 'root'}:${call.id}`
        this.upsert({ runId, key, kind: 'tool', id: call.id, name: call.name, status, parentSubagentId: subagentId })
        if (status === 'completed') this.database.prepare('DELETE FROM agent_tool_approvals WHERE run_id=? AND activity_key=?').run(runId, key)
      },
      recordSubagent: (runId, id, name, status) => { this.upsert({ runId, key: `subagent:${id}`, kind: 'subagent', id, name, status, outputJson: JSON.stringify({ status }) }) }
    }
  }

}
