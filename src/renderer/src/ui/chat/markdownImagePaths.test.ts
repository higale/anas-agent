import { describe, expect, it } from 'vitest'
import { fileUrlToPath, normalizeLocalImagePath, resolveMarkdownDocumentUrl } from './markdownImagePaths'

describe('Markdown document-relative destinations', () => {
  it.each([
    ['/skills/鱼 # 100%/SKILL.md', './images/a%20%231.png', '/skills/鱼 # 100%/images/a #1.png'],
    ['C:\\skills\\demo\\SKILL.md', '../images/a.png', 'C:\\skills\\images\\a.png'],
    ['/skills/SKILL.md', 'C:/docs/guide.md#section', 'C:\\docs\\guide.md'],
    ['/skills/SKILL.md', 'C:/images/photo%20%231.png?raw=1#preview', 'C:\\images\\photo #1.png'],
    ['/skills/SKILL.md', '\\\\server\\share\\guide.md#section', '\\\\server\\share\\guide.md'],
    ['\\\\server\\share\\demo\\SKILL.md', './a.png', '\\\\server\\share\\demo\\a.png'],
    ['/skills/demo/SKILL.md', '/other/readme.md', '/other/readme.md']
  ])('resolves %s and %s to a filesystem target', (path, href, expected) => {
    expect(fileUrlToPath(resolveMarkdownDocumentUrl(href, path))).toBe(expected)
  })
  it('keeps anchors and explicit URL schemes for the existing URL policy', () => {
    for (const href of ['#section', 'https://example.com', 'mailto:a@example.com', 'javascript:alert(1)']) {
      expect(resolveMarkdownDocumentUrl(href, '/skills/SKILL.md')).toBe(href)
    }
    expect(resolveMarkdownDocumentUrl('//example.com/a.png', '/skills/SKILL.md')).toBe('https://example.com/a.png')
  })
})

describe('normalizeLocalImagePath', () => {
  it('keeps absolute macOS file URLs as POSIX paths', () => {
    expect(normalizeLocalImagePath('file:///Users/user/Pictures/photo%201.png')).toBe('/Users/user/Pictures/photo 1.png')
  })

  it('accepts absolute POSIX image paths', () => {
    expect(normalizeLocalImagePath('/Users/user/Pictures/photo.jpg')).toBe('/Users/user/Pictures/photo.jpg')
  })

  it('keeps Windows file URLs as Windows paths', () => {
    expect(normalizeLocalImagePath('file:///C:/Users/user/Pictures/photo.png')).toBe('C:\\Users\\user\\Pictures\\photo.png')
  })

  it('accepts direct Windows image paths', () => {
    expect(normalizeLocalImagePath('C:\\Users\\user\\Pictures\\photo.webp')).toBe('C:\\Users\\user\\Pictures\\photo.webp')
  })

  it('decodes Markdown destinations exactly once before identifying local paths', () => {
    expect(normalizeLocalImagePath('C:%5CUsers%5Cuser%5CPictures%5C002.png')).toBe('C:\\Users\\user\\Pictures\\002.png')
    expect(normalizeLocalImagePath('/Pictures/%E9%B1%BC%20%23%20100%25.png')).toBe('/Pictures/鱼 # 100%.png')
    expect(normalizeLocalImagePath('images/literal%2520.png')).toBe('images/literal%20.png')
    expect(normalizeLocalImagePath('file:///C:/Pictures/photo%20%23%20100%25.png')).toBe('C:\\Pictures\\photo # 100%.png')
    expect(normalizeLocalImagePath('file://server/share/photo%20%23.png')).toBe('\\\\server\\share\\photo #.png')
  })

  it('strips query and hash fragments before reading the local image', () => {
    expect(normalizeLocalImagePath('/Users/user/Pictures/photo.png?raw=1#preview')).toBe('/Users/user/Pictures/photo.png')
  })

  it('accepts workspace-relative image paths and decodes URL escapes', () => {
    expect(normalizeLocalImagePath('asian_woman_avatar.png')).toBe('asian_woman_avatar.png')
    expect(normalizeLocalImagePath('./images/asian%20woman.webp')).toBe('./images/asian woman.webp')
  })

  it('rejects non-local and non-image sources', () => {
    expect(normalizeLocalImagePath('https://example.com/photo.png')).toBeNull()
    expect(normalizeLocalImagePath('data:image/png;base64,AA==')).toBeNull()
    expect(normalizeLocalImagePath('/Users/user/Pictures/readme.txt')).toBeNull()
    expect(normalizeLocalImagePath('notes/readme.txt')).toBeNull()
    expect(normalizeLocalImagePath('//example.com/photo.png')).toBeNull()
    expect(normalizeLocalImagePath('C:%5CPictures%5Cbad%ZZ.png')).toBeNull()
  })
})
