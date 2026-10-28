import type Database from 'better-sqlite3'
import type { AgentBackgroundCleanup } from '../../shared/backgroundCleanup'
import type { ManagedCallStore, AgentManagedCallRecord } from './managedCallStore'
import type { ConversationResourceAccess } from './conversationResourceReader'
import { subagentCallFromRow, type SubagentCallRow, type AgentSubagentCallRecord } from './subagentTaskStore'

/** Durable ownership of background cleanup, independent of the execution format.
 * Handoff removes tasks from model supervision without claiming they stopped. */
export class BackgroundTaskStore {
  constructor(private readonly database: Database.Database,
    private readonly managed: ManagedCallStore,
    private readonly resources: Pick<ConversationResourceAccess, 'getThread' | 'hasUnresolvedManagedCallsForThread' | 'listUnresolvedSubagentCallsForRun'>,
    private readonly changed: () => void = () => {}) {}

  private requireRun(runId: string) {
    const run = this.database.prepare('SELECT thread_id AS threadId FROM agent_runs WHERE id=?').get(runId) as { threadId: string } | undefined
    if (!run) throw new Error(`Run ${runId} was not found.`)
    return run
  }

  getManagedCall(callId: string, threadId: string) { return this.managed.getManagedCall(callId, threadId) }
  hasUnresolvedManagedCallsForThread(threadId: string) { return this.resources.hasUnresolvedManagedCallsForThread(threadId) }
  listUnresolvedSubagentCallsForRun(runId: string, limit?: number) { return this.resources.listUnresolvedSubagentCallsForRun(runId, limit) }

  updateRunBackgroundCleanup(runId: string, cleanup: AgentBackgroundCleanup): void {
    this.requireRun(runId)
    this.database.prepare(`INSERT INTO agent_run_background_cleanup (run_id, status, report) VALUES (?, ?, ?)
      ON CONFLICT(run_id) DO UPDATE SET status = excluded.status, report = excluded.report`)
      .run(runId, cleanup.status, cleanup.report)
    this.changed()
  }

  listDescendantSubagentCalls(threadId: string, rootRunIds?: readonly string[]): AgentSubagentCallRecord[] {
    if (!this.resources.getThread(threadId)) throw new Error(`Thread ${threadId} was not found.`)
    const runs = rootRunIds ? JSON.stringify(rootRunIds) : null
    const rows = this.database.prepare(`
      WITH RECURSIVE descendants(id, child_thread_id) AS (
        SELECT id, child_thread_id FROM agent_subagent_calls
        WHERE parent_thread_id = ?
          AND (? IS NULL OR parent_run_id IN (SELECT value FROM json_each(?)))
        UNION
        SELECT call.id, call.child_thread_id FROM agent_subagent_calls call
        JOIN descendants ON call.parent_thread_id = descendants.child_thread_id
      )
      SELECT call.* FROM agent_subagent_calls call
      JOIN descendants ON call.id = descendants.id
      ORDER BY call.created_at ASC, call.id ASC
    `).all(threadId, runs, runs) as SubagentCallRow[]
    return rows.map(subagentCallFromRow)
  }

  handoffBackgroundTasksToCleanup(cleanupRunId: string): {
    calls: AgentManagedCallRecord[]
    subagents: AgentSubagentCallRecord[]
  } {
    const run = this.requireRun(cleanupRunId)
    return this.database.transaction(() => {
      const descendants = this.listDescendantSubagentCalls(run.threadId)
      const threadIds = [run.threadId, ...descendants.map((call) => call.childThreadId)]
      const calls = threadIds.flatMap((id) => this.managed.listUnresolvedManagedCallsForThread(id))
      const subagents = [...new Set(descendants.map((call) => call.parentRunId))]
        .flatMap((id) => this.resources.listUnresolvedSubagentCallsForRun(id))
      const now = new Date().toISOString()
      const markCall = this.database.prepare('INSERT OR IGNORE INTO agent_managed_call_cleanup VALUES (?, ?, ?)')
      const markSubagent = this.database.prepare('INSERT OR IGNORE INTO agent_subagent_cleanup VALUES (?, ?, ?)')
      for (const call of calls) markCall.run(call.id, cleanupRunId, now)
      for (const call of subagents) markSubagent.run(call.id, cleanupRunId, now)
      this.changed()
      return { calls, subagents }
    })()
  }

}
