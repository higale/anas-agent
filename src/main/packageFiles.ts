import { constants } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, stat, readdir, readlink, realpath, open, rm, rename, mkdir, rmdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PackageFileNode, PackageFilePreview, PackageFileUpdate } from '@shared/packageFiles'

const ignoredDirectories = new Set(['.git', '.svn', '__pycache__', 'node_modules', '.backup', '__history', '__recovery'])
const systemEntriesByPlatform: Partial<Record<NodeJS.Platform, ReadonlySet<string>>> = {
  darwin: new Set(['.ds_store', '.localized', '__macosx', 'icon\r']),
  win32: new Set(['thumbs.db', 'ehthumbs.db', 'ehthumbs_vista.db', 'desktop.ini']),
  linux: new Set(['.directory'])
}
const binaryExtensions = new Set(['.7z', '.avi', '.bin', '.bmp', '.db', '.dmg', '.doc', '.docx', '.gif', '.gz', '.ico', '.jpeg', '.jpg', '.mov', '.mp3', '.mp4', '.pdf', '.png', '.ppt', '.pptx', '.sqlite', '.tar', '.tgz', '.wav', '.webp', '.xls', '.xlsx', '.zip'])
const maxPreviewBytes = 1024 * 1024
const maxTreeDepth = 24
const maxTreeEntriesPerDirectory = 4096

function safeRelativePath(value: string): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error('Package file path is invalid.')
  const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized || isAbsolute(value) || normalized.split('/').some((part) => part === '..' || part === '')) {
    throw new Error('Package file path is invalid.')
  }
  if (normalized.split('/').length > maxTreeDepth) throw new Error('Package tree path is too deep.')
  return normalized
}

function lexicalPackagePath(directory: string, value: string): string {
  const safe = safeRelativePath(value)
  const path = resolve(directory, safe)
  const rel = relative(resolve(directory), path)
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Package file path is outside the Package directory.')
  return path
}

function fileKind(name: string): 'text' | 'binary' {
  const dot = name.lastIndexOf('.')
  return dot >= 0 && binaryExtensions.has(name.slice(dot).toLowerCase()) ? 'binary' : 'text'
}

export async function listPackageFiles(packageDirectory: string, relativePath?: string): Promise<PackageFileNode[]> {
  const directory = relativePath ? lexicalPackagePath(packageDirectory, relativePath) : packageDirectory
  const directoryInfo = await stat(directory)
  if (!directoryInfo.isDirectory()) throw new Error('Package tree node is not a directory.')
  const entries = await readdir(directory, { withFileTypes: true })
  if (entries.length > maxTreeEntriesPerDirectory) {
    throw new Error(`Package directory contains more than ${maxTreeEntriesPerDirectory} entries.`)
  }
  const systemEntries = systemEntriesByPlatform[process.platform]
  const nodes = await Promise.all(entries
    .filter((entry) => !ignoredDirectories.has(entry.name.toLowerCase()) && !systemEntries?.has(entry.name.toLowerCase())
      && !(process.platform === 'darwin' && entry.name.startsWith('._')))
    .map(async (entry): Promise<PackageFileNode> => {
      const childPath = join(directory, entry.name)
      const childRelative = relativePath ? `${safeRelativePath(relativePath)}/${entry.name}` : entry.name
      const linkInfo = await lstat(childPath)
      const targetInfo = linkInfo.isSymbolicLink() ? await stat(childPath).catch(() => undefined) : linkInfo
      const kind = linkInfo.isSymbolicLink()
        ? 'symlink'
        : targetInfo?.isDirectory()
          ? 'directory'
          : fileKind(entry.name)
      return {
        name: entry.name,
        path: childPath,
        relativePath: childRelative,
        kind,
        ...(!targetInfo?.isDirectory() && targetInfo ? { size: targetInfo.size } : {}),
        ...(linkInfo.isSymbolicLink() ? {
          linkTarget: await readlink(childPath),
          resolvedPath: await realpath(childPath).catch(() => undefined),
          linkDirectory: targetInfo?.isDirectory() ?? false
        } : {})
      }
    }))
  return nodes.sort((left, right) => (
    Number(right.kind === 'directory' || right.linkDirectory) - Number(left.kind === 'directory' || left.linkDirectory)
    || left.name.localeCompare(right.name)
  ))
}

export async function readPackageFile(packageDirectory: string, relativePath: string): Promise<PackageFilePreview> {
  const lexicalPath = lexicalPackagePath(packageDirectory, relativePath)
  const [linkInfo, resolvedPath] = await Promise.all([lstat(lexicalPath), realpath(lexicalPath)])
  const handle = await open(resolvedPath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0))
  let info
  let data: Buffer
  try {
    info = await handle.stat()
    if (!info.isFile()) throw new Error('Package tree node is not a file.')
    if (info.size > maxPreviewBytes) throw new Error(`Package file exceeds ${maxPreviewBytes} bytes.`)
    const buffer = Buffer.allocUnsafe(maxPreviewBytes + 1)
    let length = 0
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null)
      if (!bytesRead) break
      length += bytesRead
    }
    if (length > maxPreviewBytes) throw new Error(`Package file exceeds ${maxPreviewBytes} bytes.`)
    data = buffer.subarray(0, length)
  } finally {
    await handle.close()
  }
  let content: string | undefined
  if (fileKind(resolvedPath) !== 'binary' && !data.includes(0)) {
    try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(data) } catch { /* Non-UTF-8 files are not text-editable. */ }
  }
  const binary = content === undefined
  return {
    name: basename(lexicalPath),
    path: lexicalPath,
    relativePath: safeRelativePath(relativePath),
    resolvedPath,
    ...(linkInfo.isSymbolicLink() ? { linkTarget: await readlink(lexicalPath) } : {}),
    size: info.size,
    kind: binary ? 'binary' : 'text',
    ...(!binary ? { content, revision: createHash('sha256').update(data).digest('hex') } : {})
  }
}

let saveTail: Promise<unknown> = Promise.resolve()

export async function packageFileExists(directory: string, relativePath: string): Promise<boolean> {
  const path = lexicalPackagePath(directory, relativePath)
  try { await lstat(path); return true }
  catch (reason) { if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason }
  // Windows can report ENOENT when an intermediate component is a file.
  // Check the nearest existing parent before offering to create the file.
  const root = resolve(directory)
  let parent = dirname(path)
  while (true) {
    try {
      if (!(await stat(parent)).isDirectory()) {
        throw Object.assign(new Error('Package tree node is not a directory.'), { code: 'ENOTDIR' })
      }
      return false
    } catch (reason) { if ((reason as NodeJS.ErrnoException).code !== 'ENOENT') throw reason }
    if (parent === root) return false
    parent = dirname(parent)
  }
}

export async function createPackageFile(directory: string, relativePath: string): Promise<PackageFilePreview> {
  lexicalPackagePath(directory, relativePath)
  const root = await realpath(directory)
  const parts = safeRelativePath(relativePath).split('/')
  let parent = root
  const createdDirectories: string[] = []
  try {
    for (const part of parts.slice(0, -1)) {
      const path = join(parent, part)
      try { await mkdir(path); createdDirectories.push(path) }
      catch (reason) { if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason }
      parent = await realpath(path)
      const rel = relative(root, parent)
      if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Package file path is outside the Package directory.')
      if (!(await stat(parent)).isDirectory()) throw new Error('Package tree node is not a directory.')
    }
    const handle = await open(join(parent, parts.at(-1)!), 'wx')
    await handle.close()
    return await readPackageFile(directory, relativePath)
  } catch (reason) {
    for (const path of createdDirectories.reverse()) await rmdir(path).catch(() => {})
    throw reason
  }
}

export function savePackageFile(directory: string, relativePath: string, update: PackageFileUpdate): Promise<PackageFilePreview> {
  const operation = saveTail.then(async () => {
    if (!update || typeof update.content !== 'string' || typeof update.revision !== 'string'
      || typeof update.resolvedPath !== 'string' || update.content.includes('\0')
      || Buffer.byteLength(update.content, 'utf8') > maxPreviewBytes) throw new Error('Invalid package file update.')
    const check = async () => {
      const current = await readPackageFile(directory, relativePath)
      if (current.kind !== 'text' || current.revision !== update.revision || current.resolvedPath !== update.resolvedPath) {
        throw new Error('The file changed outside the editor. Reload it before saving.')
      }
      return current
    }
    const original = await check()
    const info = await stat(original.resolvedPath)
    const temporary = join(dirname(original.resolvedPath), `.${basename(original.path)}.${randomUUID()}.tmp`)
    try {
      const handle = await open(temporary, 'wx', info.mode & 0o777)
      try {
        await handle.writeFile(update.content, 'utf8')
        await handle.chmod(info.mode & 0o777)
        await handle.sync()
      } finally { await handle.close() }
      await check()
      await rename(temporary, original.resolvedPath)
    } finally { await rm(temporary, { force: true }) }
    return readPackageFile(directory, relativePath)
  })
  saveTail = operation.catch(() => undefined)
  return operation
}
