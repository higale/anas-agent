import type Database from 'better-sqlite3'
import type { AgentModelActivity, AgentToolActivity, AgentToolCall, AgentToolCallProgress, AgentSubagentActivity, AgentContextSummary } from '../../shared/agentTypes'
import type { ActivityAtom } from '../../shared/activityView'
import { activityReference, displayTool } from '../../shared/activityDisplay'
import { decodeExecutionValue } from '../../runtime/executionValue'
import { ActivityGroupIndex, type DisplayScope } from './activityGroupIndex'
import type { ActivityMessageHeader } from './activityDirectoryIndex'

interface Run { id: string; thread_id: string; status: string; updated_at: string }
interface LightModel {
  hasText: boolean; hasReasoning: boolean; reasoningSummary?: string; toolCallIds: string[]
  recovery?: AgentModelActivity['recovery']; progress?: AgentToolCallProgress[]
}
interface AtomRecord { scope: DisplayScope; atom: ActivityAtom }
const owners = new WeakMap<Database.Database, ActivityDisplayProjection>()
export function activityDisplayProjection(database: Database.Database) {
  let owner = owners.get(database)
  if (!owner) { owner = new ActivityDisplayProjection(database); owners.set(database, owner) }
  return owner
}
const writing = new WeakSet<Database.Database>()
/** Every caller is an existing synchronous product mutation. Pending source
 * identities and derived display changes roll back with that same transaction. */
export function displayTransaction<T>(database: Database.Database, mutation: () => T): () => T {
  return () => {
    if (writing.has(database)) return mutation()
    const owner = activityDisplayProjection(database)
    writing.add(database)
    try {
      return owner.atomic(() => database.transaction(() => {
        const result = mutation()
        owner.flush()
        return result
      })())
    } finally { writing.delete(database) }
  }
}

/** One projection for committed facts and lightweight in-flight observations.
 * Bodies stay with execution/observation owners. Reads never invoke this writer. */
export class ActivityDisplayProjection {
  private readonly index: ActivityGroupIndex
  private readonly models = new Map<string, LightModel>()
  private readonly tools = new Map<string, Pick<AgentToolActivity, 'call' | 'freeform'>>()
  private readonly calls = new Map<string, { modelId: string; index: number }>()
  private undo?: (() => void)[]
  constructor(private readonly database: Database.Database) { this.index = new ActivityGroupIndex(database) }
  atomic<T>(mutation: () => T): T {
    this.undo = []
    try { return mutation() }
    catch (error) { for (const revert of this.undo.reverse()) revert(); throw error }
    finally { this.undo = undefined }
  }
  private set<T>(map: Map<string, T>, key: string, value: T) {
    const old = map.get(key)
    this.undo?.push(() => { if (old === undefined) map.delete(key); else map.set(key, old) })
    map.set(key, value)
  }
  private identity(runId: string, id: string) { return JSON.stringify([runId, id]) }
  pendingProgress(runId: string, modelId: string) {
    const progress = this.models.get(this.identity(runId, modelId))?.progress
    return progress?.length ? progress : undefined
  }
  private mark(runId: string, sourceKey: string) {
    this.database.prepare('INSERT OR IGNORE INTO agent_display_changes VALUES(?,?)').run(runId, sourceKey)
  }
  private markModel(runId: string, modelId: string) {
    this.mark(runId, `model:${modelId}`)
    // The child owns streamed content; ancestors own only display references.
    // Walk the indexed ownership chain when its visible metadata changes.
    this.database.prepare(`WITH RECURSIVE owners(run_id) AS (
      SELECT ? UNION SELECT call.parent_run_id FROM agent_subagent_calls call JOIN owners ON call.child_run_id=owners.run_id
    ) INSERT OR IGNORE INTO agent_display_changes(run_id,source_key)
      SELECT model.run_id,'model:' || model.model_id FROM owners JOIN agent_model_activities model
      ON model.run_id=owners.run_id WHERE model.model_id=?`).run(runId, modelId)
  }
  observeModel(runId: string, model: Pick<AgentModelActivity, 'id' | 'text' | 'reasoning' | 'reasoningSummary' | 'toolCallIds' | 'recovery'>) {
    const key = this.identity(runId, model.id), old = this.models.get(key)
    const next: LightModel = { hasText: /\S/.test(model.text), hasReasoning: Boolean(model.reasoning),
      reasoningSummary: model.reasoningSummary?.slice(0, 240), toolCallIds: model.toolCallIds, recovery: model.recovery, progress: old?.progress }
    if (JSON.stringify(old) === JSON.stringify(next)) return
    model.toolCallIds.forEach((id, index) => this.set(this.calls, this.identity(runId, id), { modelId: model.id, index }))
    this.set(this.models, key, next); this.markModel(runId, model.id)
  }
  observeProgress(runId: string, modelId: string, progress: AgentToolCallProgress[]) {
    const key = this.identity(runId, modelId), model = this.models.get(key) ?? { hasText: false, hasReasoning: false, toolCallIds: [] }
    progress.forEach((item, index) => { if (item.callId) this.set(this.calls, this.identity(runId, item.callId), { modelId, index }) })
    this.set(this.models, key, { ...model, progress }); this.markModel(runId, modelId)
  }
  observeTool(runId: string, call: AgentToolCall, subagentId?: string) {
    const key = `tool:${subagentId ?? 'root'}:${call.id}`
    const { call: header, freeform } = displayTool('', runId, { call, status: 'running', sequence: 0 })
    this.set(this.tools, this.identity(runId, key), { call: header, freeform }); this.mark(runId, `activity:${key}`)
  }
  release(runId: string) {
    const clear = <T>(values: Map<string, T>) => { for (const [key, value] of values) if ((JSON.parse(key) as string[])[0] === runId) {
      this.undo?.push(() => { values.set(key, value) }); values.delete(key)
    } }
    clear(this.models); clear(this.tools); clear(this.calls)
    this.mark(runId, 'run')
  }
  private run(runId: string) { return this.database.prepare('SELECT id,thread_id,status,updated_at FROM agent_runs WHERE id=?').get(runId) as Run | undefined }
  private source(run: Run, agentId: string) {
    const child = agentId ? this.database.prepare('SELECT child_thread_id AS thread_id,child_run_id AS id,status FROM agent_subagent_calls WHERE id=?')
      .get(agentId) as Run | undefined : undefined
    return child ?? run
  }
  private header(threadId: string, messageId: string | null): ActivityMessageHeader | undefined {
    const row = messageId ? this.database.prepare('SELECT header_json FROM agent_display_headers WHERE thread_id=? AND message_id=?')
      .get(threadId, messageId) as { header_json: string } | undefined : undefined
    return row ? JSON.parse(row.header_json) as ActivityMessageHeader : undefined
  }
  private entry(scope: DisplayScope, item: Extract<ActivityAtom, { type: 'entry' }>['item'], sequence: number, part = 1): AtomRecord {
    return { scope, atom: { type: 'entry', item, position: { sequence, part, key: item.key } } }
  }
  private model(run: Run, id: string): AtomRecord[] {
    const row = this.database.prepare(`SELECT model.sequence,model.subagent_id AS agent_id,model.display_round AS round,
      message.message_id,timing.started_at,timing.completed_at FROM agent_model_activities model
      LEFT JOIN agent_model_messages message ON message.run_id=model.run_id AND message.model_id=model.model_id
      LEFT JOIN agent_activity_timing timing ON timing.run_id=model.run_id AND timing.activity_key='model:' || model.model_id
      WHERE model.run_id=? AND model.model_id=?`).get(run.id, id) as {
        sequence: number; agent_id: string | null; round: number; message_id: string | null; started_at: string | null; completed_at: string | null
      } | undefined
    if (!row) return []
    const scope = { runId: run.id, agentId: row.agent_id ?? '' }, source = this.source(run, scope.agentId)
    const header = this.header(source.thread_id, row.message_id)
    const active = source.status === 'running' || source.status === 'interrupted'
    if (!header && !active) return []
    const observed = this.models.get(this.identity(source.id, id)) ?? this.models.get(this.identity(run.id, id))
    const ids = header?.calls.map(item => item.call.id) ?? observed?.toolCallIds ?? []
    const key = `model:${scope.agentId || 'root'}:${id}`
    const model: AgentModelActivity = { id, messageId: header ? row.message_id! : undefined, sequence: row.sequence, round: row.round,
      subagentId: scope.agentId || undefined, status: header ? 'completed' : 'running', text: '', reasoning: '', toolCallIds: [],
      hasText: header?.hasText ?? observed?.hasText ?? false, hasReasoning: header?.hasReasoning ?? observed?.hasReasoning ?? false,
      reasoningSummary: header?.reasoningSummary ?? observed?.reasoningSummary, recovery: observed?.recovery,
      startedAt: row.started_at ?? undefined, completedAt: header ? row.completed_at ?? undefined : undefined,
      detail: activityReference(run.thread_id, run.id, 'model', id, scope.agentId || undefined) }
    const result: AtomRecord[] = []
    if (model.hasReasoning || ids.length || model.status === 'running') result.push(this.entry(scope, { type: 'model', key, model, round: row.round, showText: false }, row.sequence))
    if (model.hasText) result.push({ scope, atom: { type: 'reply', model, position: { sequence: row.sequence, part: 2, key: `text:${key}` } } })
    if (!header && active) for (const [index, progress] of (observed?.progress ?? []).entries()) {
      const callId = ids[index] ?? progress.callId ?? `${id}:draft:${progress.index}`
      if (this.database.prepare("SELECT 1 FROM agent_activities WHERE run_id=? AND activity_id=? AND parent_subagent_id IS ? AND kind='tool'")
        .get(run.id, callId, row.agent_id)) continue
      result.push(this.entry(scope, { type: 'tool', key: `model-tool:${scope.agentId || 'root'}:${id}:${index}`, progress,
        tool: { call: { id: callId, name: progress.name, args: undefined }, status: 'running', sequence: row.sequence, subagentId: scope.agentId || undefined,
          startedAt: model.startedAt } }, row.sequence, 3 + index))
    }
    return result
  }
  private activity(run: Run, key: string, delegationOnly = false): AtomRecord[] {
    const row = this.database.prepare(`SELECT activity.activity_id AS id,activity.kind,activity.sequence,activity.name,
      activity.parent_subagent_id AS agent_id,timing.started_at,timing.completed_at,approval.interrupt_id,approval.action_index
      FROM agent_activities activity LEFT JOIN agent_activity_timing timing ON timing.run_id=activity.run_id AND timing.activity_key=activity.activity_key
      LEFT JOIN agent_tool_approvals approval ON approval.run_id=activity.run_id AND approval.activity_key=activity.activity_key
      WHERE activity.run_id=? AND activity.activity_key=?`).get(run.id, key) as {
        id: string; kind: string; sequence: number; name: string; agent_id: string | null; started_at: string | null; completed_at: string | null;
        interrupt_id: string | null; action_index: number | null
      } | undefined
    if (!row) { if (!delegationOnly) this.delegation(run.id, key); return [] }
    const scope = { runId: run.id, agentId: row.agent_id ?? '' }
    if (row.kind === 'subagent') {
      const child = this.database.prepare(`SELECT id,agent_name AS name,status,parent_subagent_id AS parentSubagentId,
        updated_at AS completedAt,substr(error,1,240) AS error FROM agent_subagent_calls WHERE id=?`).get(row.id) as AgentSubagentActivity | undefined
      if (!child) return []
      const link = this.database.prepare('SELECT activity_key FROM agent_display_delegations WHERE run_id=? AND child_id=?').get(run.id, row.id) as { activity_key: string } | undefined
      const delegated = link ? this.activity(run, link.activity_key, true)[0]?.atom : undefined
      const delegation = delegated?.type === 'entry' && delegated.item.type === 'tool' ? delegated.item.tool : undefined
      return [this.entry(scope, { type: 'subagent', key: `subagent:${row.id}`, subagent: { ...child, sequence: row.sequence,
        parentSubagentId: child.parentSubagentId ?? undefined, error: child.error ?? undefined, detailsDeferred: true, delegation,
        startedAt: row.started_at ?? undefined, completedAt: child.status === 'running' || child.status === 'interrupted' ? undefined : child.completedAt,
        detail: activityReference(run.thread_id, run.id, 'subagent', row.id) } }, delegation?.sequence ?? row.sequence)]
    }
    const source = this.source(run, scope.agentId), active = source.status === 'running' || source.status === 'interrupted'
    const link = this.database.prepare('SELECT model_message_id,tool_message_id FROM agent_tool_messages WHERE thread_id=? AND run_id=? AND call_id=?')
      .get(source.thread_id, source.id, row.id) as { model_message_id: string | null; tool_message_id: string | null } | undefined
    const header = this.header(source.thread_id, link?.model_message_id ?? null)
    const callIndex = header?.calls.findIndex(call => call.call.id === row.id) ?? -1
    const call = header?.calls[callIndex]
    if (!call && !active) { if (!delegationOnly) this.delegation(run.id, key); return [] }
    const model = link?.model_message_id ? this.database.prepare(`SELECT model.model_id FROM agent_model_activities model
      JOIN agent_model_messages message ON message.run_id=model.run_id AND message.model_id=model.model_id
      WHERE model.run_id=? AND model.subagent_id IS ? AND message.message_id=?`).get(run.id, row.agent_id, link.model_message_id) as { model_id: string } | undefined : undefined
    let itemKey = model && callIndex >= 0 ? `model-tool:${scope.agentId || 'root'}:${model.model_id}:${callIndex}` : `tool:${scope.agentId || 'root'}:${row.id}`
    const pending = this.calls.get(this.identity(source.id, row.id)) ?? this.calls.get(this.identity(run.id, row.id))
    if (!model && pending) itemKey = `model-tool:${scope.agentId || 'root'}:${pending.modelId}:${pending.index}`
    const observed = this.tools.get(this.identity(source.id, `tool:root:${row.id}`)) ?? this.tools.get(this.identity(run.id, key))
    const tool: AgentToolActivity = { call: call?.call ?? observed?.call ?? { id: row.id, name: row.name, args: {} },
      freeform: call?.freeform ?? observed?.freeform, status: link?.tool_message_id ? 'completed' : 'running', sequence: row.sequence,
      subagentId: scope.agentId || undefined, startedAt: row.started_at ?? undefined, completedAt: link?.tool_message_id ? row.completed_at ?? undefined : undefined,
      ...(!link?.tool_message_id && row.interrupt_id && row.action_index !== null ? { approval: { status: 'pending_approval', interruptId: row.interrupt_id, actionIndex: row.action_index } } : {}),
      detail: activityReference(run.thread_id, run.id, 'tool', row.id, scope.agentId || undefined) }
    if (delegationOnly) return [this.entry(scope, { type: 'tool', key: itemKey, tool }, row.sequence)]
    const effect = row.name === 'start_subagent' ? this.database.prepare('SELECT resources_value FROM execution_effects WHERE thread_id=? AND run_id=? AND call_id=?')
      .get(source.thread_id, source.id, row.id) as { resources_value: Uint8Array } | undefined : undefined
    const childId = effect ? (decodeExecutionValue(effect.resources_value) as { subagent?: string }).subagent
      : this.header(source.thread_id, link?.tool_message_id ?? null)?.childId
    this.delegation(run.id, key, childId)
    if (childId && this.database.prepare("SELECT 1 FROM agent_activities WHERE run_id=? AND activity_id=? AND kind='subagent'").get(run.id, childId)) return []
    return [this.entry(scope, { type: 'tool', key: itemKey, tool }, row.sequence)]
  }
  private delegation(runId: string, key: string, childId?: string) {
    const old = this.database.prepare('SELECT child_id FROM agent_display_delegations WHERE run_id=? AND activity_key=?').get(runId, key) as { child_id: string } | undefined
    if (childId) this.database.prepare(`INSERT INTO agent_display_delegations VALUES(?,?,?)
      ON CONFLICT(run_id,activity_key) DO UPDATE SET child_id=excluded.child_id WHERE child_id<>excluded.child_id`).run(runId, key, childId)
    else if (old) this.database.prepare('DELETE FROM agent_display_delegations WHERE run_id=? AND activity_key=?').run(runId, key)
    if (old && old.child_id !== childId) this.mark(runId, `activity:subagent:${old.child_id}`)
    if (childId) this.mark(runId, `activity:subagent:${childId}`)
  }
  private messagePosition(runId: string, id: string): number | undefined {
    const row = this.database.prepare(`SELECT model.sequence FROM agent_model_messages message JOIN agent_model_activities model
      ON model.run_id=message.run_id AND model.model_id=message.model_id WHERE message.run_id=? AND message.message_id=? AND model.subagent_id IS NULL
      UNION ALL SELECT activity.sequence FROM agent_tool_messages link JOIN agent_activities activity ON activity.run_id=link.run_id
      AND activity.activity_id=link.call_id AND activity.kind='tool' WHERE link.run_id=? AND link.tool_message_id=? AND activity.parent_subagent_id IS NULL LIMIT 1`)
      .get(runId, id, runId, id) as { sequence: number } | undefined
    return row?.sequence
  }
  private other(run: Run, sourceKey: string): AtomRecord[] {
    const scope = { runId: run.id, agentId: '' }, id = sourceKey.slice(sourceKey.indexOf(':') + 1)
    if (sourceKey.startsWith('summary:')) {
      const row = this.database.prepare(`SELECT summary_id AS id,sequence,status,first_preserved_message_id AS firstPreservedMessageId,
        input_tokens_before AS inputTokensBefore,input_tokens_after AS inputTokensAfter,created_at AS createdAt
        FROM agent_context_summaries WHERE run_id=? AND summary_id=?`).get(run.id, id) as AgentContextSummary | undefined
      const sequence = row?.firstPreservedMessageId ? this.messagePosition(run.id, row.firstPreservedMessageId) : undefined
      if (!row || sequence === undefined) return []
      const number = (this.database.prepare('SELECT COUNT(*) AS count FROM agent_context_summaries WHERE run_id=? AND sequence<=?')
        .get(run.id, row.sequence) as { count: number }).count
      return [this.entry(scope, { type: 'summary', key: `summary:${id}`, number, summary: { ...row, summaryText: '', firstPreservedActivitySequence: sequence,
        detail: activityReference(run.thread_id, run.id, 'summary', id) } }, sequence, 0)]
    }
    let header: ActivityMessageHeader | undefined, messageId = id
    if (sourceKey === 'input') {
      const input = this.database.prepare('SELECT display_json FROM agent_run_input_intents WHERE run_id=?').get(run.id) as { display_json: string | null } | undefined
      const value = input?.display_json ? JSON.parse(input.display_json) as { id: string; header: ActivityMessageHeader } : undefined
      header = value?.header; messageId = value?.id ?? ''
      if (!value) {
        const first = this.database.prepare('SELECT message_id FROM agent_message_payloads WHERE run_id=? ORDER BY body_sequence LIMIT 1').get(run.id) as { message_id: string } | undefined
        messageId = first?.message_id ?? ''; header = this.header(run.thread_id, messageId)
      }
    } else header = this.header(run.thread_id, messageId)
    if (!header) return []
    if (sourceKey === 'input' && header.skill) return [this.entry(scope, { type: 'skill', key: `skill:${run.id}`,
      invocation: { ...header.skill, detail: activityReference(run.thread_id, run.id, 'skill', messageId) } }, -1, 0)]
    const last = header.directionAfterCallIds?.at(-1)
    const row = last ? this.database.prepare("SELECT sequence FROM agent_activities WHERE run_id=? AND activity_id=? AND kind='tool' AND parent_subagent_id IS NULL")
      .get(run.id, last) as { sequence: number } | undefined : undefined
    return row ? [this.entry(scope, { type: 'direction', key: `direction:${id}`, message: { id, role: 'user', runId: run.id, content: [] },
      detail: activityReference(run.thread_id, run.id, 'message', id) }, row.sequence, Number.MAX_SAFE_INTEGER)] : []
  }
  resetTransient(): void {
    displayTransaction(this.database, () => {
      this.database.prepare(`INSERT OR IGNORE INTO agent_display_changes
        SELECT run_id,source_key FROM agent_display_items WHERE transient=1`).run()
    })()
  }
  flush(): void {
    if (!this.database.inTransaction) throw new Error('Display projection requires its owning write transaction.')
    const changes = this.database.prepare('SELECT run_id,source_key FROM agent_display_changes').all() as { run_id: string; source_key: string }[]
    this.database.prepare('DELETE FROM agent_display_changes').run()
    for (const { run_id: runId, source_key: sourceKey } of changes) {
      const run = this.run(runId)
      if (!run) continue
      if (sourceKey === 'run') {
        const sources = this.database.prepare('SELECT DISTINCT source_key FROM agent_display_items WHERE run_id=?').all(runId) as { source_key: string }[]
        for (const source of sources) this.mark(runId, source.source_key)
        continue
      }
      const atoms = sourceKey.startsWith('model:') ? this.model(run, sourceKey.slice(6))
        : sourceKey.startsWith('activity:') ? this.activity(run, sourceKey.slice(9)) : this.other(run, sourceKey)
      this.index.replaceSource(runId, sourceKey, atoms)
    }
    if (this.database.prepare('SELECT 1 FROM agent_display_changes LIMIT 1').get()) this.flush()
  }
}
