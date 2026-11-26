import { mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderWindowsMetafile } from './windowsMetafile'

const extensions: Record<string, string> = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/tiff': 'tiff',
  'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/x-emf': 'emf', 'image/emf': 'emf', 'image/x-wmf': 'wmf', 'image/wmf': 'wmf'
}

export function needsImageFileLink(url: string): boolean {
  return /\.(?:emf|wmf|tiff?)$/i.test(url)
}

export class DocumentImages {
  count = 0
  private size = 0
  constructor(private stage: string, private directory: string) {}
  save(bytes: Uint8Array, mime: string, extension?: string): string {
    const limit = 256 * 1024 * 1024
    if (this.count >= 32_000 || this.size + bytes.length > limit) throw new Error('Document images exceed 256 MiB or 32,000 files.')
    const ext = extensions[mime.split(';')[0].toLowerCase()] ?? extension?.replace(/^\./, '').toLowerCase()
    if (!ext || !/^[a-z0-9]{1,12}$/.test(ext)) throw new Error('Unsupported document image type: ' + mime)
    const directory = join(this.stage, 'images')
    if (!this.count) mkdirSync(directory)
    const stem = 'image-' + ++this.count
    let name = stem + '.' + ext
    const original = join(directory, name)
    writeFileSync(original, bytes)
    let size = bytes.length
    if (process.platform === 'win32' && (ext === 'emf' || ext === 'wmf')) {
      const preview = join(directory, stem + '.png')
      if (renderWindowsMetafile(original, preview)) {
        size = statSync(preview).size
        if (this.size + size > limit) throw new Error('Document images exceed 256 MiB.')
        rmSync(original)
        name = stem + '.png'
      } else {
        rmSync(preview, { force: true })
      }
    }
    this.size += size
    return './' + encodeURIComponent(this.directory).replace(/[()]/g, c => '%' + c.charCodeAt(0).toString(16)) + '/' + name
  }
}
