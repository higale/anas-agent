import { describe, expect, it } from 'vitest'
import { attachmentImageCount, attachmentImageFailure, modelImageDataFailure } from './modelImageValidation'
import type { SelectedAttachment } from './types'

describe('shared attachment image validation', () => {
  it('checks BMP dimensions and original/base64 sizes consistently for byte and string inputs', () => {
    const data = new Uint8Array(54), header = new DataView(data.buffer)
    data.set([0x42, 0x4d])
    header.setUint32(14, 40, true)
    header.setInt32(18, 8, true)
    header.setInt32(22, -6, true)
    const base64 = btoa(String.fromCharCode(...data))
    for (const value of [data, base64]) {
      expect(modelImageDataFailure({ data: value }, { minShortSide: 6, maxLongSide: 8, maxPixels: 48 })).toBeUndefined()
      expect(modelImageDataFailure({ data: value }, { minShortSide: 7 })).toContain('short side 6')
      expect(modelImageDataFailure({ data: value }, { maxBytes: 54 })).toBeUndefined()
      expect(modelImageDataFailure({ data: value }, { maxBytes: 71, byteBasis: 'base64' })).toContain('Base64 size 72')
    }
  })

  it('leaves remote references outside validation and counts only embedded attachments', () => {
    const file: SelectedAttachment = { path: '/image.png', name: 'image.png', size: 100, kind: 'image',
      contextPolicy: 'one_turn', mimeType: 'image/png', url: 'https://fixture.invalid/image' }
    expect(attachmentImageFailure(file, { maxBytes: 0, minShortSide: 10 })).toBeUndefined()
    const local = { ...file, url: undefined, dataUri: 'DATA:image/png;BASE64,AAAA' }
    expect(attachmentImageFailure(local, { maxBytes: 0 })).toContain('Original size 3')
    expect(attachmentImageCount([file, local, { ...file, kind: 'text' }])).toBe(1)
    expect(attachmentImageFailure({ ...local, skippedReason: 'Corrupted image' }, {})).toBe('Corrupted image')
  })
})
