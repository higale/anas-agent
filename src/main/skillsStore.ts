import { pluginCapabilityEnabled } from '@shared/pluginCapabilities'
import { findSubagentPackage } from './subagentPackages'
import { requireDataVersion } from '@shared/dataVersion'
import { listPackageFiles, readPackageFile, savePackageFile } from './packageFiles'
import { writeJsonFileAtomic } from './atomicJson'
import { assertUserResourceDirectory, validateBundledDirectories } from './bundledDirectories'
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, readlink, realpath, stat } from 'node:fs/promises'
import { shell } from 'electron'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { isSameOrInsideDirectory } from './pathContainment'
import { renameExclusive } from './renameExclusive'
import { copyPackageContents } from './copyPackageContents'
import { runtimeLog } from './runtimeLogger'
import { inspectSkillText } from './skillDefinition'
import { pluginRuntime, pluginToolMapping } from './plugins/pluginRuntime'
import { pluginToolId } from '@shared/pluginTools'
import { SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH, SKILL_SHORTCUT_ALIAS_MAX_LENGTH, SKILL_SHORTCUT_ALIAS_PATTERN } from '@shared/types'
import type {
  SkillAvailabilityUpdate,
  SkillFileNode,
  SkillFilePreview,
  SkillImportBatch,
  SkillImportError,
  SkillInvocationResult,
  SkillLoadIssue,
  SkillRootKind,
  SkillRootSummary,
  SkillRootUpdate,
  SkillSnapshot,
  SkillSummary
} from '@shared/types'
import {
  getBundledConfigFile,
  getConfigFile,
  getSkillsDir,
  getSystemSkillsDir,
  skillsConfigFileName
} from './config/dataDir'
import { getProject } from './projectStore'
import { parseResourceDirectories, resourceDirectoryName } from './resourceDirectories'
import { parseCapabilities, resolveSkillSelection, defaultCapabilities, resolvePluginCapabilities, type SkillSelection } from '@shared/agentCapabilities'
import { packageResourceEnabled } from '@shared/packageResourceSelection'


interface ExternalSkillDirectory {
  id: string
  name: string
  shortcut_alias: string
  path: string
}

interface StoredAvailability {
  model_available: boolean
  user_available: boolean
}

interface SkillsConfigFile {
  version: 0
  external_directories: ExternalSkillDirectory[]
  availability: Record<string, StoredAvailability>
}

interface LoadedSkill {
  summary: SkillSummary
}

interface RootScan {
  root: SkillRootSummary
  skills: LoadedSkill[]
}

interface SkillDirectory {
  id?: string
  requiredTools?: string[]
  name: string
  path: string
  linked: boolean
  linkTarget?: string
  resolvedPath?: string
}

const maxPreviewBytes = 1024 * 1024
const maxSkillDirectoriesPerRoot = 2048
const skillNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const reservedAliases = new Set(['system', 'user', 'project'])
let initialization: Promise<void> | undefined
let configMutationTail: Promise<void> = Promise.resolve()
let skillImportTail: Promise<void> = Promise.resolve()

type SkillImportFailureCode = 'already_exists' | 'invalid_directory' | 'invalid_skill'

class SkillImportFailure extends Error {
  constructor(
    readonly code: SkillImportFailureCode,
    message: string,
    readonly skillName?: string,
    readonly issue?: SkillLoadIssue
  ) {
    super(message)
    this.name = 'SkillImportFailure'
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw reason
  }
}

async function entryExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (reason) {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw reason
  }
}

function expandHome(path: string): string {
  const trimmed = path.trim()
  if (trimmed === '~') return homedir()
  if (trimmed.startsWith('~/') || trimmed.startsWith('~\\')) return join(homedir(), trimmed.slice(2))
  return trimmed
}

function externalPath(path: string): string {
  return resolve(expandHome(path))
}

function normalizeRootDisplayName(value: unknown): string {
  const name = typeof value === 'string' ? value.trim() : ''
  if (!name || name.length > SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH || /[\r\n\t]/.test(name)) {
    throw new Error('Skill directory display name is invalid.')
  }
  return name
}

function normalizeShortcutAlias(value: unknown): string {
  const alias = typeof value === 'string' ? value.trim() : ''
  if (alias.length > SKILL_SHORTCUT_ALIAS_MAX_LENGTH || !SKILL_SHORTCUT_ALIAS_PATTERN.test(alias)) {
    throw new Error('Skill directory shortcut alias is invalid.')
  }
  return alias
}

function normalizeExternalDirectory(value: unknown): ExternalSkillDirectory {
  if (!isRecord(value)) throw new Error('External Skill directory must be an object.')
  const id = typeof value.id === 'string' ? value.id.trim() : ''
  const name = normalizeRootDisplayName(value.name)
  const shortcutAlias = normalizeShortcutAlias(value.shortcut_alias)
  const path = typeof value.path === 'string' ? value.path.trim() : ''
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id) || id === 'system' || id === 'user' || id.startsWith('project-') || !path) {
    throw new Error('External Skill directory configuration is invalid.')
  }
  return { id, name, shortcut_alias: shortcutAlias, path }
}

export function normalizeSkillsConfig(value: unknown): SkillsConfigFile {
  requireDataVersion(value, 0, 'Skills configuration')
  if (!isRecord(value) || !Array.isArray(value.external_directories) || !isRecord(value.availability)) {
    throw new Error('Skills configuration is invalid.')
  }
  const directories = value.external_directories.map(normalizeExternalDirectory)
  const ids = new Set<string>()
  const aliases = new Set(reservedAliases)
  for (const directory of directories) {
    if (ids.has(directory.id)) throw new Error(`Duplicate external Skill directory ID: ${directory.id}`)
    if (aliases.has(directory.shortcut_alias)) throw new Error(`Duplicate Skill shortcut alias: ${directory.shortcut_alias}`)
    ids.add(directory.id)
    aliases.add(directory.shortcut_alias)
  }
  const availability: Record<string, StoredAvailability> = {}
  for (const [id, raw] of Object.entries(value.availability)) {
    if (!isRecord(raw) || typeof raw.model_available !== 'boolean' || typeof raw.user_available !== 'boolean') {
      throw new Error(`Skill availability is invalid: ${id}`)
    }
    availability[id] = { model_available: raw.model_available, user_available: raw.user_available }
  }
  return { version: 0, external_directories: directories, availability }
}

async function ensureSkillsConfig(): Promise<void> {
  const target = getConfigFile(skillsConfigFileName)
  if (await pathExists(target)) return
  await mkdir(dirname(target), { recursive: true })
  await copyFile(getBundledConfigFile(skillsConfigFileName), target)
}

async function readSkillsConfig(): Promise<SkillsConfigFile> {
  await initializeSkillsStore()
  return normalizeSkillsConfig(JSON.parse(await readFile(getConfigFile(skillsConfigFileName), 'utf8')))
}

export async function validateSkillsConfigFile(path: string): Promise<void> {
  normalizeSkillsConfig(JSON.parse(await readFile(path, 'utf8')))
}

async function writeSkillsConfig(config: SkillsConfigFile): Promise<void> {
  await writeJsonFileAtomic(getConfigFile(skillsConfigFileName), normalizeSkillsConfig(config))
}

function mutateSkillsConfig<T>(mutation: (config: SkillsConfigFile) => Promise<T>): Promise<T> {
  const result = configMutationTail.then(async () => mutation(await readSkillsConfig()))
  configMutationTail = result.then(() => undefined, () => undefined)
  return result
}


export function toSkillImportError(reason: unknown): SkillImportError {
  if (reason instanceof SkillImportFailure) {
    if (reason.code === 'already_exists' && reason.skillName) {
      return { code: 'already_exists', name: reason.skillName }
    }
    if (reason.code === 'invalid_skill' && reason.issue) {
      return { code: 'invalid_skill', issue: reason.issue }
    }
    if (reason.code === 'invalid_directory') return { code: 'invalid_directory' }
  }
  return { code: 'failed', detail: reason instanceof Error ? reason.message : String(reason) }
}

export async function validateBundledSkill(dirPath: string, expectedName: string): Promise<void> {
  const info = await lstat(dirPath)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Bundled Skill must be a regular directory: ${dirPath}`)
  const parsed = inspectSkillText(await readBoundedTextFile(join(dirPath, 'SKILL.md')), expectedName)
  if ('code' in parsed) throw new Error(`Invalid bundled Skill ${expectedName}: ${parsed.code}`)
}

export async function initializeSkillsStore(): Promise<void> {
  if (!initialization) {
    initialization = Promise.allSettled([
      ensureSkillsConfig(),
      mkdir(getSkillsDir(), { recursive: true }),
      validateBundledDirectories(getSystemSkillsDir(), validateBundledSkill)
    ]).then((results) => {
      // Settle all initialization work before allowing a failed attempt to retry.
      const failure = results.find((result) => result.status === 'rejected')
      if (failure) throw failure.reason
    })
    initialization.catch(() => { initialization = undefined })
  }
  await initialization
}

export async function validateRestoredSkillsDirectory(skillsDir: string, userRoot = false): Promise<void> {
  if (!(await pathExists(skillsDir))) return
  const info = await lstat(skillsDir)
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Restored Skills path must be a regular directory.')
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || (userRoot && entry.name.toLowerCase() === '_system')) continue
    if (!entry.isDirectory()) throw new Error(`Restored Skills contains a non-directory entry: ${entry.name}`)
    const parsed = inspectSkillText(await readFile(join(skillsDir, entry.name, 'SKILL.md'), 'utf8'), entry.name)
    if ('code' in parsed) throw new Error(`Invalid skill ${entry.name}: ${parsed.code}`)
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'skills'
}

async function resolveSkillRoots(directories?: string[]): Promise<SkillRootSummary[]> {
  const config = await readSkillsConfig()
  const roots: SkillRootSummary[] = [
    { id: 'system', kind: 'system', name: 'System', shortcutAlias: 'system', path: getSystemSkillsDir(), removable: false, available: true },
    { id: 'user', kind: 'user', name: 'User', shortcutAlias: 'user', path: getSkillsDir(), removable: false, available: true }
  ]
  if (directories) {
    const used = new Set([
      ...roots.map((root) => root.shortcutAlias),
      ...config.external_directories.map((directory) => directory.shortcut_alias)
    ])
    const projectRoots = [
      ...parseResourceDirectories(directories).map(path => ({
        id: `project-skill-${createHash('sha256').update(process.platform === 'win32' ? path.toLowerCase() : path).digest('hex').slice(0, 16)}`,
        path, name: defaultExternalDirectoryName(path), base: `project-${slug(defaultExternalDirectoryName(path))}`, removable: true
      }))
    ]
    projectRoots.forEach(({ id, path, name, base, removable }) => {
      let alias = base
      let suffix = 2
      while (used.has(alias)) alias = `${base}-${suffix++}`
      used.add(alias)
      roots.push({
        id,
        kind: 'project',
        name,
        shortcutAlias: alias,
        path,
        removable,
        available: true
      })
    })
  }
  roots.push(...config.external_directories.map((directory) => ({
    id: directory.id,
    kind: 'external' as const,
    name: directory.name,
    shortcutAlias: directory.shortcut_alias,
    path: externalPath(directory.path),
    removable: true,
    available: true
  })))
  return roots
}

function invalidSkill(root: SkillRootSummary, directory: SkillDirectory, issue: SkillLoadIssue, config: SkillsConfigFile): LoadedSkill {
  const name = directory.name
  const id = directory.id ?? `${root.id}:${name}`
  const availability = config.availability[id]
  return {
    summary: {
      id,
      rootId: root.id,
      name,
      description: '',
      modelAvailable: availability?.model_available ?? true,
      userAvailable: availability?.user_available ?? true,
      dirPath: directory.path,
      linked: directory.linked,
      ...(directory.linkTarget ? { linkTarget: directory.linkTarget } : {}),
      ...(directory.resolvedPath ? { resolvedDirPath: directory.resolvedPath } : {}),
      relativePath: name,
      source: root.kind,
      rootName: root.name,
      shortcutAlias: root.shortcutAlias,
      loadError: issue
    }
  }
}

function isVisibleSkillEntry(name: string, userRoot: boolean): boolean {
  return !name.startsWith('.') && (!userRoot || name.toLowerCase() !== '_system')
}

async function skillDirectories(rootPath: string, userRoot: boolean): Promise<SkillDirectory[]> {
  const entries = (await readdir(rootPath, { withFileTypes: true }))
    .filter(entry => isVisibleSkillEntry(entry.name, userRoot))
  if (entries.length > maxSkillDirectoriesPerRoot) {
    throw new Error(`Skill root contains more than ${maxSkillDirectoriesPerRoot} entries.`)
  }
  const result: SkillDirectory[] = []
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(rootPath, entry.name)
    if (entry.isDirectory()) result.push({ name: entry.name, path, linked: false, resolvedPath: await realpath(path).catch(() => undefined) })
    else if (entry.isSymbolicLink()) {
      const linkTarget = await readlink(path)
      const target = await stat(path).catch(() => undefined)
      if (target?.isDirectory()) {
        result.push({ name: entry.name, path, linked: true, linkTarget, resolvedPath: await realpath(path) })
      } else if (!target) {
        result.push({ name: entry.name, path, linked: true, linkTarget })
      }
    }
  }
  return result
}

async function scanRoot(root: SkillRootSummary, config: SkillsConfigFile, declaredDirectories?: SkillDirectory[]): Promise<RootScan> {
  let directories = declaredDirectories
  const userSource = root.kind === 'user' || root.kind === 'external' || root.kind === 'project'
  try {
    if (userSource) await assertUserResourceDirectory(root.path)
    const info = await stat(root.path)
    if (!info.isDirectory()) return { root: { ...root, available: false, issue: 'not_directory' }, skills: [] }
    directories ??= await skillDirectories(root.path, root.kind === 'user')
  } catch (reason) {
    const code = (reason as NodeJS.ErrnoException).code
    return { root: { ...root, available: false, issue: code === 'ENOENT' ? 'not_found' : 'unreadable' }, skills: [] }
  }
  const skills: LoadedSkill[] = []
  for (const directory of directories) {
    if (directory.linked && !directory.resolvedPath) {
      skills.push(invalidSkill(root, directory, { code: 'missing_skill_file', detail: 'The linked Skill directory target is unavailable.' }, config))
      continue
    }
    let content: string | undefined
    try {
      if (userSource) await assertUserResourceDirectory(directory.path)
      content = await readBoundedTextFile(join(directory.path, 'SKILL.md'))
    } catch (reason) {
      const error = reason as NodeJS.ErrnoException
      if (error.code !== 'ENOENT') {
        skills.push(invalidSkill(root, directory, { code: 'unreadable_skill_file', detail: error.message }, config))
        continue
      }
    }
    if (content === undefined) {
      skills.push(invalidSkill(root, directory, { code: 'missing_skill_file' }, config))
      continue
    }
    const parsed = inspectSkillText(content, directory.name)
    if ('code' in parsed) {
      skills.push(invalidSkill(root, directory, parsed, config))
      continue
    }
    const id = directory.id ?? `${root.id}:${directory.name}`
    const availability = root.kind === 'project' ? undefined : config.availability[id]
    skills.push({
      summary: {
        id,
        rootId: root.id,
        name: parsed.name,
        description: parsed.description,
        ...(parsed.compatibility ? { compatibility: parsed.compatibility } : {}),
        modelAvailable: availability?.model_available ?? true,
        userAvailable: availability?.user_available ?? true,
        dirPath: directory.path,
        linked: directory.linked,
        ...(directory.linkTarget ? { linkTarget: directory.linkTarget } : {}),
        ...(directory.resolvedPath ? { resolvedDirPath: directory.resolvedPath } : {}),
        relativePath: directory.name,
        source: root.kind,
        rootName: root.name,
        shortcutAlias: root.shortcutAlias,
        ...(directory.requiredTools?.length ? { requiredTools: directory.requiredTools } : {})
      }
    })
  }
  return { root, skills }
}

function precedence(kind: SkillRootKind): number {
  if (kind === 'subagent') return -1
  return kind === 'project' ? 0 : kind === 'user' ? 1 : kind === 'external' ? 2 : kind === 'system' ? 3 : 4
}

async function loadPluginSkills(config: SkillsConfigFile, includeDisabledPlugins: boolean): Promise<RootScan[]> {
  const { store } = pluginRuntime()
  return store.exclusive(async () => {
    const scans: RootScan[] = []
    for (const plugin of await store.list()) {
      if ((!plugin.enabled && !includeDisabledPlugins) || plugin.error || !plugin.manifest?.skills?.length) continue
      const path = await store.packageDirectory(plugin.id)
      const root: SkillRootSummary = { id: `plugin:${plugin.id}`, kind: 'plugin', name: plugin.manifest.name,
        shortcutAlias: `plugin:${plugin.id}`, path, removable: false, available: true }
      const scan = await scanRoot(root, config, plugin.manifest.skills.map(skill => ({
        id: `${plugin.id}:skill:${skill.id}`, name: basename(dirname(skill.path)), path: join(path, dirname(skill.path)), linked: false,
        requiredTools: skill.tools.map(id => pluginToolId(plugin.id, id))
      })))
      for (const skill of scan.skills) {
        skill.summary.configuredAvailability = { modelAvailable: skill.summary.modelAvailable, userAvailable: skill.summary.userAvailable }
        const declaration = plugin.manifest.skills.find(item => `${plugin.id}:skill:${item.id}` === skill.summary.id)!
        if (!plugin.enabled
          || declaration.tools.some(id => !pluginCapabilityEnabled(plugin.capabilityChoices, 'tool', id))) {
          skill.summary.modelAvailable = false
          skill.summary.userAvailable = false
        }
      }
      scans.push(scan)
    }
    return scans
  })
}

function resolveConflicts(scans: RootScan[]): LoadedSkill[] {
  const rootOrder = new Map(scans.map((scan, index) => [scan.root.id, index]))
  const skills = scans.flatMap((scan) => scan.skills).sort((left, right) => (
    precedence(left.summary.source) - precedence(right.summary.source)
    || (rootOrder.get(left.summary.rootId) ?? 0) - (rootOrder.get(right.summary.rootId) ?? 0)
    || left.summary.name.localeCompare(right.summary.name)
  ))
  const modelWinners = new Map<string, LoadedSkill>()
  const userWinners = new Map<string, LoadedSkill>()
  for (const skill of skills) {
    if (skill.summary.loadError) continue
    const name = skill.summary.name.toLowerCase()
    if (skill.summary.modelAvailable && !modelWinners.has(name)) modelWinners.set(name, skill)
    if (skill.summary.userAvailable && !userWinners.has(name)) userWinners.set(name, skill)
  }
  return skills.map((skill) => {
    const name = skill.summary.name.toLowerCase()
    const modelWinner = modelWinners.get(name)
    const userWinner = userWinners.get(name)
    return {
      ...skill,
      summary: {
        ...skill.summary,
        ...(!skill.summary.loadError && skill.summary.userAvailable
          ? { shortcut: userWinner?.summary.id === skill.summary.id ? `/${skill.summary.name}` : `/${skill.summary.name}@${skill.summary.shortcutAlias}` }
          : {}),
        ...(skill.summary.modelAvailable && modelWinner && modelWinner.summary.id !== skill.summary.id ? { modelShadowedBy: modelWinner.summary.rootName } : {}),
        ...(skill.summary.userAvailable && userWinner && userWinner.summary.id !== skill.summary.id ? { userShadowedBy: userWinner.summary.rootName } : {})
      }
    }
  })
}

function subagentSkillRootId(id: string): string { return `subagent:${id}:skill` }

export async function listSubagentSkills(ids: readonly string[]): Promise<SkillSnapshot> {
  const scans: RootScan[] = []
  for (const id of [...new Set(ids)]) {
    const agent = await findSubagentPackage(id)
    const root: SkillRootSummary = { id: subagentSkillRootId(id), kind: 'subagent', name: agent.name!, shortcutAlias: `agent-${id}`,
      path: join(agent.directory!, 'skills'), removable: false, available: true }
    const scan = await scanRoot(root, { version: 0, external_directories: [], availability: {} })
    const selection = parseCapabilities(agent.capabilities).skills.package
    for (const skill of scan.skills) {
      skill.summary.modelAvailable = packageResourceEnabled(selection, skill.summary)
      skill.summary.userAvailable = false
    }
    scans.push(scan)
  }
  return { roots: scans.map(s => s.root), skills: scans.flatMap(s => s.skills.map(s => s.summary)) }
}

export type SkillAgentScope = { kind: 'main' } | { kind: 'subagent'; id?: string }

export interface SkillCatalogRequest {
  /** The caller owns discovery scope; saved selections never add package sources. */
  agent: SkillAgentScope
  projectId?: string
  skillDirectories?: string[]
  selection?: SkillSelection
  pluginTools?: readonly string[]
  includeDisabledPlugins?: boolean
}

async function loadCatalog({ agent, projectId, selection, pluginTools, skillDirectories, includeDisabledPlugins = false }: SkillCatalogRequest): Promise<{ roots: SkillRootSummary[]; skills: LoadedSkill[] }> {
  if (projectId && skillDirectories === undefined) {
    const project = await getProject(projectId)
    skillDirectories ??= project.skillDirectories ?? []
  }
  const [roots, config] = await Promise.all([resolveSkillRoots(skillDirectories), readSkillsConfig()])
  // A source owns its IDs, availability and explicit shortcut alias even when
  // another source points to the same directory. Resolve winners after selection.
  const scans = await Promise.all(roots.map(root => scanRoot(root, config)))
  scans.push(...await loadPluginSkills(config, includeDisabledPlugins))
  if (agent.kind === 'subagent' && agent.id) {
    const prefix = `${subagentSkillRootId(agent.id)}:`
    // Resolved custom selections enumerate dependencies within the explicit owner's scope.
    const needsOwnedSkills = !selection || selection.mode === 'default' || selection.mode === 'custom'
      && selection.entries.some(entry => entry.model && entry.id.startsWith(prefix) && entry.id.length > prefix.length)
    if (needsOwnedSkills) {
      const own = await listSubagentSkills([agent.id])
      for (const root of own.roots) scans.unshift({ root, skills: own.skills.filter(s => s.rootId === root.id).map(summary => ({ summary })) })
    }
  }
  if (selection) {
    const resolved = resolveSkillSelection(selection, scans.flatMap(scan => scan.skills.map(skill => skill.summary)), false, false, pluginTools)
    const entries = new Map(resolved.entries.map(entry => [entry.id, entry]))
    for (const scan of scans) for (const skill of scan.skills) {
      skill.summary.modelAvailable = entries.get(skill.summary.id)?.model ?? false
      skill.summary.userAvailable = agent.kind === 'main' && (entries.get(skill.summary.id)?.shortcut ?? false)
    }
  }
  return { roots: scans.map((scan) => scan.root), skills: resolveConflicts(scans) }
}

export async function listSkillSnapshot(projectId?: string, skillDirectories?: string[]): Promise<SkillSnapshot> {
  const directories = skillDirectories === undefined ? undefined : parseResourceDirectories(skillDirectories)
  const catalog = await loadCatalog({ agent: { kind: 'main' }, projectId, skillDirectories: directories, includeDisabledPlugins: !projectId })
  return { ...(projectId ? { projectId } : {}), roots: catalog.roots, skills: catalog.skills.map((skill) => skill.summary) }
}

async function findSkill(projectId: string | undefined, skillId: string): Promise<LoadedSkill> {
  const skill = (await loadCatalog({ agent: { kind: 'main' }, projectId, includeDisabledPlugins: !projectId })).skills.find((candidate) => candidate.summary.id === skillId)
  if (!skill) throw new Error(`Skill was not found: ${skillId}`)
  return skill
}

async function readBoundedTextFile(path: string): Promise<string> {
  const handle = await open(path, 'r')
  try {
    const info = await handle.stat()
    if (!info.isFile()) throw new Error('Skill file is not a regular file.')
    if (info.size > maxPreviewBytes) throw new Error(`Skill file exceeds ${maxPreviewBytes} bytes.`)
    const buffer = Buffer.allocUnsafe(maxPreviewBytes + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > maxPreviewBytes) throw new Error(`Skill file exceeds ${maxPreviewBytes} bytes.`)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    await handle.close()
  }
}

export async function listSkillFiles(projectId: string | undefined, skillId: string, relativePath?: string): Promise<SkillFileNode[]> {
  return listPackageFiles((await findSkill(projectId, skillId)).summary.dirPath, relativePath)
}

export async function readSkillFile(projectId: string | undefined, skillId: string, relativePath: string): Promise<SkillFilePreview> {
  const { summary } = await findSkill(projectId, skillId)
  const preview = await readPackageFile(summary.dirPath, relativePath)
  return { ...preview, skillId, editable: preview.editable && summary.source !== 'system' && summary.source !== 'plugin' }
}

export async function updateSkillAvailability(projectId: string | undefined, skillId: string, update: SkillAvailabilityUpdate): Promise<SkillSnapshot> {
  const hasModelAvailable = typeof update?.modelAvailable === 'boolean'
  const hasUserAvailable = typeof update?.userAvailable === 'boolean'
  if (!hasModelAvailable && !hasUserAvailable) throw new Error('Skill availability update is empty or invalid.')
  if (update.modelAvailable !== undefined && !hasModelAvailable) throw new Error('Skill model availability is invalid.')
  if (update.userAvailable !== undefined && !hasUserAvailable) throw new Error('Skill user availability is invalid.')
  const currentSkill = await findSkill(projectId, skillId)
  if (currentSkill.summary.source === 'project') throw new Error('Select project skills in project capability settings.')
  return mutateSkillsConfig(async (config) => {
    const configured = currentSkill.summary.configuredAvailability ?? currentSkill.summary
    const current = config.availability[skillId] ?? {
      model_available: configured.modelAvailable,
      user_available: configured.userAvailable
    }
    config.availability[skillId] = {
      model_available: update.modelAvailable ?? current.model_available,
      user_available: update.userAvailable ?? current.user_available
    }
    await writeSkillsConfig(config)
    return listSkillSnapshot(projectId)
  })
}

interface SkillImportSource {
  name: string
  path: string
}

async function importDirectoryIdentity(path: string): Promise<string> {
  const info = await lstat(path, { bigint: true })
  if (!info.isDirectory() || info.ino === 0n) throw new Error(`Cannot identify Skill import directory: ${path}`)
  return `${info.dev}:${info.ino}:${info.birthtimeNs}`
}

async function checkImportDirectory(path: string, identity: string): Promise<void> {
  if (await importDirectoryIdentity(path) !== identity) throw new Error(`Skill import directory changed: ${path}`)
}

async function inspectSkillImportSource(sourcePath: string, name = basename(resolve(sourcePath))): Promise<SkillImportSource> {
  const selectedPath = resolve(sourcePath)
  if (!skillNamePattern.test(name) || name.length > 64) {
    throw new SkillImportFailure('invalid_directory', `Invalid Skill directory name: ${name}`)
  }
  let canonicalPath: string
  try {
    const info = await stat(selectedPath)
    if (!info.isDirectory()) throw new SkillImportFailure('invalid_directory', `Skill source is not a directory: ${selectedPath}`)
    canonicalPath = await realpath(selectedPath)
  } catch (reason) {
    if (reason instanceof SkillImportFailure) throw reason
    const code = (reason as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      throw new SkillImportFailure('invalid_directory', `Skill source does not exist: ${selectedPath}`)
    }
    throw reason
  }
  let content: string
  try {
    const skillFile = join(canonicalPath, 'SKILL.md')
    const info = await stat(skillFile)
    if (!info.isFile()) throw new SkillImportFailure('invalid_skill', `SKILL.md is not a regular file: ${skillFile}`, name, { code: 'unreadable_skill_file' })
    if (info.size > maxPreviewBytes) {
      throw new SkillImportFailure('invalid_skill', `SKILL.md exceeds ${maxPreviewBytes} bytes: ${skillFile}`, name, { code: 'unreadable_skill_file', detail: `The file exceeds ${maxPreviewBytes} bytes.` })
    }
    content = await readFile(skillFile, 'utf8')
  } catch (reason) {
    if (reason instanceof SkillImportFailure) throw reason
    const code = (reason as NodeJS.ErrnoException).code
    const issue: SkillLoadIssue = code === 'ENOENT'
      ? { code: 'missing_skill_file' }
      : { code: 'unreadable_skill_file', detail: reason instanceof Error ? reason.message : String(reason) }
    throw new SkillImportFailure('invalid_skill', `Cannot read Skill definition: ${selectedPath}`, name, issue)
  }
  const parsed = inspectSkillText(content, name)
  if ('code' in parsed) throw new SkillImportFailure('invalid_skill', `Invalid Skill definition: ${name}`, name, parsed)
  return { name, path: canonicalPath }
}

async function importSkillDirectoriesExclusive(sourcePaths: readonly string[]): Promise<SkillImportBatch> {
  if (!Array.isArray(sourcePaths) || !sourcePaths.length || sourcePaths.some(path => typeof path !== 'string' || !path.trim())) {
    throw new SkillImportFailure('invalid_directory', 'At least one Skill directory is required.')
  }
  const userRoot = getSkillsDir()
  await assertUserResourceDirectory(userRoot)
  await initializeSkillsStore()
  const destination = await realpath(userRoot)
  const destinationId = await importDirectoryIdentity(destination)
  const verifyRoot = async () => {
    await assertUserResourceDirectory(destination)
    await checkImportDirectory(destination, destinationId)
  }
  const verifyDestination = async () => {
    await verifyRoot()
    if (await realpath(userRoot) !== destination) throw new Error('User Skill directory changed during import.')
  }
  const sources = await Promise.all(sourcePaths.map(path => inspectSkillImportSource(path)))
  const selected = new Set<string>()
  for (const source of sources) {
    if (isSameOrInsideDirectory(source.path, destination)) {
      throw new SkillImportFailure('invalid_directory', 'The selected Skill contains its import destination.')
    }
    if (selected.has(source.name) || await entryExists(join(destination, source.name))) {
      throw new SkillImportFailure('already_exists', `Skill already exists: ${source.name}`, source.name)
    }
    selected.add(source.name)
  }
  const existing = (await readdir(destination)).filter(name => isVisibleSkillEntry(name, true))
  if (existing.length + selected.size > maxSkillDirectoriesPerRoot) {
    throw new Error(`User Skill directory would exceed ${maxSkillDirectoriesPerRoot} entries.`)
  }

  const result: SkillImportBatch = { names: [], failures: [] }
  for (const source of sources) {
    let stage: string | undefined
    let stageId: string | undefined
    try {
      await verifyDestination()
      stage = await mkdtemp(join(destination, '.import-'))
      stageId = await importDirectoryIdentity(stage)
      const stagingPath = stage, identity = stageId
      await copyPackageContents(source.path, stagingPath, () => checkImportDirectory(stagingPath, identity))
      const target = join(destination, source.name)
      await inspectSkillImportSource(stagingPath, source.name)
      await verifyDestination()
      await checkImportDirectory(stage, stageId)
      try {
        renameExclusive(stage, target)
      } catch (reason) {
        if ((reason as NodeJS.ErrnoException).code !== 'EEXIST') throw reason
        throw new SkillImportFailure('already_exists', `Skill already exists: ${source.name}`, source.name)
      }
      // This rename commits one Skill. Later operations do not own its files.
      result.names.push(source.name)
    } catch (reason) {
      const failure: SkillImportBatch['failures'][number] = { name: source.name, error: toSkillImportError(reason) }
      if (stage) {
        try {
          await verifyRoot()
          if (await entryExists(stage)) {
            if (!stageId) throw new Error('Unverified Skill staging directory.')
            await checkImportDirectory(stage, stageId)
            // Keep even unexpected edits recoverable. Only the private staging directory is discarded.
            await shell.trashItem(stage)
          }
        } catch (cleanupError) {
          failure.stagingPath = stage
          runtimeLog('warn', 'skills', 'Failed to discard an incomplete Skill copy.', { path: stage, error: cleanupError })
        }
      }
      result.failures.push(failure)
    }
  }
  return result
}

export function importSkillDirectories(sourcePaths: readonly string[]): Promise<SkillImportBatch> {
  const result = skillImportTail.then(() => importSkillDirectoriesExclusive(sourcePaths))
  skillImportTail = result.then(() => undefined, () => undefined)
  return result
}

function uniqueAlias(config: SkillsConfigFile, name: string): string {
  const used = new Set([...reservedAliases, ...config.external_directories.map((item) => item.shortcut_alias)])
  const base = slug(name)
  let candidate = base
  let suffix = 2
  while (used.has(candidate)) candidate = `${base}-${suffix++}`
  return candidate
}

function defaultExternalDirectoryName(path: string): string {
  if (path === join(homedir(), '.agents', 'skills')) return '~/.agents/skills'
  return resourceDirectoryName(path, 'skills')
}

async function reservedSkillRootPaths(projectId?: string): Promise<string[]> {
  const paths = [getSkillsDir()]
  if (projectId) {
    const project = await getProject(projectId)
    paths.push(...project.skillDirectories ?? [])
  }
  return Promise.all(paths.map(async (path) => realpath(path).catch(() => resolve(path))))
}

export async function addExternalSkillDirectory(path: string, projectId?: string): Promise<SkillSnapshot> {
  const absolute = externalPath(path)
  const info = await stat(absolute)
  if (!info.isDirectory()) throw new Error('Selected Skill root is not a directory.')
  const canonical = await realpath(absolute)
  await assertUserResourceDirectory(absolute)
  if ((await reservedSkillRootPaths(projectId)).includes(canonical)) {
    throw new Error('This Skill directory is already managed by Anas.')
  }
  return mutateSkillsConfig(async (config) => {
    for (const existing of config.external_directories) {
      const candidate = externalPath(existing.path)
      const resolvedCandidate = await realpath(candidate).catch(() => candidate)
      if (resolvedCandidate === canonical) throw new Error('Skill directory is already configured.')
    }
    const name = defaultExternalDirectoryName(absolute)
    config.external_directories.push({ id: randomUUID(), name, shortcut_alias: uniqueAlias(config, name), path: absolute })
    await writeSkillsConfig(config)
    return listSkillSnapshot(projectId)
  })
}

export async function removeExternalSkillDirectory(rootId: string, projectId?: string): Promise<SkillSnapshot> {
  return mutateSkillsConfig(async (config) => {
    const index = config.external_directories.findIndex((directory) => directory.id === rootId)
    if (index < 0) throw new Error('External Skill directory was not found.')
    config.external_directories.splice(index, 1)
    for (const id of Object.keys(config.availability)) if (id.startsWith(`${rootId}:`)) delete config.availability[id]
    await writeSkillsConfig(config)
    return listSkillSnapshot(projectId)
  })
}

export async function updateExternalSkillDirectory(rootId: string, update: SkillRootUpdate, projectId?: string): Promise<SkillSnapshot> {
  const name = normalizeRootDisplayName(update?.name)
  const shortcutAlias = normalizeShortcutAlias(update?.shortcutAlias)
  return mutateSkillsConfig(async (config) => {
    const directory = config.external_directories.find((candidate) => candidate.id === rootId)
    if (!directory) throw new Error('External Skill directory was not found.')
    if (reservedAliases.has(shortcutAlias) || config.external_directories.some((candidate) => candidate.id !== rootId && candidate.shortcut_alias === shortcutAlias)) {
      throw new Error('Skill directory shortcut alias is already in use.')
    }
    directory.name = name
    directory.shortcut_alias = shortcutAlias
    await writeSkillsConfig(config)
    return listSkillSnapshot(projectId)
  })
}

export async function moveExternalSkillDirectory(rootId: string, direction: -1 | 1, projectId?: string): Promise<SkillSnapshot> {
  if (direction !== -1 && direction !== 1) throw new Error('Skill directory move direction is invalid.')
  return mutateSkillsConfig(async (config) => {
    const index = config.external_directories.findIndex((directory) => directory.id === rootId)
    if (index < 0) throw new Error('External Skill directory was not found.')
    const nextIndex = index + direction
    if (nextIndex >= 0 && nextIndex < config.external_directories.length) {
      const [directory] = config.external_directories.splice(index, 1)
      config.external_directories.splice(nextIndex, 0, directory)
      await writeSkillsConfig(config)
    }
    return listSkillSnapshot(projectId)
  })
}

export async function buildUserSkillInvocation(projectId: string | undefined, name: string, sourceAlias: string | undefined, args: string): Promise<SkillInvocationResult> {
  const project = projectId ? await getProject(projectId) : undefined
  const capabilities = resolvePluginCapabilities(project ? project.capabilities : defaultCapabilities, await pluginRuntime().store.list())
  const catalog = await loadCatalog({ agent: { kind: 'main' }, projectId, selection: capabilities.skills })
  const named = catalog.skills.filter((skill) => !skill.summary.loadError && skill.summary.name.toLowerCase() === name.trim().toLowerCase())
  if (!named.length) return { handled: false, promptText: '', displayText: '' }
  const command = `/${name}${sourceAlias ? `@${sourceAlias}` : ''}`
  if (sourceAlias && !catalog.roots.some((root) => root.shortcutAlias === sourceAlias)) {
    return { handled: true, promptText: '', displayText: command, errorCode: 'source_not_found', errorName: name }
  }
  const candidates = sourceAlias ? named.filter((skill) => skill.summary.shortcutAlias === sourceAlias) : named
  if (sourceAlias && candidates.length === 0) {
    return { handled: true, promptText: '', displayText: command, errorCode: 'source_skill_not_found', errorName: name }
  }
  const skill = candidates.find((candidate) => candidate.summary.userAvailable)
  if (!skill) return { handled: true, promptText: '', displayText: command, errorCode: 'user_unavailable', errorName: name }
  const missingTools = skill.summary.requiredTools?.filter(id => !capabilities.pluginTools.includes(id))
  if (missingTools?.length) return { handled: true, promptText: '', displayText: command, errorCode: 'tools_unavailable', errorName: name, missingTools }
  const trimmedArgs = args.trimStart()
  const displayText = `${command}${trimmedArgs ? ` ${trimmedArgs}` : ''}`
  const skillPath = join(skill.summary.dirPath, 'SKILL.md')
  const contents = await readBoundedTextFile(skillPath)
  const parsed = inspectSkillText(contents, skill.summary.name)
  if ('code' in parsed) throw new Error(`Skill ${skill.summary.name} could not be loaded: ${parsed.code}`)
  if (!parsed.body.trim()) throw new Error(`Skill instructions are empty: ${skill.summary.name}`)
  return {
    handled: true,
    displayText,
    promptText: [
      displayText,
      '',
      '<skill>',
      `<name>${skill.summary.name}</name>`,
      `<path>${skillPath}</path>`,
      contents,
      '</skill>',
      ...(skill.summary.requiredTools?.length ? [await pluginToolMapping(skill.summary.requiredTools)] : [])
    ].join('\n')
  }
}

// Filesystem Skill guidance from OpenAI Codex (Apache-2.0); see data/licenses/codex.
const skillsIntro = "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and the absolute path to its `SKILL.md` file."
const skillsUsage = "- Discovery: The list above is the skills available in this session (name + description + absolute path). Skill bodies live on disk at the listed paths.\n- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.\n- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.\n- How to use a skill (progressive disclosure):\n  1) After deciding to use a skill, the main agent must open the listed absolute path and read its `SKILL.md` completely before taking task actions. If a read is truncated or paginated, continue until EOF.\n  2) When `SKILL.md` references relative paths (e.g., `scripts/foo.py`), resolve them relative to the directory containing that `SKILL.md` first, and only consider other paths if needed.\n  3) If `SKILL.md` points to extra folders such as `references/`, use its routing instructions to identify the files required for the task. The main agent must read each required instruction or reference file itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent. Subagents may still perform task work when the selected skill allows it.\n  4) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.\n  5) If `assets/` or templates exist, reuse them instead of recreating from scratch.\n- Coordination and sequencing:\n  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.\n  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.\n- Context hygiene:\n  - Progressive disclosure applies to selecting relevant files, not partially reading a selected instruction file. Do not load unrelated references, scripts, or assets.\n  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.\n  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.\n- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue."

export async function buildSkillsPrompt(request: SkillCatalogRequest): Promise<string> {
  const catalog = await loadCatalog({ ...request, selection: request.selection ?? defaultCapabilities.skills, pluginTools: request.pluginTools ?? [] })
  const winners = catalog.skills.filter((skill) => (
        !skill.summary.loadError
        && skill.summary.modelAvailable
        && !skill.summary.modelShadowedBy
      ))
  if (!catalog.skills.some((skill) => !skill.summary.loadError && (skill.summary.modelAvailable || skill.summary.userAvailable))) return ''
  return [
    '<skills_instructions>',
    '',
    '## Skills',
    skillsIntro,
    '### Available skills',
    ...winners.map(({ summary: skill }) => `- ${skill.name}: ${skill.description} (file: ${join(skill.dirPath, 'SKILL.md')})`),
    ...(winners.some(skill => skill.summary.requiredTools?.length)
      ? ['### Tool names', await pluginToolMapping(winners.flatMap(skill => skill.summary.requiredTools ?? []))] : []),
    '### How to use skills',
    skillsUsage,
    '',
    '</skills_instructions>'
  ].join('\n')
}

export async function saveSkillFile(projectId: string | undefined, skillId: string, relativePath: string, update: import('@shared/packageFiles').PackageFileUpdate): Promise<SkillFilePreview> {
  const { summary } = await findSkill(projectId, skillId)
  if (summary.source === 'system' || summary.source === 'plugin') throw new Error(`${summary.source === 'system' ? 'System' : 'Plugin'} skill files are read-only.`)
  const definitionPath = await realpath(join(summary.dirPath, 'SKILL.md')).catch(reason => {
    if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw reason
  })
  if (definitionPath && update?.resolvedPath === definitionPath) {
    if (typeof update.content !== 'string' || Buffer.byteLength(update.content) > maxPreviewBytes) throw new Error('Invalid Skill content.')
    const parsed = inspectSkillText(update.content, summary.name)
    if ('code' in parsed) throw new Error(`Invalid Skill definition: ${parsed.code}`)
  }
  return { ...await savePackageFile(summary.dirPath, relativePath, update), skillId, editable: true }
}
