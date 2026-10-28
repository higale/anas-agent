import type { ConversationMessage, ConversationToolCall } from './conversationMessage'
import { createHash } from 'node:crypto'
import { decodeExecutionValue, encodeExecutionValue } from './executionValue'

type Fields = Record<string, unknown>
const messageKeys: Record<keyof ConversationMessage, string> = {
  id: 'id', kind: 'kind', role: 'role', name: 'name', content: 'content', calls: 'calls',
  invalidCalls: 'invalid_calls', partial: 'partial', callFragments: 'call_fragments',
  resultFor: 'result_for', resultStatus: 'result_status', resultKind: 'result_kind', resultMetadata: 'result_metadata',
  artifact: 'artifact', usage: 'usage', source: 'source', context: 'context'
}
const callKeys: Record<keyof ConversationToolCall, string> = {
  id: 'id', name: 'name', args: 'args', kind: 'kind', itemId: 'item_id', extensions: 'extensions'
}
const sourceKeys: Record<keyof NonNullable<ConversationMessage['source']>, string> = {
  provider: 'provider', contentFormat: 'content_format', metadata: 'metadata', extras: 'extras',
  functionItemIds: 'function_item_ids', customItemIds: 'custom_item_ids'
}
const contextKeys: Record<keyof NonNullable<ConversationMessage['context']>, string> = {
  runId: 'run_id', createdAt: 'created_at', displayText: 'display_text', directionAfterCallIds: 'direction_after_call_ids',
  skill: 'skill', reviewScope: 'review_scope', reviewReport: 'review_report', summaryId: 'summary_id', summary: 'summary',
  modelContextKey: 'model_context_key', requestKey: 'request_key', projectRulesReceipt: 'project_rules_receipt',
  attachmentProjection: 'attachment_projection', attachmentBlockCount: 'attachment_block_count', unrecordedResult: 'unrecorded_result'
}

function invalid(detail: string): never { throw new Error(`Invalid conversation message: ${detail}.`) }
function record(value: unknown): Fields {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return invalid('expected a data object')
  return value as Fields
}
function remap(value: unknown, keys: Record<string, string>, read: boolean): Fields {
  const input = record(value), mapping = read ? Object.fromEntries(Object.entries(keys).map(([key, stored]) => [stored, key])) : keys
  const result: Fields = {}
  for (const key of Object.keys(input)) {
    if (!Object.hasOwn(mapping, key)) return invalid(`unrecognized field ${key}`)
    const descriptor = Object.getOwnPropertyDescriptor(input, key)!
    if (!('value' in descriptor)) return invalid(`accessor field ${key}`)
    result[mapping[key]] = descriptor.value
  }
  return result
}
function optionalString(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'string') invalid(`${name} must be a string`)
}
function validate(value: unknown): asserts value is ConversationMessage {
  const message = record(value)
  if (!['user', 'assistant', 'tool', 'system', 'function', 'custom', 'other'].includes(String(message.kind))) invalid('unrecognized kind')
  if (typeof message.content !== 'string' && !Array.isArray(message.content)) invalid('missing content')
  for (const key of ['id', 'role', 'name', 'resultFor']) optionalString(message[key], key)
  if (message.kind === 'tool' && typeof message.resultFor !== 'string') invalid('missing tool call identity')
  if (message.resultStatus !== undefined && message.resultStatus !== 'success' && message.resultStatus !== 'error') invalid('invalid result status')
  if (message.resultKind !== undefined && !['function', 'custom', 'computer'].includes(String(message.resultKind))) invalid('invalid result kind')
  if (message.partial !== undefined && typeof message.partial !== 'boolean') invalid('invalid partial flag')
  for (const key of ['calls', 'invalidCalls', 'callFragments']) {
    if (message[key] !== undefined && !Array.isArray(message[key])) invalid(`${key} must be an array`)
  }
  for (const value of message.calls as unknown[] ?? []) {
    const call = record(value)
    optionalString(call.id, 'call id')
    if (typeof call.name !== 'string') invalid('missing tool name')
    if (!['object', 'string', 'number', 'boolean'].includes(typeof call.args)) invalid('missing or invalid tool arguments')
    // Save the reported value, including numeric overflow, before tool input
    // validation. The execution codec rejects unsupported/cyclic data below.
    if (call.kind !== undefined && !['function', 'custom', 'computer'].includes(String(call.kind))) invalid('invalid call kind')
    if (call.extensions !== undefined) record(call.extensions)
  }
  if (message.source !== undefined) {
    const source = record(message.source)
    record(source.metadata); record(source.extras)
    optionalString(source.provider, 'provider')
    if (source.contentFormat !== undefined && source.contentFormat !== 'portable') invalid('invalid content format')
    for (const key of ['functionItemIds', 'customItemIds']) if (source[key] !== undefined) record(source[key])
  }
  if (message.context !== undefined) record(message.context)
  // Usage and context evidence are retained as reported, including unknown or
  // invalid measurements. Their consumers decide whether they are usable.
  if (message.usage !== undefined) record(message.usage)
  if (message.resultMetadata !== undefined) record(message.resultMetadata)
}

function transform(value: unknown, read: boolean): Fields {
  const result = remap(value, messageKeys, read)
  if (result.calls !== undefined) {
    if (!Array.isArray(result.calls)) return invalid('calls must be an array')
    result.calls = result.calls.map(call => remap(call, callKeys, read))
  }
  if (result.source !== undefined) result.source = remap(result.source, sourceKeys, read)
  if (result.context !== undefined) result.context = remap(result.context, contextKeys, read)
  return result
}

/** Application fields have an explicit disk representation. Provider metadata,
 * original content and tool artifacts retain their own keys and typed values. */
export function encodeConversationMessage(message: ConversationMessage): Uint8Array {
  validate(message)
  return encodeExecutionValue(transform(message, false))
}

export function decodeConversationMessage(bytes: Uint8Array): ConversationMessage {
  const message = transform(decodeExecutionValue(bytes), true)
  validate(message)
  return message
}

/** One body identity for execution and detached results. */
export function conversationMessageRecordId(messageId: string, bytes: Uint8Array): string {
  return createHash('sha256').update('anas-execution-message-v1\0')
    .update(JSON.stringify(messageId)).update('\0').update(bytes).digest('base64url')
}
