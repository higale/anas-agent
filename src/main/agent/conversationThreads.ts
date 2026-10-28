import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { AgentAccessMode, AgentThread, AgentThreadCreate, AgentThreadStatus, AgentThreadUpdate } from '../../shared/agentTypes'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '../../shared/types'

export type ThreadRow = {
  id: string
  title: string
  project_id: string
  model_config_id: string | null
  model_parameter_preset_id: string | null
  pinned: number
  full_access: number
  strict_approval: number
  status: AgentThreadStatus
  user_turn_count: number
  created_at: string
  updated_at: string
}

export function defaultTitle(title?: string): string {
  const normalized = title?.replace(/\s+/g, ' ').trim()
  return normalized || 'New Thread'
}

export function accessModeColumns(accessMode: AgentAccessMode): {
  fullAccess: number
  strictApproval: number
} {
  if (
    accessMode !== 'smart_approval'
    && accessMode !== 'strict_approval'
    && accessMode !== 'full_access'
  ) throw new Error('Agent access mode is invalid.')
  return {
    fullAccess: accessMode === 'full_access' ? 1 : 0,
    strictApproval: accessMode === 'strict_approval' ? 1 : 0
  }
}

export function threadFromRow(row: ThreadRow): AgentThread {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    modelConfigId: row.model_config_id ?? undefined,
    modelParameterPresetId: row.model_parameter_preset_id ?? undefined,
    pinned: row.pinned === 1,
    accessMode: row.full_access === 1
      ? 'full_access'
      : row.strict_approval === 1
        ? 'strict_approval'
        : 'smart_approval',
    status: row.status,
    userTurnCount: row.user_turn_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function readThreadRecord(database: Database.Database, threadId: string): AgentThread | null {
  const row = database.prepare(`
    SELECT thread.id, thread.title, thread.project_id,
      thread.model_config_id, thread.model_parameter_preset_id, thread.pinned, thread.full_access,
      thread.strict_approval,
      thread.status, thread.created_at, thread.updated_at,
      (
        SELECT COUNT(*)
        FROM agent_runs run
        WHERE run.thread_id = thread.id AND run.operation = 'agent'
      ) AS user_turn_count
    FROM agent_threads thread
    WHERE thread.id = ?
  `).get(threadId) as ThreadRow | undefined
  return row ? threadFromRow(row) : null
}

export function createThreadRecord(
  database: Database.Database,
  options: AgentThreadCreate = {},
  threadId: string = randomUUID()
): AgentThread {
  const now = new Date().toISOString()
  const thread: AgentThread = {
    id: threadId,
    title: defaultTitle(options.title),
    projectId: options.projectId ?? DEFAULT_WORKSPACE_PROJECT_ID,
    modelConfigId: options.modelConfigId,
    modelParameterPresetId: options.modelParameterPresetId ?? undefined,
    pinned: false,
    accessMode: options.accessMode ?? 'smart_approval',
    status: 'idle',
    userTurnCount: 0,
    createdAt: now,
    updatedAt: now
  }
  const create = database.transaction(() => {
    database.prepare(`
      INSERT INTO agent_threads (
        id, title, project_id, model_config_id, model_parameter_preset_id,
        pinned, full_access, strict_approval,
        status, created_at, updated_at
      ) VALUES (
        @id, @title, @projectId, @modelConfigId, @modelParameterPresetId,
        0, @fullAccess, @strictApproval,
        @status, @createdAt, @updatedAt
      )
    `).run({
      ...thread,
      modelConfigId: thread.modelConfigId ?? null,
      modelParameterPresetId: thread.modelParameterPresetId ?? null,
      ...accessModeColumns(thread.accessMode)
    })
  })
  create()
  return thread
}

function requireThreadRecord(database: Database.Database, threadId: string): AgentThread {
  const thread = readThreadRecord(database, threadId)
  if (!thread) throw new Error(`Thread ${threadId} was not found.`)
  return thread
}

export function updateThreadRecord(
  database: Database.Database,
  threadId: string,
  update: AgentThreadUpdate & { status?: AgentThreadStatus }
): AgentThread {
  const existing = requireThreadRecord(database, threadId)
  if (update.modelConfigId === null && !database.prepare('SELECT 1 FROM agent_subagent_calls WHERE child_thread_id=?').get(threadId)) {
    throw new Error('A root conversation must select its own model.')
  }
  if (update.modelConfigId === null && update.modelParameterPresetId) {
    throw new Error('An inherited model selection also inherits its parameter preset.')
  }
  const next: AgentThread = {
    ...existing,
    title: update.title === undefined ? existing.title : defaultTitle(update.title),
    projectId: update.projectId ?? existing.projectId,
    modelConfigId: update.modelConfigId === undefined ? existing.modelConfigId : update.modelConfigId ?? undefined,
    modelParameterPresetId: update.modelConfigId === null ? undefined : update.modelParameterPresetId === undefined
      ? existing.modelParameterPresetId
      : update.modelParameterPresetId ?? undefined,
    pinned: update.pinned ?? existing.pinned,
    status: update.status ?? existing.status,
    updatedAt: new Date().toISOString()
  }
  database.prepare(`
    UPDATE agent_threads
    SET title = @title,
        project_id = @projectId,
        model_config_id = @modelConfigId,
        model_parameter_preset_id = @modelParameterPresetId,
        pinned = @pinned,
        full_access = @fullAccess,
        strict_approval = @strictApproval,
        status = @status,
        updated_at = @updatedAt
    WHERE id = @id
  `).run({
    ...next,
    modelConfigId: next.modelConfigId ?? null,
    modelParameterPresetId: next.modelParameterPresetId ?? null,
    pinned: next.pinned ? 1 : 0,
    ...accessModeColumns(next.accessMode)
  })
  return next
}

export function setThreadAccessMode(database: Database.Database, threadId: string, accessMode: AgentAccessMode): AgentThread {
  requireThreadRecord(database, threadId)
  const columns = accessModeColumns(accessMode)
  database.prepare(`
    UPDATE agent_threads
    SET full_access = ?, strict_approval = ?, updated_at = ?
    WHERE id = ?
  `).run(columns.fullAccess, columns.strictApproval, new Date().toISOString(), threadId)
  return requireThreadRecord(database, threadId)
}
