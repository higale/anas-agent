import { modelImageDataFailure, modelImageCountFailure, modelImageFailureText, type EmbeddedModelImage } from '@shared/modelImageValidation'
import { ModelImageSelectionError } from './modelImageSelectionError'
import { hasModelImageLimits, type ModelImageLimits } from '@shared/modelImageLimits'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { inputContentBlocks } from '../../runtime/inputContent'
import { isToolImageBlock } from '../../runtime/conversationHistory'

function embeddedImage(value: unknown): EmbeddedModelImage | undefined {
  if (!isToolImageBlock(value)) return undefined
  const block = inputContentBlocks([value])[0] as Record<string, unknown>
  // Match provider source selection: explicit source types are normalized above;
  // otherwise uploaded IDs and URLs take precedence over incidental data.
  if (block.source_type === undefined && typeof block.fileId === 'string') return undefined
  const imageUrl = block.image_url
  const url = block.source_type === 'base64' ? undefined
    : block.url ?? (typeof imageUrl === 'object' && imageUrl ? (imageUrl as { url?: unknown }).url : imageUrl)
  if (typeof url === 'string') {
    if (!/^data:/i.test(url)) return undefined
    const comma = url.indexOf(',')
    return comma < 0 || !/;base64$/i.test(url.slice(0, comma))
      ? { data: '', malformed: true } : { data: url.slice(comma + 1) }
  }
  if (typeof block.data === 'string' || block.data instanceof Uint8Array) return { data: block.data }
  return undefined
}

/** Estimates retain attachments that would block a request, so history can still be summarized.
 * Tool omissions match actual requests. Originals, statuses and remote references remain intact. */
export function projectModelImageLimits(messages: readonly ConversationMessage[], limits?: ModelImageLimits,
  mode: 'request' | 'submission' | 'estimate' = 'request'): ConversationMessage[] {
  if (!hasModelImageLimits(limits)) return [...messages]
  const rules = limits!
  const images = new Map<unknown, EmbeddedModelImage>()
  let count = 0, toolCount = 0
  for (const message of messages) {
    if (!['tool', 'user'].includes(message.kind) || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      const image = embeddedImage(block)
      if (image) { images.set(block, image); count++; if (message.kind === 'tool') toolCount++ }
    }
  }
  const rejectsAttachments = !toolCount || mode === 'submission' && count > toolCount
  const countFailure = modelImageCountFailure(count, rules, failure => {
    if (rejectsAttachments && mode !== 'estimate') throw new ModelImageSelectionError(failure)
    return modelImageFailureText(failure)
  })
  const batchFailure = countFailure && !rejectsAttachments ? `${countFailure} The entire batch of ${count} embedded images was omitted.` : undefined
  return messages.map(message => {
    if (!['tool', 'user'].includes(message.kind) || !Array.isArray(message.content)) return message
    let ordinal = 0
    const warnings: string[] = []
    const content = message.content.map(block => {
      if (isToolImageBlock(block)) ordinal++
      const image = images.get(block)
      if (!image) return block
      if (message.kind === 'user' && mode === 'estimate' && !batchFailure) return block
      const failure = batchFailure ? undefined : modelImageDataFailure(image, rules, reason => {
        if (message.kind === 'user') throw new ModelImageSelectionError(reason, { ordinal, messageId: message.id })
        return modelImageFailureText(reason)
      })
      const reason = batchFailure ?? failure
      if (!reason) return block
      const origin = message.kind === 'user' ? `Attachment (message ${message.id ?? 'current'})` : `Tool ${message.name ?? 'unknown'} (result ${message.resultFor ?? message.id ?? 'unknown'})`
      const text = `${origin}, image ${ordinal} was not sent to the current model: ${reason} ${message.kind === 'user' ? 'The original attachment is preserved.' : 'The original tool result is preserved; this is not a tool execution failure.'}`
      warnings.push(text)
      return { type: 'text', text }
    })
    return warnings.length ? { ...message, content, context: { ...message.context, imageLimitWarnings: warnings } } : message
  })
}
