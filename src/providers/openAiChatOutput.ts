import type OpenAI from 'openai'
import { openAiChatUsage } from './modelUsage'

type Fields = Record<string, unknown>
export type ChatResponseBlock = Fields & { type: string }
type Block = ChatResponseBlock
type Completion = OpenAI.Chat.ChatCompletion
function record(value: unknown): Fields { return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {} }

function toolBlock(raw: Fields, complete: boolean): Block {
  const custom = raw.type === 'custom', call = record(custom ? raw.custom : raw.function)
  const args = custom ? JSON.stringify({ input: call.input }) : call.arguments
  const identity = { ...(typeof raw.id === 'string' && raw.id ? { id: raw.id } : {}),
    ...(typeof call.name === 'string' && call.name ? { name: call.name } : {}) }
  const extras = custom ? { extras: { openai: { type: 'custom' } } } : {}
  if (!complete) return { type: 'tool_call_chunk', ...identity, args: typeof args === 'string' ? args : '', ...extras }
  try {
    if (!identity.id || !identity.name) throw new Error('Tool calls require a provider ID and name.')
    if (custom && typeof call.input !== 'string') throw new Error('Custom tool input must be a string.')
    const parsed = JSON.parse(typeof args === 'string' ? args : '')
    return { type: 'tool_call', ...identity, args: parsed, ...extras }
  } catch (error) {
    return { type: 'invalid_tool_call', ...identity, args: typeof args === 'string' ? args : '',
      error: error instanceof Error ? error.message : String(error), ...extras }
  }
}

export function chatResponseBlocks(message: Completion['choices'][number]['message'], complete: boolean, tools?: Array<[number, Fields]>): Map<string, Block> {
  const raw = message as unknown as Fields
  const result = new Map<string, Block>()
  const reasoning = raw.reasoning_content ?? raw.reasoning
  if (typeof reasoning === 'string' && reasoning) result.set('reasoning', { type: 'reasoning', reasoning })
  if (message.content) result.set('text', { type: 'text', text: message.content,
    ...(message.annotations?.length ? { annotations: message.annotations.map(annotation => ({ type: 'citation',
      url: annotation.url_citation.url, title: annotation.url_citation.title,
      startIndex: annotation.url_citation.start_index, endIndex: annotation.url_citation.end_index })) } : {}) })
  if (message.refusal) result.set('refusal', { type: 'non_standard', value: { type: 'refusal', refusal: message.refusal } })
  for (const [index, call] of tools ?? (message.tool_calls ?? []).map((call, index) => [index, call as unknown as Fields] as [number, Fields])) {
    result.set(`tool:${index}`, toolBlock(call, complete))
  }
  if (message.audio) result.set('audio', { type: 'audio', ...message.audio, mimeType: 'audio/pcm' })
  if (Array.isArray(raw.images)) raw.images.forEach((image, index) => {
    const url = record(record(image).image_url).url
    if (typeof url === 'string') result.set(`image:${index}`, { type: 'image', url })
  })
  return result
}

/** Decode one provider response without creating stored or framework messages.
 * Original choices remain available for lossless protocol replay and diagnostics. */
export function readChatCompletion(response: Completion) {
  return { id: response.id, usage: openAiChatUsage(response), candidates: response.choices.map(choice => {
    const content = choice.message.role === 'assistant' ? [...chatResponseBlocks(choice.message, true).values()] : []
    const plain = content.length === 0 || content.length === 1 && content[0].type === 'text' && !content[0].annotations
    return { choice, role: String(choice.message.role), text: choice.message.content ?? '', blocks: content,
      content: plain ? choice.message.content ?? '' : content,
      calls: content.filter(block => block.type === 'tool_call'), invalidCalls: content.filter(block => block.type === 'invalid_tool_call') }
  }) }
}
