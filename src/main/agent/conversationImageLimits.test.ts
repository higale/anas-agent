import { describe, expect, it } from 'vitest'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { projectModelImageLimits } from './conversationImageLimits'
import { projectConversationToolImages } from './conversationContext'

// Header fixture deliberately tests dimension inspection, not full image decoding.
function png(width: number, height: number) {
  const bytes = Buffer.alloc(33)
  Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').copy(bytes)
  bytes.writeUInt32BE(width, 16); bytes.writeUInt32BE(height, 20)
  return { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') }
}
const tool = (content: unknown[], id = 'capture'): ConversationMessage => ({ kind: 'tool', name: 'capture', resultFor: id, resultStatus: 'success', content })
const text = { type: 'text', text: 'Original result' }
const project = (message: ConversationMessage, rules: Parameters<typeof projectModelImageLimits>[1]) => projectModelImageLimits([message], rules)[0]

describe('model image input limits', () => {
  it('leaves empty rules and remote references untouched, and rejects invalid attachments', () => {
    const invalid = tool([{ type: 'image', data: 'bad image' }])
    expect(project(invalid, {})).toBe(invalid)
    expect(project(invalid, { byteBasis: 'base64' })).toBe(invalid)
    const remote = tool([{ type: 'image', url: 'https://fixture.invalid/a.png' }, { type: 'image', fileId: 'file-id' }])
    expect(project(remote, { maxCount: 0, maxBytes: 0, minShortSide: 100 })).toBe(remote)
    const user: ConversationMessage = { kind: 'user', content: [png(1, 1)] }
    expect(() => project(user, { minShortSide: 10 })).toThrow('short side 1')
    expect(project(user, {})).toBe(user)
    expect(() => project(user, { maxCount: 0 })).toThrow('Remove attachments')
  })

  it('counts attachments with pending tool images, omits the complete batch, and preserves originals', () => {
    const source: ConversationMessage[] = [{ id: 'user', kind: 'user', content: [text, png(8, 6)] }, tool([png(20, 20)])]
    const original = structuredClone(source)
    const result = projectModelImageLimits(source, { maxCount: 1 })
    expect(result.every(message => message.context?.imageLimitWarnings?.length === 1)).toBe(true)
    expect(result[0].content).toContain(text)
    expect(JSON.stringify(result)).not.toContain(png(8, 6).data)
    expect(JSON.stringify(result)).not.toContain(png(20, 20).data)
    expect(source).toEqual(original)
    expect(() => projectModelImageLimits(source, { maxCount: 1 }, 'submission')).toThrow('Remove attachments')
    expect(projectModelImageLimits([source[1]], { maxCount: 0 }, 'submission')[0].context?.imageLimitWarnings).toHaveLength(1)
    const consumed = projectConversationToolImages([...source, { kind: 'assistant', content: 'Seen' }])
    expect(projectModelImageLimits(consumed, { maxCount: 1 })).toEqual(consumed)
  })

  it.each([
    [{ minShortSide: 6 }, true], [{ minShortSide: 7 }, false],
    [{ maxLongSide: 8 }, true], [{ maxLongSide: 7 }, false],
    [{ maxPixels: 48 }, true], [{ maxPixels: 47 }, false],
    [{ maxAspectRatio: 8 / 6 }, true], [{ maxAspectRatio: 1.3 }, false],
    [{ maxBytes: 33 }, true], [{ maxBytes: 32 }, false],
    [{ maxBytes: 44, byteBasis: 'base64' as const }, true], [{ maxBytes: 43, byteBasis: 'base64' as const }, false]
  ])('checks inclusive boundaries %j', (limits, accepted) => {
    const image = png(8, 6), source = tool([text, image]), before = structuredClone(source)
    const result = project(source, limits)
    expect(result.content).toContain(text)
    expect((result.content as unknown[]).includes(image)).toBe(accepted)
    expect(result.resultStatus).toBe('success')
    expect(source).toEqual(before)
    if (!accepted) expect(JSON.stringify(result.content)).toContain('was not sent')
  })

  it('invalidates the entire multi-tool batch before filtering individual images', () => {
    const small = png(8, 6), large = png(20, 20), remote = { type: 'image', url: 'https://fixture.invalid/image' }
    const source = [tool([text, small, remote]), tool([large], 'other')]
    const result = projectModelImageLimits(source, { maxCount: 1, minShortSide: 10 })
    expect(JSON.stringify(result)).not.toContain(small.data)
    expect(JSON.stringify(result)).not.toContain(large.data)
    expect(result[0].content).toContain(remote)
    expect(JSON.stringify(result)).toContain('entire batch of 2')
    expect(projectModelImageLimits(result, { maxCount: 1 })).toEqual(result)
  })

  it('uses the same source precedence as encoding and leaves remote references untouched', () => {
    const data = png(8, 6).data
    const remote = tool([{ type: 'image', url: 'https://fixture.invalid/image', data },
      { type: 'image', fileId: 'file-image', data }])
    expect(project(remote, { maxCount: 0, maxBytes: 0 })).toBe(remote)
    const explicit = tool([{ type: 'image', source_type: 'base64', mime_type: 'image/png', data, url: 'https://fixture.invalid/ignored' }])
    expect(project(explicit, { maxCount: 0 }).context?.imageLimitWarnings).toHaveLength(1)
  })

  it('checks case-insensitive inline data URLs instead of treating them as remote references', () => {
    const data = png(8, 6).data
    const source = tool([{ type: 'image', url: `DATA:image/png;BASE64,${data}` }])
    expect(project(source, { minShortSide: 11 }).context?.imageLimitWarnings).toEqual([expect.stringContaining('short side 6')])
  })

  it('checks all supported embedded forms, including Data URIs', () => {
    const { data } = png(8, 6)
    const source = tool([
      { type: 'image', source_type: 'base64', data, mime_type: 'image/png' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data } },
      { type: 'image_url', image_url: { url: `data:image/png;base64,${data}` } },
      { type: 'input_image', image_url: `data:image/png;base64,${data}` },
      { type: 'image', data: Buffer.from(data, 'base64'), mimeType: 'image/png' }
    ])
    expect(project(source, { minShortSide: 11 }).context?.imageLimitWarnings).toHaveLength(5)
  })

  it('distinguishes invalid encoding from unreadable headers and never echoes payloads', () => {
    const source = tool([{ type: 'image', data: 'invalid_base64' }, { type: 'image', data: Buffer.from('not an image').toString('base64') }])
    const result = JSON.stringify(project(source, { minShortSide: 2 }))
    expect(result).toContain('Invalid Base64')
    expect(result).toContain('dimensions could not be read')
    expect(result).not.toContain('invalid_base64')
  })

  it('keeps pending images eligible under changed rules without reviving consumed images', () => {
    const image = png(8, 6), source = tool([image])
    expect(project(source, { minShortSide: 11 }).context?.imageLimitWarnings).toHaveLength(1)
    expect(project(source, { minShortSide: 6 })).toBe(source)
    const consumed = projectConversationToolImages([source, { kind: 'assistant', content: 'Seen' }])
    expect(JSON.stringify(projectModelImageLimits(consumed, {}))).not.toContain(image.data)
  })
})
