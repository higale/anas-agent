import type Database from 'better-sqlite3'
import type { AgentThread } from '../../shared/agentTypes'
import { readThreadRecord } from './conversationThreads'
import { deleteProjectMemoryRecords } from './memoryStore'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '../../shared/types'

/** Finish the already committed project deletion using only shared catalog
 * records. Both live storage and staged format conversion use this boundary. */
export function completeProjectCatalogDeletion(catalog: Database.Database, projectId: string): void {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('Project ID must be non-empty text.')
  catalog.transaction(() => {
    if (catalog.prepare('SELECT 1 FROM agent_conversations WHERE project_id = ? LIMIT 1').get(projectId)) {
      throw new Error('Cannot complete project deletion while project conversations still exist.')
    }
    deleteProjectMemoryRecords(catalog, projectId)
    catalog.prepare(`UPDATE agent_workspace_state SET draft_project_id = ?, draft_model_config_id = NULL,
      draft_model_parameter_preset_id = NULL WHERE draft_project_id = ?`).run(DEFAULT_WORKSPACE_PROJECT_ID, projectId)
  })()
}

export interface ConversationCatalogSnapshot {
  thread: AgentThread
  threadIds: string[]
  runs: Array<{ id: string; threadId: string; submissionId?: string }>
  hasQueuedInputs: boolean
}

/** Read business rows only; independent of the execution storage format. */
export function readConversationCatalogSnapshot(database: Database.Database, ownerThreadId: string): ConversationCatalogSnapshot | undefined {
  return database.transaction(() => {
    const thread = readThreadRecord(database, ownerThreadId)
    if (!thread) return undefined
    return { thread,
      threadIds: (database.prepare('SELECT id FROM agent_threads').all() as Array<{ id: string }>).map(row => row.id),
      runs: (database.prepare('SELECT id,thread_id,submission_id FROM agent_runs').all() as Array<{ id: string; thread_id: string; submission_id: string | null }>)
        .map(row => ({ id: row.id, threadId: row.thread_id, ...(row.submission_id === null ? {} : { submissionId: row.submission_id }) })),
      hasQueuedInputs: Boolean(database.prepare('SELECT 1 FROM agent_queued_inputs LIMIT 1').get()) }
  })()
}

/** The conversation owns its state. The catalog is its atomic sidebar and
 * lookup projection, shared by live refresh and unpublished conversion. */
export function writeConversationCatalogSnapshot(catalog: Database.Database, snapshot: ConversationCatalogSnapshot): void {
  const { thread, threadIds, runs } = snapshot, ownerThreadId = thread.id
  catalog.transaction(() => {
    catalog.prepare(`
      INSERT INTO agent_conversations VALUES (@id, @title, @projectId, @modelConfigId, @modelParameterPresetId,
        @pinned, @accessMode, @status, @userTurnCount, @queued, @createdAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, project_id=excluded.project_id,
        model_config_id=excluded.model_config_id, model_parameter_preset_id=excluded.model_parameter_preset_id,
        pinned=excluded.pinned, access_mode=excluded.access_mode, status=excluded.status,
        user_turn_count=excluded.user_turn_count, has_queued_inputs=excluded.has_queued_inputs,
        updated_at=excluded.updated_at
    `).run({ ...thread, modelConfigId: thread.modelConfigId ?? null,
      modelParameterPresetId: thread.modelParameterPresetId ?? null, pinned: Number(thread.pinned),
      queued: Number(snapshot.hasQueuedInputs) })
    const localThreads = new Set(threadIds)
    for (const row of catalog.prepare('SELECT thread_id FROM agent_thread_locations WHERE owner_thread_id = ?').all(ownerThreadId) as Array<{ thread_id: string }>) {
      if (!localThreads.has(row.thread_id)) catalog.prepare('DELETE FROM agent_thread_locations WHERE thread_id = ?').run(row.thread_id)
    }
    const insertThread = catalog.prepare('INSERT OR IGNORE INTO agent_thread_locations VALUES (?, ?)')
    for (const id of threadIds) {
      const existing = (catalog.prepare('SELECT owner_thread_id FROM agent_thread_locations WHERE thread_id=?').get(id) as { owner_thread_id: string } | undefined)?.owner_thread_id
      if (existing && existing !== ownerThreadId) throw new Error(`Thread ${id} already belongs to another conversation.`)
      insertThread.run(id, ownerThreadId)
    }
    const localRuns = new Set(runs.map(({ id }) => id))
    for (const row of catalog.prepare('SELECT run_id FROM agent_run_locations WHERE owner_thread_id = ?').all(ownerThreadId) as Array<{ run_id: string }>) {
      if (!localRuns.has(row.run_id)) catalog.prepare('DELETE FROM agent_run_locations WHERE run_id = ?').run(row.run_id)
    }
    const insertRun = catalog.prepare(`
      INSERT INTO agent_run_locations VALUES (@id, @threadId, @ownerThreadId, @submissionId)
      ON CONFLICT(run_id) DO UPDATE SET submission_id=excluded.submission_id
      WHERE agent_run_locations.owner_thread_id = excluded.owner_thread_id
        AND agent_run_locations.thread_id = excluded.thread_id
        AND agent_run_locations.submission_id IS NOT excluded.submission_id
    `)
    const runLocation = catalog.prepare('SELECT owner_thread_id, thread_id FROM agent_run_locations WHERE run_id = ?')
    for (const run of runs) {
      const existing = runLocation.get(run.id) as { owner_thread_id: string; thread_id: string } | undefined
      if (existing && (existing.owner_thread_id !== ownerThreadId || existing.thread_id !== run.threadId)) {
        throw new Error(`Run ${run.id} already belongs to another conversation.`)
      }
      insertRun.run({ ...run, ownerThreadId, submissionId: run.submissionId ?? null })
    }
  })()
}
