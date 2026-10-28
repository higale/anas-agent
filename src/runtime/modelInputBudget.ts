import { createHash } from 'node:crypto'
import stableStringify from 'fast-json-stable-stringify'
import type { ModelProtocol } from '../shared/types'
import { ModelSelectionError } from './errors'

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

/** Request-level input outside the message list, counted once per request. */
export function modelParameterInputTokens(protocol: ModelProtocol | undefined, parameters?: Record<string, unknown>): number {
  let tokens = 0
  if (protocol === 'openai_responses' && parameters?.instructions != null) {
    if (typeof parameters.instructions !== 'string') {
      throw new ModelSelectionError('OpenAI Responses model parameter "instructions" must be a string or null. Correct its settings and send again.')
    }
    tokens += Math.ceil(parameters.instructions.length / 4)
  }
  const format = protocol === 'openai_responses' && isRecord(parameters?.text)
    ? parameters.text.format
    : protocol === 'anthropic_messages' && isRecord(parameters?.output_config)
      ? parameters.output_config.format
      : protocol === 'openai_chat_completions' ? parameters?.response_format : undefined
  // Structured-output schemas become part of the provider's input prefix. Their
  // JSON describes output data, so image-shaped fields are ordinary schema text.
  if (isRecord(format) && format.type === 'json_schema') tokens += Math.ceil(JSON.stringify(format).length / 4)
  return tokens
}

export interface ModelInputBudgetOptions {
  protocol?: ModelProtocol
  /** Include only for complete requests, not individual message slices. */
  parameters?: Record<string, unknown>
}

export interface ProjectedModelInput {
  system?: unknown
  messages: readonly unknown[]
}

const imageTokens = 1024

function isImageBlock(value: unknown): boolean {
  return isRecord(value) && ['image', 'image_url', 'input_image'].includes(String(value.type))
}

/** Traverse only protocol image slots, leaving arbitrary tool JSON untouched. */
function imageContentProjection(value: unknown): { content: unknown; images: number } {
  let images = 0
  const withoutImages = (item: unknown): unknown => {
    if (isImageBlock(item)) {
      images++
      return null
    }
    if (Array.isArray(item)) return item.map(withoutImages)
    if (!isRecord(item) || typeof item.type !== 'string') return item
    // Only protocol content positions contain images. Tool inputs/arguments and
    // arbitrary metadata are JSON text even when they contain an object type=image.
    return {
      ...item,
      ...('content' in item ? { content: withoutImages(item.content) } : {}),
      ...(item.type.endsWith('_call_output') && 'output' in item ? { output: withoutImages(item.output) } : {}),
      ...(item.type === 'code_interpreter_call' && 'outputs' in item ? { outputs: withoutImages(item.outputs) } : {})
    }
  }
  const content = withoutImages(value)
  return { content, images }
}

/** Count opaque protocol content without charging for image URLs or base64 data. */
function structuredTokens(value: unknown): number {
  if (value === undefined) return 0
  const { content, images } = imageContentProjection(value)
  const serialized = JSON.stringify(content)
  // Each placeholder contributes four characters (null), replaced by the image budget.
  return Math.ceil((serialized.length - images * 4) / 4) + images * imageTokens
}

export function approximateContentTokens(content: unknown): number {
  if (typeof content === 'string') return Math.ceil(content.length / 4)
  if (!Array.isArray(content)) return content == null ? 0 : structuredTokens(content)
  let text = ''
  let otherTokens = 0
  for (const item of content) {
    if (typeof item === 'string') text += item
    else if (isImageBlock(item)) otherTokens += imageTokens
    else if (isRecord(item) && ['text', 'input_text', 'output_text'].includes(String(item.type)) && typeof item.text === 'string') {
      text += item.text
      // Cache routing is a provider control field, not additional model-visible text.
      const { type: _type, text: _text, cache_control: _cacheControl, ...metadata } = item
      if (Object.keys(metadata).length) otherTokens += structuredTokens(metadata)
    } else otherTokens += structuredTokens(item)
  }
  return Math.ceil(text.length / 4) + otherTokens
}

function isGeneratedImageReplay(message: Record<string, unknown>): boolean {
  return !('role' in message) && message.type === 'image_generation_call'
    && typeof message.result === 'string' && message.result.length > 0
}

function projectedMessageTokens(message: unknown): number {
  if (!isRecord(message)) return approximateContentTokens(message)
  // Responses replays generated images in this provider-owned slot. Handle it
  // only on replay items, never on JSON embedded in tool arguments or results.
  if (isGeneratedImageReplay(message)) {
    const { result: _result, ...metadata } = message
    return structuredTokens(metadata) + imageTokens
  }
  // Messages have a role/content envelope; Responses replay items (reasoning,
  // function calls, provider tools, etc.) are counted in their complete wire form.
  if (!('role' in message)) return structuredTokens(message)
  const { role: _role, type: _type, content, ...fields } = message
  return approximateContentTokens(content) + (Object.keys(fields).length ? structuredTokens(fields) : 0)
}

/** Count the actual protocol projection, independent of message classes. */
export function projectedModelInputTokens(input: ProjectedModelInput): number {
  return approximateContentTokens(input.system)
    + input.messages.reduce<number>((total, message) => total + projectedMessageTokens(message), 0)
}

export function projectedModelInputHasImages(input: ProjectedModelInput): boolean {
  return imageContentProjection(input.system).images > 0 || input.messages.some(message => {
    if (isRecord(message) && isGeneratedImageReplay(message)) return true
    const content = isRecord(message) && 'role' in message ? message.content : message
    return imageContentProjection(content).images > 0
  })
}

/** Cache placement is a transport hint; string and block text carry the same input. */
function canonicalContent(content: unknown): unknown {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  if (!Array.isArray(content)) return content
  return content.map((block) => {
    if (!block || typeof block !== 'object' || !('type' in block)) return block
    const { cache_control: _cacheControl, ...input } = block
    return input
  })
}

/** Stable identity of the protocol input used for server-usage calibration. */
export function modelRequestKey(input: ProjectedModelInput, declarations: readonly unknown[]): string {
  const normalized = {
    ...(input.system !== undefined ? { system: canonicalContent(input.system) } : {}),
    messages: input.messages.map((message) => {
      if (!message || typeof message !== 'object' || !('role' in message) || !('content' in message)) return message
      return { ...message, content: canonicalContent(message.content) }
    })
  }
  // Tool order is not a content change; declarations already contain the
  // provider's actual schema and server-tool fields.
  const tools = declarations.map(tool => stableStringify(tool)).sort()
  return createHash('sha256').update(stableStringify({ input: normalized, tools })).digest('hex')
}
