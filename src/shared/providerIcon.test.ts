import { describe, expect, it } from 'vitest'
import { maxProviderSvgBytes, normalizeProviderIconData } from './providerIcon'

describe('provider icon data', () => {
  it('defaults an absent icon to empty and preserves SVG and PNG bytes', () => {
    expect(normalizeProviderIconData(undefined)).toBe('')
    expect(normalizeProviderIconData('')).toBe('')
    for (const mime of ['image/svg+xml', 'image/png']) {
      const data = `data:${mime};base64,${Buffer.from('image bytes').toString('base64')}`
      expect(normalizeProviderIconData(data)).toBe(data)
    }
  })

  it.each([null, 42, 'https://example.test/icon.svg', 'data:text/html;base64,PHN2Zz4=',
    'data:image/png;base64,!', 'data:image/png;base64,YQ', 'data:image/png;base64,'])('rejects unsupported or malformed values: %s', (value) => {
    expect(() => normalizeProviderIconData(value)).toThrow('icon_data')
  })

  it('enforces the SVG byte limit including padded Base64', () => {
    const data = (size: number) => `data:image/svg+xml;base64,${Buffer.alloc(size).toString('base64')}`
    expect(normalizeProviderIconData(data(maxProviderSvgBytes))).toBe(data(maxProviderSvgBytes))
    expect(() => normalizeProviderIconData(data(maxProviderSvgBytes + 1))).toThrow('1 MB')
  })

  it('does not apply the SVG byte limit to PNG data', () => {
    const data = `data:image/png;base64,${Buffer.alloc(maxProviderSvgBytes + 1).toString('base64')}`
    expect(normalizeProviderIconData(data)).toBe(data)
  })
})
