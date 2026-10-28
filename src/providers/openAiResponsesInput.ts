import type OpenAI from 'openai'
import { chatContentPart, openAiToolImageContent } from './openAiChatInput'

// Protocol behavior informed by @langchain/openai 1.5.9 (MIT), rewritten for
// plain request data. See data/licenses/langchain/LICENSE.
export type ResponseInputItem = OpenAI.Responses.ResponseInputItem
type Item = Record<string, unknown> & { type: string }
type Fields = Record<string, unknown>

/** Request history only; execution and storage retain ownership of messages. */
export type ResponseHistoryEntry = {
  kind: 'result'
  callId: string
  id?: string
  content: string | readonly unknown[]
  resultKind: 'function' | 'custom' | 'computer'
} | {
  kind: 'message'
  role: string
  id?: string
  content: string | readonly unknown[]
  calls: ResponseToolCall[]
  output?: readonly Fields[]
  portable?: { blocks: readonly unknown[]; nativeProvider: boolean }
  reasoning?: unknown
  refusal?: unknown
  toolOutputs?: unknown
}

/** Select native replay, portable content and tool result forms once for the
 * entire request. This is also used by estimation and request identity. */
export function responseInput(history: readonly ResponseHistoryEntry[], options: { model: string; zeroRetention: boolean }): ResponseInputItem[] {
  const customCallIds = new Set<string>()
  for (const entry of history) {
    if (entry.kind !== 'message' || entry.role !== 'assistant') continue
    for (const call of entry.calls) if (call.kind === 'custom' && call.id) customCallIds.add(call.id)
    for (const item of entry.output ?? []) {
      if (item.type === 'custom_tool_call' && typeof item.call_id === 'string') customCallIds.add(item.call_id)
    }
  }
  return history.flatMap(entry => {
    if (entry.kind === 'result') return [responseToolResult({ callId: entry.callId, id: entry.id,
      content: openAiToolImageContent(entry.content, true)?.result ?? entry.content,
      kind: entry.resultKind === 'computer' ? 'computer' : customCallIds.has(entry.callId) ? 'custom' : entry.resultKind })]
    let role = entry.role
    if (role === 'function') throw new Error('Function messages are not supported by Responses.')
    if (!['assistant', 'user', 'system', 'developer'].includes(role)) throw new Error(`Unsupported Responses message role: ${role}`)
    if (role === 'system' && (/^o\d/.test(options.model) || (options.model.startsWith('gpt-5') && !options.model.startsWith('gpt-5-chat')))) role = 'developer'
    if (role === 'assistant' && entry.output) return responseReplay(entry.output, options.zeroRetention)
    if (entry.portable) return responsePortableInput(role, entry.portable.blocks, {
      nativeProvider: entry.portable.nativeProvider, zeroRetention: options.zeroRetention, calls: entry.calls
    })
    if (role !== 'assistant') return responseUserInput(role, entry.content)
    return responseAssistantInput(entry, options.zeroRetention)
  })
}

function record(value: unknown): Fields | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined
}

function json(value: unknown): string {
  return typeof value === 'string' ? value : JSON.stringify(value ?? {})
}

function annotation(value: unknown): unknown {
  const item = record(value)
  if (!item) return value
  if (item.type === 'non_standard') return item.value
  if (item.type !== 'citation') return item
  switch (item.source) {
    case 'url_citation': return { type: item.source, url: item.url ?? '', title: item.title ?? '', start_index: item.startIndex ?? 0, end_index: item.endIndex ?? 0 }
    case 'file_citation': return { type: item.source, file_id: item.file_id ?? '', filename: item.title ?? '', index: item.startIndex ?? 0 }
    case 'container_file_citation': return { type: item.source, file_id: item.file_id ?? '', filename: item.title ?? '', container_id: item.container_id ?? '', start_index: item.startIndex ?? 0, end_index: item.endIndex ?? 0 }
    case 'file_path': return { type: item.source, file_id: item.file_id ?? '', index: item.startIndex ?? 0 }
    default: return item
  }
}

/** Responses supports remote files and uploaded image IDs as well as inline media. */
export function responseInputContent(value: unknown): Item | undefined {
  const block = record(value)
  if (!block) return undefined
  const metadata = record(block.metadata)
  const source = block.source_type
  if (block.type === 'text' || block.type === 'text-plain') return { type: 'input_text', text: block.text }
  if (block.type === 'image_url') {
    const image = record(block.image_url)
    return { type: 'input_image', image_url: image?.url ?? block.image_url, detail: image?.detail ?? 'auto' }
  }
  if (block.type === 'image') {
    const detail = metadata?.detail ?? block.detail ?? 'auto'
    const id = source === 'id' ? block.id : source === undefined ? block.fileId : undefined
    if (typeof id === 'string') return { type: 'input_image', file_id: id, detail }
    if (source !== undefined && source !== 'url' && source !== 'base64') throw new Error('Invalid Responses image source.')
    if (source !== 'base64' && typeof block.url === 'string') return { type: 'input_image', image_url: block.url, detail }
    if (source !== 'url' && block.data !== undefined) return { type: 'input_image', detail,
      image_url: `data:${block.mime_type ?? block.mimeType ?? 'image/png'};base64,${base64(block.data)}` }
    throw new Error('Responses images require a URL, uploaded file ID or base64 content.')
  }
  if (block.type === 'file' || block.type === 'video') {
    const filename = metadata?.filename ?? metadata?.name ?? metadata?.title
    const name = filename === undefined ? {} : { filename }
    const id = source === 'id' ? block.id : source === undefined ? block.fileId : undefined
    if (typeof id === 'string') return { type: 'input_file', file_id: id, ...name }
    if (source !== undefined && source !== 'url' && source !== 'base64') throw new Error('Invalid Responses file source.')
    if (source !== 'base64' && typeof block.url === 'string') return { type: 'input_file', file_url: block.url, ...name }
    if (source !== 'url' && block.data !== undefined) return { type: 'input_file', filename: filename ?? 'attachment',
      file_data: `data:${block.mime_type ?? block.mimeType ?? 'application/octet-stream'};base64,${base64(block.data)}` }
    throw new Error('Responses files require a URL, uploaded file ID or base64 content.')
  }
  if (['input_text', 'input_image', 'input_file'].includes(String(block.type))) return block as Item
  if (block.type === 'audio') return chatContentPart(block) as Item
  return undefined
}

function base64(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('base64')
  throw new Error('Media content must be base64 text or binary bytes.')
}

export function responseToolResult(input: { callId: string; id?: string; kind: 'function' | 'custom' | 'computer'; content: string | readonly unknown[] }): ResponseInputItem {
  let output: unknown = input.content
  if (input.kind === 'computer') {
    output = typeof input.content === 'string' ? { type: 'input_image', image_url: input.content }
      : input.content.find(item => record(item)?.type === 'input_image')
        ?? input.content.find(item => record(item)?.type === 'computer_screenshot')
        ?? input.content.map(responseInputContent).find(item => item?.type === 'input_image')
    if (!output) throw new Error('Invalid computer call output: a screenshot is required.')
  } else if (input.kind === 'function' && Array.isArray(input.content)
    && !input.content.every(item => ['input_text', 'input_image', 'input_file'].includes(String(record(item)?.type)))) {
    output = JSON.stringify(input.content)
  }
  return { type: input.kind === 'custom' ? 'custom_tool_call_output' : `${input.kind}_call_output`, call_id: input.callId, output,
    ...(input.kind === 'function' && input.id?.startsWith('fc_') ? { id: input.id } : {}) } as ResponseInputItem
}

export function responseUserInput(role: string, content: string | readonly unknown[]): ResponseInputItem[] {
  if (typeof content === 'string') return [{ type: 'message', role, content } as ResponseInputItem]
  const items: Item[] = []
  const parts: Item[] = []
  for (const value of content) {
    const block = record(value)
    if (block?.type === 'mcp_approval_response') items.push({ type: 'mcp_approval_response', approval_request_id: block.approval_request_id, approve: block.approve })
    else { const part = responseInputContent(value); if (part) parts.push(part) }
  }
  if (parts.length) items.push({ type: 'message', role, content: parts })
  return items as ResponseInputItem[]
}

export interface ResponseToolCall {
  kind: 'function' | 'custom' | 'computer'
  id?: string
  itemId?: string
  name: string
  args: unknown
  argumentsText?: string
}

export function responseToolCall(call: ResponseToolCall, zeroRetention: boolean): Item {
  const args = record(call.args)
  if (call.kind === 'custom') return { type: 'custom_tool_call', call_id: call.id ?? '', name: call.name, input: args?.input,
    ...(!zeroRetention && call.itemId !== undefined ? { id: call.itemId } : {}) }
  if (call.kind === 'computer') return { type: 'computer_call', call_id: call.id ?? '', action: args?.action,
    ...(!zeroRetention && call.itemId !== undefined ? { id: call.itemId } : {}) }
  return { type: 'function_call', call_id: call.id, name: call.name, arguments: call.argumentsText ?? JSON.stringify(call.args),
    ...(!zeroRetention && call.itemId !== undefined ? { id: call.itemId } : {}) }
}

/** Exact provider output takes precedence over the visible presentation. */
export function responseReplay(output: readonly unknown[], zeroRetention: boolean): ResponseInputItem[] {
  return output.flatMap(value => {
    const fields = record(value)
    if (!fields || typeof fields.type !== 'string') throw new Error('Invalid Responses replay item.')
    const item = fields as Item
    if (!zeroRetention) return [item]
    // Server-side identifiers cannot restore state in zero-retention mode.
    // Encrypted reasoning remains self-contained; visible summaries alone do not.
    if (item.type === 'item_reference' || (item.type === 'reasoning' && !item.encrypted_content)) return []
    if (['message', 'reasoning', 'function_call', 'custom_tool_call'].includes(item.type)) {
      const { id: _id, ...selfContained } = item
      return [selfContained]
    }
    return [item]
  }) as ResponseInputItem[]
}

export function responseAssistantInput(input: {
  id?: string; content: string | readonly unknown[]; calls: ResponseToolCall[]; reasoning?: unknown; refusal?: unknown; toolOutputs?: unknown
}, zeroRetention: boolean): ResponseInputItem[] {
  const items: Item[] = []
  const reasoning = record(input.reasoning)
  if (reasoning && (!zeroRetention || reasoning.encrypted_content)) {
    const summary: Fields[] = []
    let previousIndex: unknown
    for (const part of Array.isArray(reasoning.summary) ? reasoning.summary : []) {
      const entry = record(part)
      if (!entry) continue
      const { index, ...value } = entry
      if (summary.length && index === previousIndex) summary[summary.length - 1].text = String(summary.at(-1)?.text ?? '') + String(value.text ?? '')
      else summary.push({ ...value })
      previousIndex = index
    }
    items.push(...responseReplay([{ ...reasoning, type: 'reasoning', summary }], zeroRetention) as Item[])
  }
  let content: string | readonly unknown[] = input.content
  if (input.refusal) content = [...(typeof content === 'string' ? [{ type: 'output_text', text: content, annotations: [] }] : content), { type: 'refusal', refusal: input.refusal }]
  if (typeof content === 'string' || content.length) {
    const parts = typeof content === 'string' ? content : content.flatMap(value => {
      const block = record(value)
      if (block?.type === 'text') return [{ type: 'output_text', text: block.text, annotations: Array.isArray(block.annotations) ? block.annotations.map(annotation) : [] }]
      return block?.type === 'output_text' || block?.type === 'refusal' ? [block] : []
    })
    const phase = Array.isArray(content) ? content.map(record).find(block => typeof block?.phase === 'string')?.phase : undefined
    items.push({ type: 'message', role: 'assistant', content: parts,
      ...(!zeroRetention && input.id?.startsWith('msg_') ? { id: input.id } : {}), ...(phase !== undefined ? { phase } : {}) })
  }
  items.push(...input.calls.map(call => responseToolCall(call, zeroRetention)))
  if (Array.isArray(input.toolOutputs)) items.push(...input.toolOutputs.filter(value => ['computer_call', 'mcp_call', 'code_interpreter_call', 'image_generation_call', 'shell_call', 'local_shell_call'].includes(String(record(value)?.type))) as Item[])
  return items as ResponseInputItem[]
}

/** Ordered portable content used when changing providers or replaying older messages. */
export function responsePortableInput(role: string, blocks: readonly unknown[], options: { nativeProvider: boolean; zeroRetention: boolean; calls?: ResponseToolCall[] }): ResponseInputItem[] {
  const items: Item[] = []
  let current: Item | undefined
  const completedCalls = new Set<string>()
  const chunks = new Map<string, { name: string; args: string[] }>()
  const calls = new Map(options.calls?.map(call => [call.id, call]))
  const flush = () => { if (current) items.push(current); current = undefined }
  const add = (part: Item, phase?: unknown) => {
    current ??= { type: 'message', role, content: [], ...(phase !== undefined ? { phase } : {}) }
    ;(current.content as Item[]).push(part)
  }
  for (const value of blocks) {
    const block = record(value)
    if (!block) continue
    if (block.type === 'text' || block.type === 'text-plain') {
      add(role === 'assistant' ? { type: 'output_text', text: block.text, annotations: [] } : { type: 'input_text', text: block.text }, record(block.extras)?.phase)
    } else if (block.type === 'reasoning') {
      flush()
      const entries = Array.isArray(block.summary) ? block.summary.map(record).filter(item => typeof item?.text === 'string').map(item => item!.text) : []
      const summary = (entries.length ? entries : [block.reasoning ?? '']).map(text => ({ type: 'summary_text', text }))
      const encrypted = block.encrypted_content ?? record(block.extras)?.encrypted_content
      items.push(...responseReplay([{ type: 'reasoning', ...(block.id ? { id: block.id } : {}), summary,
        ...(encrypted !== undefined ? { encrypted_content: encrypted } : {}) }], options.zeroRetention) as Item[])
    } else if (block.type === 'tool_call' || block.type === 'server_tool_call') {
      flush()
      const id = String(block.id ?? '')
      if (id) { completedCalls.add(id); chunks.delete(id) }
      items.push(responseToolCall(calls.get(id) ?? { kind: 'function', id, name: String(block.name ?? ''), args: block.args,
        argumentsText: typeof block.args === 'string' ? block.args : undefined }, options.zeroRetention))
    } else if (block.type === 'tool_call_chunk' || block.type === 'server_tool_call_chunk') {
      if (typeof block.id !== 'string' || !block.id) continue
      const chunk = chunks.get(block.id) ?? { name: '', args: [] }
      if (typeof block.name === 'string' && block.name) chunk.name = block.name
      if (typeof block.args === 'string') chunk.args.push(block.args)
      chunks.set(block.id, chunk)
    } else if (block.type === 'server_tool_call_result') {
      flush()
      const status = block.status === 'success' ? 'completed' : block.status === 'error' ? 'incomplete' : undefined
      items.push({ type: 'function_call_output', call_id: block.toolCallId ?? '', output: json(block.output), ...(status ? { status } : {}) })
    } else if (block.type === 'non_standard' && options.nativeProvider) {
      flush()
      items.push(...responseReplay([block.value], options.zeroRetention) as Item[])
    } else {
      const part = responseInputContent(block)
      if (part) add(part)
    }
  }
  flush()
  for (const [id, chunk] of chunks) if (!completedCalls.has(id) && (chunk.name || chunk.args.length)) {
    items.push({ type: 'function_call', call_id: id, name: chunk.name, arguments: chunk.args.join('') })
  }
  return items as ResponseInputItem[]
}
