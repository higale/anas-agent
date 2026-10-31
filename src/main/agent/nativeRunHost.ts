import type { AgentRun, AgentRuntimeEvent, AgentSubagentActivity } from '../../shared/agentTypes'
import type { RunExecution, RunExecutionCommand } from '../../runtime/runExecution'
import type { ModelRecoveryEvent } from '../../runtime/modelRecoveryDiagnostics'
import type { NativeConversationDatabase } from './nativeConversationDatabase'
import type { ManagedCallService } from './managedCallService'
import type { RunActivityProjection, RunEventSink } from './runActivityProjection'
import type { AgentSubagentCallRecord, AgentSubagentCallTransition } from './subagentTaskStore'
import { cleanupUnresolvedBackgroundTasks, hasUnresolvedBackgroundTasks } from './backgroundTaskCleanup'
import { runWithoutCurrentAgentToolEffect } from './toolEffectScope'
import { withoutToolExecution } from './toolExecutionContext'
import type { ConversationContextRuntime } from './conversationContextRuntime'
import { conversationContextSource } from './conversationModelExecution'
import { directoryTreePages } from '../directoryTree'
import { runtimeLog } from '../runtimeLogger'
import { ResourceCleanup } from './resourceCleanup'
import { prepareMessageEditDraft } from './messageEditDraft'
import type { NativeHistoryRevision } from './nativeHistoryOwner'
import { AgentThreadLockedError } from './agentErrors'
import { isAgentThreadLocked, type AgentMessageRangeInput, type AgentRunSubmission, type AgentResumeInput, type AgentModelRetryInput,
  type AgentQueuedInputCreate, type AgentRunDirectionInput, type AgentRunDirectionReferenceInput } from '../../shared/agentTypes'
import { normalizeAgentRunSubmissionId, type AgentMessageRegenerateExecutionInput, type AgentRunSubmissionExecutionInput } from './agentRunInput'
import { archiveAgentAttachments, deleteArchivedAgentAttachments, validatedAttachmentInputs } from './agentAttachmentStore'
import { userMessageContent } from '../../runtime/messagePresentation'
import { getProject } from '../projectStore'
import { randomUUID } from 'node:crypto'
import { QueuedInputService } from './queuedInputService'
import { isDeepStrictEqual } from 'node:util'
import { validateShutdownTimeout, waitForShutdownDrain, type AgentRuntimeShutdownResult } from './runtimeShutdown'
import { isModelSelectionError, isModelRequestChangedError } from '../../runtime/errors'

type Owner = { threadId: string; runId: string }
export type NativeRunInstance = { execution: RunExecution; context?: Pick<ConversationContextRuntime, 'projectedStatus'>; dispose(): Promise<void> }
export type NativeRunContext = ReturnType<RunActivityProjection['contextCallbacks']> & { requestId: string; signal: AbortSignal;
  recoveryLog?: (event: ModelRecoveryEvent) => void }
export type NativeRunFactory = (context: NativeRunContext) => Promise<NativeRunInstance>
export type NativeRunSubmission = AgentRunSubmission & { handle?: NativeRunHandle }
export interface NativeRunHandle {
  /** The durable outcome has been published, including bounded cleanup reports. */
  completed: Promise<AgentRun>
  /** This executor has exited. Terminal runs also drain owned background work;
   * use host.waitForIdle() before closing the shared connection. */
  drained: Promise<void>
  diagnostics: unknown[]
}
interface ActiveRun extends NativeRunHandle, Owner {
  controller: AbortController
  settling: boolean
  backgroundCleanup?: AgentRun['backgroundCleanup']
  cancellations: Promise<unknown>[]
  newUserTurn: boolean
}
const terminal = (run: AgentRun) => ['completed', 'failed', 'cancelled'].includes(run.status)
const detail = (reason: unknown) => reason instanceof Error ? reason.message : String(reason)

/** Live ownership for the native product executor. Execution facts, approvals
 * and recovery still belong exclusively to the conversation's durable owner.
 * One application host owns all root/child executions on this connection. */
export class NativeRunHost {
  private readonly active = new Map<string, ActiveRun>()
  private readonly listeners = new Set<(event: AgentRuntimeEvent) => void>()
  private readonly resourceCleanup: ResourceCleanup
  private readonly mutations = new Map<string, Promise<void>>()
  private readonly submissions = new Map<string, Promise<NativeRunSubmission>>()
  private readonly queuedInputs: QueuedInputService
  private readonly tasks = new Set<Promise<unknown>>()
  private shuttingDown = false
  private shutdownDrain?: Promise<void>
  constructor(private readonly database: NativeConversationDatabase,
    private readonly managed: ManagedCallService, private readonly events: RunEventSink,
    private readonly recoveryLog?: (event: ModelRecoveryEvent) => void) {
    this.resourceCleanup = new ResourceCleanup(database.resourceCleanup, managed,
      (runId, retained) => database.resources.fileEditStore.deleteFileEditRecordsForRequest(runId, retained), task => this.track(task))
    this.queuedInputs = new QueuedInputService(database.queue, database.resourceCleanup.attachmentRoot,
      id => Boolean(database.resources.getThread(id)), () => this.resourceCleanup.drainPendingAttachmentCleanup(), task => this.track(task))
  }

  listQueuedInputs() { return this.queuedInputs.listQueuedInputs() }
  enqueueQueuedInput(input: AgentQueuedInputCreate) { this.assertOpen(); return this.queuedInputs.enqueueQueuedInput(input) }
  removeQueuedInput(threadId: string, queuedInputId: string) { this.assertOpen(); return this.queuedInputs.removeQueuedInput(threadId, queuedInputId) }
  markQueuedInputFailed(threadId: string, queuedInputId: string, error: string) { this.assertOpen(); return this.queuedInputs.markQueuedInputFailed(threadId, queuedInputId, error) }
  retryQueuedInput(threadId: string, queuedInputId: string) { this.assertOpen(); return this.queuedInputs.retryQueuedInput(threadId, queuedInputId) }

  async steerRun(input: AgentRunDirectionInput): Promise<boolean> {
    this.assertOpen()
    const id = input.queuedInputId.trim(), text = input.text.trim(), displayText = input.displayText?.trim()
    if (!id) throw new Error('A queued input ID is required.')
    if (!text) throw new Error('Direction text is required.')
    if (input.displayText !== undefined && !displayText) throw new Error('Direction display text must not be empty.')
    const attachments = validatedAttachmentInputs(input.attachments, 'Direction')
    this.requireRun(input)
    const active = this.active.get(input.threadId)
    if (!active || active.runId !== input.runId || active.settling || active.controller.signal.aborted) return false
    const queued = this.database.queue.getQueuedInput(input.threadId, id)
    if (queued) {
      const supplied = attachments.map(item => ({ ...item, textTruncated: item.textTruncated ?? false }))
      const saved = queued.attachments.map(item => ({ path: item.path, name: item.name, mimeType: item.mimeType, size: item.size,
        kind: item.kind, contextPolicy: item.contextPolicy, textTruncated: item.truncated ?? false }))
      if (text !== queued.text.trim() || (displayText ?? text) !== queued.displayText.trim() || !isDeepStrictEqual(supplied, saved)) {
        throw new Error('Direction input changed from its saved queued message. Reload the queue before applying it.')
      }
    }
    return this.database.runs.queueDirection(input, id)
  }

  async removeSteer(input: AgentRunDirectionReferenceInput): Promise<boolean> {
    this.assertOpen()
    if (!this.isActive(input)) return false
    return this.database.runs.removeDirection(input, input.queuedInputId)
  }

  /** Explicit startup/history cleanup. Durable failures stay queued for retry. */
  cleanupResources(): Promise<void> {
    return this.track((async () => {
      await this.resourceCleanup.drainPendingAttachmentCleanup()
      await this.resourceCleanup.drainPendingFileEditCleanup()
    })())
  }

  private async withConversationMutation<T>(threadId: string, mutate: () => Promise<T>, creating = false): Promise<T> {
    this.assertOpen()
    const thread = this.database.resources.getThread(threadId)
    if (!thread && !creating) throw new Error(`Thread ${threadId} was not found.`)
    if (thread && creating) throw new Error(`Thread ${threadId} already exists.`)
    if (this.active.has(threadId) || this.mutations.has(threadId) || thread && isAgentThreadLocked(thread.status)) {
      throw new AgentThreadLockedError(threadId, 'change its messages')
    }
    let release!: () => void
    this.mutations.set(threadId, new Promise<void>(resolve => { release = resolve }))
    try { return await mutate() }
    finally { this.mutations.delete(threadId); release() }
  }

  getRunSubmission(submissionId: string): AgentRunSubmission | undefined {
    const run = this.database.messages.activities.getRunBySubmissionId(submissionId)
    if (!run) return undefined
    const thread = this.database.resources.getThread(run.threadId)
    if (!thread) throw new Error(`Thread ${run.threadId} was not found.`)
    const message = this.database.messages.submittedUserMessage(run.id)
    const attachments = message ? this.database.resources.listAttachmentsForMessages(thread.id, [message.id]) : []
    return { thread, run, ...(message ? { userMessage: attachments.length ? { ...message, attachments } : message } : {}) }
  }

  submitRunWithAttachments(input: AgentRunSubmissionExecutionInput, create: NativeRunFactory): Promise<NativeRunSubmission> {
    this.assertOpen()
    const submissionId = normalizeAgentRunSubmissionId(input.submissionId)
    const existing = this.getRunSubmission(submissionId)
    if (existing) return Promise.resolve(existing)
    const pending = this.submissions.get(submissionId)
    if (pending) return pending
    const task = this.withConversationMutation(input.threadId, async () => {
      let thread = input.newThread
      if (thread) {
        const project = await getProject(thread.projectId)
        thread = { ...thread, accessMode: thread.accessMode ?? (project.kind === 'workspace' ? project.accessMode : undefined) ?? 'smart_approval' }
      }
      const id = `${input.runId}:input`, archived = await archiveAgentAttachments(input.attachments ?? [],
        { threadId: input.threadId, runId: input.runId, messageId: id }, this.database.resourceCleanup.attachmentRoot)
      let saved = false
      try {
        const message = { id, value: { id, kind: 'user' as const, content: userMessageContent(input.text, input.content),
          context: { runId: input.runId, createdAt: new Date().toISOString(),
            ...(input.displayText && input.displayText !== input.text ? { displayText: input.displayText } : {}),
            ...(input.codeReview ? { reviewScope: input.codeReview } : {}) } } }
        if (thread) this.database.runs.createThreadAndRun({ threadId: input.threadId, runId: input.runId, thread, message, attachments: archived, submissionId })
        else this.database.runs.createRun({ threadId: input.threadId, runId: input.runId, operation: 'agent', message, attachments: archived, submissionId })
        saved = true
        const submission = this.getRunSubmission(submissionId)!
        return { ...submission, handle: this.launch({ threadId: input.threadId, runId: input.runId }, 'input', create) }
      } catch (reason) {
        // After the atomic input commit the conversation owns these attachments,
        // even if assembly or notification fails and the caller retries.
        if (!saved) await deleteArchivedAgentAttachments(archived.map(item => item.artifact), this.database.resourceCleanup.attachmentRoot)
        throw reason
      }
    }, Boolean(input.newThread))
    this.submissions.set(submissionId, task)
    void task.then(() => this.submissions.delete(submissionId), () => this.submissions.delete(submissionId))
    return task
  }

  startCompression(threadId: string, create: NativeRunFactory, runId: string = randomUUID()) {
    return this.withConversationMutation(threadId, async () => {
      const run = this.database.runs.createRun({ threadId, runId, operation: 'compression' })
      return { run, handle: this.launch({ threadId, runId }, 'input', create) }
    })
  }

  async retryModel(input: AgentModelRetryInput, create: NativeRunFactory): Promise<NativeRunHandle> {
    if (!input || typeof input.threadId !== 'string' || !input.threadId || typeof input.runId !== 'string' || !input.runId
        || typeof input.expectedRevisionId !== 'string' || !input.expectedRevisionId || typeof input.withholdToolResults !== 'boolean'
        || input.discardLaterMessages !== undefined && typeof input.discardLaterMessages !== 'boolean') throw new Error('Invalid model retry request.')
    const details = { operationId: randomUUID(), withholdToolResults: input.withholdToolResults,
      discardLaterMessages: input.discardLaterMessages === true }
    const event = { threadId: input.threadId, runId: input.runId, revisionId: input.expectedRevisionId, details }
    this.observeRecovery({ ...event, event: 'manual_requested' })
    try { return await this.withConversationMutation(input.threadId, async () => {
      if (this.database.resources.getSubagentCallByChildThreadId(input.threadId)) throw new Error('Retry the model request from its main conversation.')
      const failed = this.requireRun(input)
      const revision = this.database.history.prepareModelRetry(input)
      if (revision) await this.commitHistory(revision)
      else this.database.runs.retryModel(input)
      const handle = this.launch(input, 'continue', create, false)
      this.observeRecovery({ ...event, event: 'manual_started', details: { ...details, previousError: failed.error,
        discardedLaterContent: Boolean(revision) } })
      return handle
    }) } catch (error) {
      this.observeRecovery({ ...event, event: 'manual_rejected', error })
      throw error
    }
  }

  private observeRecovery(event: ModelRecoveryEvent): void {
    try { this.recoveryLog?.(event) }
    catch { /* Diagnostic logging must not change an accepted retry or its outcome. */ }
  }

  resumeRun(input: AgentResumeInput, create: NativeRunFactory): NativeRunHandle {
    this.assertOpen()
    const rootId = this.database.resources.getSubagentCallByChildThreadId(input.threadId)?.ownerThreadId ?? input.threadId
    if (this.active.has(input.threadId) || this.mutations.has(input.threadId) || this.mutations.has(rootId)) throw new AgentThreadLockedError(input.threadId, 'resume before its executor has settled')
    this.database.runs.saveResponses(input)
    return this.start(input, 'resume', create)
  }

  recoverRun(threadId: string, create: NativeRunFactory): NativeRunHandle | undefined {
    if (this.shuttingDown) return undefined
    const run = this.database.messages.activities.getLatestRunForThread(threadId)
    if (!run || terminal(run) || this.active.has(threadId)) return undefined
    const state = this.database.runs.store.readHead(threadId)
    let command: RunExecutionCommand = state?.runId === run.id ? 'continue' : 'input'
    if (state?.runId === run.id && (state.phase === 'waiting' || state.phase === 'waiting_context')) {
      if (this.readSnapshot(threadId).interrupts.length) return undefined
      command = 'resume'
    }
    return this.start({ threadId, runId: run.id }, command, create, { newUserTurn: false })
  }

  private async commitHistory(revision: NativeHistoryRevision) {
    const runIds = this.database.history.affectedRunIds(revision)
    const cancelled = await this.managed.cancelRuns(runIds, 'The conversation history containing this background call is being replaced.')
    if (cancelled.lingeringCallIds.length || runIds.some(runId => this.managed.hasActiveForRun(runId))) {
      throw new Error('Conversation history was not changed because background work is still executing. Wait for it to stop before trying again.')
    }
    await this.cancelChildren(() => this.database.background.listDescendantSubagentCalls(revision.threadId, runIds))
    const result = this.database.history.commit(revision)
    // The visible ledger changed with the history transaction. Physical cleanup
    // may fail or be deferred; neither it nor a display callback owns this commit.
    for (const runId of runIds) {
      try { this.database.resources.fileChanges.notifyChanged(runId) } catch (error) {
        runtimeLog('warn', 'agent', 'Failed to publish a committed history file-change notification.', { runId, error: detail(error) })
      }
    }
    await this.cleanupResources()
    return result
  }

  truncateMessages(input: AgentMessageRangeInput) {
    return this.withConversationMutation(input.threadId, async () => {
      await this.commitHistory(this.database.history.prepare({ ...input, kind: 'truncate' }))
      return this.readSnapshot(input.threadId)
    })
  }

  prepareMessageEdit(input: AgentMessageRangeInput, temporaryRoot: string) {
    return this.withConversationMutation(input.threadId, async () => {
      const revision = this.database.history.prepare({ ...input, kind: 'truncate' })
      const attachments = this.database.resources.listAttachmentsForMessages(input.threadId, [input.messageId])
      return prepareMessageEditDraft(attachments, temporaryRoot, async () => {
        await this.commitHistory(revision)
        return this.readSnapshot(input.threadId)
      })
    })
  }

  regenerateMessage(input: AgentMessageRegenerateExecutionInput, create: (context: NativeRunContext) => Promise<NativeRunInstance>) {
    return this.withConversationMutation(input.threadId, async () => {
      const result = await this.commitHistory(this.database.history.prepare({ ...input, kind: 'regenerate' }))
      if (!result.run) throw new Error(`Failed to create regeneration run ${input.runId}.`)
      return { run: result.run, handle: this.launch({ threadId: input.threadId, runId: result.run.id }, 'input', create) }
    })
  }

  private requireRun(owner: Owner): AgentRun {
    const run = this.database.messages.activities.getRun(owner.runId)
    if (!run || run.threadId !== owner.threadId) throw new Error('The run does not belong to this conversation.')
    return run
  }

  private snapshotOptions(threadId: string, startIndex?: number) {
    const active = this.active.get(threadId)
    const activeSubagentIds = new Set([...this.active.values()].flatMap(run => {
      const call = !run.settling && this.database.resources.getSubagentCallByChildThreadId(run.threadId)
      return call ? [call.id] : []
    }))
    return { startIndex, executingRunId: active && !active.settling ? active.runId : undefined,
      settlingRunId: active?.settling ? active.runId : undefined, backgroundCleanup: active?.backgroundCleanup, activeSubagentIds }
  }

  readSnapshot(threadId: string, startIndex?: number) { return this.database.readSnapshot(threadId, this.snapshotOptions(threadId, startIndex)) }

  readActivityWindow(threadId: string, runId: string, beforeSequence: number) {
    return this.database.readActivityWindow(threadId, runId, beforeSequence, this.snapshotOptions(threadId))
  }

  async readSnapshotWithPreviews(threadId: string, primaryFolder?: string, startIndex?: number) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const options = this.snapshotOptions(threadId, startIndex)
      const snapshot = await this.database.readSnapshotWithPreviews(threadId, primaryFolder, options)
      if (isDeepStrictEqual(options, this.snapshotOptions(threadId, startIndex))) return snapshot
    }
    throw new Error('Conversation execution changed while its approval paths were being read. Read the snapshot again.')
  }

  isActive(owner: Owner): boolean { return this.active.get(owner.threadId)?.runId === owner.runId }

  getRunHandle(owner: Owner): NativeRunHandle | undefined {
    const active = this.active.get(owner.threadId)
    return active?.runId === owner.runId ? active : undefined
  }

  subscribe(listener: (event: AgentRuntimeEvent) => void): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  publishSubagent(call: AgentSubagentCallRecord, activity: AgentSubagentActivity): void {
    const active = this.active.get(call.parentThreadId), diagnostics: unknown[] = []
    this.publish(active ?? { threadId: call.parentThreadId, diagnostics }, {
      type: 'subagent_updated', runId: call.parentRunId, threadId: call.parentThreadId, subagent: activity })
    for (const reason of diagnostics) runtimeLog('warn', 'subagent', 'Failed to publish a native subagent observation.', {
      subagentId: call.id, error: detail(reason) })
  }

  private publish(active: Pick<ActiveRun, 'threadId' | 'diagnostics'>, event: AgentRuntimeEvent): void {
    try {
      let carrier = this.database.resources.getSubagentCallByChildThreadId(active.threadId)
      let projected: AgentRuntimeEvent | undefined = event
      while (carrier && projected) {
        if (projected.type === 'run_started' || projected.type === 'run_interrupted' || projected.type === 'run_completed'
          || projected.type === 'run_failed' || projected.type === 'run_cancelled' || projected.type === 'run_recovery_failed') {
          const transition: AgentSubagentCallTransition | undefined = projected.type === 'run_recovery_failed'
            ? this.database.runs.subagents.recordRecoveryFailure(carrier.id, carrier.ownerThreadId, projected.error)
            : projected.type === 'run_started'
              ? this.database.runs.subagents.resume(carrier.id, carrier.ownerThreadId) ?? this.database.runs.reconcileSubagent(carrier.id, carrier.ownerThreadId)
              : this.database.runs.reconcileSubagent(carrier.id, carrier.ownerThreadId)
          const activity: AgentSubagentActivity | undefined = transition?.activity ?? (projected.type === 'run_started'
            ? this.database.runs.subagents.recordCallActivity(carrier) : undefined)
          projected = activity ? { type: 'subagent_updated', runId: carrier.parentRunId, threadId: carrier.parentThreadId, subagent: activity } : undefined
        } else projected = this.database.subagentProjection.projectEvent(carrier, projected)
        carrier = this.database.resources.getSubagentCallByChildThreadId(carrier.parentThreadId)
      }
      if (projected) this.events.push(projected)
    } catch (error) { active.diagnostics.push(error) }
    for (const listener of this.listeners) {
      try { listener(event) } catch (error) { active.diagnostics.push(error) }
    }
  }

  start(owner: Owner, command: RunExecutionCommand, create: NativeRunFactory, options: { newUserTurn?: boolean } = {}): NativeRunHandle {
    this.assertOpen()
    const rootId = this.database.resources.getSubagentCallByChildThreadId(owner.threadId)?.ownerThreadId ?? owner.threadId
    if (this.mutations.has(owner.threadId) || this.mutations.has(rootId)) throw new AgentThreadLockedError(owner.threadId, 'start while its history is being changed')
    if (terminal(this.requireRun(owner)) && command !== 'continue') throw new Error('A terminal run cannot accept another input or approval.')
    if (this.active.has(owner.threadId)) throw new Error('The conversation executor is still active or settling.')
    return this.launch(owner, command, create, options.newUserTurn)
  }

  private launch(owner: Owner, command: RunExecutionCommand, create?: NativeRunFactory, newUserTurn = command === 'input'): NativeRunHandle {
    let resolve!: (run: AgentRun) => void, reject!: (reason: unknown) => void
    const completed = new Promise<AgentRun>((yes, no) => { resolve = yes; reject = no })
    const active: ActiveRun = { ...owner, controller: new AbortController(), settling: false, diagnostics: [],
      completed, drained: Promise.resolve(), cancellations: [], newUserTurn }
    // An accepted submission/history mutation may finish saving after shutdown
    // starts. Preserve its intent, then settle cancellation without dispatch.
    if (this.shuttingDown) {
      this.database.runs.requestCancellation(owner)
      active.controller.abort(new Error('Agent runtime is shutting down.'))
    }
    if (!create) active.controller.abort(new Error('Agent run cancelled.'))
    this.active.set(owner.threadId, active)
    active.drained = runWithoutCurrentAgentToolEffect(() => withoutToolExecution(async () => {
      try { resolve(await this.execute(active, command, create)) }
      catch (error) { active.diagnostics.push(error); reject(error) }
      finally {
        // A cancellation deadline reports uncertainty, never releases a live task.
        await Promise.allSettled(active.cancellations)
        if (terminal(this.requireRun(owner))) {
          await this.managed.waitForRunIdle(owner.runId)
          await this.resourceCleanup.drainPendingFileEditCleanup()
          try { await directoryTreePages.closeIdleCursors(owner.runId) } catch (error) { active.diagnostics.push(error) }
          this.database.activityProjection.releaseRun(owner.runId)
        }
        this.active.delete(owner.threadId)
        const run = this.requireRun(owner)
        this.publish(active, { type: 'run_settled', ...owner, operation: run.operation, status: run.status })
      }
    }))
    return active
  }

  async waitForIdle(): Promise<void> {
    do {
      await Promise.all([...this.active.values()].map(run => run.drained))
      await Promise.all(this.mutations.values())
      await this.queuedInputs.waitForIdle()
      await this.managed.waitForIdle()
      await Promise.allSettled(this.tasks)
    } while (this.hasLiveWork())
    await this.cleanupResources()
    await this.resourceCleanup.waitForIdle()
  }

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task)
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }

  private assertOpen(): void {
    if (this.shuttingDown) throw new Error('Agent runtime is shutting down.')
  }

  hasLiveWork(): boolean {
    return this.active.size > 0 || this.mutations.size > 0 || this.submissions.size > 0
      || this.tasks.size > 0 || this.managed.activeCallIds().length > 0
  }

  retireIfIdle(): boolean {
    if (this.hasLiveWork()) return false
    this.shuttingDown = true
    return true
  }

  async shutdown(options: { timeoutMs?: number } = {}): Promise<AgentRuntimeShutdownResult> {
    validateShutdownTimeout(options.timeoutMs)
    if (!this.shutdownDrain) {
      this.shuttingDown = true
      for (const run of [...this.active.values()]) this.cancel(run)
      this.shutdownDrain = (async () => { await this.managed.shutdown(); await this.waitForIdle() })()
    }
    const drained = await waitForShutdownDrain(this.shutdownDrain, options.timeoutMs)
    return { drained, lingeringRunIds: [...this.active.values()].map(run => run.runId), lingeringCallIds: this.managed.activeCallIds() }
  }

  resumeAfterIncompleteShutdown(): void {
    if (!this.shuttingDown) return
    this.shuttingDown = false
    this.shutdownDrain = undefined
    this.managed.resumeAfterShutdownTimeout()
  }

  cancel(owner: Owner, armEffect?: () => void): boolean {
    let active = this.active.get(owner.threadId)
    if (active && active.runId !== owner.runId) throw new Error('Another run owns this conversation executor.')
    if (!this.database.runs.requestCancellation(owner, armEffect)) return false
    if (!active) {
      const handle = this.launch(owner, 'continue')
      void handle.completed.catch(() => {})
      active = this.active.get(owner.threadId)!
    }
    active.controller.abort(new Error('Agent run cancelled.'))
    // Signal descendants and managed work now, before the foreground drain.
    const descendants = () => this.database.background.listDescendantSubagentCalls(owner.threadId, [owner.runId])
    this.trackCancellation(active, this.cancelChildren(descendants))
    this.trackCancellation(active, this.managed.cancelRun(owner.runId, 'Agent run cancelled.'))
    return true
  }

  private trackCancellation(active: ActiveRun, promise: Promise<unknown>): Promise<void> {
    const observed = promise.then(() => {}, error => { active.diagnostics.push(error) })
    active.cancellations.push(observed)
    return observed
  }

  private async cancelChildren(list: () => AgentSubagentCallRecord[]): Promise<void> {
    const seen = new Set<string>()
    while (true) {
      const calls = list().filter(call => !seen.has(call.id))
      if (!calls.length) return
      const outcomes = await Promise.allSettled(calls.map(async call => {
        seen.add(call.id)
        const owner = { threadId: call.childThreadId, runId: call.childRunId }
        this.cancel(owner)
        // Cancelling an unaccepted saved input also launches a settlement owner.
        // Capture it after cancellation so history cannot delete its rows early.
        const child = this.active.get(owner.threadId)
        if (child) await child.drained
        await this.managed.cancelRun(owner.runId, 'Parent run stopped.')
        await this.managed.waitForRunIdle(owner.runId)
        this.database.runs.reconcileSubagent(call.id, call.ownerThreadId)
      }))
      const failures = outcomes.filter(result => result.status === 'rejected').map(result => result.reason)
      if (failures.length) throw new AggregateError(failures, 'Failed to settle native child runs.')
    }
  }

  private async execute(active: ActiveRun, command: RunExecutionCommand, create?: (context: NativeRunContext) => Promise<NativeRunInstance>): Promise<AgentRun> {
    const { threadId, runId } = active, database = this.database
    const emit = (event: AgentRuntimeEvent) => this.publish(active, event)
    const sink = { push: emit }
    const publishedDirections = new Set(database.messages.committedDirections(threadId, runId).map(item => item.queuedInputId))
    let instance: NativeRunInstance | undefined, failure: unknown, contextObserved = false
    try {
      if (!terminal(this.requireRun(active))) {
        active.controller.signal.throwIfAborted()
        if (!create) throw new Error('A run instance is required.')
        const callbacks = database.activityProjection.contextCallbacks(runId, threadId, sink)
        instance = await create({ requestId: runId, signal: active.controller.signal, ...callbacks, recoveryLog: this.recoveryLog,
          onContextStatus: status => { contextObserved = true; callbacks.onContextStatus(status) } })
        active.controller.signal.throwIfAborted()
        const execution = await instance.execution.execute(command, { threadId, runId, signal: active.controller.signal },
          database.activityProjection.observer(runId, threadId, sink, { started: () => {
            const run = this.requireRun(active)
            const message = database.messages.window(threadId).messages.find(message => message.id === `${runId}:input` && message.role === 'user')
            const attachments = message ? database.resources.listAttachmentsForMessages(threadId, [message.id]) : []
            const userMessage = message && attachments.length ? { ...message, attachments } : message
            emit(command === 'input' && userMessage ? { type: 'run_started', run, newUserTurn: active.newUserTurn, userMessage }
              : { type: 'run_started', run, newUserTurn: false })
          }, committed: async commit => {
            for (const direction of database.messages.committedDirections(threadId, runId, commit.messageIds)) {
              if (publishedDirections.has(direction.queuedInputId)) continue
              publishedDirections.add(direction.queuedInputId)
              const attachments = database.resources.listAttachmentsForMessages(threadId, [direction.message.id])
              emit({ type: 'direction_applied', threadId, runId, queuedInputId: direction.queuedInputId,
                message: attachments.length ? { ...direction.message, attachments } : direction.message })
            }
          } }))
        active.diagnostics.push(...execution.observationErrors)
        if (execution.result.status === 'rejected') failure = execution.result.reason
      }
    } catch (error) { failure = error }
    finally {
      active.settling = true
      try { await instance?.dispose() } catch (error) { active.diagnostics.push(error) }
    }
    if (active.controller.signal.aborted) database.runs.completeCancellation(active)
    if (!terminal(this.requireRun(active)) && (isModelSelectionError(failure) || isModelRequestChangedError(failure))) {
      const state = database.runs.store.load(threadId)
      // A rejected model selection ends already accepted work. An input that
      // has not been accepted remains saved for a corrected assembly retry.
      if (state?.runId === runId) database.runs.store.finish({ threadId, runId, expectedRevisionId: state.revisionId }, 'failed', detail(failure))
    }
    if (instance?.context || contextObserved) {
      try {
        let restored = false
        for (let attempt = 0; attempt < 3; attempt++) {
          const history = database.runs.store.readHistory(threadId)
          if (!history || !instance?.context) break
          const status = await instance.context.projectedStatus(conversationContextSource({ threadId, ...history }, database.runs.store))
          if (active.controller.signal.aborted) database.runs.completeCancellation(active)
          if (database.runs.store.readHead(threadId)?.revisionId !== history.revisionId) continue
          database.messages.observations.recordContextStatus(threadId, status)
          emit({ type: 'context_status_updated', threadId, runId, status })
          restored = true
          break
        }
        if (!restored) {
          database.messages.observations.clearContextStatus(threadId)
          emit({ type: 'context_status_updated', threadId, runId, status: undefined })
        }
      } catch (error) {
        active.diagnostics.push(error)
        try {
          database.messages.observations.clearContextStatus(threadId)
          emit({ type: 'context_status_updated', threadId, runId, status: undefined })
        } catch (cleanupError) { active.diagnostics.push(cleanupError) }
      }
    }
    // Cancellation may have arrived while computing the display projection.
    if (active.controller.signal.aborted) database.runs.completeCancellation(active)
    let run = this.requireRun(active)
    if (terminal(run)) {
      this.observeRecovery({ event: 'run_finished', threadId, runId, outcome: run.status, error: failure ?? run.error,
        details: { operation: run.operation } })
      try {
        if (hasUnresolvedBackgroundTasks(database.background, threadId)) {
          await cleanupUnresolvedBackgroundTasks({ database: database.background, managedCalls: this.managed, threadId, runId,
            cancelSubagents: list => {
              const cancellation = this.cancelChildren(list)
              this.trackCancellation(active, cancellation)
              return cancellation
            },
            subagentIsActive: call => this.isActive({ threadId: call.childThreadId, runId: call.childRunId }),
            report: cleanup => {
              try { database.background.updateRunBackgroundCleanup(runId, cleanup) }
              catch (error) {
                active.diagnostics.push(error)
                cleanup = { status: cleanup.status === 'running' ? 'running' : 'unconfirmed',
                  report: `${cleanup.report}\nCould not persist cleanup progress: ${detail(error)}` }
              }
              active.backgroundCleanup = cleanup
              try {
                const saved = this.requireRun(active)
                const reply = [...database.messages.window(threadId).messages].reverse().find(message => message.runId === runId && message.role === 'assistant')
                emit({ type: 'run_cleanup', run: { ...saved, backgroundCleanup: cleanup }, cleanup, reply })
              } catch (error) { active.diagnostics.push(error) }
            } })
        }
      } catch (error) { active.diagnostics.push(error) }
      this.trackCancellation(active, this.cancelChildren(() => database.background.listDescendantSubagentCalls(threadId, [runId])))
      if (this.managed.hasActiveForRun(runId)) this.trackCancellation(active, this.managed.cancelRun(runId, 'Agent run ended.'))
      run = this.requireRun(active)
      if (active.backgroundCleanup) run = { ...run, backgroundCleanup: active.backgroundCleanup }
      if (run.status === 'completed') {
        let snapshot: ReturnType<NativeRunHost['readSnapshot']> | undefined
        try { snapshot = this.readSnapshot(threadId) } catch (error) { active.diagnostics.push(error) }
        emit({ type: 'run_completed', run, snapshot })
      }
      else if (run.status === 'cancelled') emit({ type: 'run_cancelled', run })
      else emit({ type: 'run_failed', run, error: run.error ?? detail(failure ?? 'Agent run failed.') })
    } else if (run.status === 'interrupted' && failure === undefined) {
      const interrupts = database.runs.readInterrupts(active)
      let snapshot: ReturnType<NativeRunHost['readSnapshot']> | undefined
      try { snapshot = this.readSnapshot(threadId) } catch (error) { active.diagnostics.push(error) }
      emit({ type: 'run_interrupted', run, interrupts, snapshot })
    } else {
      // Assembly/refused entry has not consumed the saved intent. Report it as
      // recoverable rather than manufacturing execution or a completed input.
      emit({ type: 'run_recovery_failed', run, error: detail(failure ?? 'The run did not reach a durable outcome.') })
    }
    if (failure !== undefined) active.diagnostics.push(failure)
    return run
  }
}
