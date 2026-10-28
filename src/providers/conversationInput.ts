import { conversationRole, type ConversationMessage } from '../runtime/conversationMessage'
import { inputContentBlocks } from '../runtime/inputContent'
import { isToolImageBlock } from '../runtime/conversationHistory'
import { assistantContentBlocks } from './assistantContent'
import { chatContentPart, chatInput, type ChatInputMessage } from './openAiChatInput'
import { responseInput, type ResponseHistoryEntry, type ResponseToolCall } from './openAiResponsesInput'
import { anthropicInput, anthropicPortableContent, type AnthropicInputMessage } from './anthropicInput'

type Fields = Record<string, unknown>
function record(value: unknown): Fields | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined
}

/** Presentation blocks are derived data; original content and provider replay
 * remain in the conversation record for the next request and for persistence. */
export function conversationContentBlocks(message: ConversationMessage): Fields[] {
  if (message.kind !== 'assistant') return inputContentBlocks(message.content) as Fields[]
  const source = message.source
  return assistantContentBlocks({ content: message.content as string | Fields[], calls: message.calls,
    format: source?.contentFormat === 'portable' ? 'portable'
      : source?.provider === 'openai' || source?.provider === 'anthropic' ? source.provider : 'generic',
    reasoning: source?.extras.reasoning, toolOutputs: source?.extras.tool_outputs,
    partial: message.partial, callFragments: message.callFragments })
}

export function conversationChatInput(messages: readonly ConversationMessage[], model?: string) {
  return chatInput(messages.map((message): ChatInputMessage => {
    const role = conversationRole(message)
    if (message.kind !== 'custom' && !['assistant', 'user', 'system', 'developer', 'tool', 'function'].includes(role)) {
      throw new Error(`Unsupported Chat Completions message role: ${role}`)
    }
    const source = message.source, metadata = source?.metadata ?? {}, extra = source?.extras ?? {}
    const standard = source?.contentFormat === 'portable' || message.kind === 'assistant' && source?.provider === 'anthropic'
    const blocks = standard ? conversationContentBlocks(message) : []
    const fields: ChatInputMessage = { role, content: message.content,
      ...(message.name !== undefined ? { name: message.name } : {}),
      ...(message.kind === 'assistant' ? { toolCalls: message.calls } : {}),
      ...(message.kind === 'tool' ? { toolCallId: message.resultFor } : {}), rawToolCalls: extra.tool_calls }
    if (standard && !(message.kind === 'tool' && Array.isArray(message.content) && message.content.some(isToolImageBlock))) {
      fields.content = role === 'user'
        ? blocks.flatMap(block => block.type === 'text' ? [{ type: 'text', text: block.text }]
          : ['image', 'audio', 'file'].includes(String(block.type)) ? [chatContentPart(block)] : [])
        : blocks.flatMap(block => block.type === 'text' ? [{ type: 'text', text: block.text }] : [])
      if (role === 'function') fields.content = fields.content.map(block => String((block as { text: string }).text)).join('')
      if (message.kind === 'assistant' && !fields.rawToolCalls) {
        const customCalls = blocks.flatMap(block => {
          if (block.type !== 'tool_call' || (block.extras as { openai?: { type?: string } } | undefined)?.openai?.type !== 'custom') return []
          return [{ id: block.id, type: 'custom', custom: { name: block.name, input: (block.args as { input?: string }).input } }]
        })
        if (customCalls.length) fields.rawToolCalls = customCalls
      }
    }
    fields.functionCall = extra.function_call
    fields.audio = extra.audio
    if (message.kind === 'assistant') {
      fields.functionCall ??= metadata.function_call
      fields.audio = metadata.audio ?? fields.audio ?? (standard ? blocks.find(block => block.type === 'audio' && block.id) : undefined)
      fields.refusal = extra.refusal ?? metadata.refusal
    }
    return fields
  }), model)
}

function responseOutput(message: ConversationMessage): Fields[] | undefined {
  if (message.kind !== 'assistant') return undefined
  const output = message.source?.metadata.output
  return Array.isArray(output) && output.length && output.every(item => typeof record(item)?.type === 'string') ? output : undefined
}

function responseCalls(message: ConversationMessage): ResponseToolCall[] {
  const source = message.source, functionIds = source?.functionItemIds, customIds = source?.customItemIds
  const rawOutput = responseOutput(message)
  if (message.calls?.length) return message.calls.map(call => {
    const raw = rawOutput?.find(item => item.call_id === call.id && item.type === 'custom_tool_call')
    const custom = call.kind === 'custom' || Boolean(call.id && customIds && call.id in customIds) || Boolean(raw)
    const itemId = call.itemId ?? raw?.id ?? (call.id ? (custom ? customIds : functionIds)?.[call.id] : undefined)
    return { kind: custom ? 'custom' : call.kind === 'computer' ? 'computer' : 'function',
      id: call.id, itemId: typeof itemId === 'string' ? itemId : undefined, name: call.name,
      args: raw ? { input: raw.input } : call.args }
  })
  const rawCalls = source?.extras.tool_calls
  return Array.isArray(rawCalls) ? rawCalls.flatMap(value => {
    const call = record(value), fn = record(call?.function)
    if (!call || !fn) return []
    const id = typeof call.id === 'string' ? call.id : undefined, itemId = id ? functionIds?.[id] : undefined
    return [{ kind: 'function' as const, id, itemId: typeof itemId === 'string' ? itemId : undefined,
      name: String(fn.name ?? ''), args: {}, argumentsText: String(fn.arguments ?? '') }]
  }) : []
}

export function conversationResponsesInput(messages: readonly ConversationMessage[], options: { model: string; zeroRetention: boolean }) {
  return responseInput(messages.map((message): ResponseHistoryEntry => {
    if (message.kind === 'tool') return { kind: 'result', callId: message.resultFor!, id: message.id,
      content: message.content, resultKind: message.resultKind ?? 'function' }
    const output = responseOutput(message), source = message.source
    return { kind: 'message', role: conversationRole(message), id: message.id, content: message.content,
      calls: message.kind === 'assistant' ? responseCalls(message) : [], output,
      ...(!output && (source?.contentFormat === 'portable' || message.kind === 'assistant' && source?.provider === 'anthropic') ? { portable: {
        blocks: conversationContentBlocks(message), nativeProvider: source?.provider === 'openai'
      } } : {}), reasoning: source?.extras.reasoning, refusal: source?.extras.refusal, toolOutputs: source?.extras.tool_outputs }
  }), options)
}

export function conversationAnthropicInput(messages: readonly ConversationMessage[]) {
  return anthropicInput(messages.map((message): AnthropicInputMessage => {
    // Custom Chat roles were not accepted by the imported Anthropic path.
    const role = message.kind === 'custom' ? 'generic' : conversationRole(message)
    if (role !== 'user' && role !== 'assistant' && role !== 'system' && role !== 'tool') throw new Error(`Unsupported Anthropic message role: ${role}`)
    return { role, content: message.kind === 'assistant' && (message.source?.contentFormat === 'portable' || message.source?.provider === 'openai')
      ? anthropicPortableContent(conversationContentBlocks(message), message.source?.provider === 'anthropic') : message.content,
      ...(message.kind === 'assistant' ? { calls: message.calls } : {}),
      ...(message.kind === 'tool' ? { toolCallId: message.resultFor, toolError: message.resultStatus === 'error' } : {}) }
  }))
}
