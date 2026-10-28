import type { AgentContentBlock, AgentMessage } from '../shared/agentTypes'
import { parseSlashSkillInput } from '../shared/skillShortcuts'
import { codeReviewPresentation } from './codeReviewReport'
import { contentText, inputContentBlocks } from './inputContent'

export interface UserMessageInput {
  id: string
  text: string
  content?: AgentContentBlock[]
  displayText?: string
  runId: string
  createdAt: string
  directionAfterToolCallIds?: string[]
}

export function presentUserInput(input: UserMessageInput, reviewScope?: unknown): AgentMessage {
  const blocks = inputContentBlocks(userMessageContent(input.text, input.content))
  return presentMessage({ ...input, role: 'user', blocks, text: contentText(blocks), reviewScope,
    displayText: input.displayText && input.displayText !== input.text ? input.displayText : undefined
  }, input.id)
}

/** Product presentation input, independent of stored/provider message classes. */
export interface MessagePresentationSource {
  id?: string
  role: AgentMessage['role']
  blocks: readonly unknown[]
  text: string
  name?: string
  calls?: readonly { id?: string; name: string; args: unknown }[]
  resultFor?: string
  displayText?: unknown
  runId?: unknown
  createdAt?: unknown
  directionAfterToolCallIds?: unknown
  reviewScope?: unknown
  review?: unknown
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const strings = value.filter((item): item is string => typeof item === 'string' && Boolean(item))
  return strings.length > 0 ? strings : undefined
}

function byteData(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return undefined
}

function reasoningSummary(value: Record<string, unknown>): string | undefined {
  if (!Array.isArray(value.summary)) return undefined
  const text = value.summary.flatMap((part) => {
    const item = asRecord(part)
    return typeof item.text === 'string' && item.text.trim() ? [item.text] : []
  }).join('\n').trim()
  return text || undefined
}

function contentBlock(block: unknown): AgentContentBlock | undefined {
  const value = asRecord(block)
  switch (value.type) {
    case 'text':
      return typeof value.text === 'string' ? { type: 'text', text: value.text } : undefined
    case 'reasoning': {
      const summary = reasoningSummary(value)
      return typeof value.reasoning === 'string'
        ? {
            type: 'reasoning',
            text: value.reasoning,
            ...(summary ? { summary } : {})
          }
        : undefined
    }
    case 'image':
      return {
        type: 'image',
        mimeType: stringValue(value.mimeType),
        data: byteData(value.data),
        url: stringValue(value.url)
      }
    case 'file':
      return {
        type: 'file',
        name: stringValue(asRecord(value.metadata).filename)
          ?? stringValue(asRecord(value.metadata).name)
          ?? 'file',
        mimeType: stringValue(value.mimeType),
        data: byteData(value.data),
        url: stringValue(value.url)
      }
    case 'text-plain':
      return typeof value.text === 'string' ? { type: 'text', text: value.text } : undefined
    case 'tool_call':
    case 'tool_call_chunk':
      return undefined
    case 'non_standard':
      return { type: 'json', value: value.value }
    default:
      return { type: 'json', value: block }
  }
}

export function presentMessage(message: MessagePresentationSource, fallbackId: string): AgentMessage {
  let blocks = message.blocks
    .map(contentBlock)
    .filter((block): block is AgentContentBlock => Boolean(block))
  const promptText = blocks.find(
    (block): block is Extract<AgentContentBlock, { type: 'text' }> => block.type === 'text'
  )?.text ?? message.text
  const displayText = message.role === 'user' && message.reviewScope === undefined
    ? stringValue(message.displayText)
    : undefined
  const skillShortcut = displayText ? parseSlashSkillInput(displayText) : undefined
  if (displayText) {
    const firstText = blocks.findIndex((block) => block.type === 'text')
    if (firstText >= 0) {
      blocks = blocks.map((block, index) =>
        index === firstText ? { type: 'text', text: displayText } : block
      )
    } else {
      blocks = [{ type: 'text', text: displayText }, ...blocks]
    }
  }
  const mapped: AgentMessage = {
    id: message.id ?? fallbackId,
    role: message.role,
    content: blocks.length || !message.text ? blocks : [{ type: 'text', text: message.text }],
    name: message.name,
    // Display fallback only; execution must use the actual recorded call ID.
    toolCalls: message.role === 'assistant' && message.calls?.length ? message.calls.map(call => ({
      id: call.id ?? `${message.id ?? 'message'}:${call.name}`, name: call.name, args: call.args
    })) : undefined
  }
  const runId = stringValue(message.runId)
  const createdAt = stringValue(message.createdAt)
  const directionAfterToolCallIds = stringArray(
    message.directionAfterToolCallIds
  )
  if (runId) mapped.runId = runId
  if (createdAt) mapped.createdAt = createdAt
  if (directionAfterToolCallIds) mapped.directionAfterToolCallIds = directionAfterToolCallIds
  if (skillShortcut && promptText) {
    mapped.skillInvocation = {
      ...skillShortcut,
      promptText
    }
  }
  if (message.role === 'tool') mapped.toolCallId = message.resultFor
  if (message.role === 'assistant' && message.review !== undefined) {
    mapped.codeReview = codeReviewPresentation(message.review)
  }
  return mapped
}

function inputContentBlock(block: AgentContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image': {
      const url = block.url
        ?? (block.data
          ? `data:${block.mimeType ?? 'image/png'};base64,${block.data}`
          : undefined)
      if (!url) return { type: 'text', text: '[Image unavailable]' }
      return {
        type: 'image_url',
        image_url: {
          url,
          detail: 'auto'
        }
      }
    }
    case 'file':
      if (!block.url) return { type: 'text', text: `[Attached file: ${block.name}]` }
      return {
        type: 'file_url',
        file_url: { url: block.url },
        mime_type: block.mimeType
      }
    case 'reasoning':
      return { type: 'text', text: block.text }
    case 'json':
      return { type: 'text', text: JSON.stringify(block.value) }
  }
}

export function userMessageContent(text: string, content?: AgentContentBlock[]): string | Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = []
  if (text) blocks.push({ type: 'text', text })
  for (const block of content ?? []) {
    if (block.type === 'text' && block.text === text) continue
    blocks.push(inputContentBlock(block))
  }
  return blocks.length === 1 && text && (!content || content.length === 0) ? text : blocks
}

/** Split only the exact expanded shortcut prefix. Tags inside user input or a
 * Skill document are literal content, not delimiters to search for. */
export function skillMessageParts(content: string | readonly unknown[], displayValue: unknown, reviewScope?: unknown):
  { userContent: string | unknown[]; skillContent: string } | undefined {
  if (reviewScope !== undefined) return undefined
  const displayText = stringValue(displayValue)
  if (!displayText || !parseSlashSkillInput(displayText)) return undefined
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  const first = asRecord(blocks[0])
  if (first.type !== 'text' || typeof first.text !== 'string') return undefined
  const prefix = displayText + '\n\n'
  if (!first.text.startsWith(prefix + '<skill>\n')) return undefined
  return { userContent: blocks.length === 1 ? displayText : [{ type: 'text', text: displayText }, ...blocks.slice(1)],
    skillContent: first.text.slice(prefix.length) }
}

/** Tool timeline content is the same before and after durable reconciliation. */
export function presentToolResult(content: AgentContentBlock[]): unknown {
  if (content.length !== 1) return content
  const [block] = content
  if (block.type === 'text') return block.text
  if (block.type === 'json') return block.value
  return block
}

export function traceText(content: AgentContentBlock[], type: 'text' | 'reasoning'): string {
  return content.flatMap((block) =>
    block.type === type && 'text' in block ? [block.text] : []
  ).join('')
}

export function traceReasoningSummary(content: AgentContentBlock[]): string | undefined {
  const summaries = content.flatMap((block) =>
    block.type === 'reasoning' && block.summary ? [block.summary] : []
  )
  const text = [...new Set(summaries)].join('\n').trim()
  return text || undefined
}
