import type OpenAI from 'openai'
import { IncompleteModelResponseError } from '../runtime/errors'

type Fields = Record<string, unknown>
export type ResponseBlock = Fields & { type: string }
export type NativeResponse = OpenAI.Responses.Response
export type NativeResponseEvent = OpenAI.Responses.ResponseStreamEvent
type Item = NativeResponse['output'][number]

function record(value: unknown): Fields { return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {} }
function textParts(value: unknown): string { return Array.isArray(value) ? value.map(part => record(part).text ?? '').join('') : '' }

export function assertResponseSucceeded(response: NativeResponse): void {
  if (response.error || response.status === 'failed') {
    const error = new Error(response.error?.message ?? 'OpenAI Responses request failed.')
    error.name = response.error?.code ?? 'ResponseFailedError'
    throw error
  }
}

export function responseUsage(response: NativeResponse) {
  const usage = response.usage
  if (!usage || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return undefined
  return { input_tokens: usage.input_tokens, output_tokens: usage.output_tokens, total_tokens: usage.total_tokens,
    input_token_details: { ...(usage.input_tokens_details?.cached_tokens != null ? { cache_read: usage.input_tokens_details.cached_tokens } : {}),
      ...(usage.input_tokens_details?.cache_write_tokens != null ? { cache_creation: usage.input_tokens_details.cache_write_tokens } : {}) },
    output_token_details: { ...(usage.output_tokens_details?.reasoning_tokens != null ? { reasoning: usage.output_tokens_details.reasoning_tokens } : {}) } }
}

function annotation(value: unknown): ResponseBlock {
  const part = record(value)
  if (!['url_citation', 'file_citation', 'container_file_citation', 'file_path'].includes(String(part.type))) return { type: 'non_standard', value }
  return { type: 'citation', source: part.type,
    ...(part.url !== undefined ? { url: part.url } : {}),
    ...(part.title !== undefined || part.filename !== undefined ? { title: part.title ?? part.filename } : {}),
    ...(part.start_index !== undefined || part.index !== undefined ? { startIndex: part.start_index ?? part.index } : {}),
    ...(part.end_index !== undefined ? { endIndex: part.end_index } : {}),
    ...(part.file_id !== undefined ? { file_id: part.file_id } : {}),
    ...(part.container_id !== undefined ? { container_id: part.container_id } : {}) }
}

function tool(item: Fields, complete: boolean): ResponseBlock {
  const custom = item.type === 'custom_tool_call', computer = item.type === 'computer_call'
  const name = computer ? 'computer_use' : item.name
  const raw = custom ? JSON.stringify({ input: item.input }) : computer ? JSON.stringify({ action: item.action }) : item.arguments
  const identity = { ...(typeof item.call_id === 'string' ? { id: item.call_id } : {}), ...(typeof name === 'string' ? { name } : {}) }
  const extra = custom ? { isCustomTool: true } : computer ? { isComputerTool: true, action: item.action, pending_safety_checks: item.pending_safety_checks } : {}
  if (!complete) return { type: 'tool_call_chunk', ...identity, args: typeof raw === 'string' ? raw : '', ...extra }
  try {
    if (!identity.id || !identity.name) throw new Error('Tool calls require a provider ID and name.')
    if (custom && typeof item.input !== 'string') throw new Error('Custom tool input must be a string.')
    if (computer && !item.action) throw new Error('Computer tool call has no action.')
    const args = JSON.parse(typeof raw === 'string' ? raw : '')
    return { type: 'tool_call', ...identity, args, ...extra, ...(item.id ? { call_id: item.id } : {}) }
  } catch (error) {
    return { type: 'invalid_tool_call', ...identity, args: typeof raw === 'string' ? raw : '', error: error instanceof Error ? error.message : String(error), ...extra }
  }
}

/** Presentation is derived from native items; replay always uses the native output. */
export function responseItemBlocks(item: Item, complete = true, reasoning?: string): ResponseBlock[] {
  const raw = item as unknown as Fields
  switch (item.type) {
    case 'message': return item.content.map(part => part.type === 'output_text'
      ? { type: 'text', text: part.text, annotations: (part.annotations ?? []).map(annotation), ...(item.phase != null ? { phase: item.phase } : {}) }
      : { type: 'non_standard', value: part })
    case 'reasoning': {
      const text = textParts(raw.content) || reasoning || (complete ? textParts(item.summary) : '')
      return text ? [{ ...raw, type: 'reasoning', reasoning: text }] : []
    }
    case 'function_call': case 'custom_tool_call': case 'computer_call': return [tool(raw, complete)]
    case 'image_generation_call': return item.result ? [{ type: 'image', id: item.id, mimeType: 'image/png', data: item.result, metadata: { status: item.status } }] : []
    default: return []
  }
}

/** Native stream state is scoped to one inference and is never persisted separately. */
export class ResponsesAccumulator {
  private readonly items = new Map<number, Item>()
  private readonly done = new Set<number>()
  private readonly reasoning = new Map<number, string>()
  private readonly summaries = new Map<number, string>()
  private response?: NativeResponse
  private terminal?: NativeResponse

  accept(event: NativeResponseEvent): void {
    if (this.terminal) throw new Error('Responses sent data after a terminal response.')
    if (event.type === 'error') {
      const error = new Error(event.message)
      error.name = event.code ?? 'ResponseStreamError'
      throw error
    }
    if ('response' in event) {
      assertResponseSucceeded(event.response)
      this.response = event.response
      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        this.terminal = event.response
        this.items.clear()
        event.response.output.forEach((item, index) => { this.items.set(index, item); this.done.add(index) })
      }
      return
    }
    if (!('output_index' in event)) return
    const index = event.output_index
    if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
      this.items.set(index, structuredClone(event.item))
      if (event.type === 'response.output_item.done') this.done.add(index)
      return
    }
    let item = this.items.get(index) as unknown as Fields | undefined
    if (event.type === 'response.reasoning_text.delta') {
      this.reasoning.set(index, (this.reasoning.get(index) ?? '') + event.delta)
    }
    if (event.type.startsWith('response.reasoning')) {
      if (!item) { item = { type: 'reasoning', id: 'item_id' in event ? event.item_id : undefined, summary: [] }; this.items.set(index, item as unknown as Item) }
      if (event.type === 'response.reasoning_summary_text.delta') {
        this.summaries.set(index, (this.summaries.get(index) ?? '') + event.delta)
        const summary = item.summary as Fields[]
        const part = summary[event.summary_index] ??= { type: 'summary_text', text: '' }
        part.text = String(part.text ?? '') + event.delta
      }
      return
    }
    if (event.type === 'response.output_text.delta' || event.type === 'response.output_text.done' || event.type === 'response.output_text.annotation.added'
      || event.type === 'response.content_part.added' || event.type === 'response.content_part.done' || event.type === 'response.refusal.delta' || event.type === 'response.refusal.done') {
      if (!item) { item = { type: 'message', role: 'assistant', id: event.item_id, content: [] }; this.items.set(index, item as unknown as Item) }
      const content = item.content as Fields[]
      if (event.type === 'response.content_part.added' || event.type === 'response.content_part.done') content[event.content_index] = structuredClone(event.part) as unknown as Fields
      else {
        const refusal = event.type.startsWith('response.refusal')
        const part = content[event.content_index] ??= refusal ? { type: 'refusal', refusal: '' } : { type: 'output_text', text: '', annotations: [] }
        if (event.type === 'response.output_text.delta') part.text = String(part.text ?? '') + event.delta
        else if (event.type === 'response.output_text.done') part.text = event.text
        else if (event.type === 'response.refusal.delta') part.refusal = String(part.refusal ?? '') + event.delta
        else if (event.type === 'response.refusal.done') part.refusal = event.refusal
        else if (event.type === 'response.output_text.annotation.added') (part.annotations as unknown[])[event.annotation_index] = event.annotation
      }
    } else if (event.type === 'response.function_call_arguments.delta' || event.type === 'response.function_call_arguments.done'
      || event.type === 'response.custom_tool_call_input.delta' || event.type === 'response.custom_tool_call_input.done') {
      if (!item) throw new Error('Responses tool input has no output item.')
      const field = event.type.startsWith('response.function') ? 'arguments' : 'input'
      item[field] = 'delta' in event ? String(item[field] ?? '') + event.delta : 'arguments' in event ? event.arguments : event.input
    }
  }

  get id(): string | undefined { return this.response?.id }

  blocks(): Map<string, ResponseBlock> {
    const blocks = new Map<string, ResponseBlock>()
    for (const [index, item] of [...this.items].sort(([a], [b]) => a - b)) {
      const reasoning = this.reasoning.get(index) || (item.type === 'reasoning' && this.done.has(index) ? textParts(item.summary) || this.summaries.get(index) : undefined)
      responseItemBlocks(item, this.done.has(index), reasoning).forEach((block, part) => blocks.set(`${index}:${part}`, block))
    }
    return blocks
  }

  result(): NativeResponse {
    if (!this.terminal) throw new IncompleteModelResponseError()
    return this.terminal
  }
}

export async function collectResponses(source: AsyncIterable<NativeResponseEvent>, onEvent?: (event: NativeResponseEvent) => void | Promise<void>) {
  const accumulator = new ResponsesAccumulator()
  for await (const event of source) {
    accumulator.accept(event)
    await onEvent?.(event)
  }
  return { response: accumulator.result(), blocks: [...accumulator.blocks().values()] }
}

/** Native response facts; storage-specific metadata names belong to the caller. */
export function readOpenAiResponse(response: NativeResponse, blocks = response.output.flatMap(item => responseItemBlocks(item))) {
  assertResponseSucceeded(response)
  let refusal: unknown, parsed: unknown, reasoning: unknown
  const functionCallIds: Record<string, string> = {}, customCallIds: Record<string, string> = {}
  const toolOutputs: unknown[] = []
  for (const item of response.output) {
    if (item.type === 'message') for (const part of item.content) {
      if (part.type === 'refusal') refusal = part.refusal
      if ('parsed' in part && part.parsed != null) parsed = part.parsed
    }
    else if (item.type === 'function_call' || item.type === 'custom_tool_call') {
      const ids = item.type === 'function_call' ? functionCallIds : customCallIds
      if (item.id) (ids as Record<string, string>)[item.call_id] = item.id
    } else if (item.type === 'reasoning') reasoning = item
    else {
      toolOutputs.push(item)
    }
  }
  if (response.text?.format?.type === 'json_schema' && parsed === undefined) {
    const text = blocks.filter(block => block.type === 'text').map(block => block.text).join('')
    // Retain invalid text for the existing structured-output validator to report.
    if (text) try { parsed = JSON.parse(text) } catch { /* invalid JSON remains visible */ }
  }
  return { id: response.id, blocks, text: blocks.filter(block => block.type === 'text').map(block => block.text).join(''),
    calls: blocks.filter(block => block.type === 'tool_call'), invalidCalls: blocks.filter(block => block.type === 'invalid_tool_call'),
    refusal, parsed, reasoning, functionCallIds, customCallIds, toolOutputs, usage: responseUsage(response) }
}
