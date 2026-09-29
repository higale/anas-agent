const localImageExtensions = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'])
const localPathPattern = /^(?:[a-zA-Z]:[\\/]|\\\\|\/)/
const urlSchemePattern = /^[a-zA-Z][a-zA-Z\d+.-]*:/

export function fileUrlToPath(value: string): string | null {
  try {
    const url = new URL(value)
    if (url.protocol !== 'file:') return null
    const pathName = decodeURIComponent(url.pathname)
    if (/^\/[a-zA-Z]:[\\/]/.test(pathName)) return pathName.slice(1).replaceAll('/', '\\')
    if (url.hostname && url.hostname !== 'localhost') return `\\\\${url.hostname}${pathName.replaceAll('/', '\\')}`
    return pathName
  } catch {
    return null
  }
}

/** Resolve document assets without using the renderer page's URL or working directory. */
export function resolveMarkdownDocumentUrl(value: string, documentPath: string): string {
  if (!value || value.startsWith('#')) return value
  const asFileUrl = (path: string) => {
    const normalized = path.replaceAll('\\', '/')
    const encoded = normalized.split('/').map(encodeURIComponent).join('/').replace(/^([a-zA-Z])%3A\//, '$1:/')
    return new URL(normalized.startsWith('//') ? `file:${encoded}` : `file://${normalized.startsWith('/') ? '' : '/'}${encoded}`)
  }
  try {
    if (/^[a-zA-Z]:[\\/]/.test(value) || value.startsWith('\\\\')) {
      const path = value.split(/[?#]/, 1)[0]
      return new URL(value.slice(path.length), asFileUrl(decodeURIComponent(path))).href
    }
    if (urlSchemePattern.test(value)) return value
    if (value.startsWith('//')) return `https:${value}`
    return new URL(value, asFileUrl(documentPath)).href
  } catch { return value }
}

export function normalizeLocalImagePath(src: string | undefined): string | null {
  if (!src) return null
  const value = src.trim()
  if (!value) return null

  // Markdown encodes backslashes, spaces and Unicode in image destinations.
  // Remove URL suffixes before decoding so encoded # and ? stay in filenames.
  let filePath: string | null
  try {
    filePath = /^file:/i.test(value)
      ? fileUrlToPath(value)
      : decodeURIComponent(value.split(/[?#]/, 1)[0])
  } catch {
    return null
  }
  if (
    !filePath
    || filePath.startsWith('//')
    || (!localPathPattern.test(filePath) && urlSchemePattern.test(filePath))
  ) return null

  const extensionMatch = /\.[a-zA-Z0-9]+$/.exec(filePath)
  const extension = extensionMatch?.[0]?.toLowerCase()
  if (!extension || !localImageExtensions.has(extension)) return null
  return filePath
}
