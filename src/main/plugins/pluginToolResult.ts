import { imageDimensionsFromData } from 'image-dimensions'
import { maxImageDimension, maxImagePixels, maxImageSourceBytes } from '@shared/imageLimits'
import type { PluginContentResult } from '@shared/pluginTools'
import { requirePluginJson } from '@shared/plugins'

/** Same text/image content blocks as built-in image tools; no resource protocol. */
export function parsePluginContentResult(value: unknown): PluginContentResult {
  if (!Array.isArray(value) || value.length > 128) throw new Error('Plugin content result must be an array of up to 128 blocks.')
  let imageCount = 0
  let imageBytes = 0
  let textBytes = 0
  return value.map(block => {
    if (block?.type === 'text' && typeof block.text === 'string') {
      textBytes += Buffer.byteLength(block.text)
      if (textBytes > 1024 * 1024) throw new Error('Plugin result text exceeds 1 MiB.')
      return { type: 'text', text: block.text }
    }
    if (block?.type !== 'image' || typeof block.data !== 'string' || !['image/png', 'image/jpeg'].includes(block.mimeType)) throw new Error('Plugin content must contain text or PNG/JPEG image blocks.')
    if (++imageCount > 4) throw new Error('Plugin result exceeds 4 images.')
    const data: string = block.data
    if (!data.length || data.length > Math.ceil(maxImageSourceBytes / 3) * 4 || data.length % 4 !== 0
      || /[^A-Za-z0-9+/=]/.test(data) || /=/.test(data.slice(0, -2)) || (data.at(-2) === '=' && data.at(-1) !== '=')) throw new Error('Plugin image must be Base64 data of at most 25 MiB.')
    const bytes = Buffer.from(data, 'base64')
    imageBytes += bytes.length
    if (bytes.length > maxImageSourceBytes || imageBytes > 32 * 1024 * 1024) throw new Error('Plugin images exceed the 25 MiB per image or 32 MiB total budget.')
    const dimensions = imageDimensionsFromData(bytes)
    if (!dimensions || !['png', 'jpeg'].includes(dimensions.type) || block.mimeType !== `image/${dimensions.type}`) throw new Error('Plugin image does not match its declared media type.')
    const { width, height } = dimensions
    if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
      || width > maxImageDimension || height > maxImageDimension || width * height > maxImagePixels) throw new Error('Plugin image exceeds the pixel budget.')
    return { type: 'image', mimeType: block.mimeType, data }
  })
}

export function validatePluginToolResult(value: unknown): unknown {
  if (Array.isArray(value) && value.every(block => block && typeof block === 'object' && 'type' in block)) return parsePluginContentResult(value)
  requirePluginJson(value)
  return value
}
