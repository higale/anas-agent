import { describe, expect, it } from 'vitest'
import { contentText, inputContentBlocks } from './inputContent'

describe('input content', () => {
  it('preserves empty text and concatenates text without separators', () => {
    expect(inputContentBlocks('')).toEqual([{ type: 'text', text: '' }])
    expect(contentText(inputContentBlocks('hello'))).toBe('hello')
    expect(contentText([{ type: 'text', text: 'a' }, { type: 'image', url: 'image' },
      { type: 'text', text: 0 }, { type: 'text', text: false }, { type: 'text', text: null },
      { type: 'text', text: 'b' }])).toBe('a0falseb')
  })

  it('normalizes source references without losing empty or false metadata', () => {
    expect(inputContentBlocks([
      { type: 'image', source_type: 'url', url: '', mime_type: '', metadata: false },
      { type: 'audio', source_type: 'base64', data: '', metadata: 0 },
      { type: 'file', source_type: 'id', id: '', metadata: [] }
    ])).toStrictEqual([
      { type: 'image', url: '', mimeType: '', metadata: false },
      { type: 'audio', data: '', mimeType: 'application/octet-stream', metadata: 0 },
      { type: 'file', fileId: '', mimeType: undefined, metadata: [] }
    ])
  })

  it('preserves media payload bytes and the existing data URL recognition', () => {
    expect(inputContentBlocks([
      { type: 'image_url', image_url: { url: 'data:IMAGE/PNG;base64,YWJj==', detail: 'high' } },
      { type: 'image_url', image_url: { url: 'data:image/svg+xml;base64,YWJj' } },
      { type: 'image_url', image_url: { url: 'https://example.invalid/a.png' } },
      { type: 'input_audio', input_audio: { data: 'raw\nbytes==', format: 'wav' } },
      { type: 'file', file: { data: 'data:application/pdf;base64,YWJj', file_id: 'unused' } },
      { type: 'file', file: { data: '', file_id: 'file-1' } }
    ])).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'YWJj==' },
      { type: 'image', url: 'data:image/svg+xml;base64,YWJj' },
      { type: 'image', url: 'https://example.invalid/a.png' },
      { type: 'audio', data: 'raw\nbytes==', mimeType: 'audio/wav' },
      { type: 'file', mimeType: 'application/pdf', data: 'YWJj' },
      { type: 'file', fileId: 'file-1' }
    ])
  })

  it('normalizes Anthropic media sources without changing content bytes', () => {
    expect(inputContentBlocks([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      { type: 'image', source: { type: 'url', url: '' } },
      { type: 'document', source: { type: 'file', file_id: 'file-2' } },
      { type: 'document', source: { type: 'text', data: '\ncontent\n' } },
      { type: 'document', source: { type: 'text', data: '', media_type: '' } }
    ])).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'AA==' },
      { type: 'image', url: '' },
      { type: 'file', fileId: 'file-2' },
      { type: 'file', mimeType: 'text/plain', data: '\ncontent\n' },
      { type: 'file', mimeType: '', data: '' }
    ])
  })

  it('leaves unknown and incomplete blocks intact without guessing new formats', () => {
    const content = [
      null, false, 0, '', [], { type: 'custom', data: { value: false } },
      { type: 'image_url', image_url: 'https://example.invalid/a.png' },
      { type: 'input_audio', input_audio: { data: 'AA==' } },
      { type: 'file', file: { file_id: 'file-1' } },
      { type: 'file', file: { file_data: 'data:application/pdf;base64,AA==' } },
      { type: 'image', source_type: 'url', url: 1 },
      { type: 'image', source: { type: 'base64', data: 'AA==' } },
      { type: 'image', source: { type: 'text', data: 'hello' } }
    ]
    const before = structuredClone(content)
    expect(inputContentBlocks(content)).toEqual(before)
    expect(content).toEqual(before)
  })

  it('does not mutate frozen input or its nested media source', () => {
    const source = Object.freeze({ type: 'base64', media_type: 'image/png', data: 'AA==' })
    const block = Object.freeze({ type: 'image', source })
    const content = Object.freeze([block])
    expect(inputContentBlocks(content)).toEqual([{ type: 'image', mimeType: 'image/png', data: 'AA==' }])
    expect(content[0]).toBe(block)
    expect(block.source).toBe(source)
  })
})
