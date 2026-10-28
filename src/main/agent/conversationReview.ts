import type { CodeReviewSnapshot } from '@shared/codeReview'
import type { ExecutionMessageInput, ExecutionState } from '../../runtime/executionState'
import { codeReviewReportText, codeReviewToolName, parseCodeReviewReport, validateCodeReviewSnapshot } from '../../runtime/codeReviewReport'

/** Structured reports are host response data, not dispatchable capabilities. */
export function conversationReviewResults(state: ExecutionState, scope: CodeReviewSnapshot): Map<string, ExecutionMessageInput> {
  const snapshot = validateCodeReviewSnapshot(scope)
  const parsed = parseCodeReviewReport(snapshot.id, state.response?.value.calls ?? [])
  if (parsed.kind === 'investigate') return new Map()
  return new Map(state.calls.filter(call => call.name === codeReviewToolName).map(call => {
    const id = `${call.id}:result`
    return [call.id, { id, value: { id, kind: 'tool', name: call.name, resultFor: call.providerCallId ?? call.id,
      content: parsed.kind === 'complete' ? JSON.stringify(parsed.report) : parsed.error,
      resultStatus: parsed.kind === 'complete' ? 'success' : 'error' } }]
  }))
}

/** Accept the presentation only after the matching report result is saved.
 * The store appends it with the batch, then resumes the ordinary completion path. */
export function completeConversationReview(state: ExecutionState, scope: CodeReviewSnapshot): ExecutionMessageInput | undefined {
  const snapshot = validateCodeReviewSnapshot(scope)
  const parsed = parseCodeReviewReport(snapshot.id, state.response?.value.calls ?? [])
  if (parsed.kind !== 'complete') return undefined
  const call = state.calls[0], result = call?.result?.value
  if (state.calls.length !== 1 || !call.prepared || result?.kind !== 'tool' || result.resultStatus !== 'success'
    || result.resultFor !== parsed.call.id || result.content !== JSON.stringify(parsed.report)) {
    throw new Error('The review report has no matching durable host response.')
  }
  const id = `${state.runId}:review-report`, receipt = state.response?.value.context?.projectRulesReceipt
  return { id, value: { id, kind: 'assistant', content: codeReviewReportText(parsed.report, snapshot), context: {
    runId: state.runId, createdAt: new Date().toISOString(), reviewReport: { snapshot, report: parsed.report },
    ...(receipt !== undefined ? { projectRulesReceipt: receipt } : {})
  } } }
}
