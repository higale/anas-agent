import type { ChatModelStreamEvent } from '@langchain/core/language_models/event'
import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages'
import {
  convertMessagesToResponsesInput,
  convertOpenAIResponsesStream,
  convertResponsesMessageToAIMessage,
  type ConvertOpenAIResponsesStreamOptions,
  type ResponsesInputItem
} from '@langchain/openai'
import type OpenAI from 'openai'

type ResponsesStreamEvent = OpenAI.Responses.ResponseStreamEvent

interface ReasoningItem extends Record<string, unknown> {
  type: 'reasoning'
  id?: string
  summary?: unknown[]
  content?: unknown[]
}

interface ReasoningState {
  id?: string
  item?: ReasoningItem
  summaryDeltas: string[]
  visibleCharacters: number
}

interface StreamNormalizationState {
  activeReasoningOutputIndex?: number
  blockOutputIndices: Map<number, number>
  response?: OpenAI.Responses.Response
  reasoning: Map<number, ReasoningState>
  customCalls: Map<string, OpenAI.Responses.ResponseCustomToolCall>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function isReasoningItem(value: unknown): value is ReasoningItem {
  return isRecord(value) && value.type === 'reasoning'
}

function responseOutput(message: BaseMessage): ResponsesInputItem[] | undefined {
  if (!AIMessage.isInstance(message)) return undefined
  const output = (message.response_metadata as Record<string, unknown> | undefined)?.output
  if (
    !Array.isArray(output)
    || output.length === 0
    || !output.every((item) => isRecord(item) && typeof item.type === 'string')
  ) return undefined
  return output as ResponsesInputItem[]
}

/**
 * Native ChatModelStream messages use output_version=v1, which normally makes
 * LangChain reconstruct Responses input from visible content blocks. Prefer the
 * exact provider output whenever it is available so reasoning ids, encrypted
 * content, and provider tool items survive the next model call.
 */
export function convertOpenAICompatibleMessagesToResponsesInput(options: {
  messages: BaseMessage[]
  model: string
  zdrEnabled: boolean
}): ResponsesInputItem[] {
  return convertMessagesToResponsesInput({
    ...options,
    messages: prepareOpenAICompatibleResponsesMessages(options.messages, options.zdrEnabled)
  })
}

/** Select the SDK's raw-output replay path for requests without changing checkpoint messages. */
export function prepareOpenAICompatibleResponsesMessages(messages: BaseMessage[], zdrEnabled: boolean): BaseMessage[] {
  const customCallIds = new Set<string>()
  for (const message of messages) {
    for (const item of responseOutput(message) ?? []) {
      if (item.type === 'custom_tool_call') customCallIds.add(item.call_id)
    }
    if (AIMessage.isInstance(message)) {
      for (const call of message.tool_calls ?? []) {
        if ('isCustomTool' in call && call.isCustomTool === true && call.id) customCallIds.add(call.id)
      }
    }
  }
  return messages.map((message) => {
    // Execution and recovery use ordinary LangChain ToolMessages. Mark the
    // outbound transport from the originating call, including error results.
    if (ToolMessage.isInstance(message) && customCallIds.has(message.tool_call_id)) {
      const { output_version: _version, ...responseMetadata } = message.response_metadata
      return new ToolMessage({ ...message, content: message.content,
        response_metadata: responseMetadata, additional_kwargs: { ...message.additional_kwargs, customTool: true } })
    }
    const metadata = message.response_metadata as Record<string, unknown>
    if (zdrEnabled && AIMessage.isInstance(message) && metadata.output_version === 'v1') {
      const calls = new Map((responseOutput(message) ?? []).flatMap((item) =>
        item.type === 'custom_tool_call' ? [[item.call_id, item] as const] : []))
      if (calls.size) return new AIMessage({ ...message, tool_calls: [],
        content: message.contentBlocks.map((block) => {
          const call = block.type === 'tool_call' && block.id ? calls.get(block.id) : undefined
          if (!call) return block
          const { id: _id, ...value } = call
          return { type: 'non_standard', value }
        }) })
    }
    if (zdrEnabled || !responseOutput(message) || metadata.output_version !== 'v1') return message
    const { output_version: _version, ...responseMetadata } = metadata
    return new AIMessage({
      ...message,
      content: message.content,
      response_metadata: responseMetadata
    })
  })
}

function reasoningState(
  state: StreamNormalizationState,
  outputIndex: number
): ReasoningState {
  const existing = state.reasoning.get(outputIndex)
  if (existing) return existing
  const created: ReasoningState = {
    summaryDeltas: [],
    visibleCharacters: 0
  }
  state.reasoning.set(outputIndex, created)
  return created
}

function textParts(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((part) =>
        isRecord(part) && typeof part.text === 'string' && part.text
          ? [part.text]
          : []
      )
    : []
}

function reasoningDeltaEvent(
  event: Extract<ResponsesStreamEvent, { type: 'response.reasoning_text.delta' }>
): ResponsesStreamEvent {
  return {
    ...event,
    type: 'response.reasoning_summary_text.delta',
    summary_index: event.content_index
  } as ResponsesStreamEvent
}

function completedReasoningDelta(
  item: ReasoningItem,
  outputIndex: number,
  summaryIndex: number,
  text: string,
  sequenceNumber: number
): ResponsesStreamEvent {
  return {
    type: 'response.reasoning_summary_text.delta',
    item_id: item.id ?? `reasoning_${outputIndex}`,
    output_index: outputIndex,
    summary_index: summaryIndex,
    delta: text,
    sequence_number: sequenceNumber
  } as ResponsesStreamEvent
}

async function *normalizedResponsesEvents(
  source: AsyncIterable<ResponsesStreamEvent>,
  state: StreamNormalizationState
): AsyncGenerator<ResponsesStreamEvent> {
  const emitCompletedReasoning = async function *(
    item: ReasoningItem,
    outputIndex: number,
    sequenceNumber: number
  ): AsyncGenerator<ResponsesStreamEvent> {
    const current = reasoningState(state, outputIndex)
    current.id = item.id ?? current.id
    current.item = item
    if (current.visibleCharacters > 0) return
    const contentParts = textParts(item.content)
    const parts = contentParts.length > 0
      ? contentParts
      : textParts(item.summary).length > 0
        ? textParts(item.summary)
        : current.summaryDeltas
    for (let index = 0; index < parts.length; index += 1) {
      const text = parts[index]
      current.visibleCharacters += text.length
      state.activeReasoningOutputIndex = outputIndex
      yield completedReasoningDelta(item, outputIndex, index, text, sequenceNumber)
      state.activeReasoningOutputIndex = undefined
    }
  }

  for await (const event of source) {
    if (event.type === 'response.output_item.done' && event.item.type === 'custom_tool_call') {
      state.customCalls.set(event.item.call_id, event.item)
    }
    if (event.type === 'response.output_item.added' && isReasoningItem(event.item)) {
      const current = reasoningState(state, event.output_index)
      current.id = event.item.id ?? current.id
      current.item = event.item
      yield event
      continue
    }

    if (event.type === 'response.reasoning_text.delta') {
      const current = reasoningState(state, event.output_index)
      current.id = event.item_id || current.id
      if (event.delta) {
        current.visibleCharacters += event.delta.length
        state.activeReasoningOutputIndex = event.output_index
        yield reasoningDeltaEvent(event)
        state.activeReasoningOutputIndex = undefined
      }
      // Preserve the original event as provider telemetry. LangChain does not
      // otherwise map it to a standard content block.
      yield event
      continue
    }

    if (event.type === 'response.reasoning_summary_text.delta') {
      const current = reasoningState(state, event.output_index)
      current.id = event.item_id || current.id
      if (event.delta) current.summaryDeltas.push(event.delta)
      // Summary deltas are buffered until the item completes. Providers may
      // emit them before reasoning_text; the full reasoning must remain the body.
      continue
    }

    if (event.type === 'response.output_item.done' && isReasoningItem(event.item)) {
      yield* emitCompletedReasoning(
        event.item,
        event.output_index,
        event.sequence_number
      )
      yield event
      continue
    }

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      for (let index = 0; index < event.response.output.length; index += 1) {
        const item = event.response.output[index]
        if (!isReasoningItem(item)) continue
        yield* emitCompletedReasoning(item, index, event.sequence_number)
      }
      state.response = event.response
      yield event
      continue
    }

    yield event
  }
}

function reasoningBlockFields(
  state: StreamNormalizationState,
  blockIndex: number
): Record<string, unknown> {
  const outputIndex = state.blockOutputIndices.get(blockIndex)
  if (outputIndex === undefined) return {}
  const reasoning = state.reasoning.get(outputIndex)
  const item = reasoning?.item
  return {
    ...(reasoning?.id ? { id: reasoning.id } : {}),
    ...(item?.summary ? { summary: item.summary } : {}),
    ...(typeof item?.encrypted_content === 'string'
      ? { encrypted_content: item.encrypted_content }
      : {}),
    ...(typeof item?.status === 'string' ? { status: item.status } : {})
  }
}

/**
 * Completes LangChain's native Responses stream conversion with both standard
 * reasoning event families, final reasoning items, and generated images.
 */
export async function *convertOpenAICompatibleResponsesStream(
  source: AsyncIterable<ResponsesStreamEvent>,
  options: ConvertOpenAIResponsesStreamOptions = {}
): AsyncGenerator<ChatModelStreamEvent> {
  const state: StreamNormalizationState = {
    blockOutputIndices: new Map(),
    reasoning: new Map(),
    customCalls: new Map()
  }
  const normalized = normalizedResponsesEvents(source, state)
  let nextBlockIndex = 0
  for await (const event of convertOpenAIResponsesStream(normalized, options)) {
    if ('index' in event) nextBlockIndex = Math.max(nextBlockIndex, event.index + 1)
    if (event.event === 'content-block-finish' && 'id' in event.content && typeof event.content.id === 'string') {
      const call = state.customCalls.get(event.content.id)
      if (call) {
        // The SDK streams freeform text but finalizes it with its JSON parser.
        // Keep native block allocation/progress and adapt only the final args.
        yield { ...event, content: { type: 'tool_call', id: call.call_id, name: call.name, args: { input: call.input } } }
        continue
      }
    }
    if (
      event.event === 'content-block-start'
      && event.content.type === 'reasoning'
      && state.activeReasoningOutputIndex !== undefined
    ) {
      state.blockOutputIndices.set(event.index, state.activeReasoningOutputIndex)
      yield {
        ...event,
        content: {
          ...event.content,
          ...reasoningBlockFields(state, event.index)
        }
      }
      continue
    }
    if (event.event === 'content-block-finish' && event.content.type === 'reasoning') {
      yield {
        ...event,
        content: {
          ...event.content,
          ...reasoningBlockFields(state, event.index)
        }
      }
      continue
    }
    if (event.event === 'message-finish' && state.response) {
      // The SDK stream converter emits image-generation items only as provider
      // events. Reuse its completed-response conversion for visible image blocks,
      // after it has finished allocating indices for text, reasoning, and tools.
      const images = state.response.output.filter((item) => item.type === 'image_generation_call')
      if (images.length) {
        const message = convertResponsesMessageToAIMessage({ ...state.response, output: images })
        for (const content of message.contentBlocks) {
          if (content.type !== 'image') continue
          const index = nextBlockIndex++
          yield { event: 'content-block-start', index, content }
          yield { event: 'content-block-finish', index, content }
        }
      }
      yield {
        ...event,
        responseMetadata: {
          ...event.responseMetadata,
          output: state.response.output
        }
      }
      continue
    }
    yield event
  }
}
