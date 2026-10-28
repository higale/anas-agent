import type OpenAI from 'openai'
import { inputContentBlocks } from '../runtime/inputContent'
import { isToolImageBlock } from '../runtime/conversationHistory'

// Protocol mappings informed by @langchain/openai 1.5.9 (MIT).
// Attribution: THIRD_PARTY_NOTICES.md and data/licenses/langchain/LICENSE.

type ContentPart = Record<string, unknown>

/** A request projection, not a persisted message or an execution state. */
export interface ChatInputMessage {
  role: string
  content: string | readonly unknown[]
  name?: string
  toolCallId?: string
  toolCalls?: ReadonlyArray<{ id?: string; name: string; args: unknown }>
  rawToolCalls?: unknown
  functionCall?: unknown
  audio?: unknown
  refusal?: unknown
}

function record(value: unknown): ContentPart | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ContentPart : undefined
}

function dataUrl(value: unknown): { mime: string; data: string } | undefined {
  if (typeof value !== 'string') return undefined
  const match = /^data:([^;,]*)(?:;[^,]*)?;base64,([\s\S]*)$/i.exec(value)
  return match ? { mime: match[1], data: match[2] } : undefined
}

/** Encode product media blocks; already native provider blocks pass through. */
export function chatContentPart(value: unknown): ContentPart | undefined {
  const block = record(value)
  if (!block) return undefined
  const metadata = record(block.metadata)
  const source = block.source_type
  const mime = block.mime_type ?? block.mimeType ?? ''
  if (block.type === 'text') return source === undefined ? block : { type: 'text', text: block.text }
  if (block.type === 'image') {
    const url = source !== 'base64' && typeof block.url === 'string' ? block.url
      : source !== 'url' && typeof block.data === 'string' ? `data:${mime};base64,${block.data}` : undefined
    if (url === undefined || (source !== undefined && source !== 'url' && source !== 'base64')) {
      throw new Error('Chat Completions images require a URL or base64 content.')
    }
    const detail = metadata?.detail ?? block.detail
    return { type: 'image_url', image_url: { url, ...(detail !== undefined ? { detail } : {}) } }
  }
  if (block.type === 'audio') {
    const embedded = source !== 'base64' ? dataUrl(block.url) : undefined
    const audioMime = String(embedded?.mime || mime).split(';', 1)[0].toLowerCase()
    const format = audioMime === 'audio/mp3' ? 'mp3' : audioMime === 'audio/wav' ? 'wav' : undefined
    const data = source === 'url' ? embedded?.data : embedded?.data ?? block.data
    if (typeof data !== 'string' || (source !== undefined && (!format || !['url', 'base64'].includes(String(source))))) {
      throw new Error('Chat Completions audio requires base64 audio/wav or audio/mp3 content.')
    }
    return { type: 'input_audio', input_audio: { data, format: format ?? 'wav' } }
  }
  if (block.type === 'file' && !('file' in block)) {
    const id = source === 'id' ? block.id : source === undefined ? block.fileId : undefined
    if (typeof id === 'string') return { type: 'file', file: { file_id: id } }
    const url = source !== 'base64' && typeof block.url === 'string' && dataUrl(block.url) ? block.url
      : source !== 'url' && typeof block.data === 'string' ? `data:${mime};base64,${block.data}` : undefined
    if (url === undefined || (source !== undefined && source !== 'url' && source !== 'base64')) {
      throw new Error('Chat Completions files require a file ID or base64 content.')
    }
    const filename = metadata?.filename ?? metadata?.name ?? metadata?.title ?? 'attachment'
    return { type: 'file', file: { file_data: url, filename } }
  }
  return block
}

const nonChatContent = new Set(['tool_use', 'tool_call', 'functionCall', 'reasoning', 'reasoning_content', 'thinking'])

/** Request-only encoding; the stored result and its media remain untouched. */
export function openAiToolImageContent(content: string | readonly unknown[], responses: boolean): {
  result: ContentPart[]; attachments: ContentPart[]
} | undefined {
  if (!Array.isArray(content) || !content.some(isToolImageBlock)) return undefined
  const normalized = content.map(block => {
    const value = record(block)
    if (value?.type === 'input_text') return { type: 'text', text: value.text }
    if (value?.type === 'input_image') return { type: 'image_url', image_url: { url: value.image_url, detail: value.detail } }
    return block
  })
  const encoded: ContentPart[] = [], text: ContentPart[] = []
  for (const value of inputContentBlocks(normalized)) {
    const block = value as ContentPart
    if (block.type === 'image') {
      const image = chatContentPart(block)
      if (!image || image.type !== 'image_url') throw new Error('Tool image cannot be encoded for this model interface.')
      const imageUrl = image.image_url as { url: string; detail?: string }
      encoded.push(responses ? { type: 'input_image', image_url: imageUrl.url, detail: imageUrl.detail ?? 'auto' }
        : { type: 'image_url', image_url: image.image_url })
    } else {
      const value = block.type === 'text' ? block.text : JSON.stringify(block)
      encoded.push({ type: responses ? 'input_text' : 'text', text: value })
      text.push({ type: 'text', text: value })
    }
  }
  return { result: responses ? encoded : [...text, { type: 'text', text: 'Tool images are attached after this tool result batch.' }],
    attachments: responses ? [] : encoded }
}

/** Build the exact message payload shared by request sending and estimation. */
export function chatInput(messages: readonly ChatInputMessage[], model?: string): OpenAI.Chat.ChatCompletionMessageParam[] {
  const developer = Boolean(model && (/^o\d/.test(model) || (model.startsWith('gpt-5') && !model.startsWith('gpt-5-chat'))))
  const results: Array<Record<string, unknown> & { role: string }> = []
  let attachments: ContentPart[] = []
  const flush = () => {
    if (!attachments.length) return
    results.push({ role: 'user', content: attachments })
    attachments = []
  }
  for (const message of messages) {
    // All results of a parallel batch precede its synthetic image input.
    if (message.role !== 'tool') flush()
    const images = message.role === 'tool' ? openAiToolImageContent(message.content, false) : undefined
    if (images) attachments.push({ type: 'text', text: `Images returned by tool call ${message.toolCallId} (${message.name ?? 'tool'}):` }, ...images.attachments)
    const source = images?.result ?? message.content
    const content = typeof source === 'string' ? source : source.flatMap(block => {
      const item = record(block)
      if (item && nonChatContent.has(String(item.type))) return []
      return [item ? chatContentPart(item) : block]
    })
    const result: Record<string, unknown> & { role: string } = { role: message.role === 'system' && developer ? 'developer' : message.role, content }
    if (message.name !== undefined) result.name = message.name
    if (message.functionCall != null) result.function_call = message.functionCall
    if (message.toolCalls?.length) {
      result.tool_calls = message.toolCalls.map(call => {
        if (call.id === undefined) throw new Error('Chat Completions tool calls require an ID.')
        const raw = Array.isArray(message.rawToolCalls) ? message.rawToolCalls.find(raw => record(raw)?.id === call.id) : undefined
        if (record(raw)?.type === 'custom') {
          const input = record(call.args)?.input
          if (typeof input !== 'string') throw new Error('Chat Completions custom tool input must be a string.')
          return { type: 'custom', id: call.id, custom: { name: call.name, input } }
        }
        return { type: 'function', id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } }
      })
    } else if (message.rawToolCalls != null) result.tool_calls = message.rawToolCalls
    if (message.toolCallId !== undefined) result.tool_call_id = message.toolCallId
    if (message.refusal !== undefined && message.refusal !== null) result.refusal = message.refusal
    const audio = record(message.audio)
    results.push(result)
    if (audio && 'id' in audio) results.push({ role: 'assistant', audio: { id: audio.id } })
  }
  flush()
  return results as OpenAI.Chat.ChatCompletionMessageParam[]
}
