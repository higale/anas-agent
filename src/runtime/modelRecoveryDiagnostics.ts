import type { ModelRecoveryState } from '../shared/modelRecovery'

export interface ModelRecoveryEvent {
  event: 'scheduled' | 'attempt_started' | 'response_accepted' | 'exhausted' | 'run_finished'
    | 'manual_requested' | 'manual_started' | 'manual_rejected'
  threadId: string
  runId: string
  revisionId?: string
  modelId?: string
  recovery?: ModelRecoveryState
  maxRetries?: number
  delayMs?: number
  outcome?: string
  error?: unknown
  details?: unknown
}

// Diagnostic evidence is separate from executable state and never sent to the model.
const evidence = new WeakMap<object, Record<string, unknown>>()
export function annotateModelFailure(error: unknown, details: Record<string, unknown>): unknown {
  const target = error && typeof error === 'object' ? error : new Error(String(error))
  evidence.set(target, { ...evidence.get(target), ...details })
  return target
}
export function modelFailureEvidence(error: object): Record<string, unknown> | undefined { return evidence.get(error) }
