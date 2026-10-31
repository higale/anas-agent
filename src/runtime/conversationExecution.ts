import type { ManualContextCompression } from './compression'
import type { ExecutionApproval, ExecutionCommitScope, ExecutionContext, ExecutionMessageInput, ExecutionMessageRecord,
  ExecutionPendingCall, ExecutionState, ExecutionToolCall, ExecutionToolPreparation, ExecutionToolStateUpdate } from './executionState'
import { abortableModelRetryDelay, classifyModelRetryError, invokeModelWithRetry, modelRetryDelay, type ModelRetryOptions } from './modelRetry'
import { maxModelRecoveryAttempts, modelOutputWasTruncated, outputRecoveryReason } from './modelOutputRecovery'
import { IncompleteModelResponseError, ModelOutputLimitError } from './errors'
import type { ModelRecoveryState } from '../shared/modelRecovery'
import { annotateModelFailure, type ModelRecoveryEvent } from './modelRecoveryDiagnostics'
import type { RunExecution, RunExecutionCommand, RunExecutionResult, RunObserver } from './runExecution'

type Request = { threadId: string; runId: string; signal: AbortSignal }
type Summary = ManualContextCompression & { id: string }

function failureText(reason: unknown): string {
  if (reason instanceof Error) return reason.message
  if (typeof reason === 'string') return reason
  try { return JSON.stringify(reason) ?? String(reason) } catch { return String(reason) }
}

/** The application's durable transitions, implemented by the owning SQLite
 * store. No scheduler state or mutable message cache is held by this loop. */
export interface ConversationExecutionStore {
  load(threadId: string): ExecutionState | undefined
  readMessageRecord(threadId: string, recordId: string): ExecutionMessageRecord
  acceptModel(scope: ExecutionCommitScope, response: ExecutionMessageInput, calls: ExecutionToolCall[], context: ExecutionContext, summary?: Summary): string
  commitSummary(scope: ExecutionCommitScope, summary: Summary, options?: { completeRun?: boolean }): string
  prepareContext(scope: ExecutionCommitScope, context: ExecutionContext): string
  continueAfterModel(scope: ExecutionCommitScope, messages: ExecutionMessageInput[], context: ExecutionContext): string
  prepareTools(scope: ExecutionCommitScope, preparation: ExecutionToolPreparation[], approvals?: ExecutionApproval[], context?: ExecutionContext): string
  settleCall(scope: Omit<ExecutionCommitScope, 'expectedRevisionId'>, callId: string, result: ExecutionMessageInput, update?: ExecutionToolStateUpdate): string
  wait(scope: ExecutionCommitScope, approvals: ExecutionApproval[]): string
  waitForContext(scope: ExecutionCommitScope, approval: Extract<ExecutionApproval, { kind: 'context_read' }>, context: ExecutionContext): string
  finishBatch(scope: ExecutionCommitScope, directions?: ExecutionMessageInput[], response?: ExecutionMessageInput): string
  finish(scope: ExecutionCommitScope, outcome: 'completed' | 'cancelled' | 'failed', error?: string, options?: { modelRequestFailed?: boolean }): string
}

export interface ConversationModelResult {
  message: ExecutionMessageInput
  calls: ExecutionToolCall[]
  context: ExecutionContext
  summary?: Summary
}

/** Product services prepare actual requests and capabilities. They do not
 * schedule model/tool turns; the coordinator owns those transitions. */
export interface ConversationExecutionServices {
  store: ConversationExecutionStore
  /** Read and consume only the run's already saved input/resume intent. */
  enter(command: RunExecutionCommand, request: Request): Promise<void>
  prepareModel(state: ExecutionState, request: Request, observer: RunObserver): Promise<
    { kind: 'model'; invoke(): Promise<ConversationModelResult> } | { kind: 'manual_summary'; invoke(): Promise<Summary> }
    | { kind: 'context'; context: ExecutionContext }
    | { kind: 'wait'; approval: Extract<ExecutionApproval, { kind: 'context_read' }>; context: ExecutionContext }>
  afterModel(state: ExecutionState, request: Request): Promise<
    { kind: 'complete' } | { kind: 'continue'; messages: ExecutionMessageInput[]; context: ExecutionContext }>
  prepareTools(state: ExecutionState, request: Request): Promise<{
    calls: ExecutionToolPreparation[]; approvals?: ExecutionApproval[]; context?: ExecutionContext
  } | {
    kind: 'wait'; approval: Extract<ExecutionApproval, { kind: 'context_read' }>; context: ExecutionContext
  }>
  /** All effectful dispatch goes through the durable journal before invocation. */
  executeTool(call: ExecutionPendingCall, state: ExecutionState, request: Request, observer: RunObserver): Promise<
    { kind: 'result'; message: ExecutionMessageInput; update?: ExecutionToolStateUpdate } | { kind: 'wait'; approval: ExecutionApproval }>
  /** Read queued directions; the commit owner consumes them with finishBatch. */
  directions(state: ExecutionState, request: Request): Promise<ExecutionMessageInput[]>
  /** Host response tools (currently code review) can finish the model answer
   * after their validated results are durable, without another provider call. */
  completeResponse?(state: ExecutionState, request: Request): ExecutionMessageInput | undefined
  observeWaiting?(state: ExecutionState, observer: RunObserver): void
  drain(): Promise<void>
  retry?: Omit<ModelRetryOptions, 'signal'>
  recoveryLog?(event: ModelRecoveryEvent): void
}

/** The single application conversation loop. The host owns activation;
 * this module never opens or upgrades a database. */
export function conversationExecution(services: ConversationExecutionServices): RunExecution {
  let executing = false
  return { async execute(command, request, observer): Promise<RunExecutionResult> {
    if (executing) return { result: { status: 'rejected', reason: new Error('This conversation executor is already running.') }, interrupted: false, observationErrors: [] }
    executing = true
    const errors: unknown[] = [], failedObservers = new Set<string>()
    let observations = Promise.resolve(), modelSequence = 0, lastModelId: string | undefined, lastSubagentId: string | undefined
    let pendingRecoveryStart: ExecutionState | undefined
    const report = (name: string, error: unknown) => {
      if (!failedObservers.has(name)) { failedObservers.add(name); errors.push(error) }
    }
    const observe = (name: string, action: () => void) => { try { action() } catch (error) { report(name, error) } }
    const safeObserver: RunObserver = {
      started: () => observe('started', () => observer.started()),
      startModel: (subagentId, recovery) => {
        lastSubagentId = subagentId
        try { lastModelId = observer.startModel(subagentId, recovery) } catch (error) {
          report('startModel', error)
          lastModelId = `${request.runId}:unobserved-model:${++modelSequence}`
        }
        if (pendingRecoveryStart) logRecovery('attempt_started', pendingRecoveryStart)
        pendingRecoveryStart = undefined
        return lastModelId
      },
      discardModel: id => observe('discardModel', () => observer.discardModel(id)),
      model: event => observe('model', () => observer.model(event)),
      tool: event => observe('tool', () => observer.tool(event)),
      approval: event => observe('approval', () => observer.approval(event)),
      committed: commit => {
        observations = observations.then(async () => {
          try { await observer.committed(commit) } catch (error) { report('committed', error) }
        })
        return observations
      }
    }
    const current = () => {
      const state = services.store.load(request.threadId)
      if (!state || state.runId !== request.runId) throw new Error('The run does not own this conversation execution.')
      return state
    }
    const scope = (state: ExecutionState): ExecutionCommitScope => ({ threadId: state.threadId, runId: state.runId, expectedRevisionId: state.revisionId })
    const committed = () => {
      const state = current(), summary = state.context.summary
      const summaryMessage = summary ? services.store.readMessageRecord(state.threadId, summary.messageRecordId).value : undefined
      void safeObserver.committed({ commitId: state.revisionId, messageIds: state.messages.map(message => message.id),
        ...(summary && typeof summaryMessage?.content === 'string' ? { summary: {
          id: summary.id, cutoffIndex: summary.cutoffIndex, modelContent: summaryMessage.content
        } } : {}) })
    }
    let failure: { reason: unknown } | undefined, entered = false, modelRequestFailed = false
    const configuredRetries = services.retry?.maxRetries
    const recoveryLimit = configuredRetries !== undefined && Number.isFinite(configuredRetries)
      ? Math.min(maxModelRecoveryAttempts, Math.max(0, Math.floor(configuredRetries))) : maxModelRecoveryAttempts
    const logRecovery = (event: ModelRecoveryEvent['event'], state: ExecutionState,
      extra: Partial<ModelRecoveryEvent> = {}) => observe('recoveryLog', () => services.recoveryLog?.({ event, threadId: state.threadId,
      runId: state.runId, revisionId: state.revisionId, modelId: lastModelId, recovery: state.context.modelRecovery,
      maxRetries: recoveryLimit, ...extra }))
    const recover = (state: ExecutionState, reason: ModelRecoveryState['reason'], error: unknown, continuation = false): boolean => {
      const attempts = (state.context.modelRecovery?.attempts ?? 0) + 1
      if (attempts > recoveryLimit) { logRecovery('exhausted', state, { error, details: { reason } }); return false }
      const delayMs = modelRetryDelay(error, attempts, services.retry)
      const recovery: ModelRecoveryState = { attempts, reason, retryAt: Date.now() + delayMs,
        ...(state.context.modelRecovery?.feedback ? { feedback: state.context.modelRecovery.feedback } : {}),
        ...(['invalid_tool_call', 'output_limit', 'text_continuation'].includes(reason)
          ? { feedback: reason as NonNullable<ModelRecoveryState['feedback']> } : {}) }
      const context = { ...state.context, modelRecovery: recovery }
      logRecovery('scheduled', state, { recovery, delayMs, error,
        details: { retainedResponseId: continuation ? state.response?.id : undefined, reason } })
      if (continuation) services.store.continueAfterModel(scope(state), [], context)
      else services.store.prepareContext(scope(state), context)
      committed()
      if (lastModelId && !continuation) safeObserver.model({ kind: 'recovering', modelId: lastModelId, subagentId: lastSubagentId, recovery })
      return true
    }
    try {
      try {
        await services.enter(command, request)
        entered = true
        safeObserver.started()
        committed()
        while (true) {
          const state = current()
          if (state.phase === 'completed') break
          request.signal.throwIfAborted()
          if (state.phase === 'failed' || state.phase === 'cancelled') throw new Error(`The run is already ${state.phase}.`)
          const blocked = new Set(state.approvals.flatMap(approval => approval.callIds))
          const pending = state.calls.filter(call => !call.result && !blocked.has(call.id))
          if (state.phase === 'waiting_context' || state.phase === 'waiting' && (!pending.length
            || state.approvals.some(approval => approval.kind !== 'effect_recovery' && approval.kind !== 'subagent'))) break
          if (state.phase === 'prepare_model') {
            // A process restart must not redispatch an already reserved retry
            // for free. Its response was never committed, so consume the next
            // slot without replaying any tools.
            if (state.context.modelRecovery?.inFlight) {
              const error = new IncompleteModelResponseError()
              if (recover(state, 'incomplete', error)) continue
              modelRequestFailed = true
              throw error
            }
            // Retry includes fresh preparation/configuration, but never retries
            // the result commit or a previously saved model response.
            let step: Exclude<Awaited<ReturnType<ConversationExecutionServices['prepareModel']>>, { kind: 'model' | 'manual_summary' }>
              | { kind: 'model'; result: ConversationModelResult } | { kind: 'manual_summary'; summary: Summary }
            let savingRequest = false
            try {
              await abortableModelRetryDelay(Math.max(0, (state.context.modelRecovery?.retryAt ?? 0) - Date.now()), request.signal)
              // Retry accounting belongs to the durable head. This helper only
              // normalizes provider failures; it must not start an inner loop.
              step = await invokeModelWithRetry(async () => {
                const prepared = await services.prepareModel(current(), request, safeObserver)
                if (prepared.kind !== 'model' && prepared.kind !== 'manual_summary') return prepared
                const before = current()
                savingRequest = true
                services.store.prepareContext(scope(before), { ...before.context, modelRecovery: {
                  ...(before.context.modelRecovery ?? { attempts: 0, reason: 'incomplete', retryAt: 0 }), inFlight: true } })
                savingRequest = false
                if (prepared.kind === 'manual_summary') {
                  if (before.context.modelRecovery) logRecovery('attempt_started', current(), { details: { operation: 'compression' } })
                  return { kind: 'manual_summary' as const, summary: await prepared.invoke() }
                }
                pendingRecoveryStart = before.context.modelRecovery ? current() : undefined
                return { kind: 'model' as const, result: await prepared.invoke() }
              }, { ...services.retry, maxRetries: 0, signal: request.signal })
            } catch (error) {
              request.signal.throwIfAborted()
              if (savingRequest) throw error
              const decision = classifyModelRetryError(error, request.signal)
              const reason = outputRecoveryReason(error) ?? (decision.retry ? decision.reason : undefined)
              if (reason && services.retry?.retryWhen?.(error) !== false && recover(current(), reason, error)) {
                if (decision.retry) services.retry?.onRetry?.({ ...decision, attempt: current().context.modelRecovery!.attempts,
                  delayMs: Math.max(0, current().context.modelRecovery!.retryAt - Date.now()), maxAttempts: recoveryLimit + 1 })
                continue
              }
              modelRequestFailed = true
              throw error
            }
            if (step.kind === 'context') {
              request.signal.throwIfAborted()
              services.store.prepareContext(scope(state), step.context)
            } else if (step.kind === 'wait') {
              request.signal.throwIfAborted()
              services.store.waitForContext(scope(state), step.approval, step.context)
            } else if (step.kind === 'manual_summary') {
              request.signal.throwIfAborted()
              const attempted = current()
              services.store.commitSummary(scope(attempted), step.summary, { completeRun: true })
              if (state.context.modelRecovery) logRecovery('response_accepted', current(), { recovery: attempted.context.modelRecovery,
                outcome: 'recovered', details: { operation: 'compression', summaryId: step.summary.id } })
            } else {
              const attempted = current()
              services.store.acceptModel(scope(current()), step.result.message, step.result.calls,
                { ...step.result.context, modelRecovery: modelOutputWasTruncated(step.result.message.value) ? current().context.modelRecovery : undefined }, step.result.summary)
              if (state.context.modelRecovery) {
                logRecovery('response_accepted', current(), { recovery: attempted.context.modelRecovery,
                  outcome: modelOutputWasTruncated(step.result.message.value) ? 'truncated' : 'recovered',
                  details: { messageId: step.result.message.id, providerResponseId: step.result.message.value.source?.metadata.id,
                    model: step.result.message.value.source?.metadata.model_name, toolCalls: step.result.calls.length } })
              }
              // Later preparation failures must not overwrite this saved reply's activity.
              lastModelId = undefined
            }
            committed()
            continue
          }
          if (state.phase === 'model_result') {
            if (state.response && modelOutputWasTruncated(state.response.value)) {
              const error = annotateModelFailure(new ModelOutputLimitError(), { response: state.response.value })
              if (recover(state, 'text_continuation', error, true)) continue
              modelRequestFailed = true
              throw error
            }
            const outcome = await services.afterModel(state, request)
            if (outcome.kind === 'complete') break
            services.store.continueAfterModel(scope(state), outcome.messages, outcome.context)
            committed()
            continue
          }
          if (state.calls.some(call => !call.prepared && !call.result)) {
            const prepared = await services.prepareTools(state, request)
            request.signal.throwIfAborted()
            if ('kind' in prepared) services.store.waitForContext(scope(state), prepared.approval, prepared.context)
            else services.store.prepareTools(scope(state), prepared.calls, prepared.approvals, prepared.context)
            committed()
            continue
          }
          const settled = await Promise.allSettled(pending.map(async call => {
            request.signal.throwIfAborted()
            if (call.authorization?.approval === 'pending') throw new Error('A tool call still requires its saved approval.')
            const outcome = await services.executeTool(call, state, request, safeObserver)
            if (outcome.kind === 'result') services.store.settleCall(request, call.id, outcome.message, outcome.update)
            else {
              const latest = current()
              services.store.wait(scope(latest), [...latest.approvals, outcome.approval])
            }
            committed()
          }))
          const rejected = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
          if (rejected) throw rejected.reason
          const completed = current()
          if (completed.phase === 'waiting') break
          request.signal.throwIfAborted()
          const response = services.completeResponse?.(completed, request)
          const directions = response ? [] : await services.directions(completed, request)
          services.store.finishBatch(scope(completed), directions, response)
          committed()
        }
      } catch (reason) { failure = { reason } }
      // Entered siblings and cleanup always finish before terminal persistence,
      // observer disconnection or an interrupted execution is returned.
      try { await services.drain() } catch (reason) { failure ??= { reason } }
      try {
        const state = current()
        if (!entered) {
          // A refused input/resume is not ownership of an already running turn.
        } else if (state.phase === 'completed') {
          if (failure) report('afterCompletion', failure.reason)
          failure = undefined
        } else {
          if (request.signal.aborted) failure ??= { reason: request.signal.reason }
          if (failure) {
            if (state.phase !== 'cancelled' && state.phase !== 'failed') {
              services.store.finish(scope(state), request.signal.aborted ? 'cancelled' : 'failed',
                request.signal.aborted ? undefined : failureText(failure.reason), { modelRequestFailed })
              committed()
            }
          } else if (state.phase !== 'waiting' && state.phase !== 'waiting_context') {
            services.store.finish(scope(state), 'completed')
            committed()
          }
        }
      } catch (reason) { failure ??= { reason } }
      let state: ExecutionState | undefined
      try { state = current() } catch (reason) { failure ??= { reason } }
      const interrupted = !failure && (state?.phase === 'waiting' || state?.phase === 'waiting_context')
      if (interrupted && services.observeWaiting) observe('waiting', () => services.observeWaiting!(state!, safeObserver))
      await observations
      return { result: failure ? { status: 'rejected', reason: failure.reason } : { status: 'fulfilled', value: state },
        interrupted, observationErrors: errors }
    } finally { executing = false }
  } }
}
