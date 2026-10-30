import { requireObjectToolCall } from '../../runtime/toolInput'
import { collectNativeMessageBodies } from './nativeMessageCleanup'
import { handoffNativeFileEdits } from './nativeFileEditCleanup'
import type Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import type { RunExecutionCommand } from '../../runtime/runExecution'
import type { ExecutionCommitScope, ExecutionMessageInput, ExecutionState } from '../../runtime/executionState'
import { encodeConversationMessage } from '../../runtime/conversationStorage'
import { encodeExecutionInput, decodeExecutionInput } from '../../runtime/executionInput'
import { NativeExecutionStore, type NativeExecutionCommit } from './nativeExecutionStore'
import { resolveConversationToolApprovals } from './conversationToolPreparation'
import { resolveConversationToolWaits } from './conversationToolExecution'
import { resolveToolApprovals } from '../../runtime/toolApproval'
import { toolEffectRecoveryDecision } from '../../runtime/toolEffects'
import { conversationSubagentDecisions } from './conversationSubagentApproval'
import { conversationInterrupts } from '../../runtime/conversationApprovals'
import { matchApprovalResponses } from '../../runtime/approvalRecovery'
import { userMessageContent, traceText } from '../../runtime/messagePresentation'
import type { AgentModelRetryInput, AgentResumeInput, AgentRun, AgentThreadCreate } from '../../shared/agentTypes'
import type { ArchivedAgentAttachment } from './agentAttachmentStore'
import { RunSubmissionStore } from './runSubmissionStore'
import { createThreadRecord, readThreadRecord } from './conversationThreads'
import { SubagentTaskStore, type SubagentSubmission } from './subagentTaskStore'
import { presentConversationMessage } from './conversationPresentation'
import type { RunConfiguration } from '../../shared/agentCapabilities'

interface RunOwner { threadId: string; runId: string }
interface RunRow { id: string; thread_id: string; status: string; operation: string; error: string | null; cancellation_requested: number }
interface Answer { id: string; generation: string; response: unknown }
interface QueuedRow { id: string; thread_id: string; text: string; display_text: string; status: string; created_at: string }
/** Installed during native database creation, alongside native execution. */
export const nativeRunOwnerSchema = `
  CREATE TABLE execution_queued_directions (
    queued_input_id TEXT PRIMARY KEY REFERENCES agent_queued_inputs(id) ON DELETE CASCADE,
    thread_id TEXT NOT NULL, run_id TEXT NOT NULL,
    FOREIGN KEY (run_id,thread_id) REFERENCES agent_runs(id,thread_id) ON DELETE CASCADE
  );
`
function direction(row: QueuedRow, runId: string, afterCallIds: string[]): ExecutionMessageInput {
  const id = `${runId}:direction:${row.id}`
  return { id, value: { id, kind: 'user', content: userMessageContent(row.text.trim()),
    context: { runId, createdAt: row.created_at, displayText: row.display_text.trim(), directionAfterCallIds: afterCallIds } } }
}
function contextDecision(response: unknown): 'approve' | 'reject' {
  const decisions = (response as { decisions?: { type?: unknown; message?: unknown }[] } | undefined)?.decisions
  if (!Array.isArray(decisions) || decisions.length !== 1 || decisions[0]?.type !== 'approve' && decisions[0]?.type !== 'reject'
    || decisions[0].message !== undefined && typeof decisions[0].message !== 'string') throw new Error('Invalid context read answer.')
  return decisions[0].type
}

function validateInput(runId: string, operation: string, message?: ExecutionMessageInput): void {
  if ((operation === 'compression') !== (message === undefined)) throw new Error('The input does not match the run operation.')
  if (message && (!message.id || message.value.kind !== 'user' || message.value.partial
    || message.value.id !== message.id || message.value.context?.runId !== runId)) throw new Error('A run input requires its complete owned user message.')
}

/** Native input and lifecycle owner. It uses the same
 * SQLite connection as the execution store: accepting input or a saved answer
 * cannot commit separately from the resulting execution facts. Not activated
 * by construction of the current product database. */
export class NativeRunOwner {
  readonly store: NativeExecutionStore
  readonly subagents: SubagentTaskStore
  private readonly submissions: RunSubmissionStore
  constructor(private readonly database: Database.Database, committed?: (commit: NativeExecutionCommit) => void,
    private readonly changed: () => void = () => {}) {
    this.submissions = new RunSubmissionStore(database)
    this.subagents = new SubagentTaskStore(database)
    this.store = new NativeExecutionStore(database, commit => {
      this.commit(commit)
      committed?.(commit)
    }, effect => Boolean(database.prepare(`SELECT 1 FROM agent_managed_calls WHERE id=? AND thread_id=? AND run_id=?
      AND detached_at IS NOT NULL AND status IN ('preparing','running')`).get(effect.artifacts['managed-call'], effect.threadId, effect.runId)))
  }

  /** Submission preserves the product's lock, deduplication and attachment
   * semantics. No execution starts until the saved input is accepted. */
  createRun(input: RunOwner & { operation: AgentRun['operation']; message?: ExecutionMessageInput;
    attachments?: ArchivedAgentAttachment[]; submissionId?: string }): AgentRun {
    this.changed()
    return this.database.transaction(() => {
      validateInput(input.runId, input.operation, input.message)
      const state = this.store.load(input.threadId)
      if (state && !['completed', 'cancelled', 'failed'].includes(state.phase)) throw new Error('The conversation still has an active execution.')
      if (input.attachments?.some(({ artifact }) => artifact.messageId !== input.message?.id)) {
        throw new Error('Initial attachments do not belong to the submitted message.')
      }
      return this.submissions.createRun(input.threadId, input.runId, input.operation,
        input.attachments, encodeExecutionInput(input.message), input.submissionId)
    })()
  }

  getRunConfiguration(owner: RunOwner): RunConfiguration | undefined {
    this.requireRun(owner)
    return this.submissions.getRunConfiguration(owner.runId)
  }

  /** The original user input is read from its saved intent before acceptance,
   * then from the owned history after acceptance, including regenerated inputs. */
  readRunInput(owner: RunOwner): ExecutionMessageInput | undefined {
    const run = this.requireRun(owner)
    const intent = this.database.prepare('SELECT input_json FROM agent_run_input_intents WHERE run_id=?').get(owner.runId) as { input_json: string } | undefined
    let message = intent ? decodeExecutionInput(intent.input_json) : undefined
    if (run.operation === 'compression') return undefined
    if (!intent) {
      const rows = this.database.prepare('SELECT record_id FROM agent_message_index WHERE thread_id=? AND run_id=? ORDER BY position')
        .all(owner.threadId, owner.runId) as { record_id: string }[]
      for (const row of rows) {
        const record = this.store.readMessageRecord(owner.threadId, row.record_id)
        if (record.value.kind === 'user' && record.value.context?.runId === owner.runId) { message = record; break }
      }
    }
    if (!message) throw new Error('The run has no saved user input in its owned history.')
    validateInput(owner.runId, run.operation, message)
    return { id: message.id, value: message.value }
  }

  resolveRunConfiguration(owner: RunOwner, value: RunConfiguration): void {
    this.requireRun(owner)
    this.submissions.resolveRunConfiguration(owner.runId, value)
  }

  createThreadAndRun(input: RunOwner & { thread: AgentThreadCreate; message: ExecutionMessageInput;
    attachments?: ArchivedAgentAttachment[]; submissionId: string }) {
    if (!input.submissionId) throw new Error('A new thread run requires a submission ID.')
    return this.database.transaction(() => {
      this.createThread(input.thread, input.threadId)
      const run = this.createRun({ ...input, operation: 'agent' })
      const thread = readThreadRecord(this.database, input.threadId)
      if (!thread) throw new Error(`Thread ${input.threadId} was not created.`)
      return { thread, run }
    })()
  }

  createThread(options: AgentThreadCreate = {}, threadId: string = randomUUID()) {
    this.changed()
    return this.database.transaction(() => {
      const thread = createThreadRecord(this.database, options, threadId)
      this.store.installHistory({ threadId, revisionId: randomUUID(), messages: [] })
      return thread
    })()
  }

  /** Persist before aborting live operations. The host still drains every
   * entered operation before completeCancellation; this does not stop processes. */
  requestCancellation(owner: RunOwner, armEffect?: () => void): boolean {
    return this.database.transaction(() => {
      const run = this.requireRun(owner)
      if (!['running', 'interrupted'].includes(run.status)) return false
      armEffect?.()
      this.database.prepare('UPDATE agent_runs SET cancellation_requested=1,updated_at=? WHERE id=?')
        .run(new Date().toISOString(), run.id)
      return true
    })()
  }

  /** Called only after live work has drained, or at startup before dispatch.
   * A never-accepted input is discarded without manufacturing visible history. */
  completeCancellation(owner: RunOwner): boolean {
    this.changed()
    return this.database.transaction(() => {
      const run = this.requireRun(owner)
      if (!['running', 'interrupted'].includes(run.status)) return false
      if (!run.cancellation_requested) throw new Error('Cancellation requires its saved request.')
      const state = this.store.load(owner.threadId)
      if (state?.runId === run.id) {
        this.store.finish({ ...owner, expectedRevisionId: state.revisionId }, 'cancelled')
      } else {
        if (this.database.prepare('DELETE FROM agent_run_input_intents WHERE run_id=?').run(run.id).changes !== 1) {
          throw new Error('Unaccepted cancellation requires its saved input.')
        }
        const time = new Date().toISOString()
        this.database.prepare("UPDATE agent_runs SET status='cancelled',error=NULL,updated_at=? WHERE id=?").run(time, run.id)
        this.database.prepare("UPDATE agent_threads SET status='idle',updated_at=? WHERE id=?").run(time, owner.threadId)
        this.database.prepare('INSERT OR IGNORE INTO agent_file_edit_cleanup_outbox(run_id) VALUES (?)').run(run.id)
      }
      return true
    })()
  }

  /** The task record, hidden conversation, durable input and effect intent
   * share one transaction. Creating a task does not start its executor. */
  createSubagentCall(input: SubagentSubmission, armEffect?: () => void) {
    this.changed()
    const id = `${input.childRunId}:input`
    const message: ExecutionMessageInput = { id, value: { id, kind: 'user', content: userMessageContent(input.description),
      context: { runId: input.childRunId, createdAt: new Date().toISOString() } } }
    return this.database.transaction(() => {
      const call = this.subagents.create(input, encodeExecutionInput(message), armEffect)
      this.store.installHistory({ threadId: call.childThreadId, revisionId: randomUUID(), messages: [] })
      return call
    })()
  }

  /** Reconcile after the caller has drained the child executor and forwarding
   * task. A visible activity or a parent result cannot complete a child. */
  reconcileSubagent(subagentId: string, ownerThreadId: string) {
    return this.database.transaction(() => {
      const call = this.subagents.require(subagentId, ownerThreadId)
      if (call.status !== 'running' && call.status !== 'interrupted') return undefined
      const run = this.requireRun({ threadId: call.childThreadId, runId: call.childRunId })
      const head = this.database.prepare('SELECT run_id,phase FROM execution_state WHERE thread_id=?').get(call.childThreadId) as { run_id: string | null; phase: string } | undefined
      if (head?.run_id === null && head.phase === 'idle' && run.status === 'cancelled' && run.cancellation_requested
        && !this.database.prepare('SELECT 1 FROM agent_run_input_intents WHERE run_id=?').get(run.id)) {
        return this.subagents.finish({ subagentId: call.id, ownerThreadId: call.ownerThreadId, status: 'cancelled' })
      }
      if ((!head || head.run_id === null && head.phase === 'idle') && run.status === 'running'
        && this.database.prepare('SELECT 1 FROM agent_run_input_intents WHERE run_id=?').get(run.id)) {
        return call.status === 'running' ? undefined : this.subagents.resume(call.id, call.ownerThreadId)
      }
      if (!head || head.run_id !== run.id) throw new Error('The child task does not own its native execution.')
      const status = head.phase === 'completed' || head.phase === 'cancelled' || head.phase === 'failed' ? head.phase
        : ['waiting', 'waiting_context'].includes(head.phase) ? 'interrupted' : 'running'
      if (run.status !== status) throw new Error('The child run and execution disagree about their status.')
      if (status === 'running') return call.status === 'running' ? undefined : this.subagents.resume(call.id, call.ownerThreadId)
      if (status === 'interrupted') return this.subagents.interrupt(call.id, call.ownerThreadId)
      let result: string | undefined
      if (status === 'completed') {
        try {
          const state = this.store.load(call.childThreadId)!
          const final = state.messages.filter(message => message.value.kind === 'assistant' && !message.value.calls?.length).at(-1)
          result = final ? traceText(presentConversationMessage(final.value, final.id).content, 'text') : ''
        } catch (reason) {
          return this.subagents.recordRecoveryFailure(call.id, call.ownerThreadId,
            `Subagent completed, but its final result could not be read: ${reason instanceof Error ? reason.message : String(reason)}`)
        }
      }
      return this.subagents.finish({ subagentId: call.id, ownerThreadId: call.ownerThreadId,
        status, result,
        ...(status === 'failed' ? { error: run.error ?? 'Subagent run failed.' } : {}) })
    })()
  }

  /** The caller creates the run and saves this already prepared input in its
   * submission transaction. Regeneration supplies the revised user message;
   * no framework message class or history-edit policy is interpreted here. */
  saveInput(owner: RunOwner, message?: ExecutionMessageInput): void {
    this.database.transaction(() => {
      const run = this.requireRun(owner), state = this.store.load(owner.threadId)
      if (run.status !== 'running' || state?.runId === owner.runId) throw new Error('This run can no longer accept a new input intent.')
      validateInput(owner.runId, run.operation, message)
      const serialized = encodeExecutionInput(message)
      const existing = this.database.prepare('SELECT input_json FROM agent_run_input_intents WHERE run_id=?').get(owner.runId) as { input_json: string } | undefined
      if (existing && existing.input_json !== serialized) throw new Error('The run already owns a different saved input.')
      this.database.prepare('INSERT OR IGNORE INTO agent_run_input_intents(run_id,input_json) VALUES (?,?)').run(owner.runId, serialized)
    })()
  }

  readInterrupts(owner: RunOwner) {
    return this.database.transaction(() => {
      this.requireRun(owner)
      const state = this.store.readHead(owner.threadId)
      return state?.runId === owner.runId && state.phase !== 'idle'
        ? conversationInterrupts({ ...state, runId: owner.runId, phase: state.phase }) : []
    })()
  }

  /** Existing renderer/child responses keep their complete-set contract. The
   * durable per-request generations are resolved only inside this transaction. */
  saveResponses(input: AgentResumeInput): void {
    this.database.transaction(() => {
      this.requireRun(input)
      const state = this.store.load(input.threadId)
      if (!state || state.runId !== input.runId) throw new Error('This run has no current execution.')
      const responses = matchApprovalResponses(conversationInterrupts(state), input.responses.map(response => ({
        interruptId: response.interruptId, expectedGeneration: response.expectedGeneration, response: { decisions: response.decisions }
      })))
      this.saveAnswers({ ...input, expectedRevisionId: state.revisionId }, responses.map(response => ({ id: response.interruptId,
        generation: state.approvals.find(approval => approval.id === response.interruptId)!.generation, response: response.response })))
    })()
  }

  saveAnswers(scope: ExecutionCommitScope, answers: readonly Answer[]): void {
    this.database.transaction(() => {
      this.requireRun(scope)
      const state = this.store.load(scope.threadId)
      if (!state || state.runId !== scope.runId || state.revisionId !== scope.expectedRevisionId
        || !['waiting', 'waiting_context'].includes(state.phase) || !answers.length || answers.length > state.approvals.length
        || answers.length !== state.approvals.length && state.approvals.some(approval => approval.kind !== 'effect_recovery' && approval.kind !== 'subagent')
        || new Set(answers.map(answer => answer.id)).size !== answers.length) throw new Error('The saved answers do not match the waiting execution.')
      for (const answer of answers) {
        const approval = state.approvals.find(approval => approval.id === answer.id)
        if (!approval || approval.generation !== answer.generation) throw new Error('The approval generation changed.')
        if (approval.kind === 'context_read') contextDecision(answer.response)
        else if (approval.kind === 'subagent') conversationSubagentDecisions(approval, answer.response)
        else if (approval.kind === 'effect_recovery') toolEffectRecoveryDecision(answer.response)
        else resolveToolApprovals(state.calls, approval.callIds.map((id, index) => {
          const call = state.calls.find(call => call.id === id && !call.result)
          if (!call) throw new Error('Approval no longer belongs to an unanswered call.')
          return { call: requireObjectToolCall(call), policy: { allowedDecisions: approval.request.reviewConfigs[index].allowedDecisions } }
        }), new Set(state.calls.filter(call => call.result).map(call => call.id)), answer.response)
        const serialized = JSON.stringify({ generation: answer.generation, response: answer.response })
        const existing = this.database.prepare('SELECT response_json FROM agent_run_resume_intents WHERE run_id=? AND interrupt_id=?')
          .get(scope.runId, answer.id) as { response_json: string } | undefined
        if (existing && existing.response_json !== serialized) throw new Error('This approval already owns a different saved answer.')
        this.database.prepare('INSERT OR IGNORE INTO agent_run_resume_intents(run_id,interrupt_id,response_json) VALUES (?,?,?)')
          .run(scope.runId, answer.id, serialized)
      }
    })()
  }

  /** Explicitly bind a queued item to this active run. Unselected queue entries
   * remain queued for a later user action; reading a queue never applies it. */
  queueDirection(owner: RunOwner, queuedInputId: string): boolean {
    return this.database.transaction(() => {
      const run = this.requireRun(owner), state = this.store.load(owner.threadId)
      if (run.status !== 'running' || run.operation !== 'agent' || state?.runId !== owner.runId
        || !['prepare_model', 'model_result', 'tools'].includes(state.phase)) return false
      if (state.messages.some(message => message.id === `${owner.runId}:direction:${queuedInputId}`)) return true
      const row = this.database.prepare('SELECT * FROM agent_queued_inputs WHERE id=? AND thread_id=?').get(queuedInputId, owner.threadId) as QueuedRow | undefined
      if (!row || row.status !== 'queued') return false
      const existing = this.database.prepare('SELECT thread_id,run_id FROM execution_queued_directions WHERE queued_input_id=?')
        .get(queuedInputId) as { thread_id: string; run_id: string } | undefined
      if (existing && (existing.thread_id !== owner.threadId || existing.run_id !== owner.runId)) throw new Error('Queued direction belongs to another run.')
      this.database.prepare('INSERT OR IGNORE INTO execution_queued_directions(queued_input_id,thread_id,run_id) VALUES (?,?,?)')
        .run(queuedInputId, owner.threadId, owner.runId)
      return true
    })()
  }
  removeDirection(owner: RunOwner, queuedInputId: string): boolean {
    this.requireRun(owner)
    return this.database.prepare('DELETE FROM execution_queued_directions WHERE queued_input_id=? AND thread_id=? AND run_id=?')
      .run(queuedInputId, owner.threadId, owner.runId).changes === 1
  }
  async directions(state: ExecutionState): Promise<ExecutionMessageInput[]> {
    const actual = this.store.load(state.threadId)
    if (!actual || actual.runId !== state.runId || actual.revisionId !== state.revisionId || actual.phase !== 'tools'
      || actual.calls.some(call => !call.result)) throw new Error('Directions require the completed current tool batch.')
    const rows = this.database.prepare(`SELECT queued.* FROM agent_queued_inputs queued JOIN execution_queued_directions direction
      ON direction.queued_input_id=queued.id WHERE direction.thread_id=? AND direction.run_id=? AND queued.status='queued'
      ORDER BY queued.created_at,queued.rowid`).all(state.threadId, state.runId) as QueuedRow[]
    return rows.map(row => direction(row, state.runId, actual.calls.map(call => call.id)))
  }

  retryModel(input: AgentModelRetryInput): void {
    this.changed()
    this.database.transaction(() => {
      const run = this.requireRun(input)
      const latest = this.database.prepare('SELECT id FROM agent_runs WHERE thread_id=? ORDER BY sequence DESC LIMIT 1').get(input.threadId) as { id: string } | undefined
      if (run.status !== 'failed' || run.operation !== 'agent' || latest?.id !== run.id) throw new Error('Only the latest failed model request can be retried.')
      this.database.prepare("UPDATE agent_runs SET status='running',error=NULL,cancellation_requested=0 WHERE id=?").run(run.id)
      this.store.retryModel(input, input.withholdToolResults)
      if (input.withholdToolResults) collectNativeMessageBodies(this.database, input.threadId)
    })()
  }

  async enter(command: RunExecutionCommand, owner: RunOwner): Promise<void> {
    this.database.transaction(() => {
      const run = this.requireRun(owner)
      if (run.cancellation_requested && ['running', 'interrupted'].includes(run.status)) {
        throw new Error('Run cancellation must be settled before execution.')
      }
      let state = this.store.load(owner.threadId)
      const input = this.database.prepare('SELECT input_json FROM agent_run_input_intents WHERE run_id=?').get(owner.runId) as { input_json: string } | undefined
      if (state?.runId !== owner.runId) {
        if (command === 'resume' || !input || run.status !== 'running') throw new Error('The run has no accepted execution or saved input.')
        const message = decodeExecutionInput(input.input_json)
        if ((run.operation === 'compression') !== (message === undefined)) throw new Error('The saved input does not match the run operation.')
        if (message && message.value.context?.runId !== owner.runId) throw new Error('Invalid owned user input.')
        const history = state ?? this.store.readHistory(owner.threadId)
        this.store.start({ ...owner, expectedRevisionId: history?.revisionId, context: { ...history?.context, modelCalls: 0, todos: message ? [] : history?.context.todos ?? [] },
          messages: message ? [message] : [] })
        state = this.store.load(owner.threadId)!
      } else if (input) throw new Error('Accepted execution still has an unconsumed input intent.')
      const rows = this.database.prepare('SELECT interrupt_id,response_json FROM agent_run_resume_intents WHERE run_id=? ORDER BY interrupt_id')
        .all(owner.runId) as { interrupt_id: string; response_json: string }[]
      if (!rows.length) {
        if (command === 'resume' && ['waiting', 'waiting_context'].includes(state.phase)) throw new Error('The run has no saved approval answers.')
        return
      }
      const answers: Answer[] = rows.map(row => {
        const value = JSON.parse(row.response_json) as { generation?: unknown; response?: unknown }
        if (!value || typeof value.generation !== 'string') throw new Error('Invalid saved approval generation.')
        return { id: row.interrupt_id, generation: value.generation, response: value.response }
      })
      const scope = { ...owner, expectedRevisionId: state.revisionId }
      const consume = () => { this.database.prepare('DELETE FROM agent_run_resume_intents WHERE run_id=?').run(owner.runId) }
      if (state.phase === 'waiting_context') {
        if (answers.length !== 1) throw new Error('Invalid context read answer count.')
        const answer = answers[0]
        this.store.resolveContextWait(scope, answer.id, answer.generation, contextDecision(answer.response), consume)
      } else if (state.approvals.every(approval => approval.kind === 'tool')) {
        resolveConversationToolApprovals(this.store, scope, answers, consume)
      } else resolveConversationToolWaits(this.store, scope, answers, consume)
    })()
  }

  private requireRun(owner: RunOwner): RunRow {
    const run = this.database.prepare('SELECT id,thread_id,status,operation,error,cancellation_requested FROM agent_runs WHERE id=?').get(owner.runId) as RunRow | undefined
    if (!run || run.thread_id !== owner.threadId) throw new Error('The run does not belong to this conversation.')
    return run
  }

  private commit(commit: NativeExecutionCommit): void {
    const run = this.requireRun(commit)
    if (!['running', 'interrupted'].includes(run.status)) throw new Error('The run no longer accepts execution commits.')
    if (commit.inputAccepted && this.database.prepare('DELETE FROM agent_run_input_intents WHERE run_id=?').run(commit.runId).changes !== 1) {
      throw new Error('Execution input acceptance requires a saved intent.')
    }
    if (commit.summary) {
      const summary = commit.summary
      // The public summary row is staged by the existing generation callbacks.
      // Confirm exactly that result with its native revision, in this same
      // transaction as the body/context and optional terminal transition.
      const confirmed = this.database.prepare(`UPDATE agent_context_summaries SET status='completed',committed_checkpoint_id=?
        WHERE run_id=? AND summary_id=? AND status='running' AND committed_checkpoint_id IS NULL
        AND summary_text=? AND model_content=? AND cutoff_index=? AND activated_after_message_index=?
        AND covered_through_message_id IS ? AND first_preserved_message_id IS ? AND input_tokens_before=? AND input_tokens_after=?`)
        .run(commit.revisionId, commit.runId, summary.id, summary.summaryText, summary.modelContent, summary.cutoffIndex,
          summary.activatedAfterMessageIndex, summary.coveredThroughMessageId ?? null, summary.firstPreservedMessageId ?? null,
          summary.inputTokensBefore, summary.inputTokensAfter)
      if (confirmed.changes !== 1) throw new Error('The committed summary does not match this run\'s staged summary.')
    }
    if (!commit.inputAccepted) {
      for (const record of commit.messageRecords) {
        const prefix = `${commit.runId}:direction:`
        if (record.value.kind !== 'user' || !record.id.startsWith(prefix)) continue
        const id = record.id.slice(prefix.length)
        const row = this.database.prepare(`SELECT queued.* FROM agent_queued_inputs queued JOIN execution_queued_directions direction
          ON direction.queued_input_id=queued.id WHERE queued.id=? AND queued.thread_id=? AND direction.thread_id=? AND direction.run_id=?`)
          .get(id, commit.threadId, commit.threadId, commit.runId) as QueuedRow | undefined
        const after = record.value.context?.directionAfterCallIds
        if (!row || row.status !== 'queued' || !Array.isArray(after) || after.some(id => typeof id !== 'string')
          || !Buffer.from(encodeConversationMessage(direction(row, commit.runId, after).value)).equals(Buffer.from(encodeConversationMessage(record.value)))) {
          throw new Error('The committed direction no longer matches its queued input.')
        }
        this.database.prepare(`INSERT INTO agent_attachments(id,thread_id,message_id,run_id,name,mime_type,size,kind,storage_path,text_truncated,context_policy,created_at)
          SELECT id,?,?,?,name,mime_type,size,kind,storage_path,text_truncated,context_policy,created_at
          FROM agent_queued_attachments WHERE queued_input_id=?`).run(commit.threadId, record.id, commit.runId, id)
        this.database.prepare('DELETE FROM agent_queued_inputs WHERE id=? AND thread_id=?').run(id, commit.threadId)
      }
    }
    handoffNativeFileEdits(this.database, commit)
    const status = commit.phase === 'completed' || commit.phase === 'cancelled' || commit.phase === 'failed' ? commit.phase
      : commit.phase === 'waiting' || commit.phase === 'waiting_context' ? 'interrupted' : 'running'
    const threadStatus = status === 'completed' || status === 'cancelled' ? 'idle' : status
    if (status === 'interrupted') this.database.prepare('DELETE FROM execution_queued_directions WHERE run_id=?').run(commit.runId)
    if (status === 'completed' || status === 'cancelled' || status === 'failed') {
      this.database.prepare('DELETE FROM agent_run_resume_intents WHERE run_id=?').run(commit.runId)
      this.database.prepare('DELETE FROM execution_queued_directions WHERE run_id=?').run(commit.runId)
      this.database.prepare("DELETE FROM agent_context_summaries WHERE run_id=? AND status='running'").run(commit.runId)
    }
    const time = new Date().toISOString()
    this.database.prepare('UPDATE agent_runs SET status=?,updated_at=?,error=?,cancellation_requested=CASE WHEN ? THEN 0 ELSE cancellation_requested END WHERE id=?')
      .run(status, time, status === 'failed' ? commit.error ?? null : null, status === 'completed' ? 1 : 0, commit.runId)
    this.database.prepare('UPDATE agent_threads SET status=?,updated_at=? WHERE id=?').run(threadStatus, time, commit.threadId)
  }
}
