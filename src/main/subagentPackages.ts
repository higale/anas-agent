import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { subagentPresetIds, normalizeSubagentDirectoryName, normalizeSubagentPackageSettings, requireSubagentPackageId, type SubagentPackageSettings, type SubagentRootSummary, type SubagentDirectoryUpdate } from '@shared/subagentPackages'
import type { RawSubagentConfig } from './config/rawAppConfig'
import { normalizeSubagent, rawSubagentFromSave } from './config/subagentConfigMapper'
import { getBundledDataDir, getDataDir } from './config/dataDir'
import { writeJsonFileAtomic } from './atomicJson'
import { mirrorBundledDirectories } from './bundledDirectories'

const configPath = (root: string) => join(root, 'config', 'subagents.json')
const maxSourceEntries = 2048
let tail: Promise<unknown> = Promise.resolve()
let initializedRoot: string | undefined
export function serializeSubagentPackages<T>(operation: () => Promise<T>): Promise<T> {
  const next = tail.then(operation); tail = next.catch(() => undefined); return next
}
export async function packageExists(path: string): Promise<boolean> {
  try { await lstat(path); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

export async function readSubagentPackage(directory: string): Promise<RawSubagentConfig> {
  const text = async (file: string) => {
    const path = join(directory, file), info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error(`Invalid Agent package file: ${path}`)
    return readFile(path, 'utf8')
  }
  const raw = JSON.parse(await text('AGENT.json'))
  if (!raw || raw.version !== 0) throw new Error(`Unsupported Agent manifest: ${directory}`)
  const id = requireSubagentPackageId(raw.id)
  const result: RawSubagentConfig = { ...raw, id, directory, enabled: true, system_prompt: await text('PROMPT.md') }
  const normalized = rawSubagentFromSave({ ...normalizeSubagent(result, 0), enabled: false }, result)
  return { ...normalized, enabled: true }
}

export async function writeSubagentDefinition(directory: string, agent: RawSubagentConfig): Promise<void> {
  const { directory: _directory, enabled: _enabled, system_prompt, ...definition } = agent
  requireSubagentPackageId(definition.id)
  normalizeSubagent({ ...agent, enabled: agent.enabled ?? true }, 0)
  await mkdir(directory, { recursive: true })
  await writeJsonFileAtomic(join(directory, 'AGENT.json'), { ...definition, version: 0 })
  await writeFile(join(directory, 'PROMPT.md'), `${system_prompt?.trim() ?? ''}\n`)
}

export function initializeSubagentPackages(): Promise<void> { return serializeSubagentPackages(initializeExclusive) }
export function readSubagentPackages(root: string): Promise<RawSubagentConfig[]> { return serializeSubagentPackages(() => readPackagesExclusive(root)) }

export function listSubagentRoots(): Promise<SubagentRootSummary[]> {
  return serializeSubagentPackages(async () => { await initializeExclusive(); return (await readCatalogExclusive(getDataDir())).roots })
}

export async function readSubagentSettings(root = getDataDir()): Promise<SubagentPackageSettings> {
  return normalizeSubagentPackageSettings(JSON.parse(await readFile(configPath(root), 'utf8')))
}

/** The config file is the commit marker. A retained transaction rolls back before any catalog read. */
async function recover(root: string): Promise<void> {
  const stage = join(root, 'subagents', '.transaction')
  if (!await packageExists(stage)) return
  if (!(await lstat(stage)).isDirectory() || (await lstat(stage)).isSymbolicLink()) throw new Error('Invalid Agent transaction directory.')
  if (!await packageExists(join(stage, 'transaction.json'))) {
    if (await packageExists(join(stage, 'previous'))) throw new Error('Agent recovery record is missing; retained files need repair.')
    await rm(stage, { recursive: true }); return
  }
  const record = JSON.parse(await readFile(join(stage, 'transaction.json'), 'utf8')) as {
    version: number; directory: string; hadPackage: boolean; remove: boolean; before: string; after: string; externalRootId?: string; stageId?: string
  }
  if (record.version !== 0 || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(record.directory)
    || typeof record.hadPackage !== 'boolean' || typeof record.remove !== 'boolean'
    || typeof record.before !== 'string' || typeof record.after !== 'string') throw new Error('Invalid Agent transaction.')
  const current = await readFile(configPath(root), 'utf8')
  if (current !== record.before && current !== record.after) throw new Error('Agent settings changed during transaction recovery.')
  let parent = join(root, 'subagents'), payload = stage
  if (record.externalRootId !== undefined) {
    if (resolve(root) !== resolve(getDataDir())) throw new Error('Recover external Agent transactions in the original data directory before backup or restore.')
    requireSubagentPackageId(record.externalRootId)
    requireSubagentPackageId(record.stageId)
    const source = normalizeSubagentPackageSettings(JSON.parse(record.before)).external_directories.find(item => item.id === record.externalRootId)
    if (!source || !isAbsolute(source.path)) throw new Error('Invalid external Agent transaction source.')
    parent = source.path
    // Require the original volume/directory before touching retained transaction files.
    if (await realpath(parent) !== parent) throw new Error('External Agent transaction directory changed.')
    payload = join(parent, `.anas-subagent-${record.stageId}`)
  }
  const target = join(parent, record.directory), previous = join(payload, 'previous'), incoming = join(payload, 'incoming')
  if (current === record.after && !record.remove && !await packageExists(target)) throw new Error('Committed Agent package is missing; recovery files retained.')
  if (current !== record.after) {
    // The old directory is never deleted before the settings commit.
    if (await packageExists(previous)) {
      if (await packageExists(target)) {
        if (await packageExists(incoming)) throw new Error('Conflicting Agent recovery directories.')
        await rename(target, incoming)
      }
      await rename(previous, target)
    } else if (!record.hadPackage && !await packageExists(incoming) && await packageExists(target)) {
      await rename(target, incoming)
    }
  }
  if (payload !== stage) await rm(payload, { recursive: true, force: true })
  await rm(stage, { recursive: true })
}

async function initializeExclusive(): Promise<void> {
  const root = getDataDir()
  await mkdir(join(root, 'config'), { recursive: true })
  await mkdir(join(root, 'subagents'), { recursive: true })
  if (!await packageExists(configPath(root))) {
    await cp(configPath(getBundledDataDir()), configPath(root), { errorOnExist: true, force: false })
  }
  await recover(root)
  if (initializedRoot !== root) {
    await mirrorBundledDirectories(join(getBundledDataDir(), 'subagents/_system'), join(root, 'subagents/_system'), 'AGENT.json', async (directory, name) => {
      validateSystemAgent(await readSubagentPackage(directory), name)
    })
    initializedRoot = root
  }
}

function validateSystemAgent(agent: RawSubagentConfig, name: string): void {
  if (!subagentPresetIds.some(id => id === name) || agent.id !== name || agent.name !== name || agent.preset !== name) {
    throw new Error(`Invalid built-in Agent identity: ${name}`)
  }
}

async function readPackagesExclusive(root: string): Promise<RawSubagentConfig[]> {
  return (await readCatalogExclusive(root)).agents
}

async function readCatalogExclusive(root: string): Promise<{ agents: RawSubagentConfig[]; roots: SubagentRootSummary[] }> {
  await recover(root)
  const settings = await readSubagentSettings(root), directory = join(root, 'subagents')
  const result: RawSubagentConfig[] = []
  const ids = new Set<string>(), names = new Set<string>()
  const roots: SubagentRootSummary[] = [
    { id: 'system', name: 'System', path: join(directory, '_system'), kind: 'system', available: true, agentIds: [], errors: [] },
    { id: 'user', name: 'User', path: directory, kind: 'user', available: true, agentIds: [], errors: [] },
    ...settings.external_directories.map(item => ({ ...item, kind: 'external' as const, available: true, agentIds: [], errors: [] }))
  ]
  const paths: string[] = []
  for (const source of roots) {
    try {
      if (!isAbsolute(source.path)) throw new Error('Agent directory path must be absolute.')
      const info = await lstat(source.path)
      if (!info.isDirectory() || info.isSymbolicLink()) { source.issue = 'not_directory'; throw new Error('Agent root must be a regular directory.') }
      const canonical = await realpath(source.path)
      if (source.kind === 'external' && paths.some(path => pathsOverlap(path, canonical))) throw new Error('Agent directory overlaps another source.')
      paths.push(canonical)
      const entries = await readdir(source.path, { withFileTypes: true })
      if (entries.length > maxSourceEntries) throw new Error('Too many Agent packages.')
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (entry.name.startsWith('.') || source.kind === 'user' && entry.name === '_system') continue
        // External roots may also contain documentation or other unrelated files.
        if (source.kind === 'external' && (!entry.isDirectory() || !await packageExists(join(source.path, entry.name, 'AGENT.json')))) continue
        try {
          requireSubagentPackageId(entry.name)
          if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`Invalid Agent directory: ${entry.name}`)
          const agent = await readSubagentPackage(join(canonical, entry.name)), id = agent.id!
          if (source.kind === 'system') validateSystemAgent(agent, entry.name)
          else if (agent.preset) throw new Error('Built-in Agents must be stored in subagents/_system.')
          if (ids.has(id) || names.has(agent.name!)) throw new Error(`Duplicate Agent ID or name: ${id} / ${agent.name}`)
          const configured = { ...agent, enabled: !settings.disabled.includes(id) }
          normalizeSubagent(configured, result.length)
          ids.add(id); names.add(agent.name!); source.agentIds.push(id)
          result.push(configured)
        } catch (error) {
          if (source.kind !== 'external') throw error
          source.errors.push({ path: join(source.path, entry.name), message: String(error) })
        }
      }
    } catch (error) {
      if (source.kind !== 'external') throw error
      source.available = false
      source.issue ??= (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'not_found' : 'unreadable'
      source.errors.push({ path: source.path, message: String(error) })
    }
  }
  const rank = (id: string) => { const i = settings.order.indexOf(id); return i < 0 ? settings.order.length : i }
  return { agents: result.sort((a, b) => rank(a.id!) - rank(b.id!)), roots }
}

function pathsOverlap(a: string, b: string): boolean {
  const contains = (parent: string, child: string) => { const path = relative(parent, child); return !path || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path) }
  return contains(a, b) || contains(b, a)
}

export function addExternalSubagentDirectory(path: string): Promise<void> {
  return serializeSubagentPackages(async () => {
    await initializeExclusive()
    const canonical = await realpath(path)
    if (!(await lstat(canonical)).isDirectory()) throw new Error('Selected Agent root is not a directory.')
    if (await packageExists(join(canonical, 'AGENT.json'))) throw new Error('Select the parent directory containing Agent packages, or import this package.')
    const settings = await readSubagentSettings()
    const paths = [join(getDataDir(), 'subagents'), ...settings.external_directories.map(item => item.path)]
    for (const existing of paths) {
      if (pathsOverlap(await realpath(existing).catch(() => resolve(existing)), canonical)) throw new Error('Agent directory is already managed or overlaps another source.')
    }
    settings.external_directories.push({ id: randomUUID(), name: normalizeSubagentDirectoryName(basename(canonical)), path: canonical })
    await writeJsonFileAtomic(configPath(getDataDir()), settings)
  })
}

export function updateExternalSubagentDirectory(id: string, update: SubagentDirectoryUpdate): Promise<void> {
  return serializeSubagentPackages(async () => {
    await initializeExclusive()
    const settings = await readSubagentSettings(), items = settings.external_directories
    const index = items.findIndex(item => item.id === id)
    if (index < 0) throw new Error('External Agent directory was not found.')
    if ('name' in update) items[index].name = normalizeSubagentDirectoryName(update.name)
    else if ('remove' in update && update.remove === true) items.splice(index, 1)
    else if ('direction' in update && (update.direction === -1 || update.direction === 1)) {
      const next = index + update.direction
      if (next >= 0 && next < items.length) items.splice(next, 0, ...items.splice(index, 1))
    } else throw new Error('Invalid Agent directory update.')
    await writeJsonFileAtomic(configPath(getDataDir()), settings)
  })
}

/** Used by the existing config mutation queue; at most one package changes per operation. */
export async function writeSubagentPackages(agents: RawSubagentConfig[], expected?: readonly RawSubagentConfig[]): Promise<void> {
  return serializeSubagentPackages(async () => {
    await initializeExclusive()
    const root = getDataDir(), existing = await readPackagesExclusive(root), settings = await readSubagentSettings(root)
    if (expected && JSON.stringify(existing) !== JSON.stringify(expected)) throw new Error('Agent packages changed; refresh before saving.')
    const next = agents.map(agent => ({ ...agent, id: agent.id ?? randomUUID() }))
    if (new Set(next.map(a => a.id)).size !== next.length || new Set(next.map(a => a.name)).size !== next.length) throw new Error('Duplicate Agent package.')
    const shape = (agent: RawSubagentConfig) => {
      const { directory: _path, enabled: _enabled, ...value } = agent
      return JSON.stringify(value)
    }
    const removed = existing.filter(a => !next.some(b => b.id === a.id))
    const changed = next.filter(a => { const old = existing.find(b => b.id === a.id); return !old || shape(old) !== shape(a) })
    if (removed.length + changed.length > 1) throw new Error('Change one Agent package at a time.')
    if (removed.some(a => a.preset)) throw new Error('Built-in subagents cannot be deleted.')
    for (const agent of next) {
      const old = existing.find(a => a.id === agent.id)
      if (old?.preset) {
        if (shape(old) !== shape(agent)) throw new Error('Built-in Agent definitions are read-only.')
        normalizeSubagent(agent, 0)
      } else if (agent.preset) throw new Error('User packages cannot declare a built-in Agent preset.')
    }
    // Offline external packages retain their order and enabled state through unrelated edits.
    const unseen = (id: string) => !existing.some(a => a.id === id)
    const updated = { ...settings, order: [...next.map(a => a.id!), ...settings.order.filter(unseen)],
      disabled: [...next.filter(a => !a.enabled).map(a => a.id!), ...settings.disabled.filter(unseen)] }
    normalizeSubagentPackageSettings(updated)
    const agent = removed[0] ?? changed[0]
    if (!agent || agent.preset) { await writeJsonFileAtomic(configPath(root), updated); return }
    const old = existing.find(a => a.id === agent.id)
    const folder = old ? basename(old.directory!) : requireSubagentPackageId(agent.name)
    const target = old?.directory ?? join(root, 'subagents', folder)
    const external = settings.external_directories.find(item => item.path === dirname(target))
    if (old && dirname(target) !== join(root, 'subagents') && !external) throw new Error('Agent source changed; refresh before saving.')
    if (!old && await packageExists(target)) throw new Error('Agent directory already exists.')
    const stage = join(root, 'subagents', '.transaction')
    const { assertToolDirectoryTreeIdle } = await import('./toolsStore')
    assertToolDirectoryTreeIdle(target)
    await mkdir(stage)
    const stageId = external ? randomUUID() : undefined
    const payload = external ? join(external.path, `.anas-subagent-${stageId}`) : stage
    const before = await readFile(configPath(root), 'utf8')
    // A unique commit ID distinguishes a definition-only edit from an uncommitted transaction.
    const document = { ...updated, revision: randomUUID() }
    const after = `${JSON.stringify(document, null, 2)}\n`
    try {
      // Write recovery metadata before creating a staging directory on the external volume.
      await writeJsonFileAtomic(join(stage, 'transaction.json'), { version: 0, directory: folder, hadPackage: !!old, remove: !!removed.length, before, after,
        ...(external ? { externalRootId: external.id, stageId } : {}) })
      if (external) await mkdir(payload)
      if (!removed.length) {
        if (old) await cp(target, join(payload, 'incoming'), { recursive: true, dereference: false, verbatimSymlinks: true })
        await writeSubagentDefinition(join(payload, 'incoming'), agent)
      }
      if (await readFile(configPath(root), 'utf8') !== before) throw new Error('Agent settings changed during save.')
      if (old && shape(await readSubagentPackage(target)) !== shape(old)) throw new Error('Agent files changed during save; refresh before saving.')
      assertToolDirectoryTreeIdle(target)
      if (old) await rename(target, join(payload, 'previous'))
      if (!removed.length) await rename(join(payload, 'incoming'), target)
      await writeJsonFileAtomic(configPath(root), document)
      await recover(root)
    } catch (error) {
      if (await packageExists(join(stage, 'transaction.json'))) await recover(root)
      else await rm(stage, { recursive: true })
      throw error
    }
  })
}

export async function findSubagentPackage(id: string): Promise<RawSubagentConfig> {
  requireSubagentPackageId(id)
  const agent = (await readSubagentPackages(getDataDir())).find(a => a.id === id)
  if (!agent) throw new Error(`Agent package is unavailable: ${id}`)
  if (resolve(await realpath(agent.directory!)) !== resolve(agent.directory!)) throw new Error('Agent package directory is linked.')
  return agent
}

export async function importSubagentPackages(sourcePaths: readonly string[]): Promise<void> {
  return serializeSubagentPackages(async () => {
    if (!Array.isArray(sourcePaths) || !sourcePaths.length || sourcePaths.some(path => typeof path !== 'string' || !path.trim())) throw new Error('Select at least one Agent package directory.')
    await initializeExclusive()
    const destination = resolve(getDataDir(), 'subagents')
    if ((await readdir(destination)).length + sourcePaths.length > maxSourceEntries) throw new Error(`Import would exceed the limit of ${maxSourceEntries} Agent directory entries.`)
    const current = await readPackagesExclusive(getDataDir())
    const ids = new Set(current.map(agent => agent.id)), names = new Set(current.map(agent => agent.name))
    const sources: { path: string; id: string; name: string; target: string }[] = []
    for (const path of sourcePaths) {
      try {
        const canonical = await realpath(path)
        const overlap = relative(canonical, destination)
        if (!overlap || overlap !== '..' && !overlap.startsWith(`..${sep}`) && !isAbsolute(overlap)) throw new Error('Import an Agent package, not its destination or an ancestor.')
        const agent = await readSubagentPackage(canonical)
        if (agent.preset) throw new Error('Imported Agent packages cannot replace a built-in Agent.')
        const name = requireSubagentPackageId(agent.name)
        if (ids.has(agent.id) || names.has(name)) throw new Error(`Agent ID or name already exists: ${name}`)
        const target = join(destination, name)
        if (await packageExists(target)) throw new Error(`Agent directory already exists: ${target}`)
        ids.add(agent.id); names.add(name)
        sources.push({ path: canonical, id: agent.id!, name, target })
      } catch (error) { throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
    }
    const stage = join(destination, `.import-${randomUUID()}`)
    const installed: string[] = []
    await mkdir(stage)
    try {
      // Prepare every package before publishing any of them, matching Skills and tools imports.
      for (const source of sources) {
        let bytes = 0, count = 0
        const incoming = join(stage, source.name)
        try {
          await cp(source.path, incoming, { recursive: true, dereference: false, errorOnExist: true, force: false, filter: async path => {
            if (relative(source.path, path).split(sep).length > 24) throw new Error('Agent package is too deep.')
            const info = await lstat(path)
            if (info.isSymbolicLink() || !info.isDirectory() && !info.isFile()) throw new Error('Imported Agent packages must contain regular files and directories.')
            bytes += info.size
            if (++count > 10000 || bytes > 128 * 1024 * 1024) throw new Error('Agent package exceeds import limits.')
            return true
          } })
          const staged = await readSubagentPackage(incoming)
          if (staged.id !== source.id || staged.name !== source.name) throw new Error('Agent identity changed during import.')
        } catch (error) { throw new Error(`${source.path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error }) }
      }
      for (const source of sources) {
        if (await packageExists(source.target)) throw new Error(`Agent directory already exists: ${source.target}`)
        await rename(join(stage, source.name), source.target)
        installed.push(source.target)
      }
    } catch (error) {
      await Promise.all(installed.map(path => rm(path, { recursive: true, force: true })))
      throw error
    } finally { await rm(stage, { recursive: true, force: true }) }
  })
}

export function withSubagentPackage<T>(id: string, operation: (agent: RawSubagentConfig) => Promise<T>): Promise<T> {
  return serializeSubagentPackages(async () => {
    requireSubagentPackageId(id)
    const agent = (await readPackagesExclusive(getDataDir())).find(a => a.id === id)
    if (!agent) throw new Error(`Agent package is unavailable: ${id}`)
    return operation(agent)
  })
}
