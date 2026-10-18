import { chmod, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { pluginToolId, pluginToolName, type ResolvedPluginTool } from '@shared/pluginTools'
import { basename, dirname, extname, join } from 'node:path'
import fs from 'stubborn-fs'
import { parsePluginManifest, pluginHomePolicy, requirePluginHomeLocation, requirePluginIconPath, requirePluginId, requirePluginJson, requirePluginPath, type PluginManifest, type PluginSummary, type PluginInstallPreview } from '@shared/plugins'
import { writeJsonFileAtomic } from '../atomicJson'
import { canonicalizeAbsolutePath } from '../workspacePath'
import { isSameOrInsideDirectory, samePath } from '../pathContainment'
import { extractZipArchive, type ZipArchiveLimits } from '../zipArchive'
import { loadPluginLanguages } from './pluginLanguages'
import { inspectSkillText } from '../skillDefinition'
import type { PluginContributionKind, PluginContributionPreview, PluginSkillSummary } from '@shared/plugins'
import { pluginSettingValues, type PluginSettingsSnapshot } from '@shared/pluginSettings'
import { newPluginTransaction, PluginTransactionError, PluginTransactions, writePluginTransaction } from './pluginTransactions'

const MAX_FILE_BYTES = 128 * 1024 * 1024
const MAX_PACKAGE_BYTES = 512 * 1024 * 1024
const MAX_PACKAGE_ENTRIES = 10_000
const MAX_PLUGIN_PROMPT_BYTES = 16 * 1024
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

export async function validateBundledPlugin(directory: string, expectedId?: string): Promise<void> {
  const info = await lstat(directory)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Bundled plugin must be a regular directory.')
  const manifest = parsePluginManifest(await optionalJson(join(directory, 'PLUGIN.json'), 64 * 1024))
  if (expectedId !== undefined && manifest.id !== expectedId) throw new Error('Bundled plugin ID does not match its directory.')
}

export async function validateBundledPluginZip(path: string, temporaryRoot: string): Promise<void> {
  await mkdir(temporaryRoot, { recursive: true })
  const stage = await mkdtemp(join(temporaryRoot, 'plugin-example-'))
  try {
    await extractZipArchive(path, stage, pluginArchiveLimits, { validatePath: requirePluginPath })
    await validateBundledPlugin(stage)
  } finally {
    await rm(stage, { recursive: true, force: true })
  }
}

export class PluginStore {
  private resourceUses = new Map<string, number>()
  private tail: Promise<unknown> = Promise.resolve()
  private pending?: { stage: string; preview: PluginInstallPreview; identity?: string }
  private transactionErrors = new Map<string, Error>()
  constructor(readonly dataDirectory: string, private bundled: Readonly<Record<string, string>> = {}) {}

  isBuiltin(id: string): boolean { return Object.hasOwn(this.bundled, id) }

  exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation, operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }

  /** Pin actual path operations, not a model run or a serialized installation snapshot.
   * null is a process whose dynamically loaded paths cannot be enumerated. */
  async withPackageResources<T>(paths: readonly string[] | null, operation: () => Promise<T>): Promise<T> {
    const held = await this.exclusive(async () => {
      const root = join(await realpath(this.dataDirectory), 'plugins')
      const resolved = paths === null ? [root] : await Promise.all(paths.map(async path =>
        (await canonicalizeAbsolutePath(path, 'follow')).canonicalPath))
      const held = [...new Set(resolved.filter(path => isSameOrInsideDirectory(root, path) || isSameOrInsideDirectory(path, root)))]
      for (const path of held) this.resourceUses.set(path, (this.resourceUses.get(path) ?? 0) + 1)
      return held
    })
    try { return await operation() }
    finally {
      for (const path of held) {
        const count = this.resourceUses.get(path)! - 1
        if (count) this.resourceUses.set(path, count)
        else this.resourceUses.delete(path)
      }
    }
  }

  async assertPackageIdle(id: string): Promise<void> {
    const root = await this.directory('plugins', id)
    if ([...this.resourceUses].some(([path, count]) => count > 0
      && (isSameOrInsideDirectory(root, path) || isSameOrInsideDirectory(path, root)))) {
      throw new Error('Plugin package is in use by a file or process tool. Wait for the running call to finish before replacing or uninstalling it.')
    }
  }

  // Managed directories must retain their physical identity across reads and writes.
  async directory(group: 'plugins' | 'db/plugins' | 'tmp', id?: string, create = false): Promise<string> {
    if (id) requirePluginId(id)
    let target = await realpath(this.dataDirectory)
    for (const part of [...group.split('/'), ...(id ? [group === 'tmp' ? `anas-plugin-${id}` : id] : [])]) {
      target = join(target, part)
      if (create) await mkdir(target).catch(error => { if (error.code !== 'EEXIST') throw error })
      const info = await lstat(target)
      if (!info.isDirectory() || info.isSymbolicLink() || !samePath(await realpath(target), target)) throw new Error('Plugin directory is not a managed directory.')
    }
    return target
  }

  async packageDirectory(id: string): Promise<string> {
    requirePluginId(id)
    if (this.transactionErrors.has(id)) throw this.transactionErrors.get(id)
    if (this.isBuiltin(id)) return realpath(this.bundled[id])
    return this.directory('plugins', id)
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
      if (this.transactionErrors.has(id)) throw this.transactionErrors.get(id)
      const builtin = this.isBuiltin(id)
      if (builtin) {
        const collision = await lstat(join(this.dataDirectory, 'plugins', id)).catch(error => {
          if (error.code === 'ENOENT') return undefined
          throw error
        })
        if (collision) throw new Error(`A user-installed plugin already uses the built-in ID "${id}". Its files are preserved in plugins/${id}; move that installation out before using the built-in plugin.`)
      }
      const { state } = await this.installationState(id)
      const manifest = await this.readManifest(id)
      for (const entry of [manifest.ui, manifest.backend]) if (entry) await this.packageFile(id, entry)
      const skillSummaries = await this.validateContributions(manifest, entry => this.packageFile(id, entry))
      const error = manifest.platforms && !manifest.platforms.includes(process.platform) ? 'Plugin does not support this platform.' : undefined
      const language = includeLanguages ? await loadPluginLanguages(await this.packageDirectory(id), manifest) : undefined
      return { id, ...(builtin ? { builtin: true } : {}), manifest, skillSummaries, enabled: state.enabled, showInTitlebar: state.show_in_titlebar ?? false, error, backendStatus: 'stopped', languages: language?.languages, languageErrors: language?.errors }
    } catch (error) {
      return { id, ...(this.isBuiltin(id) ? { builtin: true } : {}), enabled: false, error: error instanceof Error ? error.message : String(error), backendStatus: 'stopped' }
    }
  }

  private async installationPath(id: string, create = false): Promise<string> {
    requirePluginId(id)
    const root = await this.directory('db/plugins', id, create).catch(async error => {
      if (create || error.code !== 'ENOENT') throw error
      return join(await realpath(this.dataDirectory), 'db/plugins', id)
    })
    return join(root, 'anas-installation.json')
  }

  private async installationState(id: string, create = false) {
    const path = await this.installationPath(id, create)
    const saved = await optionalJson(path)
    const raw = (saved === undefined ? { version: 0 } : saved) as { version?: unknown; enabled?: unknown; show_in_titlebar?: unknown } | undefined
    if (!raw || raw.version !== 0 || (raw.enabled !== undefined && typeof raw.enabled !== 'boolean')
      || (raw.show_in_titlebar !== undefined && typeof raw.show_in_titlebar !== 'boolean')) throw new Error('Invalid plugin installation state.')
    return { path, exists: saved !== undefined, state: { version: 0, enabled: raw.enabled ?? true,
      ...(raw.show_in_titlebar === undefined ? {} : { show_in_titlebar: raw.show_in_titlebar }) } }
  }

  private async readManifest(id: string): Promise<PluginManifest> {
    const manifest = parsePluginManifest(await optionalJson(await this.packageFile(id, 'PLUGIN.json'), 64 * 1024))
    if (manifest.id !== id) throw new Error('Plugin ID does not match its installation directory.')
    return manifest
  }

  private async validateContributions(manifest: PluginManifest, file: (path: string) => Promise<string>): Promise<PluginSkillSummary[]> {
    const names = new Set<string>()
    const summaries: PluginSkillSummary[] = []
    for (const skill of manifest.skills ?? []) {
      const path = await file(skill.path)
      if ((await stat(path)).size > 1024 * 1024) throw new Error('Plugin skill exceeds 1 MiB.')
      const parsed = inspectSkillText(await readFile(path, 'utf8'), basename(dirname(path)))
      if ('code' in parsed) throw new Error(`Invalid plugin skill ${skill.id}: ${parsed.code}`)
      if (names.has(parsed.name)) throw new Error(`Duplicate plugin skill name: ${parsed.name}`)
      names.add(parsed.name)
      summaries.push({ id: skill.id, name: parsed.name, description: parsed.description })
    }
    for (const prompt of manifest.prompts ?? []) {
      const path = await file(prompt.path)
      if ((await stat(path)).size > MAX_PLUGIN_PROMPT_BYTES || !(await readFile(path, 'utf8')).trim()) throw new Error('Plugin prompt is empty or exceeds 16 KiB.')
    }
    return summaries
  }

  /** Inspect declared package content without enabling or starting the plugin. */
  async readContribution(id: string, kind: PluginContributionKind, contributionId: string): Promise<PluginContributionPreview> {
    if (kind !== 'skill' && kind !== 'prompt') throw new Error('Invalid plugin contribution kind.')
    const manifest = await this.readManifest(id)
    const items = kind === 'skill' ? manifest.skills : manifest.prompts
    const item = items?.find(item => item.id === contributionId)
    if (!item) throw new Error('Plugin contribution is not declared.')
    const resolvedPath = await this.packageFile(id, item.path)
    const limit = kind === 'skill' ? 1024 * 1024 : MAX_PLUGIN_PROMPT_BYTES
    if ((await stat(resolvedPath)).size > limit) throw new Error('Plugin contribution exceeds its size limit.')
    const content = await readFile(resolvedPath, 'utf8')
    if (Buffer.byteLength(content) > limit) throw new Error('Plugin contribution exceeds its size limit.')
    return { content, resolvedPath }
  }

  async promptText(id: string, path: string): Promise<string> {
    const manifest = await this.requireEnabled(id)
    if (!manifest.prompts?.some(prompt => prompt.path === path)) throw new Error('Plugin prompt is not declared.')
    const contents = await readFile(await this.packageFile(id, path), 'utf8')
    if (Buffer.byteLength(contents) > MAX_PLUGIN_PROMPT_BYTES || !contents.trim()) throw new Error('Plugin prompt is empty or exceeds 16 KiB.')
    return contents
  }

  /** Cosmetic package assets remain available in settings while a plugin is disabled. */
  async iconResource(id: string, name: string): Promise<{ bytes: Buffer; mime: string }> {
    requirePluginIconPath(name)
    const path = await this.packageFile(id, name)
    const maxBytes = 256 * 1024
    if ((await stat(path)).size > maxBytes) throw new Error('Plugin icon exceeds 256 KiB.')
    const bytes = await readFile(path)
    if (bytes.length > maxBytes) throw new Error('Plugin icon exceeds 256 KiB.')
    const mime = { '.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' }[extname(name).toLowerCase()]!
    return { bytes, mime }
  }

  async resolveTools(selection: readonly string[]): Promise<ResolvedPluginTool[]> {
    const tools: ResolvedPluginTool[] = []
    for (const id of selection) {
      const [pluginId, , localId] = id.split(':')
      const manifest = await this.requireEnabled(pluginId)
      const definition = manifest.tools.find(tool => tool.id === localId)
      if (!definition) throw new Error(`Plugin tool is unavailable: ${id}`)
      const name = pluginToolName(pluginId, localId)
      tools.push({ ...definition, pluginId, name })
    }
    if (new Set(tools.map(tool => tool.name)).size !== tools.length) throw new Error('Plugin model tool names collide.')
    return tools
  }

  async requireTool(tool: Pick<ResolvedPluginTool, 'pluginId' | 'id'>): Promise<void> {
    const manifest = await this.requireEnabled(tool.pluginId)
    if (!manifest.tools.some(item => item.id === tool.id)) throw new Error(`Plugin tool is unavailable: ${pluginToolId(tool.pluginId, tool.id)}`)
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
    const manifest = await this.readManifest(id)
    if (!manifest.ui) throw new Error('Plugin has no UI entry.')
    const policy = pluginHomePolicy(manifest)
    const saved = await this.data(id, 'home_open_location')
    return { location: saved === null ? policy.defaultLocation : requirePluginHomeLocation(manifest, saved), locations: policy.locations }
  }

  async list(): Promise<PluginSummary[]> {
    let root: string | undefined
    try { root = await this.directory('plugins') } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    const names = [...new Set([...Object.keys(this.bundled), ...this.transactionErrors.keys(), ...(root ? await readdir(root) : [])])]
      .filter(name => { try { requirePluginId(name); return true } catch { return false } })
    return Promise.all(names.sort().map(name => this.read(name)))
  }

  async install(sourcePath: string): Promise<PluginSummary> {
    const prepared = await this.prepareInstall(sourcePath)
    return this.finishInstall(prepared.token)
  }

  async prepareInstall(sourcePath: string): Promise<PluginInstallPreview> {
    await this.recoverTransactions()
    await this.cancelInstall()
    const source = await realpath(sourcePath)
    const info = await stat(source)
    if (info.isDirectory()) return this.installDirectory(source)
    if (!info.isFile()) throw new Error('Select a plugin ZIP file, directory or PLUGIN.json.')
    if (basename(source) === 'PLUGIN.json') return this.installDirectory(dirname(source))
    if (extname(source).toLowerCase() !== '.zip') throw new Error('Select a plugin ZIP file, directory or PLUGIN.json.')

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

  private async installDirectory(sourceDirectory: string): Promise<PluginInstallPreview> {
    const source = await realpath(sourceDirectory)
    if (!(await stat(source)).isDirectory()) throw new Error('Select a plugin directory.')
    const definition = await optionalJson(join(source, 'PLUGIN.json'), 64 * 1024)
    if (definition === undefined) throw new Error('Plugin directory must contain PLUGIN.json at its root.')
    const manifest = parsePluginManifest(definition)
    if (this.isBuiltin(manifest.id)) throw new Error('Built-in plugins are updated with the application and cannot be replaced.')
    const root = await this.directory('plugins', undefined, true)
    if (isSameOrInsideDirectory(source, this.dataDirectory) || isSameOrInsideDirectory(root, source)) throw new Error('Plugin source must be outside the managed installation directory.')
    const identity = await this.installationIdentity(manifest.id)
    const installed = identity === undefined ? undefined : await this.read(manifest.id)
    const tempRoot = await this.directory('tmp', undefined, true)
    const stage = await mkdtemp(join(tempRoot, 'plugin-install-'))
    let retained = false
    try {
      const incoming = join(stage, 'incoming')
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
      await copy(source, incoming, new Set())
      const staged = parsePluginManifest(await optionalJson(join(incoming, 'PLUGIN.json'), 64 * 1024))
      if (JSON.stringify(staged) !== JSON.stringify(manifest)) throw new Error('Plugin manifest changed while installing.')
      for (const entry of [manifest.ui, manifest.backend]) {
        if (entry && !(await stat(join(incoming, entry))).isFile()) throw new Error('Missing plugin entry.')
      }
      await this.validateContributions(manifest, async path => {
        const file = join(incoming, path)
        if (!(await stat(file)).isFile()) throw new Error('Missing plugin contribution.')
        return file
      })
      const preview = { token: randomUUID(), incoming: manifest, installed }
      this.pending = { stage, preview, identity }
      retained = true
      return preview
    } finally {
      if (!retained) await rm(stage, { recursive: true, force: true })
    }
  }

  private async installationIdentity(id: string): Promise<string | undefined> {
    try {
      const info = await stat(await this.directory('plugins', id))
      return JSON.stringify([info.dev, info.ino, info.birthtimeMs])
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  }

  async cancelInstall(token?: string): Promise<void> {
    if (!this.pending || (token !== undefined && this.pending.preview.token !== token)) return
    const { stage } = this.pending
    await rm(stage, { recursive: true, force: true })
    this.pending = undefined
  }

  private transactions(): PluginTransactions {
    return new PluginTransactions(group => this.directory(group, undefined, group === 'plugins'))
  }

  /** Startup/restore runs this before any plugin backend or page is opened. */
  async recoverTransactions(): Promise<void> {
    await this.transactions().recoverAll()
    this.transactionErrors.clear()
  }

  private async executeTransaction(stage: string, id: string): Promise<void> {
    try { await this.transactions().execute(stage) } catch (error) {
      if (error instanceof PluginTransactionError && !error.committed) this.transactionErrors.set(id, error)
      throw error
    }
  }

  async finishInstall(token: string, options: { replace?: boolean; deleteData?: boolean } = {}, beforeReplace?: (id: string) => Promise<void>): Promise<PluginSummary> {
    const { replace = false, deleteData = false } = options
    if (typeof replace !== 'boolean' || typeof deleteData !== 'boolean') throw new Error('Invalid plugin replacement options.')
    if (typeof token !== 'string' || !this.pending || this.pending.preview.token !== token) throw new Error('Plugin installation is no longer pending. Select the package again.')
    const { preview, identity, stage } = this.pending
    this.pending = undefined
    const { incoming: manifest, installed } = preview
    let recoveryStage: string
    try {
      const unchanged = async () => {
        if (this.transactionErrors.has(manifest.id)) throw this.transactionErrors.get(manifest.id)
        if (await this.installationIdentity(manifest.id) !== identity
          || (installed && JSON.stringify((await this.read(manifest.id)).manifest) !== JSON.stringify(installed.manifest))) {
          throw new Error('Installed plugin changed. Select the package again before replacing it.')
        }
      }
      await unchanged()
      if (installed && !replace) throw new Error('Plugin is already installed. Confirm replacement before installing another version.')
      const dataDirectory = () => this.directory('db/plugins', manifest.id).catch(error => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (installed && deleteData) await dataDirectory()
      if (installed) {
        await this.assertPackageIdle(manifest.id)
        await beforeReplace?.(manifest.id)
      }
      await unchanged()
      // Shutdown can finish writing or create the plugin's data directory.
      const data = installed && deleteData ? await dataDirectory() : undefined
      const current = await this.installationState(manifest.id)
      const installation = installed ? current.state : { version: 0, enabled: true }
      const installationChange = data ? 'reset' : current.exists ? 'replace' : 'create'
      if (data) {
        await mkdir(join(stage, 'incoming-data'))
        await writeJsonFileAtomic(join(stage, 'incoming-data', 'anas-installation.json'), installation)
      } else {
        await this.directory('db/plugins', manifest.id, true)
        await writeJsonFileAtomic(join(stage, 'incoming-installation.json'), installation)
      }
      await writePluginTransaction(stage, newPluginTransaction(manifest.id, 'replace', Boolean(installed), Boolean(data), installationChange))
      recoveryStage = join(await this.directory('plugins', undefined, true), '.replace-' + token)
      await fs.retry.rename({ timeout: 2_000, interval: 25 })(stage, recoveryStage)
    } catch (error) {
      // No live files move until the complete journal and incoming package are
      // published outside tmp. Failed preparation contains no recovery data.
      await rm(stage, { recursive: true, force: true })
      throw error
    }
    await this.executeTransaction(recoveryStage, manifest.id)
    return this.read(manifest.id)
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    if (typeof enabled !== 'boolean') throw new Error('Invalid plugin enabled state.')
    if (this.transactionErrors.has(id)) throw this.transactionErrors.get(id)
    const item = await this.read(id)
    if (enabled && item.error) throw new Error(item.error)
    const { path, state } = await this.installationState(id, true)
    await writeJsonFileAtomic(path, { ...state, enabled })
  }

  async setShowInTitlebar(id: string, show: boolean): Promise<void> {
    if (typeof show !== 'boolean') throw new Error('Invalid plugin titlebar preference.')
    const item = await this.read(id)
    if (item.error) throw new Error(item.error)
    if (!item.manifest?.ui) throw new Error('Plugin has no home page.')
    const { path, state } = await this.installationState(id, true)
    await writeJsonFileAtomic(path, { ...state, show_in_titlebar: show })
  }

  async uninstall(id: string, deleteData = false): Promise<void> {
    if (this.isBuiltin(id)) throw new Error('Built-in plugins can be disabled, but cannot be uninstalled.')
    if (typeof deleteData !== 'boolean') throw new Error('Invalid plugin data deletion option.')
    await this.recoverTransactions()
    await this.assertPackageIdle(id)
    const data = deleteData ? await this.directory('db/plugins', id).catch(error => {
      if (error.code === 'ENOENT') return undefined
      throw error
    }) : undefined
    const installation = !deleteData && await lstat(await this.installationPath(id)).catch(error => {
      if (error.code !== 'ENOENT') throw error
      return undefined
    })
    const stage = await mkdtemp(join(await this.directory('tmp', undefined, true), 'plugin-remove-'))
    const recoveryStage = join(await this.directory('plugins'), '.remove-' + randomUUID())
    try {
      // Publish a complete journal before moving any live files. An interrupted
      // initial write stays disposable and cannot block startup recovery.
      await writePluginTransaction(stage, newPluginTransaction(id, 'remove', true, Boolean(data), installation ? 'remove' : undefined))
      await fs.retry.rename({ timeout: 2_000, interval: 25 })(stage, recoveryStage)
    } catch (error) {
      await rm(stage, { recursive: true, force: true })
      throw error
    }
    await this.executeTransaction(recoveryStage, id)
  }

  async data(id: string, key: unknown, write = false, value?: unknown): Promise<unknown> {
    // The host-owned home preference remains configurable while the plugin is disabled.
    const manifest = key === 'home_open_location' ? await this.readManifest(id) : await this.requireEnabled(id)
    if (typeof key !== 'string' || !/^[a-zA-Z0-9_.-]{1,80}$/.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('Invalid plugin data key.')
    const root = await this.directory('db/plugins', id, true)
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

  /** Call under exclusive(). The revision covers both saved values and the current form. */
  async settings(id: string, update?: { revision: unknown; values: unknown }): Promise<PluginSettingsSnapshot> {
    const plugin = await this.read(id, false)
    if (plugin.error || !plugin.manifest) throw new Error(plugin.error ?? 'Plugin is unavailable.')
    const fields = plugin.manifest.settings ?? []
    if (!fields.length) throw new Error('Plugin has no settings declaration.')
    const path = join(await this.directory('db/plugins', id, true), 'anas-settings.json')
    const raw = await optionalJson(path) as { version?: unknown; values?: unknown } | undefined
    if (raw !== undefined && (!raw || raw.version !== 0 || !raw.values || typeof raw.values !== 'object' || Array.isArray(raw.values))) throw new Error('Invalid plugin settings file; original content was preserved.')
    const saved = (raw?.values ?? {}) as Record<string, unknown>
    const revision = (values: unknown) => createHash('sha256').update(JSON.stringify([fields, values])).digest('hex')
    const current = { values: pluginSettingValues(fields, saved), revision: revision(saved) }
    if (!update) return current
    if (!plugin.enabled) throw new Error('Plugin is disabled.')
    if (typeof update.revision !== 'string' || update.revision !== current.revision) throw new Error('Plugin settings changed. Reload before saving.')
    const values = pluginSettingValues(fields, update.values, true)
    // Preserve removed keys for a later supported package update; they are not exposed in the current form.
    const next = { ...saved, ...values }
    requirePluginJson(next)
    if (Buffer.byteLength(JSON.stringify({ version: 0, values: next }, null, 2)) + 1 > 1024 * 1024) throw new Error('Plugin settings exceed 1 MiB.')
    await writeJsonFileAtomic(path, { version: 0, values: next })
    return { values, revision: revision(next) }
  }
}
