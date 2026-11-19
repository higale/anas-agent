import { imageDimensionsFromData } from 'image-dimensions'
import type { ModelImageLimits } from './modelImageLimits'
import type { SelectedAttachment } from './types'
import { bmpImageDimensions } from './imageDimensions'

// Inspect bounded headers in both processes; never decode a full-resolution bitmap.
const headerBytes = 1_048_576
export interface EmbeddedModelImage { data: string | Uint8Array; malformed?: boolean }

export type ModelImageFailure =
  | { code: 'invalid_base64' }
  | { code: 'unreadable_dimensions'; headerBytes: number }
  | { code: 'max_bytes'; basis: 'original' | 'base64'; size: number; limit: number }
  | { code: 'min_short_side' | 'max_long_side' | 'max_pixels' | 'max_aspect_ratio'; width: number; height: number; actual: number; limit: number }
  | { code: 'max_count'; count: number; limit: number }

export type ModelImageFailureFormatter = (failure: ModelImageFailure) => string

// Runtime/model notices use English; UI callers format the same failure in the active language.
export function modelImageFailureText(failure: ModelImageFailure): string {
  switch (failure.code) {
    case 'invalid_base64': return 'Invalid Base64 image data; the configured image rules could not be checked.'
    case 'unreadable_dimensions': return `Image dimensions could not be read from the first ${failure.headerBytes.toLocaleString('en-US')} bytes (damaged or unsupported image header); the configured dimension rules could not be checked.`
    case 'max_bytes': return `${failure.basis === 'base64' ? 'Base64' : 'Original'} size ${failure.size.toLocaleString('en-US')} bytes exceeds the limit of ${failure.limit.toLocaleString('en-US')} bytes.`
    case 'min_short_side': return `Dimensions ${failure.width}×${failure.height} px: short side ${failure.actual} px is below the minimum of ${failure.limit} px.`
    case 'max_long_side': return `Dimensions ${failure.width}×${failure.height} px: long side ${failure.actual} px exceeds the maximum of ${failure.limit} px.`
    case 'max_pixels': return `Dimensions ${failure.width}×${failure.height} px: ${failure.actual} pixels exceeds the limit of ${failure.limit} pixels.`
    case 'max_aspect_ratio': return `Dimensions ${failure.width}×${failure.height} px: aspect ratio ${failure.actual} exceeds the limit of ${failure.limit}.`
    case 'max_count': return `This request contains ${failure.count} embedded images, exceeding the limit of ${failure.limit}.`
  }
}

export function modelImageDataFailure(image: EmbeddedModelImage, limits: ModelImageLimits,
  format: ModelImageFailureFormatter = modelImageFailureText): string | undefined {
  const dimensionsNeeded = limits.minShortSide !== undefined || limits.maxLongSide !== undefined
    || limits.maxPixels !== undefined || limits.maxAspectRatio !== undefined
  if (!dimensionsNeeded && limits.maxBytes === undefined) return undefined
  const data = image.data
  let bytes: number, encodedBytes: number
  if (typeof data === 'string') {
    const unpadded = data.replace(/=+$/, '')
    if (image.malformed || !data.length || /[^A-Za-z0-9+/]/.test(unpadded) || unpadded.length % 4 === 1
      || data.length - unpadded.length > 2 || (data.includes('=') && data.length % 4 !== 0)) {
      return format({ code: 'invalid_base64' })
    }
    bytes = Math.floor(unpadded.length * 3 / 4)
    encodedBytes = data.length
  } else {
    bytes = data.byteLength
    encodedBytes = Math.ceil(bytes / 3) * 4
  }
  if (limits.maxBytes !== undefined) {
    const size = limits.byteBasis === 'base64' ? encodedBytes : bytes
    if (size > limits.maxBytes) return format({ code: 'max_bytes', basis: limits.byteBasis ?? 'original', size, limit: limits.maxBytes })
  }
  if (!dimensionsNeeded) return undefined
  const head = typeof data === 'string'
    ? Uint8Array.from(atob(data.slice(0, Math.ceil(headerBytes / 3) * 4)), character => character.charCodeAt(0)).subarray(0, headerBytes)
    : data.subarray(0, headerBytes)
  let dimensions: { width: number; height: number } | undefined
  try { dimensions = bmpImageDimensions(head) ?? imageDimensionsFromData(head) } catch { dimensions = undefined }
  if (!dimensions || dimensions.width <= 0 || dimensions.height <= 0) {
    return format({ code: 'unreadable_dimensions', headerBytes })
  }
  const { width, height } = dimensions
  const short = Math.min(width, height), long = Math.max(width, height)
  if (limits.minShortSide !== undefined && short < limits.minShortSide) return format({ code: 'min_short_side', width, height, actual: short, limit: limits.minShortSide })
  if (limits.maxLongSide !== undefined && long > limits.maxLongSide) return format({ code: 'max_long_side', width, height, actual: long, limit: limits.maxLongSide })
  if (limits.maxPixels !== undefined && width * height > limits.maxPixels) return format({ code: 'max_pixels', width, height, actual: width * height, limit: limits.maxPixels })
  if (limits.maxAspectRatio !== undefined && long / short > limits.maxAspectRatio) return format({ code: 'max_aspect_ratio', width, height, actual: long / short, limit: limits.maxAspectRatio })
  return undefined
}

export function modelImageCountFailure(count: number, limits?: ModelImageLimits,
  format: ModelImageFailureFormatter = modelImageFailureText): string | undefined {
  return limits?.maxCount !== undefined && count > limits.maxCount
    ? format({ code: 'max_count', count, limit: limits.maxCount }) : undefined
}

export function attachmentImageFailure(file: SelectedAttachment, limits?: ModelImageLimits,
  format: ModelImageFailureFormatter = modelImageFailureText): string | undefined {
  if (file.kind !== 'image') return undefined
  if (file.skippedReason) return file.skippedReason
  const uri = file.dataUri ?? file.url
  if (!uri || !/^data:/i.test(uri) || !limits) return undefined
  const comma = uri.indexOf(',')
  return modelImageDataFailure({ data: comma < 0 ? '' : uri.slice(comma + 1),
    malformed: comma < 0 || !/;base64$/i.test(uri.slice(0, comma)) }, limits, format)
}

export function attachmentImageCount(files: SelectedAttachment[]): number {
  return files.filter(file => {
    const uri = file.dataUri ?? file.url
    return file.kind === 'image' && (!uri || /^data:/i.test(uri))
  }).length
}
