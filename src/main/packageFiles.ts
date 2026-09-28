import { constants } from 'node:fs'
import { lstat, stat, readdir, readlink, realpath, open } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { PackageFileNode, PackageFilePreview } from '@shared/packageFiles'

const ignoredDirectories = new Set(['.git', '.svn', '__pycache__', 'node_modules', '.backup', '__history', '__recovery'])
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
  const nodes = await Promise.all(entries
    .filter((entry) => !ignoredDirectories.has(entry.name.toLowerCase()))
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
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxPreviewBytes) throw new Error(`Package file exceeds ${maxPreviewBytes} bytes.`)
    data = buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
  const binary = fileKind(resolvedPath) === 'binary' || data.includes(0)
  return {
    name: basename(lexicalPath),
    path: lexicalPath,
    relativePath: safeRelativePath(relativePath),
    resolvedPath,
    ...(linkInfo.isSymbolicLink() ? { linkTarget: await readlink(lexicalPath) } : {}),
    size: info.size,
    kind: binary ? 'binary' : 'text',
    ...(!binary ? { content: data.toString('utf8') } : {})
  }
}
