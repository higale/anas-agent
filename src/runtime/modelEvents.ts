import type { AgentMessage, AgentToolCall, AgentToolCallProgress } from '../shared/agentTypes'

/** Display-only progress. Arguments and executable calls are delivered only
 * through the complete model result, never through this event. */
export interface ModelToolInputProgress {
  index: number
  callId?: string
  name?: string
  characterCount?: number
  complete: boolean
  streamed: boolean
}
/** Observations update the timeline only; the committed execution result still
 * owns execution. Every payload is application data, without stream classes. */
export type ModelRunObservation = { modelId: string; subagentId?: string } & (
  | { kind: 'delta'; channel: 'text' | 'reasoning'; text: string }
  | { kind: 'tool_input'; progress: AgentToolCallProgress[] }
  | { kind: 'incomplete' }
  | { kind: 'recovering'; recovery: import('../shared/modelRecovery').ModelRecoveryState }
  | { kind: 'completed'; message: AgentMessage; calls: AgentToolCall[]; streamedText: string; streamedReasoning: string;
      usage: unknown; responseMetadata: unknown }
)
