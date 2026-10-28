import type { ModelRetryEvent } from '../../runtime/modelRetry'
import { runtimeLog } from '../runtimeLogger'

/** Bind host diagnostics without making request policy depend on Electron. */
export function observeModelRetry(runId?: string, onRetry?: (event: ModelRetryEvent) => void): (event: ModelRetryEvent) => void {
  return event => {
    onRetry?.(event)
    runtimeLog('warn', 'agent-model', 'Retrying a transient model request.', {
      runId,
      attempt: event.attempt,
      nextAttempt: event.attempt + 1,
      maxAttempts: event.maxAttempts,
      delayMs: event.delayMs,
      reason: event.reason,
      status: event.status,
      code: event.code
    })
  }
}
