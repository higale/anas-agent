import type Database from 'better-sqlite3'
import { isAgentThreadLocked } from '../../shared/agentTypes'
import type { AgentRun } from '../../shared/agentTypes'
import { historyRevisionBoundary, regenerationContent } from '../../runtime/historyRevision'
import type { ExecutionMessageInput } from '../../runtime/executionState'
import { conversationMessageRecordId, encodeConversationMessage } from '../../runtime/conversationStorage'
import { readThreadRecord } from './conversationThreads'
import { presentConversationMessage } from './conversationPresentation'
import { AgentThreadLockedError } from './agentErrors'
import { HistoryRevisionResources } from './historyRevisionResources'
import { handoffUnacceptedNativeFileEdits } from './nativeFileEditCleanup'
import { collectNativeMessageBodies } from './nativeMessageCleanup'
import type { NativeRunOwner } from './nativeRunOwner'

export interface NativeHistoryRevision {
  threadId: string; messageId: string; revisionId: string; kind: 'truncate' | 'regenerate';
  retainedCount: number; fromRunId: string; replacement?: { runId: string; message: ExecutionMessageInput }
}

/** The caller stops and drains affected tasks before commit, as in the existing
 * product history flow. This service never executes tools or removes files. */
export class NativeHistoryOwner {
  private readonly resources: HistoryRevisionResources
  constructor(private readonly database: Database.Database, private readonly owner: NativeRunOwner) {
    this.resources = new HistoryRevisionResources(database)
  }

  affectedRunIds(revision: NativeHistoryRevision): string[] {
    if (this.history(revision.threadId).revisionId !== revision.revisionId) throw new Error('Conversation history changed before its tasks could be stopped.')
    return this.resources.runIdsFrom(revision.threadId, revision.fromRunId)
  }

  private assertMutable(threadId: string): void {
    const thread = readThreadRecord(this.database, threadId)
    if (!thread) throw new Error(`Thread ${threadId} was not found.`)
    if (isAgentThreadLocked(thread.status)) throw new AgentThreadLockedError(threadId, 'change its messages')
  }

  private history(threadId: string) {
    const history = this.owner.store.readHistory(threadId)
    if (!history) throw new Error('Conversation has no saved history.')
    const indexes = this.database.prepare('SELECT position,record_id,run_id FROM agent_message_index WHERE thread_id=? ORDER BY position')
      .all(threadId) as { position: number; record_id: string; run_id: string | null }[]
    if (indexes.length !== history.messages.length || indexes.some((row, index) => row.position !== index || row.record_id !== history.messages[index].recordId)) {
      throw new Error('History index does not match the current conversation.')
    }
    const messages = history.messages.map((record, index) => {
      const bodyRunId = record.value.context?.runId, indexRunId = indexes[index].run_id
      if (typeof bodyRunId === 'string' && indexRunId !== null && bodyRunId !== indexRunId) {
        throw new Error('History message and index disagree about their owning run.')
      }
      return { id: record.id,
        role: record.value.kind === 'user' || record.value.kind === 'assistant' || record.value.kind === 'tool' ? record.value.kind : 'other' as const,
        runId: typeof bodyRunId === 'string' ? bodyRunId : indexRunId ?? undefined }
    })
    return { ...history, boundaryMessages: messages }
  }

  prepare(input: { threadId: string; messageId: string } & ({ kind: 'truncate' } | { kind: 'regenerate'; runId: string; skillPromptText?: string })): NativeHistoryRevision {
    return this.database.transaction(() => {
      this.assertMutable(input.threadId)
      const history = this.history(input.threadId), boundary = historyRevisionBoundary(history.boundaryMessages, input.messageId, input.kind)
      const revision: NativeHistoryRevision = { threadId: input.threadId, messageId: input.messageId, kind: input.kind,
        revisionId: history.revisionId, retainedCount: boundary.retainedCount, fromRunId: boundary.fromRunId }
      if (input.kind === 'regenerate') {
        const original = history.messages[boundary.targetIndex], message = original.value
        const content = regenerationContent(message.content as string | Record<string, unknown>[],
          Boolean(presentConversationMessage(message, original.id).skillInvocation), input.skillPromptText)
        revision.replacement = { runId: input.runId, message: { id: original.id,
          value: { ...message, id: original.id, content, context: { ...message.context, runId: input.runId, createdAt: new Date().toISOString() } } } }
      }
      return revision
    })()
  }

  commit(revision: NativeHistoryRevision): { run?: AgentRun } {
    return this.database.transaction(() => {
      this.assertMutable(revision.threadId)
      const history = this.history(revision.threadId)
      if (history.revisionId !== revision.revisionId) throw new Error('Conversation history changed before the revision could be committed.')
      const boundary = historyRevisionBoundary(history.boundaryMessages, revision.messageId, revision.kind)
      if (boundary.retainedCount !== revision.retainedCount || boundary.fromRunId !== revision.fromRunId
        || (revision.kind === 'regenerate') !== Boolean(revision.replacement)
        || revision.replacement && revision.replacement.message.id !== revision.messageId) throw new Error('Invalid conversation history revision boundary.')
      const plan = this.resources.prepare(revision.threadId, revision.fromRunId, revision.retainedCount, revision.replacement?.message.id)
      const removedRunIds = [...plan.runIds, ...plan.children.map(child => child.runId)], ids = JSON.stringify(removedRunIds)
      if (this.database.prepare("SELECT 1 FROM agent_runs WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('running','interrupted')").get(ids)
        || this.database.prepare("SELECT 1 FROM agent_managed_calls WHERE run_id IN (SELECT value FROM json_each(?)) AND status IN ('preparing','running')").get(ids)
        || this.database.prepare("SELECT 1 FROM agent_subagent_calls WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('running','interrupted')")
          .get(JSON.stringify(plan.children.map(child => child.id)))) {
        throw new Error('Affected tasks must be stopped before changing history.')
      }
      for (const child of plan.children) {
        const state = this.owner.store.load(child.threadId)
        if (state && !['completed', 'cancelled', 'failed'].includes(state.phase)) throw new Error('Child execution must be stopped before changing history.')
      }
      let summary
      if (plan.summary) {
        if (!plan.summary.committed_checkpoint_id) throw new Error('History summary has no durable confirmation.')
        // The original history operation rebuilds its selected summary from
        // the confirmed row, rather than retaining a later active summary.
        const id = plan.summary.summary_id, value = { kind: 'user' as const, content: plan.summary.model_content, context: { summary: true, summaryId: id } }
        const bytes = encodeConversationMessage(value), recordId = conversationMessageRecordId(id, bytes)
        this.database.prepare('INSERT OR IGNORE INTO execution_message_bodies(thread_id,record_id,message_id,value) VALUES (?,?,?,?)')
          .run(revision.threadId, recordId, id, bytes)
        summary = { id, messageRecordId: recordId, cutoffIndex: plan.summary.cutoff_index! }
      }
      for (const runId of plan.runIds) handoffUnacceptedNativeFileEdits(this.database, revision.threadId, runId)
      this.owner.store.reviseHistory({ threadId: revision.threadId, expectedRevisionId: revision.revisionId, retainedCount: revision.retainedCount, summary })
      for (const child of plan.children) {
        handoffUnacceptedNativeFileEdits(this.database, child.threadId, child.runId)
        this.database.prepare('INSERT OR IGNORE INTO agent_file_edit_cleanup_outbox(run_id) VALUES (?)').run(child.runId)
        this.database.prepare('DELETE FROM execution_effects WHERE thread_id=?').run(child.threadId)
        this.database.prepare('DELETE FROM execution_state WHERE thread_id=?').run(child.threadId)
      }
      this.database.prepare('DELETE FROM execution_effects WHERE run_id IN (SELECT value FROM json_each(?))').run(ids)
      this.database.prepare('DELETE FROM agent_message_index WHERE thread_id=? AND position>=?').run(revision.threadId, revision.retainedCount)
      this.resources.remove(plan)
      for (const threadId of [revision.threadId, ...plan.children.map(child => child.threadId)]) collectNativeMessageBodies(this.database, threadId)
      if (!revision.replacement) return {}
      const run = this.owner.createRun({ threadId: revision.threadId, runId: revision.replacement.runId, operation: 'agent', message: revision.replacement.message })
      this.resources.restoreAttachments(plan, run.id)
      return { run }
    })()
  }
}
