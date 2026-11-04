export const maxIconSvgBytes = 1024 * 1024
export const maxIconPngSide = 128

/** Stored icons are self-contained images; an empty value selects the default artwork. */
export function normalizeIconData(value: unknown, path = 'icon_data'): string {
  if (value === undefined || value === '') return ''
  if (typeof value !== 'string') throw new Error(`Config value ${path} must be an image data URL.`)
  const match = /^data:image\/(svg\+xml|png);base64,/.exec(value)
  if (!match) throw new Error(`Config value ${path} must be a Base64 SVG or PNG image.`)
  const encoded = value.slice(match[0].length)
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0
  if (!encoded || encoded.length % 4 !== 0
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error(`Config value ${path} must be a valid Base64 image.`)
  }
  if (match[1] === 'svg+xml' && encoded.length / 4 * 3 - padding > maxIconSvgBytes) {
    throw new Error(`Config value ${path} must be an SVG image up to 1 MB.`)
  }
  return value
}
