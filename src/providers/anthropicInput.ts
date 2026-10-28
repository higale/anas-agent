import type Anthropic from '@anthropic-ai/sdk'

// Product protocol behavior informed by @langchain/anthropic 1.5.10 (MIT).
// The payload and media mapping operate on plain data, without message classes.
type Block = Record<string, unknown> & { type: string }
type Fields = Record<string, unknown>
export interface AnthropicInputCall { id?: string; name: string; args: unknown }
export interface AnthropicInputMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | readonly unknown[]
  calls?: readonly AnthropicInputCall[]
  toolCallId?: string
  toolError?: boolean
}

function record(value: unknown): Fields | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : undefined
}

function encoded(data: unknown): string {
  if (typeof data === 'string') return data
  if (data instanceof Uint8Array) return Buffer.from(data).toString('base64')
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('base64')
  throw new Error('Anthropic media must contain base64 text or binary bytes.')
}

function imageSource(url: string): Fields {
  const match = /^data:([^;,]+);base64,([\s\S]*)$/i.exec(url)
  if (match) return { type: 'base64', media_type: match[1], data: match[2] }
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Anthropic image URLs must use HTTP, HTTPS or base64 data.')
  return { type: 'url', url }
}

function metadata(block: Fields, keys: string[]): Fields {
  const source = record(block.metadata)
  const selected: Fields = {}
  for (const key of keys) {
    const value = block[key] ?? source?.[key]
    if (value !== undefined) selected[key] = value
  }
  return selected
}

function media(block: Fields): Block {
  const image = block.type === 'image' || block.type === 'image_url'
  const props = metadata(block, image ? ['cache_control'] : ['cache_control', 'citations', 'context', 'title'])
  if (record(block.source)) return { ...block, ...props } as Block
  const sourceType = block.source_type
  let source: Fields | undefined
  const id = sourceType === 'id' ? block.id : sourceType === undefined ? block.fileId : undefined
  const mime = String(block.mime_type ?? block.mimeType ?? (sourceType === 'text' ? 'text/plain' : image ? 'image/jpeg' : 'application/pdf')).split(';', 1)[0].toLowerCase()
  if (sourceType === 'id' && typeof id !== 'string') throw new Error('Anthropic media requires a valid file ID.')
  if (typeof id === 'string') source = { type: 'file', file_id: id }
  else if (block.type === 'image_url') {
    const url = typeof block.image_url === 'string' ? block.image_url : record(block.image_url)?.url
    if (typeof url === 'string') source = imageSource(url)
  } else if (sourceType !== 'base64' && sourceType !== 'text' && typeof block.url === 'string') {
    if (!image && mime !== 'application/pdf' && mime !== '') throw new Error(`Unsupported Anthropic document URL media type: ${mime}`)
    source = image ? imageSource(block.url) : { type: 'url', url: block.url }
  } else if (sourceType === 'text') {
    if (image || (mime !== 'text/plain' && mime !== '')) throw new Error(`Unsupported Anthropic text document media type: ${mime}`)
    source = { type: 'text', media_type: 'text/plain', data: block.text }
  } else if (sourceType !== 'url' && block.data !== undefined) {
    const data = encoded(block.data)
    if (image) source = { type: 'base64', media_type: mime, data }
    else if (mime === 'text/plain') source = { type: 'text', media_type: mime, data }
    else if (mime === 'application/pdf' || mime === '') source = { type: 'base64', media_type: 'application/pdf', data }
    else if (['image/jpeg', 'image/png', 'image/webp', 'image/gif'].includes(mime)) {
      source = { type: 'content', content: [{ type: 'image', source: { type: 'base64', media_type: mime, data } }] }
    } else throw new Error(`Unsupported Anthropic document media type: ${mime}`)
  }
  if (!source || (sourceType !== undefined && !['url', 'base64', 'text', 'id'].includes(String(sourceType)))) {
    throw new Error('Anthropic media requires a valid source.')
  }
  return { type: image ? 'image' : 'document', source, ...props }
}

/** Convert product media and preserve provider-native content without mutating it. */
export function anthropicContent(content: string | readonly unknown[], calls: readonly AnthropicInputCall[] = []): string | Block[] {
  if (typeof content === 'string') return content
  return content.flatMap(value => {
    const block = record(value)
    if (!block || typeof block.type !== 'string') throw new Error('Invalid Anthropic content block.')
    if (['image', 'image_url', 'file'].includes(block.type)) return [media(block)]
    if (block.type === 'audio') throw new Error('Anthropic does not support audio content blocks.')
    if (block.type === 'text' || block.type === 'text_delta') return [{ type: 'text', text: block.text, ...metadata(block, ['cache_control', 'citations']) }]
    if (block.type === 'input_json_delta' || block.type === 'reasoning' || block.type === 'tool_call' || block.type === 'invalid_tool_call') return []
    const { index: _index, ...native } = block
    if ((native.type === 'tool_use' || native.type === 'server_tool_use') && typeof native.input === 'string') {
      const call = calls.find(call => call.id === native.id)
      const input = call ? call.args : JSON.parse(native.input + content.flatMap(value => {
        const delta = record(value)
        return delta?.type === 'input_json_delta' && delta.index === block.index && typeof delta.input === 'string' ? [delta.input] : []
      }).join(''))
      return [{ ...native, type: String(native.type), input }]
    }
    return [native as Block]
  })
}

function callBlock(call: AnthropicInputCall): Block {
  if (call.id === undefined) throw new Error('Anthropic tool calls require an ID.')
  return { type: 'tool_use', id: call.id, name: call.name, input: call.args }
}

export function anthropicInput(input: readonly AnthropicInputMessage[]): Pick<Anthropic.MessageCreateParams, 'system' | 'messages'> {
  let system: unknown
  const messages: Array<{ role: 'user' | 'assistant'; content: string | Block[] }> = []
  for (let index = 0; index < input.length; index++) {
    const message = input[index]
    if (message.role === 'system') {
      if (index !== 0) throw new Error('System messages are only permitted at the beginning of an Anthropic request.')
      system = message.content
      continue
    }
    let content = anthropicContent(message.content, message.calls)
    if (message.role === 'tool') {
      if (message.toolCallId === undefined) throw new Error('Anthropic tool results require a call ID.')
      content = [{ type: 'tool_result', tool_use_id: message.toolCallId, content,
        ...(message.toolError ? { is_error: true } : {}) }]
    } else if (message.role === 'assistant' && message.calls?.length) {
      const parts = typeof content === 'string' ? content ? [{ type: 'text', text: content }] : [] : content
      const represented = new Set(parts.filter(block => block.type === 'tool_use' || block.type === 'server_tool_use').map(block => block.id))
      content = [...parts, ...message.calls.filter(call => !represented.has(call.id)).map(callBlock)]
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    const previous = messages.at(-1)
    const results = Array.isArray(content) && content.length > 0 && content.every(block => block.type === 'tool_result')
    if (results && role === 'user' && previous?.role === 'user' && Array.isArray(previous.content)
      && previous.content.every(block => block.type === 'tool_result')) previous.content = [...previous.content, ...content as Block[]]
    else messages.push({ role, content })
  }
  return { system, messages } as Pick<Anthropic.MessageCreateParams, 'system' | 'messages'>
}

/** Portable presentation blocks need provider provenance for signed reasoning. */
export function anthropicPortableContent(blocks: readonly unknown[], nativeProvider: boolean): Block[] {
  return blocks.flatMap(value => {
    const block = record(value)
    if (!block) throw new Error('Invalid portable content block.')
    const nativeFields = nativeProvider ? record(record(block.extras)?.anthropic) ?? {} : {}
    if (block.type === 'text') return [{ ...nativeFields, type: 'text', text: block.text,
      ...(Array.isArray(block.annotations) ? { citations: block.annotations.flatMap(citation) } : {}) }]
    if (block.type === 'tool_call' || block.type === 'tool_call_chunk') {
      return [{ ...nativeFields, ...callBlock({ id: typeof block.id === 'string' ? block.id : '', name: String(block.name ?? ''),
        args: typeof block.args === 'string' ? JSON.parse(block.args) : block.args }) }]
    }
    if (block.type === 'reasoning') return nativeProvider ? [{ ...nativeFields, type: 'thinking', thinking: block.reasoning, signature: block.signature }] : []
    if (block.type === 'server_tool_call') return nativeProvider ? [{ ...nativeFields, type: 'server_tool_use', id: block.id ?? '', name: block.name, input: block.args }] : []
    if (block.type === 'server_tool_call_result' && nativeProvider) {
      if (block.name === 'web_search') {
        const urls = record(block.output)?.urls
        if (Array.isArray(urls)) return [{ type: 'web_search_tool_result', tool_use_id: block.toolCallId ?? '',
          content: urls.map(url => ({ type: 'web_search_result', url, title: '', encrypted_content: '' })) }]
      }
      if (block.name === 'code_execution' || block.name === 'mcp_tool_result') return [{
        type: block.name === 'code_execution' ? 'code_execution_tool_result' : 'mcp_tool_result', tool_use_id: block.toolCallId ?? '', content: block.output
      }]
    }
    if (block.type === 'non_standard') return nativeProvider ? [block.value as Block] : []
    if (['image', 'file', 'audio'].includes(String(block.type))) return anthropicContent([block]) as Block[]
    if (block.type === 'text-plain') return [{ type: 'document', source: { type: 'text', media_type: 'text/plain', data: block.text },
      ...metadata(block, ['cache_control', 'citations', 'context', 'title']) }]
    return []
  })
}

function citation(value: unknown): Fields[] {
  const item = record(value)
  if (!item) return []
  if (item.type !== 'citation') return [item]
  const common = { document_title: item.title ?? null, document_index: 0, cited_text: item.citedText ?? '' }
  if (item.source === 'url') return [{ type: 'web_search_result_location', url: item.url ?? '', title: item.title ?? null,
    encrypted_index: String(item.startIndex ?? 0), cited_text: item.citedText ?? '' }]
  if (item.source === 'search') return [{ type: 'search_result_location', title: item.title ?? null, start_block_index: item.startIndex ?? 0,
    end_block_index: item.endIndex ?? 0, search_result_index: 0, source: item.source, cited_text: item.citedText ?? '' }]
  const bounds = item.source === 'char' ? ['char_location', 'start_char_index', 'end_char_index']
    : item.source === 'page' ? ['page_location', 'start_page_number', 'end_page_number']
      : item.source === 'block' ? ['content_block_location', 'start_block_index', 'end_block_index'] : undefined
  return bounds ? [{ type: bounds[0], file_id: item.url ?? '', ...common, [bounds[1]]: item.startIndex ?? 0, [bounds[2]]: item.endIndex ?? 0 }] : []
}
