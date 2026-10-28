import type Database from 'better-sqlite3'
import type { AgentThreadCreate, AgentSubagentActivity } from '../../shared/agentTypes'
import { DEFAULT_WORKSPACE_PROJECT_ID, type SubagentConfig, type SubagentPreset } from '../../shared/types'
import { requireSubagentPackageId, subagentPresetIds } from '../../shared/subagentPackages'
import { validateSubagentModelSelection } from '../../shared/subagentConfig'
import { validateCapabilities } from '../../shared/agentCapabilities'
import { createThreadRecord, readThreadRecord, defaultTitle, accessModeColumns } from './conversationThreads'
import { RunSubmissionStore } from './runSubmissionStore'
import { RunActivityMetadata } from './runActivityMetadata'

export type AgentSubagentCallStatus =
  | 'running'
  | 'interrupted'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface AgentSubagentCallRecord {
  id: string
  ownerThreadId: string
  parentThreadId: string
  parentRunId: string
  parentSubagentId?: string
  childThreadId: string
  childRunId: string
  agentName: string
  config: SubagentConfig
  description: string
  status: AgentSubagentCallStatus
  result?: string
  error?: string
  createdAt: string
  updatedAt: string
}

export interface AgentSubagentCallTransition {
  call: AgentSubagentCallRecord
  activity: AgentSubagentActivity
}

export type SubagentCallRow = {
  id: string
  owner_thread_id: string
  parent_thread_id: string
  parent_run_id: string
  parent_subagent_id: string | null
  child_thread_id: string
  child_run_id: string
  agent_name: string
  config_json: string
  description: string
  status: AgentSubagentCallStatus
  result_text: string | null
  error: string | null
  created_at: string
  updated_at: string
}

const subagentConfigNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const subagentConfigPresets = new Set<SubagentPreset>(subagentPresetIds)

export function normalizeSubagentConfigSnapshot(value: unknown): SubagentConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Stored subagent config snapshot is invalid.')
  }
  const raw = value as Record<string, unknown>
  if (!Number.isSafeInteger(raw.index) || (raw.index as number) < 0) {
    throw new Error('Stored subagent config index is invalid.')
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : ''
  if (!subagentConfigNamePattern.test(name) || name.length > 64) {
    throw new Error('Stored subagent config name is invalid.')
  }
  if (typeof raw.enabled !== 'boolean' || typeof raw.builtIn !== 'boolean') {
    throw new Error('Stored subagent config flags are invalid.')
  }
  const preset = raw.preset === undefined
    ? undefined
    : typeof raw.preset === 'string' && subagentConfigPresets.has(raw.preset as SubagentPreset)
      ? raw.preset as SubagentPreset
      : null
  if (preset === null || raw.builtIn !== (preset !== undefined)) {
    throw new Error('Stored subagent config preset is invalid.')
  }
  const description = typeof raw.description === 'string' ? raw.description.trim() : undefined
  const systemPrompt = typeof raw.systemPrompt === 'string' ? raw.systemPrompt.trim() : undefined
  if (description === undefined || systemPrompt === undefined) {
    throw new Error('Stored subagent config text is invalid.')
  }
  if (!description || !systemPrompt) {
    throw new Error('Stored subagent config text must not be empty.')
  }
  return {
    ...(raw.id === undefined ? {} : { id: requireSubagentPackageId(raw.id) }),
    index: raw.index as number,
    name,
    enabled: raw.enabled,
    ...(preset === undefined ? {} : { preset }),
    builtIn: raw.builtIn,
    description,
    systemPrompt,
    ...validateSubagentModelSelection(raw),
    capabilities: validateCapabilities(raw.capabilities)
  }
}

export function subagentCallFromRow(row: SubagentCallRow): AgentSubagentCallRecord {
  const config = normalizeSubagentConfigSnapshot(JSON.parse(row.config_json))
  if (config.name !== row.agent_name) {
    throw new Error(`Subagent ${row.id} config snapshot does not match its stored name.`)
  }
  return {
    id: row.id,
    ownerThreadId: row.owner_thread_id,
    parentThreadId: row.parent_thread_id,
    parentRunId: row.parent_run_id,
    ...(row.parent_subagent_id === null ? {} : { parentSubagentId: row.parent_subagent_id }),
    childThreadId: row.child_thread_id,
    childRunId: row.child_run_id,
    agentName: row.agent_name,
    config,
    description: row.description,
    status: row.status,
    ...(row.result_text === null ? {} : { result: row.result_text }),
    ...(row.error === null ? {} : { error: row.error }),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function requireNonEmptyText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string.`)
  }
}

export interface SubagentSubmission {
  id: string
  ownerThreadId: string
  parentThreadId: string
  parentRunId: string
  parentSubagentId?: string
  childThreadId: string
  childRunId: string
  config: SubagentConfig
  description: string
  childThread: AgentThreadCreate
}

/** Task identity and presentation shared by the product and native execution.
 * The execution owner supplies its already encoded durable input. */
export class SubagentTaskStore {
  private readonly activityMetadata: RunActivityMetadata
  constructor(private readonly database: Database.Database) { this.activityMetadata = new RunActivityMetadata(database) }

  private requireThread(id: string) {
    const thread = readThreadRecord(this.database, id)
    if (!thread) throw new Error(`Thread ${id} was not found.`)
    return thread
  }

  private requireRun(id: string) {
    const run = this.database.prepare('SELECT id,thread_id AS threadId,status FROM agent_runs WHERE id=?').get(id) as { id: string; threadId: string; status: string } | undefined
    if (!run) throw new Error(`Run ${id} was not found.`)
    return run
  }

  find(id: string, ownerThreadId: string): AgentSubagentCallRecord | undefined {
    const row = this.database.prepare('SELECT * FROM agent_subagent_calls WHERE id=? AND owner_thread_id=?').get(id, ownerThreadId) as SubagentCallRow | undefined
    return row ? subagentCallFromRow(row) : undefined
  }

  require(id: string, ownerThreadId: string): AgentSubagentCallRecord {
    const call = this.find(id, ownerThreadId)
    if (!call) throw new Error(`Subagent ${id} was not found.`)
    return call
  }

  create(input: SubagentSubmission, inputJson: string, armEffect?: () => void): AgentSubagentCallRecord {
    requireNonEmptyText(input.id, 'Subagent ID')
    requireNonEmptyText(input.ownerThreadId, 'Subagent owner thread ID')
    requireNonEmptyText(input.parentThreadId, 'Subagent parent thread ID')
    requireNonEmptyText(input.parentRunId, 'Subagent parent run ID')
    requireNonEmptyText(input.childThreadId, 'Subagent child thread ID')
    requireNonEmptyText(input.childRunId, 'Subagent child run ID')
    requireNonEmptyText(input.description, 'Subagent description')
    const config = normalizeSubagentConfigSnapshot(input.config)
    const parentRun = this.requireRun(input.parentRunId)
    if (parentRun.threadId !== input.parentThreadId) {
      throw new Error(`Run ${input.parentRunId} does not belong to thread ${input.parentThreadId}.`)
    }
    if (parentRun.status !== 'running') {
      throw new Error(`Run ${input.parentRunId} is not accepting subagents.`)
    }
    const ownerThread = this.requireThread(input.ownerThreadId)
    if (input.parentSubagentId) {
      const parentSubagent = this.require(
        input.parentSubagentId,
        input.ownerThreadId
      )
      if (
        parentSubagent.childThreadId !== input.parentThreadId
        || parentSubagent.childRunId !== input.parentRunId
      ) {
        throw new Error(`Subagent ${input.parentSubagentId} does not own run ${input.parentRunId}.`)
      }
    } else if (input.ownerThreadId !== input.parentThreadId) {
      throw new Error('A root subagent call must be started by its owning conversation.')
    }
    if (
      (input.childThread.projectId ?? DEFAULT_WORKSPACE_PROJECT_ID)
      !== ownerThread.projectId
    ) {
      throw new Error('A subagent thread must belong to its owning conversation project.')
    }
    if (readThreadRecord(this.database, input.childThreadId)) {
      throw new Error(`Thread ${input.childThreadId} already exists.`)
    }
    if (this.database.prepare('SELECT 1 FROM agent_runs WHERE id=?').get(input.childRunId)) {
      throw new Error(`Run ${input.childRunId} already exists.`)
    }
    const duplicateCall = this.database.prepare(`
      SELECT 1 FROM agent_subagent_calls WHERE id = ?
    `).get(input.id)
    if (duplicateCall) throw new Error(`Subagent ${input.id} already exists.`)
    defaultTitle(input.childThread.title)
    accessModeColumns(input.childThread.accessMode ?? 'read_only_allowed')
    const now = new Date().toISOString()
    return this.database.transaction(() => {
      armEffect?.()
      createThreadRecord(this.database, input.childThread, input.childThreadId)
      this.database.prepare(`
        INSERT INTO agent_hidden_threads (thread_id, kind)
        VALUES (?, 'subagent')
      `).run(input.childThreadId)
      new RunSubmissionStore(this.database).createRun(input.childThreadId, input.childRunId, 'agent', [], inputJson)
      this.database.prepare(`
        INSERT INTO agent_subagent_calls (
          id, owner_thread_id, parent_thread_id, parent_run_id,
          parent_subagent_id, child_thread_id, child_run_id,
          agent_name, config_json, description, status, result_text, error,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', NULL, NULL, ?, ?)
      `).run(
        input.id,
        input.ownerThreadId,
        input.parentThreadId,
        input.parentRunId,
        input.parentSubagentId ?? null,
        input.childThreadId,
        input.childRunId,
        config.name,
        JSON.stringify(config),
        input.description,
        now,
        now
      )
      const call = this.require(input.id, input.ownerThreadId)
      this.recordCallActivity(call)
      return call
    })()
  }

  activity(
    runId: string,
    id: string,
    name: string,
    status: AgentSubagentActivity['status'],
    parentSubagentId?: string,
    result?: unknown,
    error?: string
  ): AgentSubagentActivity {
    const terminal = status === 'completed' || status === 'failed' || status === 'cancelled'
    const payload = {
      status,
      ...(status === 'completed' && result !== undefined ? { result } : {}),
      ...(error === undefined ? {} : { error })
    }
    const activity = this.activityMetadata.upsert({
      runId,
      key: `subagent:${id}`,
      kind: 'subagent',
      id,
      parentSubagentId,
      name,
      status: terminal ? 'completed' : 'running',
      outputJson: JSON.stringify({status})
    })
    return {
      id,
      name,
      status,
      parentSubagentId,
      ...(payload.result === undefined ? {} : { result: payload.result }),
      ...(payload.error === undefined ? {} : { error: payload.error }),
      ...activity
    }
  }

  project(
    carrierSubagentId: string,
    ownerThreadId: string,
    activity: Omit<AgentSubagentActivity, 'sequence' | 'startedAt' | 'completedAt'>
  ): AgentSubagentActivity {
    const carrier = this.require(carrierSubagentId, ownerThreadId)
    this.requireDescendant(carrier, activity.id)
    const project = this.database.transaction(() => {
      let direct: AgentSubagentActivity | undefined
      for (const [index, ancestor] of this.chain(carrier).entries()) {
        const recorded = this.activity(
          ancestor.parentRunId,
          activity.id,
          activity.name,
          activity.status,
          activity.parentSubagentId,
          activity.result,
          activity.error
        )
        if (index === 0) direct = recorded
        else if (direct) {
          this.alignTiming(
            ancestor.parentRunId,
            `subagent:${activity.id}`,
            direct
          )
        }
      }
      if (!direct) throw new Error(`Subagent ${carrierSubagentId} has no projection target.`)
      return direct
    })
    return project()
  }

  recordCallActivity(call: AgentSubagentCallRecord): AgentSubagentActivity {
    return this.project(
      call.id,
      call.ownerThreadId,
      {
        id: call.id,
        name: call.agentName,
        status: call.status,
        parentSubagentId: call.parentSubagentId,
        result: call.result,
        error: call.error
      }
    )
  }

  chain(
    carrier: AgentSubagentCallRecord
  ): AgentSubagentCallRecord[] {
    const chain = [carrier]
    const visited = new Set([carrier.id])
    let parentSubagentId = carrier.parentSubagentId
    while (parentSubagentId) {
      if (visited.has(parentSubagentId)) throw new Error('Subagent ancestry contains a cycle.')
      visited.add(parentSubagentId)
      const parent = this.require(parentSubagentId, carrier.ownerThreadId)
      chain.push(parent)
      parentSubagentId = parent.parentSubagentId
    }
    return chain
  }

  requireDescendant(
    carrier: AgentSubagentCallRecord,
    projectedSubagentId: string
  ): AgentSubagentCallRecord {
    let projected = this.require(projectedSubagentId, carrier.ownerThreadId)
    const visited = new Set<string>()
    while (true) {
      if (visited.has(projected.id)) throw new Error('Subagent ancestry contains a cycle.')
      visited.add(projected.id)
      if (projected.id === carrier.id) return projected
      if (!projected.parentSubagentId) {
        throw new Error(
          `Subagent ${projectedSubagentId} is not a descendant of ${carrier.id}.`
        )
      }
      projected = this.require(projected.parentSubagentId, carrier.ownerThreadId)
    }
  }

  private alignTiming(
    runId: string,
    activityKey: string,
    source: { startedAt?: string; completedAt?: string }
  ): void {
    if (!source.startedAt) return
    this.database.prepare(`
      UPDATE agent_activity_timing
      SET started_at = ?, completed_at = ?
      WHERE run_id = ? AND activity_key = ?
    `).run(source.startedAt, source.completedAt ?? null, runId, activityKey)
  }

  recordCompletedResult(
    subagentId: string,
    ownerThreadId: string,
    result: string
  ): { call: AgentSubagentCallRecord; activity: AgentSubagentActivity } {
    return this.database.transaction(() => {
      const existing = this.require(subagentId, ownerThreadId)
      if (existing.status !== 'completed') {
        throw new Error(`Subagent ${subagentId} is not completed.`)
      }
      this.database.prepare(`
        UPDATE agent_subagent_calls
        SET result_text = ?, updated_at = ?
        WHERE id = ?
          AND owner_thread_id = ?
          AND status = 'completed'
          AND result_text IS NULL
      `).run(result, new Date().toISOString(), subagentId, ownerThreadId)
      const call = this.require(subagentId, ownerThreadId)
      return { call, activity: this.recordCallActivity(call) }
    })()
  }

  finish(input: {
    subagentId: string
    ownerThreadId: string
    status: Exclude<AgentSubagentCallStatus, 'running' | 'interrupted'>
    result?: string
    error?: string
  }): AgentSubagentCallTransition | undefined {
    const now = new Date().toISOString()
    return this.database.transaction(() => {
      this.require(input.subagentId, input.ownerThreadId)
      const updated = this.database.prepare(`
        UPDATE agent_subagent_calls
        SET status = @status,
            result_text = @result,
            error = @error,
            updated_at = @updatedAt
        WHERE id = @id
          AND owner_thread_id = @ownerThreadId
          AND status IN ('running', 'interrupted')
      `).run({
        id: input.subagentId,
        ownerThreadId: input.ownerThreadId,
        status: input.status,
        result: input.status === 'completed' ? input.result ?? null : null,
        error: input.status === 'failed' ? input.error ?? null : null,
        updatedAt: now
      })
      if (updated.changes === 0) return undefined
      const call = this.require(input.subagentId, input.ownerThreadId)
      const activity = this.recordCallActivity(call)
      this.settleProjectedActivities(call.id, activity.completedAt ?? now)
      return { call, activity }
    })()
  }

  interrupt(
    subagentId: string,
    ownerThreadId: string
  ): AgentSubagentCallTransition | undefined {
    return this.database.transaction(() => {
      this.require(subagentId, ownerThreadId)
      const updated = this.database.prepare(`
        UPDATE agent_subagent_calls
        SET status = 'interrupted', error = NULL, updated_at = ?
        WHERE id = ? AND owner_thread_id = ? AND status = 'running'
      `).run(new Date().toISOString(), subagentId, ownerThreadId)
      if (updated.changes === 0) return undefined
      const call = this.require(subagentId, ownerThreadId)
      return { call, activity: this.recordCallActivity(call) }
    })()
  }

  resume(
    subagentId: string,
    ownerThreadId: string
  ): AgentSubagentCallTransition | undefined {
    return this.database.transaction(() => {
      this.require(subagentId, ownerThreadId)
      const updated = this.database.prepare(`
        UPDATE agent_subagent_calls
        SET status = 'running', error = NULL, updated_at = ?
        WHERE id = ?
          AND owner_thread_id = ?
          AND (
            status = 'interrupted'
            OR (status = 'running' AND error IS NOT NULL)
          )
      `).run(new Date().toISOString(), subagentId, ownerThreadId)
      if (updated.changes === 0) return undefined
      const call = this.require(subagentId, ownerThreadId)
      return { call, activity: this.recordCallActivity(call) }
    })()
  }

  recordRecoveryFailure(
    subagentId: string,
    ownerThreadId: string,
    error: string
  ): AgentSubagentCallTransition | undefined {
    requireNonEmptyText(error, 'Subagent recovery error')
    return this.database.transaction(() => {
      this.require(subagentId, ownerThreadId)
      const updated = this.database.prepare(`
        UPDATE agent_subagent_calls
        SET error = ?, updated_at = ?
        WHERE id = ?
          AND owner_thread_id = ?
          AND status IN ('running', 'interrupted')
          AND error IS NOT ?
      `).run(error, new Date().toISOString(), subagentId, ownerThreadId, error)
      if (updated.changes === 0) return undefined
      const call = this.require(subagentId, ownerThreadId)
      return { call, activity: this.recordCallActivity(call) }
    })()
  }

  resolve(
    subagentId: string,
    ownerThreadId: string,
    observingRunId: string
  ): AgentSubagentCallRecord {
    const call = this.require(subagentId, ownerThreadId)
    if (call.status === 'running' || call.status === 'interrupted') {
      throw new Error(`Subagent ${subagentId} is still ${call.status}.`)
    }
    const observingRun = this.requireRun(observingRunId)
    if (observingRun.id !== call.parentRunId) {
      throw new Error(`Run ${observingRunId} does not own subagent ${subagentId}.`)
    }
    this.database.prepare(`
      INSERT OR IGNORE INTO agent_subagent_observations (
        subagent_id, observing_run_id, observed_at
      ) VALUES (?, ?, ?)
    `).run(subagentId, observingRunId, new Date().toISOString())
    return call
  }

  settleProjectedActivities(
    subagentId: string,
    completedAt: string
  ): void {
    this.database.prepare(`
      UPDATE agent_activity_timing
      SET completed_at = COALESCE(completed_at, ?)
      WHERE EXISTS (
        SELECT 1
        FROM agent_model_activities AS model
        WHERE model.run_id = agent_activity_timing.run_id
          AND agent_activity_timing.activity_key = 'model:' || model.model_id
          AND model.subagent_id = ?
          AND model.status = 'running'
      )
    `).run(completedAt, subagentId)
    this.database.prepare(`
      UPDATE agent_model_activities
      SET status = 'completed'
      WHERE subagent_id = ? AND status = 'running'
    `).run(subagentId)

    this.database.prepare(`
      UPDATE agent_activity_timing
      SET completed_at = COALESCE(completed_at, ?)
      WHERE EXISTS (
        SELECT 1
        FROM agent_activities AS activity
        WHERE activity.run_id = agent_activity_timing.run_id
          AND activity.activity_key = agent_activity_timing.activity_key
          AND activity.kind = 'tool'
          AND activity.parent_subagent_id = ?
          AND activity.status = 'running'
      )
    `).run(completedAt, subagentId)
    this.database.prepare(`
      DELETE FROM agent_tool_approvals
      WHERE EXISTS (
        SELECT 1
        FROM agent_activities AS activity
        WHERE activity.run_id = agent_tool_approvals.run_id
          AND activity.activity_key = agent_tool_approvals.activity_key
          AND activity.kind = 'tool'
          AND activity.parent_subagent_id = ?
      )
    `).run(subagentId)
    this.database.prepare(`
      UPDATE agent_activities
      SET status = 'completed'
      WHERE kind = 'tool'
        AND parent_subagent_id = ?
        AND status = 'running'
    `).run(subagentId)
  }

}
