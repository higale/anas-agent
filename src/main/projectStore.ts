import { normalizeCompressionPrompt } from '@shared/summaryPrompt'
import type { AgentAccessMode, AgentThread } from '@shared/agentTypes'
import { orderProjectThreads, reorderSidebarItems, type SidebarReorderRequest } from '@shared/sidebarOrder'
import { ProjectOperationFailure } from '@shared/projectOperation'
import { randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { app } from 'electron'
import { renameSync } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { getDefaultWorkspaceDir, getProjectStoreFile } from './config/dataDir'
import { PROJECT_ICON_COLORS, PROJECT_ICON_NAMES } from '@shared/projectAppearance'
import { defaultCapabilities, defaultProjectSettings, defaultRestrictSubagents, parseCapabilities, serializeCapabilities, validateCapabilities } from '@shared/agentCapabilities'
import {
  compareProjects,
  DEFAULT_WORKSPACE_PROJECT_ID,
  type Project,
  type ProjectCreateRequest,
  type ProjectIconColor,
  type ProjectIconName,
  type ProjectModelSelection,
  type ProjectStateUpdate,
  type ProjectUpdateRequest
} from '@shared/types'

interface StoredProjects {
  version: 0
  projects: Project[]
}

interface ProjectDeletionJournal {
  version: 0
  projectId: string
  threadIds: string[]
  previous: ReturnType<typeof serializeProjectStore>
  next: ReturnType<typeof serializeProjectStore>
}

let projectMutationTail: Promise<void> = Promise.resolve()
const projectInitializations = new Map<string, Promise<void>>()
const projectIconNames = new Set<string>(PROJECT_ICON_NAMES)
const projectIconColors = new Set<string>(PROJECT_ICON_COLORS)

function serializeProjectMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = projectMutationTail.then(mutation, mutation)
  projectMutationTail = result.then(() => undefined, () => undefined)
  return result
}

function now(): string {
  return new Date().toISOString()
}

function initialDefaultWorkspaceName(): string {
  const locale = typeof app?.getLocale === 'function' ? app.getLocale() : 'en'
  return locale.toLowerCase().startsWith('zh') ? '默认项目' : 'Default Project'
}

function applyDefaultWorkspaceName(store: StoredProjects): StoredProjects {
  const name = initialDefaultWorkspaceName()
  return { ...store, projects: store.projects.map(project => project.id === DEFAULT_WORKSPACE_PROJECT_ID
    ? { ...project, name }
    : project) }
}

function requireProject(value: unknown, index: number): Project {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Project ${index + 1} has an invalid format.`)
  }
  const project = value as Record<string, unknown>
  if (
    typeof project.id !== 'string' || !project.id.trim()
    || typeof project.name !== 'string' || !project.name.trim()
    || (project.icon !== undefined && (typeof project.icon !== 'string' || !projectIconNames.has(project.icon)))
    || (project.iconColor !== undefined && (typeof project.iconColor !== 'string' || !projectIconColors.has(project.iconColor)))
    || typeof project.pinned !== 'boolean'
    || typeof project.collapsed !== 'boolean'
    || typeof project.createdAt !== 'string' || !Number.isFinite(Date.parse(project.createdAt))
    || typeof project.updatedAt !== 'string' || !Number.isFinite(Date.parse(project.updatedAt))
  ) {
    throw new Error(`Project ${index + 1} has an invalid format.`)
  }
  if (project.kind === 'workspace') {
    if (!Array.isArray(project.sourceFolders) || project.sourceFolders.some((folder) => typeof folder !== 'string' || !folder.trim())) {
      throw new Error(`Project ${index + 1} has an invalid format.`)
    }
  } else if (project.kind === 'simple_chat') {
    if (typeof project.prompt !== 'string') {
      throw new Error(`Project ${index + 1} has an invalid format.`)
    }
  } else {
    throw new Error(`Project ${index + 1} has an invalid format.`)
  }
  const { model_config_id, model_parameter_preset_id, capabilities, restrict_subagents, advanced_settings, coding_mode, compression_prompt, access_mode, sort_order, thread_order, ...metadata } = project
  if (sort_order !== undefined && (typeof sort_order !== 'number' || !Number.isSafeInteger(sort_order))) {
    throw new Error(`Project ${index + 1} has an invalid sort order.`)
  }
  if (thread_order !== undefined && (!Array.isArray(thread_order)
    || thread_order.some((id) => typeof id !== 'string' || !id.trim())
    || new Set(thread_order).size !== thread_order.length)) {
    throw new Error(`Project ${index + 1} has an invalid thread order.`)
  }
  const selection = validateProjectModelSelection({
    modelConfigId: model_config_id,
    modelParameterPresetId: model_parameter_preset_id
  })
  if (project.kind === 'workspace' && typeof restrict_subagents !== 'boolean') throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Invalid project subagent restriction.')
  if (project.kind === 'workspace' && typeof advanced_settings !== 'boolean') throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Invalid project advanced settings.')
  if (project.kind === 'workspace' && typeof coding_mode !== 'boolean') throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Invalid project coding mode.')
  return {
    ...metadata, ...selection,
    ...(sort_order !== undefined ? { sortOrder: sort_order } : {}),
    ...(thread_order !== undefined ? { threadOrder: thread_order } : {}),
    ...(project.kind === 'workspace' ? { accessMode: validateProjectAccessMode(access_mode), capabilities: parseCapabilities(capabilities), restrictSubagents: restrict_subagents, advancedSettings: advanced_settings, codingMode: coding_mode, compressionPrompt: normalizeCompressionPrompt(compression_prompt), prompt: validateProjectPrompt(project.prompt) } : {})
  } as Project
}

export function parseProjectStore(value: unknown): StoredProjects {
  const parsed = value as { version?: unknown; projects?: unknown } | null
  if (!parsed || parsed.version !== 0 || !Array.isArray(parsed.projects)) {
    throw new Error('Project store has an invalid format.')
  }
  const projects = parsed.projects.map(requireProject)
  if (new Set(projects.map((project) => project.id)).size !== projects.length) {
    throw new Error('Project store contains duplicate project IDs.')
  }
  const defaultWorkspace = projects.find((project) => project.id === DEFAULT_WORKSPACE_PROJECT_ID)
  if (!defaultWorkspace || defaultWorkspace.kind !== 'workspace' || defaultWorkspace.pinned) {
    throw new Error('Project store must contain one unpinned default workspace project.')
  }
  return { version: 0, projects }
}

export async function readProjectStoreFile(path: string): Promise<StoredProjects> {
  const content = await readFile(path, 'utf8')
  try {
    return parseProjectStore(JSON.parse(content))
  } catch (cause) {
    throw new Error(`Could not read project file: ${path}\n${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
}

function serializeProjectStore(store: StoredProjects) {
  return {
    version: store.version,
    projects: store.projects.map((project) => {
      const { modelConfigId, modelParameterPresetId, sortOrder, threadOrder, ...metadata } = project
      const stored = { ...metadata } as Record<string, unknown>
      delete stored.capabilities
      delete stored.restrictSubagents
      delete stored.advancedSettings
      delete stored.compressionPrompt
      delete stored.accessMode
      delete stored.codingMode
      return {
        ...stored,
        ...(sortOrder !== undefined ? { sort_order: sortOrder } : {}),
        ...(threadOrder !== undefined ? { thread_order: threadOrder } : {}),
        ...(project.kind === 'workspace' && project.accessMode && project.accessMode !== 'smart_approval'
          ? { access_mode: project.accessMode } : {}),
        ...(project.kind === 'workspace' ? { capabilities: serializeCapabilities(project.capabilities), restrict_subagents: project.restrictSubagents, advanced_settings: project.advancedSettings, coding_mode: project.codingMode, ...(project.compressionPrompt ? { compression_prompt: project.compressionPrompt } : {}) } : {}),
        ...(modelConfigId ? { model_config_id: modelConfigId } : {}),
        ...(modelConfigId && modelParameterPresetId !== undefined
          ? { model_parameter_preset_id: modelParameterPresetId }
          : {})
      }
    })
  }
}

async function readStore(): Promise<StoredProjects> {
  const path = getProjectStoreFile()
  try {
    return applyDefaultWorkspaceName(await readProjectStoreFile(path))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      let pending = projectInitializations.get(path)
      if (!pending) {
        pending = initializeMissingStore(path)
        projectInitializations.set(path, pending)
        void pending.finally(() => { projectInitializations.delete(path) }).catch(() => undefined)
      }
      await pending
      return applyDefaultWorkspaceName(await readProjectStoreFile(path))
    }
    throw error
  }
}

async function initializeMissingStore(path: string): Promise<void> {
  try {
    await readProjectStoreFile(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const timestamp = now()
      const defaultWorkspaceDir = getDefaultWorkspaceDir()
      await mkdir(defaultWorkspaceDir, { recursive: true })
      const store: StoredProjects = {
        version: 0,
        projects: [{
          id: DEFAULT_WORKSPACE_PROJECT_ID,
          kind: 'workspace',
          name: initialDefaultWorkspaceName(),
          pinned: false,
          collapsed: false,
          sourceFolders: [defaultWorkspaceDir],
          ...defaultProjectSettings,
          capabilities: structuredClone(defaultCapabilities),
          restrictSubagents: defaultRestrictSubagents,
          createdAt: timestamp,
          updatedAt: timestamp
        }]
      }
      await writeJsonFileAtomic(path, serializeProjectStore(store))
      return
    }
    throw error
  }
}

async function writeJsonFileAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tempPath = `${path}.${randomUUID()}.tmp`
  await writeFile(tempPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  await rename(tempPath, path)
}

async function writeStore(store: StoredProjects): Promise<void> {
  await writeJsonFileAtomic(getProjectStoreFile(), serializeProjectStore(store))
}

function sortProjects(projects: Project[]): Project[] {
  return [...projects].sort(compareProjects)
}

function placeAtGroupStart(project: Project, projects: Project[]): void {
  const group = sortProjects(projects.filter((item) => item.id !== project.id
    && item.id !== DEFAULT_WORKSPACE_PROJECT_ID && item.kind === project.kind && item.pinned === project.pinned))
  delete project.sortOrder
  const positions = group.flatMap((item) => item.sortOrder === undefined ? [] : [item.sortOrder])
  if (positions.length) {
    project.sortOrder = Math.min(...positions) - 1
    if (!Number.isSafeInteger(project.sortOrder)) throw new Error('Project sort order exceeds the supported range.')
  }
}

export async function reorderSidebar(
  request: SidebarReorderRequest,
  getThreads: () => AgentThread[]
): Promise<Project[]> {
  return serializeProjectMutation(async () => {
    if (!request || !['project', 'thread'].includes(request.kind)
      || typeof request.groupId !== 'string' || !request.groupId
      || typeof request.pinned !== 'boolean' || typeof request.id !== 'string' || !request.id
      || (request.beforeId !== null && (typeof request.beforeId !== 'string' || !request.beforeId))) {
      throw new Error('Sidebar reorder request is invalid.')
    }
    const store = await readStore()
    if (request.kind === 'project') {
      const group = sortProjects(store.projects.filter((project) => project.id !== DEFAULT_WORKSPACE_PROJECT_ID
        && project.kind === request.groupId && project.pinned === request.pinned))
      reorderSidebarItems(group, request).forEach((project, index) => { project.sortOrder = index })
    } else {
      const project = store.projects.find((item) => item.id === request.groupId)
      if (!project) throw new Error('Sidebar project no longer exists.')
      const threads = orderProjectThreads(getThreads().filter((thread) => thread.projectId === project.id), project.threadOrder)
      const group = reorderSidebarItems(threads.filter((thread) => thread.pinned === request.pinned), request)
      const others = threads.filter((thread) => thread.pinned !== request.pinned)
      project.threadOrder = [...group, ...others].map((thread) => thread.id)
    }
    await writeStore(store)
    return sortProjects(store.projects)
  })
}

export async function validateProjectSourceFolders(sourceFolders: string[]): Promise<string[]> {
  if (!Array.isArray(sourceFolders)) throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Source folders must be a list.')
  const folders = Array.from(new Set(
    sourceFolders
      .filter((folder): folder is string => typeof folder === 'string')
      .map((folder) => folder.trim())
      .filter(Boolean)
      .map((folder) => resolve(folder))
  ))
  if (folders.length === 0) throw new ProjectOperationFailure({ code: 'folders_required' }, 'At least one source folder is required.')
  for (const folder of folders) {
    const info = await stat(folder)
    if (!info.isDirectory()) throw new ProjectOperationFailure({ code: 'not_directory', path: folder }, `Source folder is not a directory: ${folder}`)
  }
  return folders
}

function validateProjectName(name: unknown): string {
  if (typeof name !== 'string') throw new ProjectOperationFailure({ code: 'name_required' }, 'Project name is required.')
  const normalized = name.replace(/\s+/g, ' ').trim()
  if (!normalized) throw new ProjectOperationFailure({ code: 'name_required' }, 'Project name is required.')
  if (normalized.length > 80) throw new ProjectOperationFailure({ code: 'name_too_long' }, 'Project name must be 80 characters or fewer.')
  return normalized
}

function validateProjectPrompt(prompt: unknown): string {
  if (typeof prompt !== 'string') throw new ProjectOperationFailure({ code: 'prompt_invalid' }, 'Simple chat prompt is required.')
  const normalized = prompt.trim()
  if (normalized.length > 50_000) throw new ProjectOperationFailure({ code: 'prompt_too_long' }, 'Simple chat prompt must be 50,000 characters or fewer.')
  return normalized
}

function validateProjectModelSelection(request: {
  modelConfigId?: unknown
  modelParameterPresetId?: unknown
}): ProjectModelSelection {
  const { modelConfigId, modelParameterPresetId } = request
  if (modelConfigId !== undefined && (typeof modelConfigId !== 'string' || !modelConfigId.trim())) {
    throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Project model configuration ID is invalid.')
  }
  if (modelParameterPresetId !== undefined && modelParameterPresetId !== null
    && (typeof modelParameterPresetId !== 'string' || !modelParameterPresetId.trim())) {
    throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Project model parameter preset ID is invalid.')
  }
  if (modelParameterPresetId !== undefined && !modelConfigId) {
    throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Project model parameter preset requires a model.')
  }
  return {
    ...(modelConfigId ? { modelConfigId } : {}),
    ...(modelParameterPresetId !== undefined ? { modelParameterPresetId } : {})
  }
}

function validateProjectAppearance(request: ProjectCreateRequest): {
  icon?: ProjectIconName
  iconColor?: ProjectIconColor
} {
  const appearance: { icon?: ProjectIconName; iconColor?: ProjectIconColor } = {}
  if (request.icon !== undefined) {
    if (typeof request.icon !== 'string' || !projectIconNames.has(request.icon)) {
      throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Project icon is invalid.')
    }
    appearance.icon = request.icon
  }
  if (request.iconColor !== undefined) {
    if (typeof request.iconColor !== 'string' || !projectIconColors.has(request.iconColor)) {
      throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Project icon color is invalid.')
    }
    appearance.iconColor = request.iconColor
  }
  return appearance
}

function validateProjectAccessMode(value: unknown): AgentAccessMode {
  if (value === undefined) return 'smart_approval'
  if (value === 'strict_approval' || value === 'smart_approval' || value === 'full_access') return value
  throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Invalid project tool access mode.')
}

function projectCapabilities(request: Extract<ProjectCreateRequest, { kind: 'workspace' }>) {
  if (typeof request.restrictSubagents !== 'boolean') throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Invalid project subagent restriction.')
  if (typeof request.advancedSettings !== 'boolean') throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Invalid project advanced settings.')
  if (typeof request.codingMode !== 'boolean') throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Invalid project coding mode.')
  let capabilities
  try {
    capabilities = validateCapabilities(request.capabilities)
  } catch {
    throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Invalid capability settings.')
  }
  return { accessMode: validateProjectAccessMode(request.accessMode), compressionPrompt: normalizeCompressionPrompt(request.compressionPrompt), capabilities, restrictSubagents: request.restrictSubagents, advancedSettings: request.advancedSettings, codingMode: request.codingMode, prompt: validateProjectPrompt(request.prompt) }
}

function hasDuplicateName(projects: Project[], name: string, excludedProjectId?: string): boolean {
  return projects.some((project) =>
    project.id !== excludedProjectId
    && project.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0
  )
}

export async function listProjects(): Promise<Project[]> {
  await projectMutationTail
  return sortProjects((await readStore()).projects)
}

export async function getProject(projectId: string): Promise<Project> {
  if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('Project id is required.')
  await projectMutationTail
  const project = (await readStore()).projects.find((item) => item.id === projectId)
  if (!project) throw new Error(`Project ${projectId} was not found.`)
  return project
}

export async function prepareProjectPreview(request: ProjectCreateRequest, projectId = 'project-preview'): Promise<Project> {
  if (!request || (request.kind !== 'workspace' && request.kind !== 'simple_chat')) {
    throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Project request is invalid.')
  }
  const timestamp = now()
  if (projectId === DEFAULT_WORKSPACE_PROJECT_ID && request.kind !== 'workspace') {
    throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'The default project must be a workspace.')
  }
  const common = {
    id: projectId,
    name: projectId === DEFAULT_WORKSPACE_PROJECT_ID ? initialDefaultWorkspaceName() : validateProjectName(request.name),
    ...validateProjectModelSelection(request),
    pinned: false,
    collapsed: false,
    createdAt: timestamp,
    updatedAt: timestamp
  }
  return request.kind === 'workspace'
    ? { ...common, kind: 'workspace', sourceFolders: await validateProjectSourceFolders(request.sourceFolders), ...projectCapabilities(request) }
    : { ...common, kind: 'simple_chat', prompt: validateProjectPrompt(request.prompt) }
}

export async function createProject(request: ProjectCreateRequest): Promise<Project> {
  return serializeProjectMutation(async () => {
    if (!request || typeof request.name !== 'string' || (request.kind !== 'workspace' && request.kind !== 'simple_chat')) {
      throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Project request is invalid.')
    }
    const name = validateProjectName(request.name)
    const store = await readStore()
    if (hasDuplicateName(store.projects, name)) {
      throw new ProjectOperationFailure({ code: 'duplicate_name', name }, `A project named "${name}" already exists.`)
    }
    const timestamp = now()
    const appearance = validateProjectAppearance(request)
    const common = {
      id: randomUUID(),
      name,
      ...appearance,
      ...validateProjectModelSelection(request),
      pinned: false,
      collapsed: false,
      createdAt: timestamp,
      updatedAt: timestamp
    }
    const project: Project = request.kind === 'workspace'
      ? { ...common, kind: 'workspace', sourceFolders: await validateProjectSourceFolders(request.sourceFolders), ...projectCapabilities(request) }
      : { ...common, kind: 'simple_chat', prompt: validateProjectPrompt(request.prompt) }
    placeAtGroupStart(project, store.projects)
    store.projects = sortProjects([project, ...store.projects])
    await writeStore(store)
    return project
  })
}

export async function updateProject(projectId: string, request: ProjectUpdateRequest): Promise<Project> {
  return serializeProjectMutation(async () => {
    if (
      typeof projectId !== 'string' || !projectId.trim() || !request
      || (request.kind !== 'workspace' && request.kind !== 'simple_chat')
    ) {
      throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Project update request is invalid.')
    }
    const name = validateProjectName(request.name)
    const store = await readStore()
    const current = store.projects.find((project) => project.id === projectId)
    if (!current) throw new ProjectOperationFailure({ code: 'not_found' }, 'Project was not found.')
    if (current.kind !== request.kind) throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'Project kind cannot be changed.')
    if (projectId === DEFAULT_WORKSPACE_PROJECT_ID && name !== current.name) {
      throw new ProjectOperationFailure({ code: 'invalid_settings' }, 'The default project name cannot be changed.')
    }
    if (name !== current.name && hasDuplicateName(store.projects, name, projectId)) {
      throw new ProjectOperationFailure({ code: 'duplicate_name', name }, `A project named "${name}" already exists.`)
    }
    const appearance = validateProjectAppearance(request)
    const currentMetadata = { ...current }
    delete currentMetadata.icon
    delete currentMetadata.iconColor
    delete currentMetadata.modelConfigId
    delete currentMetadata.modelParameterPresetId
    const modelSelection = validateProjectModelSelection(request)
    const updatedAt = now()
    const project: Project = request.kind === 'workspace'
      ? {
          ...currentMetadata,
          ...appearance,
          ...modelSelection,
          kind: 'workspace',
          name,
          sourceFolders: await validateProjectSourceFolders(request.sourceFolders),
          ...projectCapabilities(request),
          updatedAt
        }
      : {
          ...currentMetadata,
          ...appearance,
          ...modelSelection,
          kind: 'simple_chat',
          name,
          prompt: validateProjectPrompt(request.prompt),
          updatedAt
        }
    store.projects = sortProjects(store.projects.map((item) => item.id === projectId ? project : item))
    await writeStore(store)
    return project
  })
}

export async function updateProjectState(projectId: string, update: ProjectStateUpdate): Promise<Project> {
  return serializeProjectMutation(async () => {
    if (!update || typeof update !== 'object' || Array.isArray(update)) {
      throw new Error('Project state update is invalid.')
    }
    const hasPinned = Object.prototype.hasOwnProperty.call(update, 'pinned')
    const hasCollapsed = Object.prototype.hasOwnProperty.call(update, 'collapsed')
    if (
      typeof projectId !== 'string' || !projectId.trim()
      || (!hasPinned && !hasCollapsed)
      || (hasPinned && typeof update.pinned !== 'boolean')
      || (hasCollapsed && typeof update.collapsed !== 'boolean')
    ) {
      throw new Error('Project state update is invalid.')
    }
    if (projectId === DEFAULT_WORKSPACE_PROJECT_ID && hasPinned) {
      throw new Error('The default workspace project has a fixed position and cannot be pinned.')
    }
    const store = await readStore()
    const current = store.projects.find((project) => project.id === projectId)
    if (!current) throw new ProjectOperationFailure({ code: 'not_found' }, 'Project was not found.')
    const project: Project = {
      ...current,
      pinned: update.pinned ?? current.pinned,
      collapsed: update.collapsed ?? current.collapsed
    }
    if (project.pinned === current.pinned && project.collapsed === current.collapsed) return current
    if (project.pinned !== current.pinned) placeAtGroupStart(project, store.projects)
    store.projects = sortProjects(store.projects.map((item) => item.id === projectId ? project : item))
    await writeStore(store)
    return project
  })
}

function projectDeletionJournalPath(): string {
  return join(dirname(getProjectStoreFile()), 'project-deletion.json')
}

function projectDeletionStagePath(): string {
  return join(dirname(getProjectStoreFile()), 'project-deletion.stage.json')
}

export async function recoverProjectDeletion(
  threadExists: (threadId: string) => boolean,
  completeDatabaseCommit: (projectId: string) => void
): Promise<boolean> {
  return serializeProjectMutation(async () => {
    const storePath = getProjectStoreFile()
    const journalPath = join(dirname(storePath), 'project-deletion.json'), stagePath = join(dirname(storePath), 'project-deletion.stage.json')
    let journal: ProjectDeletionJournal
    try {
      journal = JSON.parse(await readFile(journalPath, 'utf8')) as ProjectDeletionJournal
    } catch (reason) {
      if ((reason as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw reason
    }
    if (
      journal.version !== 0
      || typeof journal.projectId !== 'string' || !journal.projectId.trim() || journal.projectId === DEFAULT_WORKSPACE_PROJECT_ID
      || !Array.isArray(journal.threadIds)
      || journal.threadIds.some((id) => typeof id !== 'string' || !id.trim())
      || new Set(journal.threadIds).size !== journal.threadIds.length
    ) throw new Error('Project deletion journal has an invalid format.')
    // Validate both outcomes before any database cleanup.
    const previous = parseProjectStore(journal.previous), next = parseProjectStore(journal.next)
    if (!previous.projects.some(project => project.id === journal.projectId)
      || !isDeepStrictEqual(serializeProjectStore(next), serializeProjectStore({ ...previous,
        projects: previous.projects.filter(project => project.id !== journal.projectId) }))) throw new Error('Project deletion journal changes unrelated project settings.')
    const current = await readStore()
    const databaseCommitted = journal.threadIds.length > 0
      ? journal.threadIds.every((threadId) => !threadExists(threadId))
      : !current.projects.some((project) => project.id === journal.projectId)
    if (databaseCommitted) completeDatabaseCommit(journal.projectId)
    await writeJsonFileAtomic(storePath, serializeProjectStore(databaseCommitted ? next : previous))
    await Promise.all([
      rm(journalPath, { force: true }),
      rm(stagePath, { force: true })
    ])
    return true
  })
}

export async function deleteProjectWithThreads<T>(
  projectId: string,
  threadIds: string[],
  commitDatabase: (commitProjectStore: () => void) => T
): Promise<T> {
  return serializeProjectMutation(async () => {
    if (typeof projectId !== 'string' || !projectId.trim()) throw new Error('Project id is required.')
    if (projectId === DEFAULT_WORKSPACE_PROJECT_ID) {
      throw new Error('The default workspace project cannot be deleted.')
    }
    const store = await readStore()
    if (!store.projects.some((project) => project.id === projectId)) {
      throw new ProjectOperationFailure({ code: 'not_found' }, 'Project was not found.')
    }

    const next: StoredProjects = {
      version: 0,
      projects: store.projects.filter((project) => project.id !== projectId)
    }
    const journal: ProjectDeletionJournal = {
      version: 0,
      projectId,
      threadIds: [...threadIds],
      previous: serializeProjectStore(store),
      next: serializeProjectStore(next)
    }
    const storePath = getProjectStoreFile()
    await mkdir(dirname(projectDeletionStagePath()), { recursive: true })
    await writeFile(projectDeletionStagePath(), `${JSON.stringify(journal.next, null, 2)}\n`, 'utf8')
    await writeJsonFileAtomic(projectDeletionJournalPath(), journal)
    let storeCommitted = false
    let result: T
    try {
      result = commitDatabase(() => {
        renameSync(projectDeletionStagePath(), storePath)
        storeCommitted = true
      })
    } catch (reason) {
      if (storeCommitted) await writeStore(store)
      await Promise.all([
        rm(projectDeletionJournalPath(), { force: true }),
        rm(projectDeletionStagePath(), { force: true })
      ])
      throw reason
    }
    await rm(projectDeletionJournalPath(), { force: true }).catch(() => undefined)
    return result
  })
}
