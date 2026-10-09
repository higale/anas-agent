import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { basename, dirname, extname, join } from 'node:path'
import fs from 'stubborn-fs'
import { parsePluginManifest, pluginHomePolicy, requirePluginHomeLocation, requirePluginId, requirePluginJson, requirePluginPath, type PluginManifest, type PluginSummary } from '@shared/plugins'
import { writeJsonFileAtomic } from '../atomicJson'
import { isSameOrInsideDirectory, samePath } from '../pathContainment'
import { extractZipArchive, type ZipArchiveLimits } from '../zipArchive'
import { loadPluginLanguages } from './pluginLanguages'

const MAX_FILE_BYTES = 128 * 1024 * 1024
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024
const MAX_PACKAGE_ENTRIES = 10_000
const pluginArchiveLimits: ZipArchiveLimits = {
  maxArchiveBytes: MAX_PACKAGE_BYTES,
  maxEntries: MAX_PACKAGE_ENTRIES,
  maxEntryBytes: MAX_FILE_BYTES,
  maxTotalBytes: MAX_PACKAGE_BYTES,
  maxCompressionRatio: 1_000,
  compressionRatioThresholdBytes: 1024 * 1024,
  maxPathBytes: 1_024
}

async function optionalJson(path: string, maxBytes = 1024 * 1024): Promise<unknown> {
  try {
    const info = await lstat(path)
    if (!info.isFile() || info.size > maxBytes) throw new Error('Invalid or oversized plugin JSON file.')
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

export class PluginStore {
  private tail: Promise<unknown> = Promise.resolve()
  constructor(readonly dataDirectory: string) {}

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  // Managed directories must retain their physical identity across reads and writes.
  async directory(group: 'plugins' | 'plugins_data' | 'tmp', id?: string, create = false): Promise<string> {
    if (id) requirePluginId(id)
    let target = await realpath(this.dataDirectory)
    for (const part of [group, ...(id ? [id] : [])]) {
      target = join(target, part)
      if (create) await mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error })
      const info = await lstat(target)
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(target), target)) throw new Error('Plugin directory is not a managed directory.')
    }
    return target
  }

  async packageDirectory(id: string): Promise<string> {
    const path = join(await this.directory('plugins', id), 'package')
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(path), path)) throw new Error('Invalid plugin package directory.')
    return path
  }

  async packageFile(id: string, name: string): Promise<string> {
    requirePluginPath(name)
    const root = await this.packageDirectory(id)
    const path = await realpath(join(root, name))
    if (!isSameOrInsideDirectory(root, path) || samePath(root, path)) throw new Error('Plugin resource leaves its package.')
    const info = await stat(path)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) throw new Error('Plugin resource is not a regular file or exceeds its size limit.')
    return path
  }

  async read(id: string, includeLanguages = true): Promise<PluginSummary> {
    requirePluginId(id)
    try {
      const root = await this.directory('plugins', id)
      const raw = await optionalJson(join(root, 'installation.json')) as { version?: unknown; enabled?: unknown } | undefined
      if (!raw || raw.version !== 0 || (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')) throw new Error('Invalid plugin installation state.')
      const manifest = parsePluginManifest(await optionalJson(await this.packageFile(id, 'PLUGIN.json'), 64 * 1024))
      if (manifest.id !== id) throw new Error('Plugin ID does not match its installation directory.')
      for (const entry of [manifest.ui, manifest.backend]) if (entry) await this.packageFile(id, entry)
      const error = manifest.platforms && !manifest.platforms.includes(process.platform) ? 'Plugin does not support this platform.' : undefined
      const language = includeLanguages ? await loadPluginLanguages(await this.packageDirectory(id), manifest) : undefined
      return { id, manifest, enabled: raw.enabled ?? true, error, backendStatus: 'stopped', languages: language?.languages, languageErrors: language?.errors }
    } catch (error) {
      return { id, enabled: false, error: error instanceof Error ? error.message : String(error), backendStatus: 'stopped' }
    }
  }

  async requireEnabled(id: string): Promise<PluginManifest> {
    const item = await this.read(id, false)
    if (item.error || !item.enabled || !item.manifest) throw new Error(item.error ?? 'Plugin is disabled.')
    return item.manifest
  }

  async languageResources(id: string) {
    const manifest = await this.requireEnabled(id)
    const { resources, errors } = await loadPluginLanguages(await this.packageDirectory(id), manifest)
    const snapshot = { resources, errors }
    requirePluginJson(snapshot)
    return snapshot
  }

  async home(id: string) {
    const manifest = await this.requireEnabled(id)
    if (!manifest.ui) throw new Error('Plugin has no UI entry.')
    const policy = pluginHomePolicy(manifest)
    const saved = await this.data(id, 'home_open_location')
    return { location: saved === null ? policy.defaultLocation : requirePluginHomeLocation(manifest, saved), locations: policy.locations }
  }

  async list(): Promise<PluginSummary[]> {
    let root: string
    try { root = await this.directory('plugins') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    const names = (await readdir(root)).filter(name => { try { requirePluginId(name); return true } catch { return false } })
    return Promise.all(names.sort().map(name => this.read(name)))
  }

  async install(sourcePath: string): Promise<PluginSummary> {
    const source = await realpath(sourcePath)
    if (!(await stat(source)).isFile()) throw new Error('Select a plugin ZIP file or PLUGIN.json.')
    if (basename(source) === 'PLUGIN.json') return this.installDirectory(dirname(source))
    if (extname(source).toLowerCase() !== '.zip') throw new Error('Select a plugin ZIP file or PLUGIN.json.')

    const tempRoot = await this.directory('tmp', undefined, true)
    const stage = await mkdtemp(join(tempRoot, 'plugin-extract-'))
    try {
      const contents = join(stage, 'contents')
      const extracted = await extractZipArchive(source, contents, pluginArchiveLimits, { validatePath: requirePluginPath })
      const manifests = [...extracted.entryNames].filter(name => name === 'PLUGIN.json' || /^[^/]+\/PLUGIN\.json$/.test(name))
      if (manifests.length > 1) throw new Error('Plugin ZIP contains multiple plugin roots; select a package with one PLUGIN.json.')
      if (manifests.length === 0) throw new Error('Plugin ZIP must contain PLUGIN.json at its root or inside a single top-level directory.')
      const manifest = manifests[0]
      if (manifest !== 'PLUGIN.json') {
        const entries = await readdir(contents, { withFileTypes: true })
        if (entries.length !== 1 || !entries[0].isDirectory() || entries[0].name !== manifest.split('/')[0]) {
          throw new Error('Plugin ZIP must contain PLUGIN.json at its root or inside a single top-level directory.')
        }
      }
      return await this.installDirectory(dirname(join(contents, manifest)))
    } finally {
      // stage is a freshly generated direct child of the verified temporary root.
      await rm(stage, { recursive: true, force: true })
    }
  }

  private async installDirectory(sourceDirectory: string): Promise<PluginSummary> {
    const source = await realpath(sourceDirectory)
    if (!(await stat(source)).isDirectory()) throw new Error('Select a plugin directory.')
    const manifest = parsePluginManifest(await optionalJson(join(source, 'PLUGIN.json'), 64 * 1024))
    const root = await this.directory('plugins', undefined, true)
    if (isSameOrInsideDirectory(source, this.dataDirectory) || isSameOrInsideDirectory(root, source)) throw new Error('Plugin source must be outside the managed installation directory.')
    const target = join(root, manifest.id)
    if (await lstat(target).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) throw new Error('Plugin is already installed. Uninstall it before installing another version; saved data is retained.')
    const tempRoot = await this.directory('tmp', undefined, true)
    const stage = await mkdtemp(join(tempRoot, 'plugin-install-'))
    try {
      let bytes = 0
      let entries = 0
      const copy = async (from: string, to: string, ancestors: Set<string>): Promise<void> => {
        if (++entries > MAX_PACKAGE_ENTRIES) throw new Error('Plugin package contains too many files.')
        const actual = await realpath(from)
        if (!isSameOrInsideDirectory(source, actual)) throw new Error('Plugin package link leaves its directory.')
        const info = await stat(actual)
        if (info.isDirectory()) {
          if (ancestors.has(actual)) throw new Error('Plugin package contains a circular directory link.')
          const next = new Set(ancestors).add(actual)
          await mkdir(to)
          for (const name of await readdir(actual)) {
            requirePluginPath(name)
            await copy(join(actual, name), join(to, name), next)
          }
        } else {
          if (!info.isFile() || info.size > MAX_FILE_BYTES || (bytes += info.size) > MAX_PACKAGE_BYTES) throw new Error('Plugin package exceeds its file size limit.')
          await copyFile(actual, to)
          if ((await stat(to)).size !== info.size) throw new Error('Plugin source changed while installing.')
          await chmod(to, info.mode & 0o777)
        }
      }
      await copy(source, join(stage, 'package'), new Set())
      const staged = parsePluginManifest(await optionalJson(join(stage, 'package', 'PLUGIN.json'), 64 * 1024))
      if (JSON.stringify(staged) !== JSON.stringify(manifest)) throw new Error('Plugin manifest changed while installing.')
      for (const entry of [manifest.ui, manifest.backend]) {
        if (entry && !(await stat(join(stage, 'package', entry))).isFile()) throw new Error('Missing plugin entry.')
      }
      await writeJsonFileAtomic(join(stage, 'installation.json'), { version: 0, enabled: true })
      await fs.retry.rename({ timeout: 2_000, interval: 25 })(stage, target)
      return this.read(manifest.id)
    } finally {
      // stage is a freshly generated direct child of the verified temporary root.
      await rm(stage, { recursive: true, force: true })
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid plugin enabled state.')
    const item = await this.read(id)
    if (enabled && item.error) throw new Error(item.error)
    const root = await this.directory('plugins', id)
    await writeJsonFileAtomic(join(root, 'installation.json'), { version: 0, enabled })
  }

  async uninstall(id: string, deleteData = false): Promise<void> {
    if (typeof deleteData !== 'boolean') throw new Error('Invalid plugin data deletion option.')
    const root = await this.directory('plugins', id)
    const data = deleteData ? await this.directory('plugins_data', id).catch(error => {
      if (error.code === 'ENOENT') return undefined
      throw error
    }) : undefined
    const temp = await this.directory('tmp', undefined, true)
    const stage = await mkdtemp(join(temp, 'plugin-remove-'))
    let moved = false
    let committed = false
    try {
      // Windows can briefly retain a package directory handle after a page or
      // utility process exits. Retry the same atomic move; never delete in place.
      await fs.retry.rename({ timeout: 2_000, interval: 25 })(root, join(stage, 'removed'))
      moved = true
      if (data) await fs.retry.rename({ timeout: 2_000, interval: 25 })(data, join(stage, 'data'))
      committed = true
    } catch (error) {
      if (moved) {
        try { await fs.retry.rename({ timeout: 2_000, interval: 25 })(join(stage, 'removed'), root); moved = false }
        catch (rollback) { throw new AggregateError([error, rollback], `Plugin removal failed; preserved files remain at ${stage}.`) }
      }
      throw error
    } finally {
      // Never discard staged files if restoring the installation failed.
      if (committed || !moved) await rm(stage, { recursive: true, force: true })
    }
  }

  async data(id: string, key: unknown, write = false, value?: unknown): Promise<unknown> {
    const manifest = await this.requireEnabled(id)
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid plugin data key.')
    const root = await this.directory('plugins_data', id, true)
    const path = join(root, 'state.json')
    const raw = await optionalJson(path) as { version?: unknown; values?: unknown } | undefined
    if (raw !== undefined && (!raw || raw.version !== 0 || !raw.values || typeof raw.values !== 'object' || Array.isArray(raw.values))) throw new Error('Invalid plugin data file; original content was preserved.')
    const values = (raw?.values ?? {}) as Record<string, unknown>
    if (!write) return Object.hasOwn(values, key) ? values[key] : null
    if (key === 'home_open_location' && value !== null) requirePluginHomeLocation(manifest, value)
    requirePluginJson(value)
    const next = { version: 0, values: { ...values, [key]: value } }
    requirePluginJson(next)
    if (Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`) > 1024 * 1024) throw new Error('Plugin data exceeds the 1 MiB limit.')
    await writeJsonFileAtomic(path, next)
    return null
  }
}
