import { mkdir, mkdtemp, readFile, rm, stat, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const electronMocks = vi.hoisted(() => ({
  createThumbnailFromPath: vi.fn(),
  getFileIcon: vi.fn(),
  handle: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getFileIcon: electronMocks.getFileIcon },
  nativeImage: { createThumbnailFromPath: electronMocks.createThumbnailFromPath },
  protocol: { handle: electronMocks.handle }
}))

vi.mock('./config/appConfig', () => ({ getAppConfigSnapshot: async () => ({
  settings: { attachmentTextMaxChars: 100_000, attachmentTextOverflow: 'truncate' }
}) }))

import { readAttachmentPreview, readSelectedAttachments, registerAttachmentPreviewProtocol, releaseTemporaryAttachments, retainTemporaryAttachment } from './attachments'
import * as dataDir from './config/dataDir'
import { archiveAgentAttachments } from './agent/agentAttachmentStore'

const onePixelPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const onePixelBmpHeader = (() => {
  const header = Buffer.alloc(54)
  header.write('BM')
  header.writeUInt32LE(54, 2)
  header.writeUInt32LE(54, 10)
  header.writeUInt32LE(40, 14)
  header.writeInt32LE(1, 18)
  header.writeInt32LE(1, 22)
  header.writeUInt16LE(1, 26)
  header.writeUInt16LE(24, 28)
  return header
})()

function thumbnail(empty = false): {
  getSize: () => { height: number; width: number }
  isEmpty: () => boolean
  toPNG: () => Buffer
} {
  return {
    getSize: () => ({ width: empty ? 0 : 1, height: empty ? 0 : 1 }),
    isEmpty: () => empty,
    toPNG: () => Buffer.from('bounded-thumbnail')
  }
}

describe('bounded attachment previews', () => {
  let root = ''

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'anas-preview-budget-'))
    electronMocks.createThumbnailFromPath.mockReset().mockResolvedValue(thumbnail())
    electronMocks.handle.mockReset()
    registerAttachmentPreviewProtocol()
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    await rm(root, { recursive: true, force: true })
  })

  it('creates bounded thumbnails and streams original previews', async () => {
    const path = join(root, 'valid.png')
    await writeFile(path, onePixelPng)

    const thumbnail = await readAttachmentPreview(path, { mode: 'thumbnail' })
    expect(thumbnail?.mimeType).toBe('image/png')
    expect(thumbnail?.src).toMatch(/^data:image\/png;base64,/)
    const original = await readAttachmentPreview(path, { mode: 'original' })
    const handler = electronMocks.handle.mock.calls[0][1] as (request: Request) => Promise<Response>
    const response = await handler(new Request(original!.src))
    expect(Buffer.from(await response.arrayBuffer()).equals(onePixelPng)).toBe(true)
  })

  it('keeps mixed selections in order, identifies path-only files and folders, and preserves native names', async () => {
    const text = join(root, '文字 # 100% .custom')
    const binary = join(root, '归档.zip')
    const directory = join(root, '未命名文件夹')
    const trailingSpace = join(root, 'notes ')
    const broken = join(root, 'broken.png')
    const missing = join(root, 'missing.txt')
    await writeFile(text, 'plain text')
    await writeFile(binary, Buffer.from([0, 255, 0]))
    await mkdir(directory)
    await writeFile(trailingSpace, 'keep name')
    await writeFile(broken, 'damaged image')
    const paths = [text, binary, directory, trailingSpace, broken, missing]
    const files = await readSelectedAttachments([...paths, text])
    expect(files.map(file => file.path)).toEqual(paths)
    expect(files.map(file => file.name)).toEqual(paths.map(path => basename(path)))
    expect(files.map(file => file.sourcePath)).toEqual(paths)
    expect(files.map(file => file.kind)).toEqual(['text', 'binary', 'binary', 'text', 'image', 'binary'])
    expect(files.slice(0, 4).every(file => !file.skippedReason)).toBe(true)
    expect(files[4].skippedReason).toBeTruthy()
    expect(files[5].skippedReason).toBeTruthy()
  })

  it('selects documents as paths without parsing and keeps Markdown and HTML as text', async () => {
    const paths = ['word.docx', 'slides.pptx', 'scan.pdf', 'notes.md', 'page.html'].map(name => join(root, name))
    await Promise.all(paths.map(path => writeFile(path, 'sample')))
    const files = await readSelectedAttachments(paths)
    expect(files.map(item => item.kind)).toEqual(['binary', 'binary', 'binary', 'text', 'text'])
    expect(files.map(item => item.text)).toEqual([undefined, undefined, undefined, 'sample', 'sample'])
    expect(files.every(item => !item.skippedReason)).toBe(true)
  })

  it('reads SVG source as text but keeps binary files with an SVG extension path-only', async () => {
    const svg = join(root, 'diagram.svg')
    const binary = join(root, 'binary.svg')
    const source = '<svg xmlns="http://www.w3.org/2000/svg"><text>中文</text></svg>'
    await writeFile(svg, source)
    await writeFile(binary, Buffer.from([0, 255, 0]))

    const files = await readSelectedAttachments([svg, binary])
    expect(files[0]).toMatchObject({ path: svg, kind: 'text', mimeType: 'text/plain', text: source })
    expect(files[1]).toMatchObject({ path: binary, kind: 'binary', mimeType: 'image/svg+xml' })
    expect(files.every(file => !file.skippedReason && !file.dataUri)).toBe(true)
    expect(files[1].text).toBeUndefined()
  })

  it.each([10, 25, 26])('previews the complete %i MiB source and archived image without a byte limit', async (mebibytes) => {
    const path = join(root, '照片 #1 %.png')
    await writeFile(path, onePixelPng)
    // Padding after the PNG payload exercises file-size limits without changing its dimensions.
    await truncate(path, mebibytes * 1024 * 1024)
    const source = await readFile(path)
    const [archived] = await archiveAgentAttachments([{
      path, name: 'photo.png', size: source.length, mimeType: 'image/png', kind: 'image', contextPolicy: 'one_turn'
    }], { threadId: 'thread', runId: 'run', messageId: 'message' }, join(root, 'archive'))

    for (const previewPath of [path, archived.artifact.path]) {
      const preview = await readAttachmentPreview(previewPath, { mode: 'original' })
      expect(preview?.mimeType).toBe('image/png')
      const handler = electronMocks.handle.mock.calls[0][1] as (request: Request) => Promise<Response>
      const response = await handler(new Request(preview!.src))
      expect(response.status).toBe(200)
      expect(response.headers.get('content-type')).toBe('image/png')
      const restored = Buffer.from(await response.arrayBuffer())
      expect(restored.equals(source)).toBe(true)
    }
  })

  it('streams images from archive paths longer than the Windows legacy path limit', async () => {
    const directory = join(root, 'nested-'.repeat(18), 'archive-'.repeat(18))
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'image.png')
    expect(path.length).toBeGreaterThan(260)
    await writeFile(path, onePixelPng)
    const preview = await readAttachmentPreview(path, { mode: 'original' })
    const handler = electronMocks.handle.mock.calls[0][1] as (request: Request) => Promise<Response>
    const response = await handler(new Request(preview!.src))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-length')).toBe(String(onePixelPng.length))
    expect(Buffer.from(await response.arrayBuffer())).toEqual(onePixelPng)
  })

  it('stops streaming an original image when its request is cancelled', async () => {
    const path = join(root, 'cancelled.png')
    await writeFile(path, onePixelPng)
    await truncate(path, 26 * 1024 * 1024)
    const preview = await readAttachmentPreview(path, { mode: 'original' })
    const controller = new AbortController()
    const handler = electronMocks.handle.mock.calls[0][1] as (request: Request) => Promise<Response>
    const response = await handler(new Request(preview!.src, { signal: controller.signal }))
    controller.abort()
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('still accepts 25 MiB attachments and rejects larger images for sending', async () => {
    const path = join(root, 'send.png')
    await writeFile(path, onePixelPng)
    await truncate(path, 25 * 1024 * 1024)
    const [accepted] = await readSelectedAttachments([path])
    expect(accepted.skippedReason).toBeUndefined()
    expect(accepted.dataUri).toMatch(/^data:image\/png;base64,/)
    await truncate(path, 25 * 1024 * 1024 + 1)
    const [rejected] = await readSelectedAttachments([path])
    expect(rejected.skippedReason).toContain('exceeds 25 MB')
    expect(rejected.dataUri).toBeUndefined()
    await expect(readAttachmentPreview(path)).resolves.toMatchObject({ mimeType: 'image/png' })
  })

  it('rejects invalid preview requests and missing or non-image files', async () => {
    const handler = electronMocks.handle.mock.calls[0][1] as (request: Request) => Promise<Response>
    expect((await handler(new Request('anas-image://local/?path=relative.png'))).status).toBe(400)
    const path = join(root, 'missing.png')
    const src = `anas-image://local/?path=${encodeURIComponent(path)}`
    expect((await handler(new Request(src))).status).toBe(404)
    await writeFile(path, 'not an image')
    expect((await handler(new Request(src))).status).toBe(404)
  })

  it('reads bounded BMP headers without routing unsupported formats through the stream parser', async () => {
    const bmpPath = join(root, 'valid.bmp')
    await writeFile(bmpPath, onePixelBmpHeader)
    await expect(readAttachmentPreview(bmpPath, { mode: 'original' })).resolves.toMatchObject({ mimeType: 'image/bmp' })

    const unsupportedPath = join(root, 'renamed.png')
    await writeFile(unsupportedPath, 'not a supported image signature')
    await expect(readAttachmentPreview(unsupportedPath)).rejects.toThrow('type is not supported')
  })

  it('rejects damaged and excessive-pixel sources before decoding', async () => {
    const damaged = join(root, 'damaged.png')
    await writeFile(damaged, 'not an image')
    await expect(readAttachmentPreview(damaged)).rejects.toThrow()

    const excessivePixels = join(root, 'pixels.png')
    const header = Buffer.from(onePixelPng)
    header.writeUInt32BE(10_000, 16)
    header.writeUInt32BE(10_000, 20)
    await writeFile(excessivePixels, header)
    await expect(readAttachmentPreview(excessivePixels)).rejects.toThrow('pixel budget')
  })

  it('does not fall back to transferring the full file when thumbnail decoding fails', async () => {
    const path = join(root, 'empty-thumbnail.png')
    await writeFile(path, onePixelPng)
    electronMocks.createThumbnailFromPath.mockResolvedValue(thumbnail(true))

    await expect(readAttachmentPreview(path, { mode: 'thumbnail' }))
      .rejects.toThrow('thumbnail could not be decoded')
  })

  it('deduplicates identical main-process preview work', async () => {
    const path = join(root, 'deduplicated.png')
    await writeFile(path, onePixelPng)

    const first = readAttachmentPreview(path, { mode: 'thumbnail' })
    const second = readAttachmentPreview(path, { mode: 'thumbnail' })
    expect(second).toBe(first)
    await Promise.all([first, second])
    expect(electronMocks.createThumbnailFromPath).toHaveBeenCalledTimes(1)
  })

  it('limits concurrent main-process decoding across different previews', async () => {
    const pending = new Map<string, (value: ReturnType<typeof thumbnail>) => void>()
    electronMocks.createThumbnailFromPath.mockImplementation((path: string) => (
      new Promise((resolve) => pending.set(path, resolve))
    ))
    const paths = await Promise.all(Array.from({ length: 7 }, async (_, index) => {
      const path = join(root, `queued-${index}.png`)
      await writeFile(path, onePixelPng)
      return path
    }))
    const requests = paths.map((path) => readAttachmentPreview(path))

    await vi.waitFor(() => expect(electronMocks.createThumbnailFromPath).toHaveBeenCalledTimes(3))
    for (const path of paths) {
      await vi.waitFor(() => expect(pending.has(path)).toBe(true))
      pending.get(path)?.(thumbnail())
    }
    await expect(Promise.all(requests)).resolves.toHaveLength(paths.length)
  })
})

it('releases only the selected edited attachment, preserving its siblings, other drafts and persistent files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anas-release-draft-'))
  const temporary = join(root, 'tmp')
  const paths = [join(temporary, 'conversations', 'one', 'message_edit', 'draft', '0', 'file.txt'),
    join(temporary, 'conversations', 'two', 'message_edit', 'draft', '0', 'file.txt'),
    join(temporary, 'conversations', 'one', 'direction', 'draft', 'file.txt'),
    join(root, 'db', 'conversations', 'one', 'attachments', 'file.txt'),
    join(temporary, 'conversations', 'one', 'message_edit', 'draft', '1', 'sibling.txt')]
  const mockedRoot = vi.spyOn(dataDir, 'getTempDir').mockReturnValue(temporary)
  try {
    for (const path of paths) { await mkdir(join(path, '..'), { recursive: true }); await writeFile(path, 'keep') }
    await releaseTemporaryAttachments([paths[0], paths[2], paths[3]])
    await expect(stat(paths[0])).rejects.toMatchObject({ code: 'ENOENT' })
    for (const path of paths.slice(1)) expect(await readFile(path, 'utf8')).toBe('keep')
  } finally { mockedRoot.mockRestore(); await rm(root, { recursive: true, force: true }) }
})

it('retains an edited attachment outside temporary cleanup, without recreating a deleted conversation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anas-retain-attachment-'))
  const temporary = join(root, 'tmp')
  const path = join(temporary, 'conversations', 'thread', 'message_edit', 'draft', '0000', '中文 # %.txt')
  const attachmentRoot = dataDir.getAgentAttachmentsDir('thread', root, 'project')
  const mocks = [vi.spyOn(dataDir, 'getDataDir').mockReturnValue(root), vi.spyOn(dataDir, 'getTempDir').mockReturnValue(temporary)]
  try {
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, 'retained content')
    await expect(retainTemporaryAttachment(path, 'project')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(path, 'utf8')).toBe('retained content')
    await mkdir(attachmentRoot, { recursive: true })
    const kept = await retainTemporaryAttachment(path, 'project')
    expect(kept.startsWith(join(attachmentRoot, '_paths'))).toBe(true)
    await releaseTemporaryAttachments([path])
    await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(kept, 'utf8')).toBe('retained content')
    await expect(retainTemporaryAttachment(kept, 'project')).rejects.toThrow('Invalid temporary attachment')
  } finally {
    for (const mock of mocks) mock.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})
