import type { ConversationMessage } from './conversationMessage'
import type { ToolResult } from './toolDefinition'

export function toolResultMessage(result: ToolResult, context: { name: string; callId: string; metadata?: Record<string, unknown> }): ConversationMessage {
  const content = typeof result.content === 'string' || Array.isArray(result.content)
    && result.content.every(block => block !== null && typeof block === 'object' && 'type' in block)
    ? result.content : JSON.stringify(result.content) ?? ''
  return { kind: 'tool', name: context.name, resultFor: context.callId, content, artifact: result.artifact,
    resultMetadata: context.metadata, resultStatus: 'success' }
}

export function toolResultText(message: Pick<ConversationMessage, 'content'>): string {
  if (typeof message.content === 'string') return message.content
  return message.content.flatMap(block => typeof block === 'string' ? [block]
    : block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string' ? [block.text] : []).join('\n')
}

export interface ManagedToolResultReference { type: 'message_record'; thread_id: string; record_id: string }
export function isManagedToolResultReference(value: unknown): value is ManagedToolResultReference {
  if (!value || typeof value !== 'object') return false
  const reference = value as Partial<ManagedToolResultReference>
  return reference.type === 'message_record' && typeof reference.thread_id === 'string' && reference.thread_id.length > 0
    && typeof reference.record_id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(reference.record_id)
}

export function managedToolResultReference(value: string, threadId: string): ManagedToolResultReference {
  const reference: unknown = JSON.parse(value)
  if (!isManagedToolResultReference(reference) || reference.thread_id !== threadId) {
    throw new Error('Invalid persisted tool result reference for this conversation.')
  }
  return reference
}
