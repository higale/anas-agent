import { imageDimensionsFromData } from 'image-dimensions'
import { hasModelImageLimits, type ModelImageLimits } from '@shared/modelImageLimits'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { inputContentBlocks } from '../../runtime/inputContent'
import { isToolImageBlock } from '../../runtime/conversationHistory'

// Header inspection only: never allocate a decoded full-resolution bitmap.
const headerBytes = 1_048_576
type EmbeddedImage = { data: string | Uint8Array; malformed?: boolean }

function embeddedImage(value: unknown): EmbeddedImage | undefined {
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

function imageFailure(image: EmbeddedImage, limits: ModelImageLimits): string | undefined {
  const dimensionsNeeded = limits.minShortSide !== undefined || limits.maxLongSide !== undefined
    || limits.maxPixels !== undefined || limits.maxAspectRatio !== undefined
  if (!dimensionsNeeded && limits.maxBytes === undefined) return undefined
  const data = image.data
  let bytes: number, encodedBytes: number
  if (typeof data === 'string') {
    const unpadded = data.replace(/=+$/, '')
    if (image.malformed || !data.length || /[^A-Za-z0-9+/]/.test(unpadded) || unpadded.length % 4 === 1
      || data.length - unpadded.length > 2 || (data.includes('=') && data.length % 4 !== 0)) {
      return 'Invalid Base64 image data; the configured image rules could not be checked.'
    }
    bytes = Math.floor(unpadded.length * 3 / 4)
    encodedBytes = data.length
  } else {
    bytes = data.byteLength
    encodedBytes = Math.ceil(bytes / 3) * 4
  }
  if (limits.maxBytes !== undefined) {
    const size = limits.byteBasis === 'base64' ? encodedBytes : bytes
    if (size > limits.maxBytes) return `${limits.byteBasis === 'base64' ? 'Base64' : 'Original'} size ${size.toLocaleString('en-US')} bytes exceeds the limit of ${limits.maxBytes.toLocaleString('en-US')} bytes.`
  }
  if (!dimensionsNeeded) return undefined
  const head = typeof data === 'string' ? Buffer.from(data.slice(0, Math.ceil(headerBytes / 3) * 4), 'base64').subarray(0, headerBytes) : data.subarray(0, headerBytes)
  let dimensions: ReturnType<typeof imageDimensionsFromData>
  try { dimensions = imageDimensionsFromData(head) } catch { dimensions = undefined }
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return `Image dimensions could not be read from the first ${headerBytes.toLocaleString('en-US')} bytes (damaged or unsupported image header); the configured dimension rules could not be checked.`
  }
  const { width, height } = dimensions
  const short = Math.min(width, height), long = Math.max(width, height)
  if (limits.minShortSide !== undefined && short < limits.minShortSide) return `Dimensions ${width}×${height} px: short side ${short} px is below the minimum of ${limits.minShortSide} px.`
  if (limits.maxLongSide !== undefined && long > limits.maxLongSide) return `Dimensions ${width}×${height} px: long side ${long} px exceeds the maximum of ${limits.maxLongSide} px.`
  if (limits.maxPixels !== undefined && width * height > limits.maxPixels) return `Dimensions ${width}×${height} px: ${width * height} pixels exceeds the limit of ${limits.maxPixels} pixels.`
  if (limits.maxAspectRatio !== undefined && long / short > limits.maxAspectRatio) return `Dimensions ${width}×${height} px: aspect ratio ${long / short} exceeds the limit of ${limits.maxAspectRatio}.`
  return undefined
}

/** Receives effective, unconsumed history. Originals, statuses and remote references remain intact. */
export function projectModelToolImageLimits(messages: readonly ConversationMessage[], limits?: ModelImageLimits): ConversationMessage[] {
  if (!hasModelImageLimits(limits)) return [...messages]
  const rules = limits!
  const images = new Map<unknown, EmbeddedImage>()
  let count = 0
  for (const message of messages) {
    if (message.kind !== 'tool' || !Array.isArray(message.content)) continue
    for (const block of message.content) {
      const image = embeddedImage(block)
      if (image) { images.set(block, image); count++ }
    }
  }
  const batchFailure = rules.maxCount !== undefined && count > rules.maxCount
    ? `This request contains ${count} embedded tool images, exceeding the limit of ${rules.maxCount}. The entire batch of ${count} embedded tool images was omitted.` : undefined
  return messages.map(message => {
    if (message.kind !== 'tool' || !Array.isArray(message.content)) return message
    let ordinal = 0
    const warnings: string[] = []
    const content = message.content.map(block => {
      if (isToolImageBlock(block)) ordinal++
      const image = images.get(block)
      if (!image) return block
      const reason = batchFailure ?? imageFailure(image, rules)
      if (!reason) return block
      const text = `Tool ${message.name ?? 'unknown'} (result ${message.resultFor ?? message.id ?? 'unknown'}), image ${ordinal} was not sent to the current model: ${reason} The original tool result is preserved; this is not a tool execution failure.`
      warnings.push(text)
      return { type: 'text', text }
    })
    return warnings.length ? { ...message, content, context: { ...message.context, imageLimitWarnings: warnings } } : message
  })
}
