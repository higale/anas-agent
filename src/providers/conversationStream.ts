import type OpenAI from 'openai'
import type { ModelToolInputProgress } from '../runtime/modelEvents'
import { ChatCompletionAccumulator } from './chatCompletionStream'
import { chatResponseBlocks } from './openAiChatOutput'
import { ResponsesAccumulator, type NativeResponseEvent } from './openAiResponsesOutput'
import { AnthropicResponseAccumulator, type AnthropicNativeEvent } from './anthropicStream'
import { anthropicResponseBlock } from './anthropicOutput'
import { anthropicConversationResponse, openAiChatConversationResponses, openAiResponsesConversationResponse } from './conversationOutput'

export type ConversationProgress =
  | { kind: 'delta'; channel: 'text' | 'reasoning'; text: string }
  | { kind: 'tool_input'; progress: ModelToolInputProgress }
export type ObserveConversationProgress = (event: ConversationProgress) => void
type Block = Record<string, unknown> & { type: string }

/** Only display metadata leaves the stream. Complete responses, including
 * provider corrections to earlier text, remain authoritative. */
class Progress {
  private readonly blocks = new Map<string, { index: number; block: Block }>()
  constructor(private readonly observe: ObserveConversationProgress) {}

  accept(key: string, block: Block, complete = false): void {
    const previous = this.blocks.get(key), index = previous?.index ?? this.blocks.size
    if (block.type === 'text' || block.type === 'reasoning') {
      const channel = block.type, before = String(previous?.block[channel] ?? ''), after = String(block[channel] ?? '')
      if (after.startsWith(before) && after.length > before.length) this.observe({ kind: 'delta', channel, text: after.slice(before.length) })
    } else if (['tool_call_chunk', 'tool_call', 'invalid_tool_call'].includes(block.type)) {
      this.observe({ kind: 'tool_input', progress: { index,
        ...(typeof block.id === 'string' && block.id ? { callId: block.id } : {}),
        ...(typeof block.name === 'string' && block.name ? { name: block.name } : {}),
        ...(typeof block.args === 'string' ? { characterCount: block.args.length } : {}),
        complete, streamed: block.type === 'tool_call_chunk' } })
    }
    this.blocks.set(key, { index, block })
  }
}

export async function streamChatConversation(source: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>, observe: ObserveConversationProgress) {
  const accumulator = new ChatCompletionAccumulator(), progress = new Progress(observe)
  for await (const frame of source) {
    accumulator.accept(frame)
    const choice = accumulator.snapshot().choices.find(choice => choice.index === 0)
    if (!choice || !frame.choices.some(choice => choice.index === 0)) continue
    for (const [key, block] of chatResponseBlocks(choice.message, false, accumulator.toolEntries(0))) progress.accept(key, block)
  }
  const response = accumulator.result(), primary = response.choices.findIndex(choice => choice.index === 0)
  if (primary < 0) throw new Error('Chat Completions stream did not contain the primary choice.')
  for (const [key, block] of chatResponseBlocks(response.choices[primary].message, true, accumulator.toolEntries(0))) progress.accept(key, block, true)
  return openAiChatConversationResponses(response)[primary]
}

export async function streamResponsesConversation(source: AsyncIterable<NativeResponseEvent>, observe: ObserveConversationProgress) {
  const accumulator = new ResponsesAccumulator(), progress = new Progress(observe)
  for await (const frame of source) {
    accumulator.accept(frame)
    for (const [key, block] of accumulator.blocks()) progress.accept(key, block)
  }
  const response = accumulator.result(), blocks = accumulator.blocks()
  for (const [key, block] of blocks) progress.accept(key, block, true)
  return openAiResponsesConversationResponse(response, [...blocks.values()])
}

export async function streamAnthropicConversation(source: AsyncIterable<AnthropicNativeEvent>, observe: ObserveConversationProgress) {
  const accumulator = new AnthropicResponseAccumulator(), progress = new Progress(observe)
  for await (const frame of source) {
    accumulator.accept(frame)
    if (!('index' in frame)) continue
    const block = accumulator.message?.content[frame.index]
    if (!block) continue
    const complete = frame.type === 'content_block_stop'
    const fields = anthropicResponseBlock(block as unknown as Record<string, unknown>, frame.index, complete) as Block
    const input = accumulator.inputText(frame.index)
    if (!complete && input !== undefined) fields.args = input
    progress.accept(String(frame.index), fields, complete)
  }
  return anthropicConversationResponse(accumulator.result())
}
