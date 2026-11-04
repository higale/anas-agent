import { describe, expect, it } from 'vitest'
import { maxIconSvgBytes, normalizeIconData } from './iconImage'

describe('provider icon data', () => {
  it('defaults an absent icon to empty and preserves SVG and PNG bytes', () => {
    expect(normalizeIconData(undefined)).toBe('')
    expect(normalizeIconData('')).toBe('')
    for (const mime of ['image/svg+xml', 'image/png']) {
      const data = `data:${mime};base64,${Buffer.from('image bytes').toString('base64')}`
      expect(normalizeIconData(data)).toBe(data)
    }
  })

  it.each([null, 42, 'https://example.test/icon.svg', 'data:text/html;base64,PHN2Zz4=',
    'data:image/png;base64,!', 'data:image/png;base64,YQ', 'data:image/png;base64,'])('rejects unsupported or malformed values: %s', (value) => {
    expect(() => normalizeIconData(value)).toThrow('icon_data')
  })

  it('enforces the SVG byte limit including padded Base64', () => {
    const data = (size: number) => `data:image/svg+xml;base64,${Buffer.alloc(size).toString('base64')}`
    expect(normalizeIconData(data(maxIconSvgBytes))).toBe(data(maxIconSvgBytes))
    expect(() => normalizeIconData(data(maxIconSvgBytes + 1))).toThrow('1 MB')
  })

  it('does not apply the SVG byte limit to PNG data', () => {
    const data = `data:image/png;base64,${Buffer.alloc(maxIconSvgBytes + 1).toString('base64')}`
    expect(normalizeIconData(data)).toBe(data)
  })
})
