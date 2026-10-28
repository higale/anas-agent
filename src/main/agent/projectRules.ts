import { ProjectRulesError, ProjectRulesReadRequired, ProjectRulesRequestBudgetError, isProjectRulesError, errorCauses } from '../../runtime/errors'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, opendir, realpath } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import type { ProjectRulesSnapshot } from '../../runtime/projectRules'
import { isSameOrInsideDirectory } from '../pathContainment'
import { canonicalizeAbsolutePath } from '../workspacePath'

export const projectRuleLimits = { fileBytes: 64 * 1024, totalBytes: 512 * 1024, directories: 256, depth: 256, entries: 10_000 }

export function projectRulesRequestBudget(error: unknown): number | undefined {
  return errorCauses(error).find((cause): cause is ProjectRulesRequestBudgetError => cause instanceof ProjectRulesRequestBudgetError)?.inputCapacityTokens
}

function missing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
}

async function entry(path: string) {
  try { return await lstat(path) } catch (error) { if (missing(error)) return undefined; throw error }
}

async function repositoryBoundary(folder: string, signal?: AbortSignal): Promise<string | undefined> {
  let current = folder
  for (let depth = 0; depth < projectRuleLimits.depth; depth++) {
    signal?.throwIfAborted()
    if (await entry(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
  throw new ProjectRulesError(`Repository ancestry exceeds ${projectRuleLimits.depth} directories: ${folder}.`)
}

export interface ProjectRulesReader {
  signal?: AbortSignal
  authorizeRead(path: string): void | Promise<void>
}

export async function createProjectRulesSnapshot(runId: string, folders: string[], signal?: AbortSignal): Promise<ProjectRulesSnapshot> {
  const roots: ProjectRulesSnapshot['roots'] = []
  try {
    for (const input of folders) {
      signal?.throwIfAborted()
      const folder = (await canonicalizeAbsolutePath(input, 'follow')).canonicalPath
      if (!roots.some((root) => root.folder === folder)) roots.push({ folder, boundary: await repositoryBoundary(folder, signal) ?? folder })
      if (roots.length > projectRuleLimits.directories) throw new ProjectRulesError('Too many source folders.')
    }
  } catch (error) {
    if (signal?.aborted || isProjectRulesError(error)) throw error
    throw new ProjectRulesError(`Could not resolve project source folders: ${String(error)}.`)
  }
  return { runId, roots, trustedFolders: roots.map((root) => root.folder), documents: [], directories: [], initialScopes: [], activeScopes: [], blockedCalls: [], rejectedCalls: [], checkedWrites: [], blockedReason: '', fatalError: '' }
}

async function adoptDirectory(snapshot: ProjectRulesSnapshot, directory: string, reader: ProjectRulesReader): Promise<void> {
  reader.signal?.throwIfAborted()
  if (snapshot.directories.some((record) => record.path === directory)) return
  if (snapshot.directories.length >= projectRuleLimits.directories) throw new ProjectRulesError(`Rule discovery exceeds ${projectRuleLimits.directories} directories at ${directory}.`)
  let documentId: string | null = null
  for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
    const candidate = join(directory, name)
    if (!await entry(candidate)) continue
    const path = await realpath(candidate)
    const existing = snapshot.documents.find((document) => document.path === path)
    if (existing) { documentId = existing.id; break }
    await reader.authorizeRead(path)
    reader.signal?.throwIfAborted()
    // Nonblocking open prevents special files from hanging discovery. Read one
    // extra byte to detect a file growing past the limit after fstat.
    const handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW)
    try {
      if (await realpath(path) !== path) throw new ProjectRulesError(`Rule file target changed while opening: ${path}.`)
      const stat = await handle.stat()
      if (!stat.isFile()) throw new ProjectRulesError(`Not a regular rule file: ${path}.`)
      if (stat.size > projectRuleLimits.fileBytes) throw new ProjectRulesError(`${path} exceeds the ${projectRuleLimits.fileBytes}-byte rule file limit.`)
      const buffer = Buffer.alloc(projectRuleLimits.fileBytes + 1)
      let size = 0
      while (size < buffer.length) {
        reader.signal?.throwIfAborted()
        const read = await handle.read(buffer, size, buffer.length - size, null)
        if (read.bytesRead === 0) break
        size += read.bytesRead
      }
      if (size > projectRuleLimits.fileBytes) throw new ProjectRulesError(`${path} exceeds the rule file limit.`)
      const total = snapshot.documents.reduce((sum, document) => sum + Buffer.byteLength(document.content), 0) + size
      if (total > projectRuleLimits.totalBytes) throw new ProjectRulesError(`Rule snapshots exceed the ${projectRuleLimits.totalBytes}-byte run limit at ${path}.`)
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size))
      documentId = createHash('sha256').update(path).update('\0').update(content).digest('hex')
      snapshot.documents.push({ id: documentId, path, content })
    } finally { await handle.close() }
    break
  }
  // Absence is a snapshot too: files created later do not rewrite this run.
  snapshot.directories.push({ path: directory, documentId })
}

export async function discoverProjectRules(snapshot: ProjectRulesSnapshot, directory: string, reader: ProjectRulesReader): Promise<string[]> {
  try {
    let boundary = snapshot.roots.filter((root) => isSameOrInsideDirectory(root.boundary, directory))
      .sort((a, b) => b.boundary.length - a.boundary.length)[0]?.boundary
    if (!boundary) {
      boundary = await repositoryBoundary(directory, reader.signal) ?? directory
      snapshot.roots.push({ folder: directory, boundary })
    }
    const chain: string[] = []
    let current = directory
    while (true) {
      chain.unshift(current)
      if (current === boundary) break
      if (chain.length >= projectRuleLimits.depth || dirname(current) === current) throw new ProjectRulesError(`Invalid or excessive rule scope: ${directory}.`)
      current = dirname(current)
    }
    for (const path of chain) await adoptDirectory(snapshot, path, reader)
    return chain
  } catch (error) {
    // Preserve native approval pauses, the remaining graph boundary and cancellation.
    if (error instanceof Error && (error instanceof ProjectRulesReadRequired || error.name.includes('Interrupt') || reader.signal?.aborted || isProjectRulesError(error))) throw error
    throw new ProjectRulesError(`Could not read rules for ${directory}: ${error instanceof Error ? error.message : String(error)}.`)
  }
}

/** Directory deletion/move includes descendants; never follow symlink entries. */
export async function mutationDirectories(path: string, destination?: string, reader?: ProjectRulesReader): Promise<string[]> {
  const directories = new Set<string>([dirname(path), ...(destination ? [dirname(destination)] : [])])
  const pending = [path]
  let entries = 0
  while (pending.length) {
    reader?.signal?.throwIfAborted()
    const current = pending.pop()!
    const stat = await entry(current)
    if (!stat?.isDirectory()) continue
    directories.add(current)
    if (destination) directories.add(join(destination, relative(path, current)))
    if (directories.size > projectRuleLimits.directories) throw new ProjectRulesError(`Directory operation exceeds the ${projectRuleLimits.directories}-scope discovery limit: ${path}.`)
    await reader?.authorizeRead(current)
    for await (const child of await opendir(current)) {
      reader?.signal?.throwIfAborted()
      if (++entries > projectRuleLimits.entries) throw new ProjectRulesError(`Directory operation exceeds ${projectRuleLimits.entries} inspected entries: ${path}.`)
      if (child.isDirectory()) pending.push(join(current, child.name))
      if (pending.length + directories.size > projectRuleLimits.directories) throw new ProjectRulesError(`Too many descendant rule scopes in ${path}.`)
    }
  }
  return [...directories]
}

export async function projectRuleTargetDirectory(path: string): Promise<string> {
  return (await entry(path))?.isDirectory() ? path : dirname(path)
}
