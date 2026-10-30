import type Database from 'better-sqlite3'
import { isAgentThreadLocked } from '../../shared/agentTypes'
import { isCompleteModelInput, lastToolResultBatch } from '../../runtime/modelRequestRecovery'
import type { AgentModelRetryInput, AgentModelRetryState, AgentRun } from '../../shared/agentTypes'
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
  threadId: string; messageId: string; revisionId: string; kind: 'truncate' | 'regenerate' | 'retry'; retryRunId?: string; withholdToolResults?: boolean;
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

  private history(threadId: string, saved = this.owner.store.readHistory(threadId)) {
    const history = saved
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

  /** Capabilities are anchored to the saved error's run, including errors before later turns. */
  modelRetries(threadId: string): AgentModelRetryState[] {
    const runs = this.database.prepare('SELECT id,status,operation FROM agent_runs WHERE thread_id=? ORDER BY sequence')
      .all(threadId) as { id: string; status: string; operation: string }[]
    if (!runs.some(run => run.status === 'failed' && run.operation === 'agent')) return []
    const head = this.owner.store.readHead(threadId)
    if (!head) return []
    const indexes = this.database.prepare('SELECT position,record_id,message_id,run_id FROM agent_message_index WHERE thread_id=? ORDER BY position')
      .all(threadId) as { position: number; record_id: string; message_id: string; run_id: string | null }[]
    const byRun = new Map<string, number[]>()
    indexes.forEach((row, index) => {
      if (row.position !== index) throw new Error('History index positions are not contiguous.')
      if (row.run_id) {
        const positions = byRun.get(row.run_id) ?? []
        positions.push(index); byRun.set(row.run_id, positions)
      }
    })
    const laterStarts: number[] = []
    let laterStart = indexes.length
    for (let index = runs.length - 1; index >= 0; index--) {
      laterStarts[index] = laterStart
      laterStart = Math.min(laterStart, byRun.get(runs[index].id)?.[0] ?? indexes.length)
    }
    const read = (index: number) => {
      const row = indexes[index], record = this.owner.store.readMessageRecord(threadId, row.record_id)
      if (record.id !== row.message_id || record.value.context?.runId !== undefined && record.value.context.runId !== row.run_id) {
        throw new Error('History message and index disagree about their identity or owning run.')
      }
      return { ...record.value, id: record.id }
    }
    // Older v1 records may lack the optional failure marker. Only that case
    // needs a complete protocol check; normal snapshots read the failure's tail.
    let unmarkedHistory: ReturnType<NativeRunOwner['store']['readHistory']>
    return runs.flatMap((run, runIndex) => {
      if (run.status !== 'failed' || run.operation !== 'agent') return []
      const positions = byRun.get(run.id), end = laterStarts[runIndex]
      if (!positions?.length || positions.at(-1)! >= end || indexes[end - 1]?.run_id !== run.id) return []
      const currentFailure = this.owner.store.currentModelFailure(threadId, run.id)
      const savedFailure = head.context.modelFailureBoundaries?.[run.id]
      const marked = savedFailure?.messageId === indexes[end - 1].message_id ? savedFailure.modelRequestFailed : undefined
      if (currentFailure === false || currentFailure === undefined && marked === false) return []
      if (!positions.some(index => read(index).kind === 'user')) return []
      if (currentFailure === undefined && marked === undefined) {
        unmarkedHistory ??= this.owner.store.readHistory(threadId)
        if (!unmarkedHistory || !isCompleteModelInput(unmarkedHistory.messages.slice(0, end).map(record => ({ ...record.value, id: record.id })))) return []
      }
      const tail = []
      for (let index = end - 1; index >= 0; index--) {
        const message = read(index)
        tail.push(message)
        if (message.kind === 'user' || message.kind === 'assistant') break
      }
      tail.reverse()
      const batch = new Set(lastToolResultBatch(tail))
      return [{ runId: run.id, revisionId: head.revisionId, requiresRollback: runIndex + 1 < runs.length,
        canWithholdToolResults: tail.some(message => batch.has(message.id) && !message.context?.resultWithheld) }]
    })
  }

  private retryPoints(threadId: string, saved = this.owner.store.readHistory(threadId)) {
    const history = this.history(threadId, saved)
    const runs = this.database.prepare('SELECT id,status,operation FROM agent_runs WHERE thread_id=? ORDER BY sequence')
      .all(threadId) as { id: string; status: string; operation: string }[]
    const order = new Map(runs.map((run, index) => [run.id, index]))
    return runs.flatMap((run, runIndex) => {
      if (run.status !== 'failed' || run.operation !== 'agent') return []
      const firstLater = history.boundaryMessages.findIndex(message => message.runId && (order.get(message.runId) ?? -1) > runIndex)
      const retainedCount = firstLater < 0 ? history.messages.length : firstLater
      const retained = history.messages.slice(0, retainedCount)
      if (!history.boundaryMessages.slice(0, retainedCount).some(message => message.runId === run.id && message.role === 'user')
        || history.boundaryMessages.slice(retainedCount).some(message => message.runId === run.id)) return []
      const messages = retained.map(record => ({ ...record.value, id: record.id })), last = messages.at(-1)
      if (!last || history.boundaryMessages[retainedCount - 1]?.runId !== run.id) return []
      const currentFailure = this.owner.store.currentModelFailure(threadId, run.id), savedFailure = history.context.modelFailureBoundaries?.[run.id]
      if (currentFailure === false || currentFailure === undefined
        && !((savedFailure?.messageId === last.id ? savedFailure.modelRequestFailed : undefined) ?? isCompleteModelInput(messages))) return []
      const fromRunId = runs[runIndex + 1]?.id
      const retry: AgentModelRetryState = { runId: run.id, revisionId: history.revisionId, requiresRollback: Boolean(fromRunId),
        canWithholdToolResults: lastToolResultBatch(messages).some(id => !messages.find(message => message.id === id)?.context?.resultWithheld) }
      return [{ retry, retainedCount, fromRunId, messageId: last.id }]
    })
  }

  prepareModelRetry(input: AgentModelRetryInput): NativeHistoryRevision | undefined {
    this.assertMutable(input.threadId)
    const history = this.owner.store.readHistory(input.threadId)
    if (history?.revisionId !== input.expectedRevisionId) throw new Error('The execution revision changed.')
    const point = this.retryPoints(input.threadId, history).find(point => point.retry.runId === input.runId)
    if (!point) throw new Error('This failure is not a retryable model request.')
    if (input.withholdToolResults && !point.retry.canWithholdToolResults) throw new Error('There are no new tool results to withhold.')
    if (!point.fromRunId) return undefined
    if (input.discardLaterMessages !== true) throw new Error('Confirm removal of later conversation content before retrying this error.')
    return { threadId: input.threadId, messageId: point.messageId, revisionId: input.expectedRevisionId,
      kind: 'retry', retryRunId: input.runId, withholdToolResults: input.withholdToolResults, retainedCount: point.retainedCount, fromRunId: point.fromRunId }
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
      const point = revision.kind === 'retry' ? this.retryPoints(revision.threadId, history).find(point => point.retry.runId === revision.retryRunId) : undefined
      const boundary = revision.kind === 'retry' ? point : historyRevisionBoundary(history.boundaryMessages, revision.messageId, revision.kind)
      if (!boundary || revision.kind === 'retry' && (point?.messageId !== revision.messageId || typeof revision.withholdToolResults !== 'boolean'
        || revision.withholdToolResults && !point?.retry.canWithholdToolResults)) throw new Error('Invalid model retry history boundary.')
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
      if (revision.kind === 'retry') {
        // History removal, saved result replacement and reattaching the failed run commit together.
        this.owner.retryModel({ threadId: revision.threadId, runId: revision.retryRunId!,
          expectedRevisionId: this.owner.store.readHistory(revision.threadId)!.revisionId, withholdToolResults: revision.withholdToolResults! })
      }
      if (!revision.replacement) return {}
      const run = this.owner.createRun({ threadId: revision.threadId, runId: revision.replacement.runId, operation: 'agent', message: revision.replacement.message })
      this.resources.restoreAttachments(plan, run.id)
      return { run }
    })()
  }
}
