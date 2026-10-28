import type { ModelUsage } from './modelUsage'

/** Lossless conversation data. UI blocks and provider requests are projections
 * of this record, not interchangeable replacements for it. No message methods,
 * constructor names, graph channels or framework serialization live here. */
export interface ConversationMessage {
  id?: string
  kind: 'user' | 'assistant' | 'tool' | 'system' | 'function' | 'custom' | 'other'
  /** Custom provider role, or the unrecognized source role for diagnostics. */
  role?: string
  name?: string
  content: string | unknown[]
  calls?: ConversationToolCall[]
  invalidCalls?: unknown[]
  partial?: boolean
  callFragments?: Array<{ id?: string; name?: string; args?: string; index?: number }>
  resultFor?: string
  resultStatus?: 'success' | 'error'
  resultKind?: 'function' | 'custom' | 'computer'
  resultMetadata?: Record<string, unknown>
  artifact?: unknown
  usage?: ModelUsage
  source?: {
    provider?: string
    contentFormat?: 'portable'
    /** Original provider metadata and extras retain provider-defined keys. */
    metadata: Record<string, unknown>
    extras: Record<string, unknown>
    functionItemIds?: Record<string, unknown>
    customItemIds?: Record<string, unknown>
  }
  context?: {
    runId?: unknown
    createdAt?: unknown
    displayText?: unknown
    directionAfterCallIds?: unknown
    skill?: unknown
    reviewScope?: unknown
    reviewReport?: unknown
    summaryId?: unknown
    summary?: boolean
    modelContextKey?: unknown
    requestKey?: unknown
    projectRulesReceipt?: unknown
    attachmentProjection?: unknown
    attachmentBlockCount?: unknown
    unrecordedResult?: unknown
  }
}

export interface ConversationToolCall {
  id?: string
  name: string
  /** Original JSON value; object/schema validation belongs to tool preflight. */
  args: unknown
  kind?: 'function' | 'custom' | 'computer'
  itemId?: unknown
  extensions?: Record<string, unknown>
}

export function conversationRole(message: ConversationMessage): string {
  return message.kind === 'custom' || message.kind === 'other' ? message.role ?? message.kind : message.kind
}
