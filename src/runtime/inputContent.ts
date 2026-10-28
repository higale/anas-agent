// Media mappings preserve the imported LangChain Core 1.2.10 behavior (MIT).
// Attribution: THIRD_PARTY_NOTICES.md and data/licenses/langchain/LICENSE.
type Fields = Record<string, unknown>

function record(value: unknown): Fields | undefined {
  return value !== null && typeof value === 'object' ? value as Fields : undefined
}

function dataUrl(value: string): { mimeType: string; data: string } | undefined {
  const match = /^data:(\w+\/\w+);base64,([A-Za-z0-9+/]+=*)$/.exec(value)
  return match ? { mimeType: match[1].toLowerCase(), data: match[2] } : undefined
}

function dataContent(value: unknown): unknown {
  const block = record(value)
  if (!block || typeof block.type !== 'string') return value
  if (block.source_type === 'url' && typeof block.url === 'string') return {
    type: block.type, mimeType: block.mime_type, url: block.url, metadata: block.metadata
  }
  if (block.source_type === 'base64' && typeof block.data === 'string') return {
    type: block.type, mimeType: block.mime_type ?? 'application/octet-stream', data: block.data, metadata: block.metadata
  }
  if (block.source_type === 'id' && typeof block.id === 'string') return {
    type: block.type, mimeType: block.mime_type, fileId: block.id, metadata: block.metadata
  }
  return value
}

function openAiContent(value: unknown): unknown {
  const block = record(value)
  if (!block) return value
  const image = record(block.image_url), audio = record(block.input_audio), file = record(block.file)
  if (block.type === 'image_url' && typeof image?.url === 'string') {
    const embedded = dataUrl(image.url)
    return embedded ? { type: 'image', ...embedded } : { type: 'image', url: image.url }
  }
  if (block.type === 'input_audio' && typeof audio?.data === 'string' && typeof audio.format === 'string') {
    return { type: 'audio', data: audio.data, mimeType: `audio/${audio.format}` }
  }
  if (block.type === 'file' && typeof file?.data === 'string') {
    const embedded = dataUrl(file.data)
    if (embedded) return { type: 'file', ...embedded }
    if (typeof file.file_id === 'string') return { type: 'file', fileId: file.file_id }
  }
  return value
}

function anthropicContent(value: unknown): unknown {
  const block = record(value), source = record(block?.source)
  if (!block || !source || (block.type !== 'image' && block.type !== 'document')) return value
  const type = block.type === 'document' ? 'file' : 'image'
  if (source.type === 'base64' && typeof source.media_type === 'string' && typeof source.data === 'string') {
    return { type, mimeType: source.media_type, data: source.data }
  }
  if (source.type === 'url' && typeof source.url === 'string') return { type, url: source.url }
  if (source.type === 'file' && typeof source.file_id === 'string') return { type, fileId: source.file_id }
  if (block.type === 'document' && source.type === 'text' && typeof source.data === 'string') {
    return { type, mimeType: String(source.media_type ?? 'text/plain'), data: source.data }
  }
  return value
}

/** User/system/tool content only. Provider response interpretation is separate;
 * unknown blocks remain intact, including ordinary JSON and unsupported media. */
export function inputContentBlocks(content: string | readonly unknown[]): unknown[] {
  const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content
  return blocks.map(block => anthropicContent(openAiContent(dataContent(block))))
}

export function contentText(blocks: readonly unknown[]): string {
  return blocks.map(value => {
    const block = record(value)
    return block?.type === 'text' ? String(block.text ?? '') : ''
  }).join('')
}
