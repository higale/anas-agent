import type { ExecutionMessageInput } from './executionState'
import { decodeConversationMessage, encodeConversationMessage } from './conversationStorage'

/** A submitted user message is already expanded and owned by its run. The same
 * complete representation is used for ordinary input and history regeneration. */
export function encodeExecutionInput(message?: ExecutionMessageInput): string {
  if (!message) return JSON.stringify({ version: 1, kind: 'manual_compression' })
  if (!message.id || message.value.id !== message.id || message.value.kind !== 'user' || message.value.partial) {
    throw new Error('A native input requires a complete user message with its identity.')
  }
  return JSON.stringify({ version: 1, kind: 'user', message: JSON.parse(new TextDecoder().decode(encodeConversationMessage(message.value))) })
}

export function decodeExecutionInput(serialized: string): ExecutionMessageInput | undefined {
  const value = JSON.parse(serialized) as { version?: unknown; kind?: unknown; message?: unknown }
  if (!value || value.version !== 1 || !['user', 'manual_compression'].includes(String(value.kind))) throw new Error('Invalid native run input encoding.')
  if (value.kind === 'manual_compression') {
    if (Object.hasOwn(value, 'message')) throw new Error('Manual compression cannot contain a user message.')
    return undefined
  }
  const message = decodeConversationMessage(new TextEncoder().encode(JSON.stringify(value.message)))
  if (!message.id || message.kind !== 'user' || message.partial) throw new Error('Invalid native user input.')
  return { id: message.id, value: message }
}
