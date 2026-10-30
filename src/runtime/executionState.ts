import type { AgentTodo, AgentApprovalDecision } from '../shared/agentTypes'
import type { ProjectRulesSnapshot } from './projectRules'
import type { ToolEffectArtifactIdentity } from './toolEffectIdentity'
import type { ToolApprovalRequest } from './toolApproval'
import type { ConversationMessage } from './conversationMessage'
import type { ToolEffectJournalState } from './toolEffects'
import type { PatchAuthorizationReceipt, ShellAuthorizationReceipt } from './authorizationReceipts'

/** A complete application message or tool result, never a framework instance. */
export interface ExecutionMessageInput {
  id: string
  value: ConversationMessage
}

export interface ExecutionMessageRecord extends ExecutionMessageInput {
  recordId: string
}

export interface ExecutionContext {
  modelCalls: number
  modelRequestFailed?: boolean
  /** Failure classification keyed by run, anchored to its final saved message. */
  modelFailureBoundaries?: Record<string, { messageId: string; modelRequestFailed: boolean }>
  threadModelCalls?: number
  todos: AgentTodo[]
  summary?: { id: string; messageRecordId: string; cutoffIndex: number; sessionId?: string }
  projectRules?: ProjectRulesSnapshot
  rulePreparation?: { runId: string; initialized: boolean; reads: { path: string; approved: boolean }[];
    completedCalls?: { id: string; name: string; inputHash: string }[] }
  observedManagedCalls?: Record<string, true>
  observedSubagents?: Record<string, true>
}

export interface ExecutionToolCall {
  /** Application identity, distinct from a possibly repeated provider ID. */
  id: string
  providerCallId?: string
  name: string
  /** Preserve raw JSON, including non-object input awaiting a correction result. */
  args: unknown
  artifacts: ToolEffectArtifactIdentity['artifacts']
  /** A saved user answer for this wait's exact child approval generation. */
  subagentApproval?: { subagentId: string; generation: string; decisions: AgentApprovalDecision[] }
  /** Validated receipts bind the application call ID and exact arguments. */
  authorization?: {
    approval?: 'pending' | 'granted'
    patch?: PatchAuthorizationReceipt
    shell?: ShellAuthorizationReceipt
  }
}

export interface ExecutionPendingCall extends ExecutionToolCall {
  index: number
  prepared: boolean
  result?: ExecutionMessageRecord
  resultUpdate?: ExecutionToolStateUpdate
}

export interface ExecutionToolStateUpdate { todos: AgentTodo[] }

export interface ExecutionToolPreparation {
  callId: string
  args: unknown
  authorization?: ExecutionToolCall['authorization']
  result?: ExecutionMessageInput
}

export type ExecutionApproval = {
  id: string
  generation: string
  request: ToolApprovalRequest
} & ({ kind: 'tool' | 'effect_recovery'; callIds: string[] }
  | { kind: 'subagent'; callIds: [string]; subagentId: string; childGeneration: string }
  | { kind: 'context_read'; callIds: []; path: string; resumePhase: 'prepare_model' | 'tools' })

export type ExecutionPhase = 'prepare_model' | 'model_result' | 'tools' | 'waiting' | 'waiting_context' | 'completed' | 'cancelled' | 'failed'

export interface ExecutionState {
  threadId: string
  runId: string
  revisionId: string
  phase: ExecutionPhase
  context: ExecutionContext
  messages: ExecutionMessageRecord[]
  response?: ExecutionMessageRecord
  calls: ExecutionPendingCall[]
  approvals: ExecutionApproval[]
}

export interface ExecutionCommitScope {
  threadId: string
  runId: string
  expectedRevisionId: string
}

export interface ExecutionEffectKey { threadId: string; runId: string; callId: string }
export interface ExecutionEffectRecord extends ToolEffectJournalState {
  threadId: string
  runId: string
  providerCallId?: string
  artifacts: ToolEffectArtifactIdentity['artifacts']
  effectKind?: string
  idempotencyFingerprint?: string
  result?: ExecutionMessageRecord
}
