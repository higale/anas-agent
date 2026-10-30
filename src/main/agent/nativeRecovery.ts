import { NativeMessageProjection } from './nativeMessageProjection'
import type Database from 'better-sqlite3'
import type { NativeRunOwner } from './nativeRunOwner'
import type { ManagedCallStore } from './managedCallStore'
import { validateNativeExecutionHeads } from './nativeStorageValidation'

export interface NativeRecoverableRun {
  threadId: string
  runId: string
  command: 'input' | 'continue' | 'resume'
}

/** Explicit startup coordination, before constructing any live executor or task
 * service. It settles saved cancellation and abandoned process ownership; the
 * returned candidates are not dispatched here, including unstarted inputs. */
export function recoverNativeConversation(database: Database.Database, runs: NativeRunOwner, managed: ManagedCallStore): NativeRecoverableRun[] {
  return database.transaction(() => {
    validateNativeExecutionHeads(database)
    new NativeMessageProjection(database).reconcileToolIdentities()
    managed.recoverAbandonedCalls()
    const requested = database.prepare(`SELECT id AS runId,thread_id AS threadId FROM agent_runs
      WHERE cancellation_requested=1 AND status IN ('running','interrupted') ORDER BY rowid`)
      .all() as Array<{ threadId: string; runId: string }>
    for (const identity of requested) runs.completeCancellation(identity)

    // A terminal parent cannot supervise a live child after a restart. Work
    // through the descendant chain, preserving each child's own saved results.
    const orphaned = database.prepare(`SELECT child.id AS runId,child.thread_id AS threadId
      FROM agent_subagent_calls call JOIN agent_runs parent ON parent.id=call.parent_run_id
      JOIN agent_runs child ON child.id=call.child_run_id
      WHERE parent.status IN ('completed','cancelled','failed') AND child.status IN ('running','interrupted')
      ORDER BY call.rowid`)
    while (true) {
      const children = orphaned.all() as Array<{ threadId: string; runId: string }>
      if (!children.length) break
      for (const identity of children) { runs.requestCancellation(identity); runs.completeCancellation(identity) }
    }
    const children = database.prepare("SELECT id,owner_thread_id FROM agent_subagent_calls WHERE status IN ('running','interrupted') ORDER BY rowid")
      .all() as Array<{ id: string; owner_thread_id: string }>
    for (const child of children) runs.reconcileSubagent(child.id, child.owner_thread_id)

    const active = database.prepare("SELECT id,thread_id,status FROM agent_runs WHERE status IN ('running','interrupted') ORDER BY rowid")
      .all() as Array<{ id: string; thread_id: string; status: string }>
    const recoverable: NativeRecoverableRun[] = []
    for (const run of active) {
      const state = runs.store.readHead(run.thread_id)
      const pending = Boolean(database.prepare('SELECT 1 FROM agent_run_input_intents WHERE run_id=?').get(run.id))
      if (pending) {
        if (run.status !== 'running' || state?.runId === run.id) throw new Error('Pending input has inconsistent execution ownership.')
      } else {
        if (state?.runId !== run.id) throw new Error('Active run has neither saved input nor its own execution.')
        const expected = ['waiting', 'waiting_context'].includes(state.phase) ? 'interrupted'
          : ['completed', 'cancelled', 'failed'].includes(state.phase) ? state.phase : 'running'
        if (run.status !== expected) throw new Error('Active run and native execution disagree about their status.')
      }
      const answered = Boolean(database.prepare('SELECT 1 FROM agent_run_resume_intents WHERE run_id=?').get(run.id))
      if (run.status === 'running' || answered) recoverable.push({ threadId: run.thread_id, runId: run.id,
        command: pending ? 'input' : answered ? 'resume' : 'continue' })
    }
    validateNativeExecutionHeads(database)
    return recoverable
  })()
}
