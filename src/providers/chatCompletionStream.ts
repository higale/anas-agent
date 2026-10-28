import type OpenAI from 'openai'
import { IncompleteModelResponseError } from '../runtime/errors'

type RecordValue = Record<string, unknown>
interface ChoiceState {
  fields: RecordValue
  message: RecordValue
  tools: Map<number, RecordValue>
}

function index(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid model stream choice or tool index.')
  return value
}

function append(target: RecordValue, key: string, value: unknown): void {
  if (typeof value === 'string') target[key] = String(target[key] ?? '') + value
  else if (value !== undefined && target[key] === undefined) target[key] = value
}

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as RecordValue : {}
}

/** Aggregate one inference, shared by complete and streaming graph consumers. */
export class ChatCompletionAccumulator {
  private readonly fields: RecordValue = {}
  private readonly choices = new Map<number, ChoiceState>()
  private usage?: OpenAI.CompletionUsage

  toolEntries(choiceIndex: number): Array<[number, RecordValue]> {
    return [...this.choices.get(choiceIndex)?.tools ?? []].sort(([a], [b]) => a - b)
  }

  accept(chunk: OpenAI.Chat.ChatCompletionChunk): void {
    const { choices: updates, usage: chunkUsage, object: _object, ...metadata } = chunk
    Object.assign(this.fields, metadata)
    if (chunkUsage) this.usage = chunkUsage
    for (const update of updates) {
      const choiceIndex = index(update.index)
      let state = this.choices.get(choiceIndex)
      if (!state) {
        state = { fields: { index: choiceIndex }, message: { role: 'assistant', content: null, refusal: null }, tools: new Map() }
        this.choices.set(choiceIndex, state)
      }
      const { delta, ...choiceFields } = update
      for (const [key, value] of Object.entries(choiceFields)) {
        if (key === 'logprobs' && value) {
          const current = record(state.fields.logprobs)
          for (const [part, entries] of Object.entries(value)) {
            current[part] = Array.isArray(entries) ? [...(Array.isArray(current[part]) ? current[part] : []), ...entries] : entries
          }
          state.fields.logprobs = current
          continue
        }
        if (value !== null && value !== undefined) state.fields[key] = value
      }
      const { tool_calls: toolCalls, function_call: functionCall, ...content } = delta
      for (const [key, value] of Object.entries(content)) {
        if (['content', 'refusal', 'reasoning_content', 'reasoning'].includes(key)) append(state.message, key, value)
        else if (key === 'audio' && value) {
          const audio = record(state.message.audio)
          for (const [field, part] of Object.entries(record(value))) {
            if (field === 'data' || field === 'transcript') append(audio, field, part)
            else audio[field] = part
          }
          state.message.audio = audio
        }
        else if (value !== undefined && value !== null) state.message[key] = value
      }
      if (functionCall) {
        const call = record(state.message.function_call)
        append(call, 'name', functionCall.name)
        append(call, 'arguments', functionCall.arguments)
        state.message.function_call = call
      }
      for (const fragment of toolCalls ?? []) {
        const toolIndex = index(fragment.index)
        const tool = state.tools.get(toolIndex) ?? {}
        const { index: _index, function: fn, custom, ...toolFields } = fragment
        for (const [key, value] of Object.entries(toolFields)) {
          // Compatible providers may repeat an empty id or name after the first frame.
          if (value !== '' && value !== undefined && value !== null) tool[key] = value
        }
        for (const [kind, value] of [['function', fn], ['custom', custom]] as const) {
          if (!value) continue
          const current = record(tool[kind])
          for (const [key, part] of Object.entries(value)) append(current, key, part)
          tool[kind] = current
        }
        state.tools.set(toolIndex, tool)
      }
    }
  }

  snapshot(): OpenAI.Chat.ChatCompletion {
    return {
      ...this.fields,
      object: 'chat.completion',
      choices: [...this.choices].sort(([a], [b]) => a - b).map(([, choice]) => ({
        ...choice.fields,
        message: { ...choice.message, ...(choice.tools.size ? {
          tool_calls: [...choice.tools].sort(([a], [b]) => a - b).map(([, tool]) => tool)
        } : {}) }
      })),
      ...(this.usage ? { usage: this.usage } : {})
    } as unknown as OpenAI.Chat.ChatCompletion
  }

  result(): OpenAI.Chat.ChatCompletion {
    if (!this.choices.size || [...this.choices.values()].some(choice => !choice.fields.finish_reason)) throw new IncompleteModelResponseError()
    return this.snapshot()
  }
}

export async function collectChatCompletion(
  source: AsyncIterable<OpenAI.Chat.ChatCompletionChunk>,
  onChunk?: (chunk: OpenAI.Chat.ChatCompletionChunk) => void | Promise<void>
): Promise<OpenAI.Chat.ChatCompletion> {
  const accumulator = new ChatCompletionAccumulator()
  for await (const chunk of source) {
    accumulator.accept(chunk)
    await onChunk?.(chunk)
  }
  return accumulator.result()
}
