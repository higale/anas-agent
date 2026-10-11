import { describe, expect, it } from 'vitest'
import { parsePluginContentResult, validatePluginToolResult } from './pluginToolResult'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
const image = { type: 'image', mimeType: 'image/png', data: png }

describe('plugin image results', () => {
  it('preserves standard text and Base64 image blocks without temporary file references', () => {
    const blocks = [{ type: 'text', text: 'Original desktop: 1 × 1.' }, image]
    expect(parsePluginContentResult(blocks)).toEqual(blocks)
    expect(validatePluginToolResult({ images: 0 })).toEqual({ images: 0 })
  })
  it.each([
    { ...image, data: 'not base64' }, { ...image, data: Buffer.from('not an image').toString('base64') },
    { ...image, mimeType: 'image/jpeg' }, { type: 'image', resource: '/tmp/image.png' },
    { type: 'image_url', image_url: 'https://example.com/image.png' }
  ])('rejects invalid image content: %j', block => {
    expect(() => parsePluginContentResult([block])).toThrow()
  })
  it('bounds image counts, text and pixel allocations', () => {
    expect(() => parsePluginContentResult(Array(5).fill(image))).toThrow('4 images')
    expect(() => parsePluginContentResult([{ type: 'text', text: 'x'.repeat(1024 * 1024 + 1) }])).toThrow('1 MiB')
    const oversized = Buffer.from(png, 'base64')
    oversized.writeUInt32BE(16385, 16)
    expect(() => parsePluginContentResult([{ ...image, data: oversized.toString('base64') }])).toThrow('pixel budget')
  })
  it('allows bounded image payloads beyond the JSON RPC budget and bounds aggregate bytes', () => {
    const large = Buffer.alloc(17 * 1024 * 1024)
    Buffer.from(png, 'base64').copy(large)
    const block = { ...image, data: large.toString('base64') }
    expect(parsePluginContentResult([block])[0]).toEqual(block)
    expect(() => parsePluginContentResult([block, block])).toThrow('32 MiB')
    expect(validatePluginToolResult([block])).toEqual([block])
    expect(() => parsePluginContentResult([{ ...image, data: 'A'.repeat(Math.ceil(25 * 1024 * 1024 / 3) * 4 + 4) }])).toThrow('25 MiB')
  })
})
