import type Database from 'better-sqlite3'
import type { AgentModelActivity, AgentToolActivity, AgentToolCall, AgentToolApproval, AgentContextStatus, AgentMemoryRecall } from '../../shared/agentTypes'
import { RunActivityMetadata } from './runActivityMetadata'
import { memoryRecallFromRow, type MemoryRecallRow } from './runActivityReader'

function timestamp(): string { return new Date().toISOString() }
function requireNonEmptyText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${label} must be a non-empty string.`)
}

function toolActivityKey(callId: string, subagentId?: string): string { return `tool:${subagentId ?? 'root'}:${callId}` }

/** Display observations bridge transport completion and durable message
 * publication. They never provide evidence for execution or recovery. */
export class RunActivityObservations {
  private readonly transientModels = new Map<string, Omit<AgentModelActivity,'sequence'|'startedAt'|'completedAt'>>()
  private readonly transientTools = new Map<string, {call:AgentToolCall;output?:unknown}>()
  private readonly activityMetadata: RunActivityMetadata
  constructor(private readonly database: Database.Database) { this.activityMetadata = new RunActivityMetadata(database) }

  pendingModel(runId: string, modelId: string) { return this.transientModels.get(JSON.stringify([runId, modelId])) }
  pendingTool(runId: string, callId: string, subagentId?: string) { return this.transientTools.get(JSON.stringify([runId, subagentId ?? null, callId])) }

  private requireRun(runId: string) {
    const run = this.database.prepare('SELECT thread_id AS threadId FROM agent_runs WHERE id=?').get(runId) as { threadId: string } | undefined
    if (!run) throw new Error(`Run ${runId} was not found.`)
    return run
  }

  recordContextStatus(threadId: string, status: AgentContextStatus): void {
    this.database.prepare(`INSERT INTO agent_context_status(thread_id,status_json) VALUES(?,?)
      ON CONFLICT(thread_id) DO UPDATE SET status_json=excluded.status_json`).run(threadId,JSON.stringify(status))
  }

  clearContextStatus(threadId: string): void {
    this.database.prepare('DELETE FROM agent_context_status WHERE thread_id=?').run(threadId)
  }

  recordMemoryRecall(
    runId: string,
    recall: Omit<AgentMemoryRecall, 'sequence' | 'createdAt'>
  ): AgentMemoryRecall {
    this.requireRun(runId)
    requireNonEmptyText(recall.id, 'Memory recall ID')
    requireNonEmptyText(recall.query, 'Memory recall query')
    requireNonEmptyText(recall.promptText, 'Memory recall prompt')
    if (!Number.isInteger(recall.memoryCount) || recall.memoryCount < 1) {
      throw new Error('Memory recall count must be a positive integer.')
    }
    if (recall.agentName !== undefined) requireNonEmptyText(recall.agentName, 'Memory recall Agent name')
    const sequence = this.activityMetadata.nextSequence(runId)
    const createdAt = timestamp()
    this.database.prepare(`
      INSERT OR IGNORE INTO agent_memory_recalls (
        run_id,
        recall_id,
        sequence,
        query,
        prompt_text,
        memory_count,
        agent_name,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      runId,
      recall.id,
      sequence,
      recall.query,
      recall.promptText,
      recall.memoryCount,
      recall.agentName ?? null,
      createdAt
    )
    const row = this.database.prepare(`
      SELECT run_id, recall_id, sequence, query, prompt_text, memory_count, agent_name, created_at
      FROM agent_memory_recalls
      WHERE run_id = ? AND recall_id = ?
    `).get(runId, recall.id) as MemoryRecallRow | undefined
    if (!row) throw new Error(`Memory recall ${recall.id} was not recorded.`)
    return memoryRecallFromRow(row)
  }

  recordToolApproval(
    runId: string,
    callId: string,
    approval: AgentToolApproval,
    subagentId?: string
  ): void {
    this.requireRun(runId)
    const activityKey = toolActivityKey(callId, subagentId)
    const activity = this.database.prepare(`
      SELECT kind
      FROM agent_activities
      WHERE run_id = ? AND activity_key = ?
    `).get(runId, activityKey) as { kind: 'tool' | 'subagent' } | undefined
    if (activity?.kind !== 'tool') {
      throw new Error(`Tool activity ${callId} was not found for run ${runId}.`)
    }
    this.database.prepare(`
      INSERT INTO agent_tool_approvals (
        run_id,
        activity_key,
        interrupt_id,
        action_index
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT (run_id, activity_key) DO UPDATE SET
        interrupt_id = excluded.interrupt_id,
        action_index = excluded.action_index
    `).run(
      runId,
      activityKey,
      approval.interruptId,
      approval.actionIndex
    )
  }

  clearToolApproval(runId: string, callId: string, subagentId?: string): void {
    this.database.prepare(`
      DELETE FROM agent_tool_approvals
      WHERE run_id = ? AND activity_key = ?
    `).run(runId, toolActivityKey(callId, subagentId))
  }

  recordTool(
    runId: string,
    call: AgentToolCall,
    status: 'running' | 'completed',
    subagentId?: string,
    output?: unknown
  ): AgentToolActivity {
    const key = JSON.stringify([runId, subagentId ?? null, call.id])
    const canonical = this.database.prepare(`SELECT model_message_id, tool_message_id FROM agent_tool_messages
      WHERE thread_id = ? AND run_id = ? AND call_id = ?`)
      .get(this.activitySourceThread(runId, subagentId), this.activitySourceRun(runId, subagentId), call.id) as {
        model_message_id: string | null; tool_message_id: string | null
      } | undefined
    if (canonical?.model_message_id && (output === undefined || canonical.tool_message_id)) this.transientTools.delete(key)
    else this.transientTools.set(key, { call: canonical?.model_message_id ? { ...call, args: {} } : call, output })
    const activity = this.activityMetadata.upsert({
      runId,
      key: toolActivityKey(call.id, subagentId),
      kind: 'tool',
      id: call.id,
      parentSubagentId: subagentId,
      name: call.name,
      status,
      outputJson: null
    })
    if (status === 'completed') this.database.prepare('DELETE FROM agent_tool_approvals WHERE run_id=? AND activity_key=?').run(runId, toolActivityKey(call.id, subagentId))
    return { call, status, subagentId, output, ...activity }
  }

  recordModel(
    runId:string,
    model:Omit<AgentModelActivity,'sequence'|'startedAt'|'completedAt'>
  ): AgentModelActivity {
    this.requireRun(runId)
    const key = JSON.stringify([runId, model.id])
    const messageId = model.messageId ?? (this.database.prepare('SELECT message_id FROM agent_model_messages WHERE run_id = ? AND model_id = ?')
      .get(runId, model.id) as { message_id: string } | undefined)?.message_id
    const canonical = messageId && this.database.prepare(`SELECT 1 FROM agent_message_payloads
      WHERE thread_id = ? AND run_id = ? AND message_id = ?`)
      .get(this.activitySourceThread(runId, model.subagentId), this.activitySourceRun(runId, model.subagentId), messageId)
    if (canonical) this.transientModels.delete(key)
    else if (model.status === 'completed') this.transientModels.set(key, model)
    return { ...model, ...this.activityMetadata.model(runId, model) }
  }

  discardModel(runId: string, modelId: string): boolean {
    this.requireRun(runId)
    const discarded = this.database.transaction(() => {
      const result = this.database.prepare(`
        DELETE FROM agent_model_activities
        WHERE run_id = ? AND model_id = ?
      `).run(runId, modelId)
      if (result.changes === 0) return false
      this.database.prepare(`
        DELETE FROM agent_activity_timing
        WHERE run_id = ? AND activity_key = ?
      `).run(runId, `model:${modelId}`)
      return true
    })()
    if (discarded) this.transientModels.delete(JSON.stringify([runId, modelId]))
    return discarded
  }

  releaseRun(runId: string): void {
    for (const key of this.transientModels.keys()) if ((JSON.parse(key) as string[])[0] === runId) this.transientModels.delete(key)
    for (const key of this.transientTools.keys()) if ((JSON.parse(key) as string[])[0] === runId) this.transientTools.delete(key)
  }

  private activitySourceThread(runId:string,subagentId?:string): string {
    const source=subagentId ? this.database.prepare('SELECT child_thread_id FROM agent_subagent_calls WHERE id=?').get(subagentId) as {child_thread_id:string}|undefined : undefined
    return source?.child_thread_id ?? this.requireRun(runId).threadId
  }

  private activitySourceRun(runId: string, subagentId?: string): string {
    const source = subagentId ? this.database.prepare('SELECT child_run_id FROM agent_subagent_calls WHERE id = ?')
      .get(subagentId) as { child_run_id: string } | undefined : undefined
    return source?.child_run_id ?? runId
  }

}
