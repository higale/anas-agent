/** Optional model rules. An empty object adds no checks. */
export interface ModelImageLimits {
  minShortSide?: number
  maxLongSide?: number
  maxPixels?: number
  maxAspectRatio?: number
  maxBytes?: number
  byteBasis?: 'original' | 'base64'
  maxCount?: number
}

export const modelImageLimitFields = ['minShortSide', 'maxLongSide', 'maxPixels', 'maxAspectRatio', 'maxBytes', 'maxCount'] as const

export function hasModelImageLimits(value?: ModelImageLimits): boolean {
  return modelImageLimitFields.some(key => value?.[key] !== undefined)
}

export function requireModelImageLimits(value: unknown, path = 'imageLimits'): ModelImageLimits {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object.`)
  const raw = value as Record<string, unknown>
  const result: ModelImageLimits = {}
  for (const key of modelImageLimitFields) {
    const number = raw[key]
    if (number === undefined) continue
    const minimum = key === 'maxCount' || key === 'maxBytes' ? 0 : 1
    if (typeof number !== 'number' || !Number.isFinite(number) || number < minimum
      || number > Number.MAX_SAFE_INTEGER || (key !== 'maxAspectRatio' && !Number.isSafeInteger(number))) {
      throw new Error(`${path}.${key} must be ${key === 'maxAspectRatio' ? 'a number' : 'an integer'} between ${minimum} and ${Number.MAX_SAFE_INTEGER}.`)
    }
    result[key] = number
  }
  if (raw.byteBasis !== undefined) {
    if (raw.byteBasis !== 'original' && raw.byteBasis !== 'base64') throw new Error(`${path}.byteBasis must be original or base64.`)
    result.byteBasis = raw.byteBasis
  }
  if (result.minShortSide !== undefined && result.maxLongSide !== undefined && result.minShortSide > result.maxLongSide) {
    throw new Error(`${path}.minShortSide must not exceed maxLongSide.`)
  }
  return result
}

export function compactImageBytes(bytes: number): string {
  const scale = bytes >= 1_000_000 ? 1_000_000 : bytes >= 1_000 ? 1_000 : 1
  return `${new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 }).format(bytes / scale)}${scale === 1_000_000 ? ' M' : scale === 1_000 ? ' K' : ''}`
}
