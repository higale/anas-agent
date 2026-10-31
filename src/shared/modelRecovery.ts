export type ModelRecoveryReason = 'network' | 'rate_limit' | 'server' | 'timeout' | 'configuration_changed'
  | 'incomplete' | 'invalid_tool_call' | 'output_limit' | 'text_continuation'

/** Displayed from the execution owner's saved recovery state. */
export interface ModelRecoveryState {
  attempts: number
  reason: ModelRecoveryReason
  retryAt: number
  inFlight?: boolean
  feedback?: 'invalid_tool_call' | 'output_limit' | 'text_continuation'
}
