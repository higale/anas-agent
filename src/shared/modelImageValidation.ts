import { imageDimensionsFromData } from 'image-dimensions'
import type { ModelImageLimits } from './modelImageLimits'
import type { SelectedAttachment } from './types'
import { bmpImageDimensions } from './imageDimensions'

// Inspect bounded headers in both processes; never decode a full-resolution bitmap.
const headerBytes = 1_048_576
export interface EmbeddedModelImage { data: string | Uint8Array; malformed?: boolean }

export function modelImageDataFailure(image: EmbeddedModelImage, limits: ModelImageLimits): string | undefined {
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
  const head = typeof data === 'string'
    ? Uint8Array.from(atob(data.slice(0, Math.ceil(headerBytes / 3) * 4)), character => character.charCodeAt(0)).subarray(0, headerBytes)
    : data.subarray(0, headerBytes)
  let dimensions: { width: number; height: number } | undefined
  try { dimensions = bmpImageDimensions(head) ?? imageDimensionsFromData(head) } catch { dimensions = undefined }
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

export function modelImageCountFailure(count: number, limits?: ModelImageLimits): string | undefined {
  return limits?.maxCount !== undefined && count > limits.maxCount
    ? `This request contains ${count} embedded images, exceeding the limit of ${limits.maxCount}.` : undefined
}

export function attachmentImageFailure(file: SelectedAttachment, limits?: ModelImageLimits): string | undefined {
  if (file.kind !== 'image') return undefined
  if (file.skippedReason) return file.skippedReason
  const uri = file.dataUri ?? file.url
  if (!uri || !/^data:/i.test(uri) || !limits) return undefined
  const comma = uri.indexOf(',')
  return modelImageDataFailure({ data: comma < 0 ? '' : uri.slice(comma + 1),
    malformed: comma < 0 || !/;base64$/i.test(uri.slice(0, comma)) }, limits)
}

export function attachmentImageCount(files: SelectedAttachment[]): number {
  return files.filter(file => {
    const uri = file.dataUri ?? file.url
    return file.kind === 'image' && (!uri || /^data:/i.test(uri))
  }).length
}
