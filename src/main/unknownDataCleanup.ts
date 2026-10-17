import { lstat, readdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import allowlist from './dataCleanupAllowlist.json'

function isMissingDataPath(reason: unknown): boolean {
  return (reason as NodeJS.ErrnoException | undefined)?.code === 'ENOENT'
}

function validRelativePath(path: unknown): path is string {
  return typeof path === 'string' && path.length > 0 && !isAbsolute(path)
    && !path.includes('\\') && !path.includes(':') && !path.includes('\0')
    && path.split('/').every(part => part !== '' && part !== '.' && part !== '..')
}

const rules = allowlist.rules.flatMap(rule => rule.paths.map(path => {
  if (allowlist.version !== 0 || !['file', 'directory', 'tree'].includes(rule.type) || !validRelativePath(path)) {
    throw new Error('Invalid data cleanup allowlist.')
  }
  const expression = path.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[^/]*')
  return { type: rule.type, pattern: new RegExp(`^${expression}${rule.type === 'directory' ? '$' : '(?:/|$)'}`, process.platform === 'win32' ? 'i' : '') }
}))

/** Retain recognized paths even if damaged or replaced by a link. Repair is separate. */
export function dataCleanupDisposition(path: string): 'keep' | 'inspect' | 'unknown' {
  for (const rule of rules) {
    if (rule.pattern.test(path)) return rule.type === 'directory' ? 'inspect' : 'keep'
  }
  return 'unknown'
}

async function unknownPaths(root: string, directory = root): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name), rel = relative(root, path).split(sep).join('/')
    const disposition = dataCleanupDisposition(rel)
    if (disposition === 'unknown') result.push(rel)
    else if (disposition === 'inspect' && entry.isDirectory() && !entry.isSymbolicLink()) {
      result.push(...await unknownPaths(root, path))
    }
  }
  return result
}

/** Only delete paths included in the displayed preview and still outside the allowlist. */
export async function cleanupUnknownData(root: string, preview: unknown): Promise<void> {
  if (!Array.isArray(preview)) throw new Error('Refresh the unknown-file preview before cleaning up.')
  const paths = preview.map(path => typeof path === 'string' && path.endsWith('/') ? path.slice(0, -1) : path)
  if (!paths.every(validRelativePath)) throw new Error('Refresh the unknown-file preview before cleaning up.')
  const canonicalRoot = await realpath(root)
  const current = new Set(await unknownPaths(canonicalRoot))
  const failures: Error[] = []
  for (const rel of new Set<string>(paths)) {
    if (!current.has(rel)) continue
    try {
      const path = resolve(canonicalRoot, ...rel.split('/'))
      if (!path.startsWith(canonicalRoot + sep)) throw new Error('Cleanup path is outside the data directory.')
      // Recheck each parent immediately before removal; never follow a linked container.
      let parent = canonicalRoot
      for (const part of rel.split('/').slice(0, -1)) {
        parent = join(parent, part)
        const info = await lstat(parent)
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Cleanup parent changed; refresh the preview.')
      }
      await rm(path, { recursive: true, force: true })
    } catch (reason) {
      if (!isMissingDataPath(reason)) failures.push(new Error(`${rel}: ${reason instanceof Error ? reason.message : String(reason)}`))
    }
  }
  if (failures.length) throw new AggregateError(failures, failures.map(error => error.message).join('\n'))
}
