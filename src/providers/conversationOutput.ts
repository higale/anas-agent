import type OpenAI from 'openai'
import type { ConversationMessage, ConversationToolCall } from '../runtime/conversationMessage'
import { readChatCompletion } from './openAiChatOutput'
import { readOpenAiResponse, responseItemBlocks, type NativeResponse, type ResponseBlock } from './openAiResponsesOutput'
import { readAnthropicResponse } from './anthropicOutput'
import type { AnthropicNativeMessage } from './anthropicStream'

type Fields = Record<string, unknown>
type Completion = OpenAI.Chat.ChatCompletion

export interface ConversationResponse {
  text: string
  message: ConversationMessage
}

function calls(blocks: Fields[]): ConversationToolCall[] {
  return blocks.map(({ id, name, args, isCustomTool, isComputerTool, call_id, ...extensions }) => ({
    id: id as string | undefined, name: name as string, args,
    ...(isCustomTool === true ? { kind: 'custom' as const } : isComputerTool === true ? { kind: 'computer' as const } : {}),
    ...(call_id === undefined ? {} : { itemId: call_id }),
    ...(Object.keys(extensions).length ? { extensions } : {})
  }))
}

export function openAiChatResponseMetadata(response: Completion, choice: Completion['choices'][number]): Fields {
  const { choices: _choices, ...rest } = response
  return { ...rest, model_name: response.model, finish_reason: choice.finish_reason,
    ...(choice.logprobs ? { logprobs: choice.logprobs } : {}),
    ...(choice.message.function_call ? { function_call: choice.message.function_call } : {}),
    ...(choice.message.audio ? { audio: { id: choice.message.audio.id, expires_at: choice.message.audio.expires_at } } : {}),
    ...(choice.message.refusal ? { refusal: choice.message.refusal } : {}) }
}

/** Complete provider responses become application data before any UI or graph
 * projection. Raw provider fields remain available for exact protocol replay. */
export function openAiChatConversationResponses(response: Completion, includeRawResponse = false): ConversationResponse[] {
  const decoded = readChatCompletion(response)
  return decoded.candidates.map(candidate => {
    const { choice, role, text, content } = candidate
    if (role !== 'assistant') return { text, message: { kind: 'custom', role, content: text } }
    const { role: _role, content: _content, ...additional } = choice.message
    return { text, message: {
      id: response.id, kind: 'assistant', content, calls: calls(candidate.calls), invalidCalls: candidate.invalidCalls, usage: decoded.usage,
      source: { provider: 'openai', ...(Array.isArray(content) ? { contentFormat: 'portable' as const } : {}),
        metadata: openAiChatResponseMetadata(response, choice),
        extras: { ...additional, ...(includeRawResponse ? { __raw_response: response } : {}) } }
    } }
  })
}

export function openAiResponsesResponseMetadata(response: NativeResponse): Fields {
  const { output_text: _text, output_parsed: _parsed, usage: _usage, ...fields } = response as NativeResponse & { output_parsed?: unknown }
  return { ...fields, output: response.output.map(item => {
    if (item.type !== 'function_call') return item
    const { parsed_arguments: _parsed, ...native } = item as typeof item & { parsed_arguments?: unknown }
    return native
  }), model_name: response.model }
}

export function openAiResponsesConversationResponse(response: NativeResponse,
  blocks: ResponseBlock[] = response.output.flatMap(item => responseItemBlocks(item))): ConversationResponse {
  const decoded = readOpenAiResponse(response, blocks)
  const extras: Fields = {}
  if (decoded.refusal !== undefined) extras.refusal = decoded.refusal
  if (decoded.parsed !== undefined) extras.parsed = decoded.parsed
  if (decoded.reasoning !== undefined) extras.reasoning = decoded.reasoning
  if (decoded.toolOutputs.length) extras.tool_outputs = decoded.toolOutputs
  return { text: decoded.text, message: {
    id: decoded.id, kind: 'assistant', content: blocks, calls: calls(decoded.calls), invalidCalls: decoded.invalidCalls, usage: decoded.usage,
    source: { provider: 'openai', contentFormat: 'portable', metadata: openAiResponsesResponseMetadata(response), extras,
      ...(response.output.some(item => item.type === 'function_call') ? { functionItemIds: decoded.functionCallIds } : {}),
      ...(response.output.some(item => item.type === 'custom_tool_call') ? { customItemIds: decoded.customCallIds } : {}) }
  } }
}

export function anthropicConversationResponse(response: AnthropicNativeMessage): ConversationResponse {
  const decoded = readAnthropicResponse(response)
  return { text: decoded.text, message: {
    id: decoded.id, kind: 'assistant', content: decoded.content, calls: calls(decoded.calls), invalidCalls: decoded.invalidCalls, usage: decoded.usage,
    source: { provider: 'anthropic', metadata: decoded.metadata, extras: decoded.metadata }
  } }
}
