import { defaultCapabilities } from '@shared/agentCapabilities'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_WORKSPACE_PROJECT_ID, type Project, type ProjectCreateRequest } from '@shared/types'
import { serializeCapabilities } from '@shared/agentCapabilities'

function storedProjectJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (!item || !item.capabilities) return item
    const { restrictSubagents, capabilities, codingMode, ...metadata } = item
    return { ...metadata, restrict_subagents: restrictSubagents, coding_mode: codingMode, capabilities: serializeCapabilities(capabilities) }
  })
}

const storePaths = vi.hoisted(() => ({
  projectFile: ''
}))

vi.mock('./config/appConfig', () => ({ getAppSettings: async () => ({ language: 'zh-CN', projectDefaultDirectory: '' }) }))
vi.mock('./languageStore', () => ({ getConfiguredTranslator: async () => () => '未命名项目' }))

vi.mock('./config/dataDir', () => ({
  getAgentCatalogFile: () => join(tempDir, 'db', 'catalog.sqlite'),
  getProjectStoreFile: () => storePaths.projectFile
}))

async function readSnapshot(): Promise<string> {
  const root = join(tempDir, 'db/projects')
  const state = JSON.parse(await readFile(storePaths.projectFile, 'utf8'))
  const { readdir } = await import('node:fs/promises')
  const projects = []
  for (const entry of await readdir(root, { withFileTypes: true })) if (entry.isDirectory()) {
    const document = JSON.parse(await readFile(join(root, entry.name, 'project.json'), 'utf8'))
    projects.push({ ...document.project, ...state.projects.find((item: { id: string }) => item.id === entry.name) })
  }
  return JSON.stringify({ version: 0, projects })
}
async function writeSnapshot(content: string, _encoding?: string): Promise<void> {
  const value = JSON.parse(content)
  const states = []
  const { readdir } = await import('node:fs/promises')
  for (const entry of await readdir(join(tempDir, 'db/projects'), { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && !value.projects.some((project: { id: string }) => project.id === entry.name)) await rm(join(tempDir, 'db/projects', entry.name), { recursive: true })
  }
  for (const project of value.projects) {
    const { pinned, collapsed, sort_order, thread_order, ...definition } = project
    const root = join(tempDir, 'db/projects', project.id)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'project.json'), JSON.stringify({ version: 0, project: definition }))
    states.push({ id: project.id, pinned, collapsed, sort_order, thread_order })
  }
  await writeFile(storePaths.projectFile, JSON.stringify({ version: value.version, storage_layout: 'project-directories', projects: states }))
}

let tempDir = ''

function projectSettings() {
  return { sourceFolders: [tempDir], capabilities: structuredClone(defaultCapabilities), codingMode: false, restrictSubagents: false }
}

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'anas-project-store-'))
  storePaths.projectFile = join(tempDir, 'db/projects/state.json')
  await mkdir(join(tempDir, 'db'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

describe('project store', () => {
  it('keeps empty folders on create, edit and unrelated saves and numbers blank names atomically', async () => {
    const store = await import('./projectStore')
    const request = { ...projectSettings(), name: '', sourceFolders: [], prompt: '' }
    await store.createProject({ ...request, name: '未命名项目1' })
    const [second, third] = await Promise.all([store.createProject(request), store.createProject({ ...request, name: '  ' })])
    expect([second.name, third.name]).toEqual(['未命名项目2', '未命名项目3'])
    expect(second.sourceFolders).toEqual([])
    const preview = await store.prepareProjectPreview(request)
    expect(preview).toMatchObject({ name: '未命名项目4', sourceFolders: [] })
    expect((await store.listProjects()).some(project => project.name === preview.name)).toBe(false)
    const updated = await store.updateProject(third.id, request)
    expect(updated).toMatchObject({ name: '未命名项目3', sourceFolders: [] })
    await store.updateProject(second.id, { ...second, sourceFolders: [tempDir] })
    await store.updateProject(second.id, request)
    await store.updateProjectState(second.id, { pinned: true })
    expect((await store.listProjects()).every(project => project.sourceFolders.length === 0)).toBe(true)
    expect(JSON.parse(await readSnapshot()).projects.every((project: Project) => project.sourceFolders.length === 0)).toBe(true)
  })
  it.each([undefined, 'workspace', 'simple_chat'])('reads v0 projects with missing settings independently of kind %s without rewriting files', async kind => {
    const store = await import('./projectStore')
    await store.listProjects()
    const snapshot = JSON.parse(await readSnapshot())
    const original = {
      id: 'retained-project', name: 'Retained project', ...(kind === undefined ? {} : { kind }),
      prompt: 'Keep my instructions', icon: 'message-circle', iconColor: 'blue',
      pinned: true, collapsed: true, sort_order: 0, thread_order: ['retained-thread'],
      model_config_id: 'unavailable-model', model_parameter_preset_id: null,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z'
    }
    snapshot.projects.push(original)
    await writeSnapshot(JSON.stringify(snapshot))
    const directory = join(tempDir, 'db/projects', original.id)
    const definition = join(directory, 'project.json')
    const conversation = join(directory, 'conversations/retained-thread/retained.txt')
    await mkdir(join(directory, 'conversations/retained-thread'), { recursive: true })
    await writeFile(conversation, 'Existing conversation data')
    const before = await readFile(definition, 'utf8')
    const stateBefore = await readFile(storePaths.projectFile, 'utf8')

    const loaded = await store.getProject(original.id)
    expect(loaded).toMatchObject({
      id: original.id, name: original.name, prompt: original.prompt, icon: original.icon, iconColor: original.iconColor,
      pinned: true, collapsed: true, sortOrder: 0, threadOrder: ['retained-thread'],
      modelConfigId: 'unavailable-model', modelParameterPresetId: null,
      createdAt: original.createdAt, updatedAt: original.updatedAt,
      sourceFolders: [], skillDirectories: [], toolDirectories: [],
      codingMode: false, restrictSubagents: false, accessMode: 'smart_approval', capabilities: defaultCapabilities
    })
    expect(loaded).not.toHaveProperty('kind')
    expect(await readFile(definition, 'utf8')).toBe(before)
    expect(await readFile(storePaths.projectFile, 'utf8')).toBe(stateBefore)

    const updated = await store.updateProject(loaded.id, { ...loaded, capabilities: { ...loaded.capabilities, memory: false } })
    expect(await store.getProject(loaded.id)).toEqual(updated)
    expect(updated).toMatchObject({ id: original.id, threadOrder: ['retained-thread'], capabilities: { memory: false } })
    const saved = JSON.parse(await readFile(definition, 'utf8'))
    expect(saved.version).toBe(0)
    expect(saved.project).not.toHaveProperty('kind')
    expect(saved.project).toMatchObject({ model_config_id: 'unavailable-model', model_parameter_preset_id: null })
    expect(await readFile(conversation, 'utf8')).toBe('Existing conversation data')
  })

  it('preserves explicit empty selections and false settings, and rejects malformed optional settings', async () => {
    const store = await import('./projectStore')
    await store.listProjects()
    const snapshot = JSON.parse(await readSnapshot())
    const project = snapshot.projects[0]
    Object.assign(project, { sourceFolders: [], coding_mode: false, restrict_subagents: false,
      prompt: '', skill_directories: [], tool_directories: [], capabilities: {
        ...project.capabilities, memory: false, tool_mode: 'selected', tools: []
      } })
    expect(store.parseProjectStore(snapshot).projects[0]).toMatchObject({ sourceFolders: [], codingMode: false,
      restrictSubagents: false, prompt: '', skillDirectories: [], toolDirectories: [],
      capabilities: { memory: false, toolMode: 'selected', tools: [] } })
    for (const field of ['sourceFolders', 'coding_mode', 'restrict_subagents', 'capabilities', 'prompt']) {
      expect(() => store.parseProjectStore({ ...snapshot, projects: [{ ...project, [field]: null }] })).toThrow()
    }
  })

  it('defaults missing bundled Python capability without rewriting v0 and saves each project independently', async () => {
    const store = await import('./projectStore')
    const request = { name: 'Python', sourceFolders: [tempDir],
      codingMode: false, prompt: '', capabilities: structuredClone(defaultCapabilities), restrictSubagents: false }
    const first = await store.createProject(request)
    const second = await store.createProject({ ...request, name: 'System Python' })
    const raw = JSON.parse(await readSnapshot())
    delete raw.projects.find((project: Project) => project.id === first.id).capabilities.bundled_python
    await writeSnapshot(JSON.stringify(raw))
    const before = await readSnapshot()
    expect(await store.getProject(first.id)).toMatchObject({ capabilities: { bundledPython: true } })
    expect(await readSnapshot()).toBe(before)
    await store.updateProject(second.id, { ...request, name: second.name, capabilities: { ...request.capabilities, bundledPython: false } })
    expect(await store.getProject(second.id)).toMatchObject({ capabilities: { bundledPython: false } })
    expect(await store.getProject(first.id)).toMatchObject({ capabilities: { bundledPython: true } })
    const saved = JSON.parse(await readSnapshot())
    expect(saved.version).toBe(0)
    const capabilities = saved.projects.find((project: Project) => project.id === second.id).capabilities
    expect(capabilities.bundled_python).toBe(false)
    expect(capabilities).not.toHaveProperty('bundledPython')
  })

  it.each(['skill', 'tool'] as const)('defaults optional %s roots, persists them in v0, and retains offline references without touching their files', async kind => {
    const field = kind === 'skill' ? 'skillDirectories' : 'toolDirectories'
    const storedField = `${kind}_directories`
    const store = await import('./projectStore')
    const request = { name: 'Skills', sourceFolders: [tempDir],
      codingMode: false, prompt: '', capabilities: structuredClone(defaultCapabilities), restrictSubagents: false }
    const project = await store.createProject(request)
    const raw = JSON.parse(await readSnapshot())
    const saved = raw.projects.find((p: Project) => p.id === project.id)
    delete saved[storedField]
    await writeSnapshot(JSON.stringify(raw))
    const before = await readSnapshot()
    expect(await store.getProject(project.id)).toMatchObject({ [field]: [] })
    expect(await readSnapshot()).toBe(before)

    const directory = join(tempDir, 'custom-skills')
    const missing = join(tempDir, 'offline-skills')
    await mkdir(directory)
    await writeFile(join(directory, 'retained.txt'), 'Keep this file')
    const draft = { ...request, [field]: [directory, directory, missing] }
    expect(await store.prepareProjectPreview(draft)).toMatchObject({ [field]: [directory, missing] })
    expect(await store.getProject(project.id)).toMatchObject({ [field]: [] })
    await store.updateProject(project.id, draft)
    expect(await store.getProject(project.id)).toMatchObject({ [field]: [directory, missing], sourceFolders: [tempDir] })
    const updated = JSON.parse(await readSnapshot())
    expect(updated.version).toBe(0)
    expect(updated.projects.find((p: Project) => p.id === project.id)).toMatchObject({ [storedField]: [directory, missing] })
    expect(updated.projects.find((p: Project) => p.id === project.id)).not.toHaveProperty(field)
    await expect(store.updateProject(project.id, { ...request, [field]: ['relative'] })).rejects.toThrow('absolute')
    await store.updateProject(project.id, { ...request, [field]: [] })
    expect(await store.getProject(project.id)).toMatchObject({ [field]: [] })
    expect(await readFile(join(directory, 'retained.txt'), 'utf8')).toBe('Keep this file')
  })

  it.each(['.DS_Store', '._state.json', '.localized', 'Thumbs.db', 'desktop.ini', '.directory'])('ignores desktop metadata %s without changing it during initialization or reads', async name => {
    const store = await import('./projectStore')
    await mkdir(join(tempDir, 'db/projects'))
    const metadata = join(tempDir, 'db/projects', name)
    await writeFile(metadata, 'Desktop metadata')
    expect(await store.listProjects()).toMatchObject([{ id: DEFAULT_WORKSPACE_PROJECT_ID }])
    const project = await store.createProject({ ...projectSettings(), name: 'Retained', prompt: 'Keep this prompt' })
    expect(await store.getProject(project.id)).toMatchObject({ prompt: 'Keep this prompt' })
    expect(await readFile(metadata, 'utf8')).toBe('Desktop metadata')
  })

  it.each(['personal notes', '.cache', 'unrelated', 'notes.txt'])('ignores unrelated directory %s and preserves its contents', async name => {
    const store = await import('./projectStore')
    const path = join(tempDir, 'db/projects', name, 'conversations')
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'notes.txt'), 'User notes')
    expect(await store.listProjects()).toMatchObject([{ id: DEFAULT_WORKSPACE_PROJECT_ID }])
    expect(await readFile(join(path, 'notes.txt'), 'utf8')).toBe('User notes')
  })

  it('separates definitions from UI state and defaults missing state without rewriting definitions', async () => {
    const store = await import('./projectStore')
    const project = await store.createProject({ ...projectSettings(), name: 'Separate', prompt: 'Keep this prompt' })
    const path = join(tempDir, 'db/projects', project.id, 'project.json')
    const before = await readFile(path, 'utf8')
    expect(JSON.parse(before).project).not.toHaveProperty('pinned')
    await store.updateProjectState(project.id, { pinned: true, collapsed: true })
    expect(await readFile(path, 'utf8')).toBe(before)
    const state = JSON.parse(await readFile(storePaths.projectFile, 'utf8'))
    expect(state.projects.find((item: { id: string }) => item.id === project.id)).not.toHaveProperty('prompt')
    await rm(storePaths.projectFile)
    expect(await store.getProject(project.id)).toMatchObject({ pinned: false, collapsed: false, prompt: 'Keep this prompt' })
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('initializes current projects without reading or changing previous-layout files', async () => {
    const store = await import('./projectStore')
    const previous = join(tempDir, 'db/projects.json')
    await writeFile(previous, 'preserve these bytes')
    await mkdir(join(tempDir, 'db/conversations/old'), { recursive: true })
    await writeFile(join(tempDir, 'db/conversations/old/conversation.sqlite'), 'unreadable old database')
    expect(await store.listProjects()).toMatchObject([{ id: DEFAULT_WORKSPACE_PROJECT_ID }])
    const project = await store.createProject({ ...projectSettings(), name: 'New project', prompt: '' })
    expect(await store.getProject(project.id)).toMatchObject({ name: 'New project' })
    expect(await readFile(previous, 'utf8')).toBe('preserve these bytes')
    expect(await readFile(join(tempDir, 'db/conversations/old/conversation.sqlite'), 'utf8')).toBe('unreadable old database')
  })

  it('refuses incomplete current directories without creating replacement data', async () => {
    const store = await import('./projectStore')
    await mkdir(join(tempDir, 'db/projects/incomplete/conversations/retained'), { recursive: true })
    await writeFile(join(tempDir, 'db/projects/incomplete/conversations/retained/conversation.sqlite'), 'Retained database')
    await expect(store.listProjects()).rejects.toThrow('definition is missing')
    await expect(readFile(storePaths.projectFile)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('completes a journaled project write after interrupted publication', async () => {
    const store = await import('./projectStore')
    const project = await store.createProject({ ...projectSettings(), name: 'Before', prompt: 'Keep' })
    const next = JSON.parse(await readSnapshot())
    next.projects.find((item: { id: string }) => item.id === project.id).name = 'After'
    await writeFile(join(tempDir, 'db/project-write.json'), JSON.stringify({ version: 0, next, removed: [] }))
    expect(await store.getProject(project.id)).toMatchObject({ name: 'After', prompt: 'Keep' })
    await expect(readFile(join(tempDir, 'db/project-write.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('persists group order independently of updates, preserves it on editing, and puts new projects first', async () => {
    const store = await import('./projectStore')
    const a = await store.createProject({ ...projectSettings(), name: 'A', prompt: '' })
    const b = await store.createProject({ ...projectSettings(), name: 'B', prompt: '' })
    expect(a.sortOrder).toBeUndefined()
    const request = { kind: 'project' as const, groupId: 'projects', pinned: false, id: a.id, beforeId: b.id }
    await store.reorderSidebar(request, () => [])
    await store.updateProject(b.id, { ...projectSettings(), name: 'Edited B', prompt: '' })
    expect((await store.listProjects()).map(p => p.id)).toEqual([a.id, b.id, DEFAULT_WORKSPACE_PROJECT_ID])
    const c = await store.createProject({ ...projectSettings(), name: 'C', prompt: '' })
    expect((await store.listProjects()).map(p => p.id)).toEqual([c.id, a.id, b.id, DEFAULT_WORKSPACE_PROJECT_ID])
    await store.updateProjectState(b.id, { pinned: true })
    const before = await readSnapshot()
    await expect(store.reorderSidebar(request, () => [])).rejects.toThrow('target changed')
    await expect(store.reorderSidebar({ ...request, id: DEFAULT_WORKSPACE_PROJECT_ID, beforeId: null }, () => [])).rejects.toThrow()
    await expect(store.reorderSidebar({ ...request, groupId: 'workspace' }, () => [])).rejects.toThrow()
    expect(JSON.parse(await readSnapshot())).toEqual(JSON.parse(before))
    const raw = JSON.parse(before)
    expect(raw.version).toBe(0)
    expect(raw.projects.find((p: Project) => p.id === a.id)).toHaveProperty('sort_order', 0)
    expect(raw.projects.find((p: Project) => p.id === a.id)).not.toHaveProperty('sortOrder')
    expect((await store.getProject(a.id)).updatedAt).toBe(a.updatedAt)
  })

  it('persists one pinned order and returns unpinned projects to the project group', async () => {
    const store = await import('./projectStore')
    const defaults = await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)
    const workspace = await store.createProject({ ...defaults, name: 'Workspace' })
    const chat = await store.createProject({ ...projectSettings(), name: 'Chat', prompt: '' })
    const otherChat = await store.createProject({ ...projectSettings(), name: 'Other chat', prompt: '' })
    await store.updateProjectState(workspace.id, { pinned: true })
    await store.updateProjectState(chat.id, { pinned: true })
    const request = { kind: 'project' as const, groupId: 'pinned', pinned: true, id: chat.id, beforeId: workspace.id }
    await store.reorderSidebar(request, () => [])
    expect((await store.listProjects()).filter(project => project.pinned).map(project => project.id)).toEqual([chat.id, workspace.id])
    await store.updateProjectState(otherChat.id, { pinned: true })
    expect((await store.listProjects()).filter(project => project.pinned).map(project => project.id)).toEqual([otherChat.id, chat.id, workspace.id])
    await store.reorderSidebar({ ...request, id: workspace.id, beforeId: chat.id }, () => [])
    expect((await store.listProjects()).filter(project => project.pinned).map(project => project.id)).toEqual([otherChat.id, workspace.id, chat.id])
    await store.updateProjectState(chat.id, { pinned: false })
    const before = await readSnapshot()
    await expect(store.reorderSidebar(request, () => [])).rejects.toThrow('target changed')
    expect(JSON.parse(await readSnapshot())).toEqual(JSON.parse(before))
    await store.updateProjectState(otherChat.id, { pinned: false })
    await store.reorderSidebar({ ...request, groupId: 'projects', pinned: false, id: chat.id, beforeId: otherChat.id }, () => [])
    expect((await store.listProjects()).map(project => project.id)).toEqual([workspace.id, chat.id, otherChat.id, DEFAULT_WORKSPACE_PROJECT_ID])
  })

  it('prepends a new pin to mixed ordering without changing the existing relative order', async () => {
    const store = await import('./projectStore')
    const defaults = await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)
    const a = await store.createProject({ ...defaults, name: 'Ordered A' })
    const b = await store.createProject({ ...defaults, name: 'Ordered B' })
    const c = await store.createProject({ ...projectSettings(), name: 'Automatic C', prompt: '' })
    const d = await store.createProject({ ...defaults, name: 'New pin D' })
    const previous = JSON.parse(await readSnapshot())
    for (const [id, sortOrder] of [[a.id, 0], [b.id, 1], [c.id, undefined]] as const) {
      const project = previous.projects.find((item: Project) => item.id === id)
      project.pinned = true
      if (sortOrder === undefined) delete project.sort_order
      else project.sort_order = sortOrder
    }
    await writeSnapshot(JSON.stringify(previous))
    const pinnedIds = async () => (await store.listProjects()).filter(project => project.pinned).map(project => project.id)
    expect(await pinnedIds()).toEqual([c.id, a.id, b.id])

    await store.updateProjectState(d.id, { pinned: true })

    expect(await pinnedIds()).toEqual([d.id, c.id, a.id, b.id])
    // Editing a formerly automatic member must retain the normalized order.
    await store.updateProject(c.id, { ...projectSettings(), name: 'Renamed C', prompt: '' })
    expect(await pinnedIds()).toEqual([d.id, c.id, a.id, b.id])
    expect(await store.getProject(a.id)).toMatchObject({ updatedAt: a.updatedAt, collapsed: a.collapsed })
    expect(await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)).toEqual(defaults)
  })

  it('saves default project conversation order and rejects cross-project, cross-pin and deleted targets without writing', async () => {
    const store = await import('./projectStore')
    const project = await store.createProject({ ...projectSettings(), name: 'Other', prompt: '' })
    const makeThread = (id: string, projectId = DEFAULT_WORKSPACE_PROJECT_ID, pinned = false): import('@shared/agentTypes').AgentThread => ({
      id, projectId, pinned, title: id, accessMode: 'full_access', status: 'idle', userTurnCount: 0,
      createdAt: '2026-10-01', updatedAt: '2026-10-01'
    })
    const threads = [makeThread('a'), makeThread('b'), makeThread('pin', DEFAULT_WORKSPACE_PROJECT_ID, true), makeThread('other', project.id)]
    const request = { kind: 'thread' as const, groupId: DEFAULT_WORKSPACE_PROJECT_ID, pinned: false, id: 'b', beforeId: 'a' }
    await store.reorderSidebar(request, () => threads)
    expect((await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)).threadOrder).toEqual(['b', 'a', 'pin'])
    const before = await readSnapshot()
    for (const beforeId of ['other', 'pin', 'deleted']) {
      await expect(store.reorderSidebar({ ...request, beforeId }, () => threads)).rejects.toThrow('target changed')
    }
    expect(JSON.parse(await readSnapshot())).toEqual(JSON.parse(before))
    const raw = JSON.parse(before)
    expect(raw.projects.find((p: Project) => p.id === DEFAULT_WORKSPACE_PROJECT_ID).thread_order).toEqual(['b', 'a', 'pin'])
    raw.projects.find((p: Project) => p.id === DEFAULT_WORKSPACE_PROJECT_ID).thread_order = []
    expect(store.parseProjectStore(raw).projects.find(p => p.id === DEFAULT_WORKSPACE_PROJECT_ID)?.threadOrder).toEqual([])
    raw.projects[0].sort_order = 0.5
    expect(() => store.parseProjectStore(raw)).toThrow('sort order')
  })

  it('defaults missing v0 tool permissions to read-only and persists explicit choices without a format upgrade', async () => {
    const store = await import('./projectStore')
    const request = { name: 'Permissions', sourceFolders: [tempDir],
      codingMode: false, prompt: '', capabilities: structuredClone(defaultCapabilities), restrictSubagents: false }
    const project = await store.createProject(request)
    const original = await readSnapshot()
    expect(JSON.parse(original).projects.find((p: Project) => p.id === project.id)).not.toHaveProperty('access_mode')
    expect(await store.getProject(project.id)).toMatchObject({ accessMode: 'smart_approval' })
    expect(await readSnapshot()).toBe(original)
    for (const accessMode of ['strict_approval', 'full_access', 'smart_approval'] as const) {
      await store.updateProject(project.id, { ...request, accessMode })
      expect(await store.getProject(project.id)).toMatchObject({ accessMode, })
      const raw = JSON.parse(await readSnapshot())
      expect(raw.version).toBe(0)
      const saved = raw.projects.find((p: Project) => p.id === project.id)
      expect(saved.access_mode ?? 'smart_approval').toBe(accessMode)
      expect(saved).not.toHaveProperty('accessMode')
      expect(await store.prepareProjectPreview({ ...request, accessMode })).toMatchObject({ accessMode })
    }
    const beforeInvalid = await readSnapshot()
    await expect(store.updateProject(project.id, { ...request, accessMode: 'unknown' } as unknown as ProjectCreateRequest))
      .rejects.toThrow('Invalid project tool access mode')
    expect(await readSnapshot()).toBe(beforeInvalid)
    const invalid = JSON.parse(beforeInvalid)
    invalid.projects.find((p: Project) => p.id === project.id).access_mode = 'unknown'
    expect(() => store.parseProjectStore(invalid)).toThrow('Invalid project tool access mode')
  })

  it('loads existing v0 projects without compression settings and saves or clears a custom prompt without changing the format', async () => {
    const store = await import('./projectStore')
    const request = { name: 'Summary', sourceFolders: [tempDir],
      codingMode: false, prompt: 'Keep project rules', capabilities: structuredClone(defaultCapabilities), restrictSubagents: false }
    const original = await store.createProject(request)
    const file = await readSnapshot()
    expect(await store.getProject(original.id)).not.toHaveProperty('compressionPrompt', expect.any(String))
    expect(await readSnapshot()).toBe(file)
    const compressionPrompt = 'Preserve sources: {conversation}'
    await store.updateProject(original.id, { ...request, compressionPrompt })
    const stored = JSON.parse(await readSnapshot())
    expect(stored.version).toBe(0)
    expect(stored.projects.find((p: Project) => p.id === original.id)).toMatchObject({ compression_prompt: compressionPrompt })
    expect(stored.projects.find((p: Project) => p.id === original.id)).not.toHaveProperty('compressionPrompt')
    expect(await store.prepareProjectPreview({ ...request, compressionPrompt }, original.id)).toMatchObject({ compressionPrompt })
    await expect(store.updateProject(original.id, { ...request, compressionPrompt: 'missing history placeholder' })).rejects.toThrow('compression prompt')
    expect(await store.getProject(original.id)).toMatchObject({ compressionPrompt, prompt: request.prompt })
    await store.updateProject(original.id, { ...request, compressionPrompt: '' })
    expect(JSON.parse(await readSnapshot()).projects.find((p: Project) => p.id === original.id)).not.toHaveProperty('compression_prompt')
  })

  it('validates a project preview without creating or updating stored projects', async () => {
    const store = await import('./projectStore')
    const saved = await store.createProject({ ...projectSettings(), name: 'Saved', prompt: 'Original' })
    const before = await readSnapshot()
    const preview = await store.prepareProjectPreview({
      name: 'Unsaved', prompt: 'Draft instructions', sourceFolders: [tempDir],
      capabilities: defaultCapabilities, restrictSubagents: false, codingMode: true
    }, saved.id)
    expect(preview).toMatchObject({ id: saved.id, prompt: 'Draft instructions', sourceFolders: [tempDir], codingMode: true })
    expect(JSON.parse(await readSnapshot())).toEqual(JSON.parse(before))
    await expect(store.prepareProjectPreview({ ...projectSettings(), name: 'Invalid', prompt: 42 } as unknown as ProjectCreateRequest))
      .rejects.toThrow('prompt')
  })

  it('shares first initialization between concurrent readers and a project creation', async () => {
    const store = await import('./projectStore')
    const results = await Promise.all([
      ...Array.from({ length: 30 }, () => store.listProjects()),
      store.createProject({ ...projectSettings(), name: 'Created during startup', prompt: '' })
    ])
    const created = results.at(-1) as Project
    const projects = await store.listProjects()
    expect(projects.map(project => project.id).sort()).toEqual([DEFAULT_WORKSPACE_PROJECT_ID, created.id].sort())
    const timestamps = results.slice(0, -1).map(projects => (projects as Project[]).find(project => project.id === DEFAULT_WORKSPACE_PROJECT_ID)?.createdAt)
    expect(new Set(timestamps).size).toBe(1)
    expect(await store.getProject(created.id)).toEqual(created)
  })

  it('persists project subagent selections independently of capability limits and allows clearing the override', async () => {
    const store = await import('./projectStore')
    const folder = join(tempDir, 'selection')
    await mkdir(folder)
    const request = { name: 'Selected agents', sourceFolders: [folder],
      codingMode: false, prompt: '', capabilities: { ...structuredClone(defaultCapabilities), subagents: { mode: 'custom' as const, names: ['general-purpose', 'removed-agent'] } }, restrictSubagents: false }
    const created = await store.createProject(request)
    expect((await store.getProject(created.id))).toMatchObject({ capabilities: { subagents: request.capabilities.subagents }, restrictSubagents: false })
    const raw = JSON.parse(await readSnapshot()).projects.find((item: Project) => item.id === created.id)
    expect(raw.capabilities.subagents).toEqual(request.capabilities.subagents)
    expect(raw).not.toHaveProperty('subagentSelection')
    await store.updateProject(created.id, { ...request, capabilities: { ...request.capabilities, subagents: { mode: 'custom', names: [] } }, restrictSubagents: true })
    expect(await store.getProject(created.id)).toMatchObject({ capabilities: { subagents: { mode: 'custom', names: [] } }, restrictSubagents: true })
    await expect(store.updateProject(created.id, { ...request, capabilities: { ...request.capabilities, subagents: { mode: 'custom', names: ['bad name'] } } })).rejects.toThrow()
    expect(await store.getProject(created.id)).toMatchObject({ capabilities: { subagents: { mode: 'custom', names: [] } } })
    await store.updateProject(created.id, { ...request, capabilities: { ...request.capabilities, subagents: { mode: 'off', names: request.capabilities.subagents.names } } })
    expect(await store.getProject(created.id)).toMatchObject({ capabilities: { subagents: { mode: 'off', names: request.capabilities.subagents.names } } })
  })

  it('defaults coding mode off and round trips explicit choices', async () => {
    const store = await import('./projectStore')
    expect(await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)).toMatchObject({ codingMode: false })
    const folder = join(tempDir, 'coding')
    await mkdir(folder)
    const request = { name: 'Coding', sourceFolders: [folder], codingMode: true,
      prompt: '', capabilities: structuredClone(defaultCapabilities), restrictSubagents: false }
    const created = await store.createProject(request)
    expect(await store.getProject(created.id)).toEqual(created)
    expect(created).toMatchObject({ codingMode: true })
    const raw = JSON.parse(await readSnapshot())
    const stored = raw.projects.find((item: Project) => item.id === created.id)
    expect(stored.coding_mode).toBe(true)
    expect(stored).not.toHaveProperty('codingMode')
    for (const value of [undefined, null, 'true', 1]) {
      await expect(store.updateProject(created.id, { ...request, codingMode: value } as unknown as ProjectCreateRequest))
        .rejects.toThrow('coding mode')
      await expect(store.createProject({ ...request, name: 'Invalid mode', codingMode: value } as unknown as ProjectCreateRequest))
        .rejects.toThrow('coding mode')
    }
    expect(await store.getProject(created.id)).toEqual(created)
    expect(await store.updateProject(created.id, { ...request, codingMode: false })).toMatchObject({ codingMode: false })
    expect(await store.getProject(created.id)).toMatchObject({ codingMode: false })
    stored.coding_mode = 'false'
    await writeSnapshot( JSON.stringify(raw))
    await expect(store.getProject(created.id)).rejects.toThrow('coding mode')
    expect(JSON.parse(await readSnapshot())).toEqual(raw)
  })

  it('reads existing project choices directly without rewriting a retired customization flag', async () => {
    const store = await import('./projectStore')
    const request = { name: 'Existing', sourceFolders: [tempDir], codingMode: false,
      prompt: 'Retained instructions', capabilities: { ...structuredClone(defaultCapabilities), workspace: false }, restrictSubagents: true }
    const created = await store.createProject(request)
    const raw = JSON.parse(await readSnapshot())
    const existing = raw.projects.find((item: Project) => item.id === created.id)
    existing.advanced_settings = false
    existing.script_auto_approve_skills = ['project-fixture:guide']
    existing.compression_prompt = 'Retained summary: {conversation}'
    await writeSnapshot(JSON.stringify(raw))
    const before = await readSnapshot()
    const loaded = await store.getProject(created.id)
    expect(loaded).toMatchObject({ capabilities: request.capabilities, prompt: request.prompt, restrictSubagents: true,
      compressionPrompt: 'Retained summary: {conversation}' })
    expect(await readSnapshot()).toBe(before)
    expect(loaded).not.toHaveProperty('advancedSettings')
    expect(loaded).not.toHaveProperty('scriptAutoApproveSkills')
    expect(loaded).not.toHaveProperty('script_auto_approve_skills')

    await store.updateProject(created.id, { ...loaded, name: 'Updated' })
    const saved = JSON.parse(await readSnapshot()).projects.find((item: Project) => item.id === created.id)
    expect(saved).not.toHaveProperty('script_auto_approve_skills')
    expect(saved).toMatchObject({ name: 'Updated', prompt: request.prompt, compression_prompt: existing.compression_prompt })
  })

  it('persists project model settings in snake_case and clears both selections together', async () => {
    const store = await import('./projectStore')
    const project = await store.createProject({
      ...projectSettings(), name: 'Model preference', prompt: '',
      modelConfigId: 'project-model', modelParameterPresetId: null
    })
    expect(await store.getProject(project.id)).toEqual(project)
    const raw = JSON.parse(await readSnapshot())
      .projects.find((item: Project) => item.id === project.id)
    expect(raw).toMatchObject({ model_config_id: 'project-model', model_parameter_preset_id: null })
    expect(raw).not.toHaveProperty('modelConfigId')
    expect(raw).not.toHaveProperty('modelParameterPresetId')
    const updated = await store.updateProject(project.id, {
      ...projectSettings(), name: project.name, prompt: '',
      modelConfigId: 'project-model', modelParameterPresetId: 'thinking-on'
    })
    expect(await store.getProject(project.id)).toEqual(updated)
    const cleared = await store.updateProject(project.id, { ...projectSettings(), name: project.name, prompt: '' })
    expect(cleared).not.toHaveProperty('modelConfigId')
    expect(cleared).not.toHaveProperty('modelParameterPresetId')
    expect(await store.getProject(project.id)).toEqual(cleared)
  })

  it.each([
    { modelConfigId: 3 }, { modelConfigId: '' },
    { modelConfigId: 'model', modelParameterPresetId: 3 },
    { modelConfigId: 'model', modelParameterPresetId: '' },
    { modelParameterPresetId: 'preset' }, { modelParameterPresetId: null }
  ])('rejects malformed project model preferences: %j', async (selection) => {
    const store = await import('./projectStore')
    await expect(store.createProject({ ...projectSettings(), name: 'Invalid', prompt: '', ...selection } as ProjectCreateRequest))
      .rejects.toThrow(/Project model/)
  })

  it('preserves unavailable model references and surviving project preferences through deletion', async () => {
    const store = await import('./projectStore')
    const preferred = await store.createProject({
      ...projectSettings(), name: 'Keep', prompt: '', modelConfigId: 'deleted-model', modelParameterPresetId: 'deleted-preset'
    })
    const removed = await store.createProject({ ...projectSettings(), name: 'Remove', prompt: '' })
    await store.deleteProjectWithThreads(removed.id, [], (commit) => commit())
    expect(await store.getProject(preferred.id)).toEqual(preferred)
    const previous = JSON.parse(await readSnapshot())
    const next = { ...previous, projects: previous.projects.filter((item: Project) => item.id !== preferred.id) }
    await writeFile(join(tempDir, 'db/project-deletion.json'), JSON.stringify({
      version: 0, projectId: preferred.id, threadIds: ['thread'], previous, next
    }), 'utf8')
    await writeSnapshot( JSON.stringify(next), 'utf8')
    await store.recoverProjectDeletion(() => true, vi.fn())
    expect(await store.getProject(preferred.id)).toEqual(preferred)
  })

  it('creates and lists a project with canonical absolute source folders', async () => {
    const firstFolder = join(tempDir, 'source')
    const secondFolder = join(tempDir, 'docs')
    await Promise.all([
      mkdir(firstFolder, { recursive: true }),
      mkdir(secondFolder, { recursive: true })
    ])
    const { createProject, listProjects } = await import('./projectStore')

    const project = await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '',

      name: '  My   Project  ',
      sourceFolders: [firstFolder, secondFolder, firstFolder]
    })

    expect(project.name).toBe('My Project')
    expect(project).toMatchObject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '',

      pinned: false,
      collapsed: false,
      sourceFolders: [firstFolder, secondFolder]
    })
    expect(await listProjects()).toEqual([
      project,
      expect.objectContaining({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', id: DEFAULT_WORKSPACE_PROJECT_ID,  })
    ])
  })

  it('allows empty folders and rejects invalid explicit directories and duplicate names', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const { createProject } = await import('./projectStore')

    await expect(createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Default folder', sourceFolders: [] }))
      .resolves.toMatchObject({ sourceFolders: [] })
    await expect(createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Example', sourceFolders: [join(tempDir, 'missing')] }))
      .rejects.toThrow()

    await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Example', sourceFolders: [sourceFolder] })
    await expect(createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'example', sourceFolders: [sourceFolder] }))
      .rejects.toThrow('already exists')
  })

  it('creates and updates a project with an optional prompt', async () => {
    const { createProject, updateProject } = await import('./projectStore')

    const project = await createProject({
      ...projectSettings(),
      name: '  Plain   chat  ',
      prompt: '  Answer only from this conversation.  '
    })

    expect(project).toMatchObject({
      ...projectSettings(),
      name: 'Plain chat',
      prompt: 'Answer only from this conversation.'
    })
    const emptyPrompt = await createProject({ ...projectSettings(), name: '未命名项目', prompt: '   ' })
    expect(emptyPrompt).toMatchObject({
      ...projectSettings(),
      name: '未命名项目',
      prompt: ''
    })
    await expect(createProject({ ...projectSettings(), name: '   ', prompt: '' }))
      .resolves.toMatchObject({ name: '未命名项目1' })

    const updated = await updateProject(project.id, {
      ...projectSettings(),
      name: 'Plain chat',
      prompt: 'Be concise.'
    })
    expect(updated).toMatchObject({ ...projectSettings(), prompt: 'Be concise.' })
    await expect(updateProject(project.id, {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '',

      name: 'Plain chat',
      sourceFolders: []
    })).resolves.toMatchObject({ sourceFolders: [] })
  })

  it('persists project appearance and clears it when automatic defaults are selected', async () => {
    const { createProject, updateProject, listProjects } = await import('./projectStore')
    const iconData = 'data:image/svg+xml;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')
    const project = await createProject({
      ...projectSettings(),
      name: 'Styled chat',
      icon: 'heart',
      iconColor: 'pink',
      iconData,
      prompt: ''
    })

    expect((await listProjects()).find(item => item.id === project.id)).toMatchObject({ icon: 'heart', iconColor: 'pink', iconData })

    const updated = await updateProject(project.id, {
      ...projectSettings(),
      name: project.name,
      prompt: ''
    })
    expect(updated).not.toHaveProperty('icon')
    expect(updated).not.toHaveProperty('iconColor')
    expect((await listProjects()).find(item => item.id === project.id)).not.toHaveProperty('iconData')
    await expect(updateProject(project.id, { ...updated, iconData: 'file:///outside.png' })).rejects.toThrow('Project icon image is invalid.')

    await expect(createProject({
      ...projectSettings(),
      name: 'Invalid icon',
      icon: 'unknown' as 'folder',
      prompt: ''
    })).rejects.toThrow('Project icon is invalid.')
  })

  it('persists project pin and collapse state without changing its update timestamp', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const { createProject, listProjects, updateProjectState } = await import('./projectStore')
    const first = await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'First', sourceFolders: [sourceFolder] })
    const second = await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Second', sourceFolders: [sourceFolder] })

    const updated = await updateProjectState(first.id, { pinned: true, collapsed: true })

    expect(updated).toMatchObject({ pinned: true, collapsed: true, updatedAt: first.updatedAt })
    expect((await listProjects()).map((project) => project.id)).toEqual([
      first.id,
      second.id,
      DEFAULT_WORKSPACE_PROJECT_ID
    ])
    await expect(updateProjectState(first.id, {})).rejects.toThrow('state update is invalid')
    await expect(updateProjectState('missing', { pinned: true })).rejects.toThrow('not found')
  })

  it('updates a project while preserving its identifier and validates unique names', async () => {
    const firstFolder = join(tempDir, 'first')
    const secondFolder = join(tempDir, 'second')
    await Promise.all([
      mkdir(firstFolder, { recursive: true }),
      mkdir(secondFolder, { recursive: true })
    ])
    const { createProject, listProjects, updateProject } = await import('./projectStore')
    const first = await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'First', sourceFolders: [firstFolder] })
    await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Second', sourceFolders: [secondFolder] })

    const updated = await updateProject(first.id, {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '',

      name: '  Updated   Project ',
      sourceFolders: [secondFolder, firstFolder, secondFolder]
    })

    expect(updated).toMatchObject({
      id: first.id,
      name: 'Updated Project',
      sourceFolders: [secondFolder, firstFolder],
      createdAt: first.createdAt
    })
    expect((await listProjects()).find((project) => project.id === first.id)).toEqual(updated)
    await expect(updateProject(first.id, {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'second', sourceFolders: [firstFolder] }))
      .rejects.toThrow('already exists')
    await expect(updateProject('missing', {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Missing', sourceFolders: [firstFolder] }))
      .rejects.toThrow('not found')
  })

  it('canonicalizes dropped source folders and rejects dropped files', async () => {
    const sourceFolder = join(tempDir, 'source')
    const sourceFile = join(tempDir, 'file.txt')
    await mkdir(sourceFolder, { recursive: true })
    await writeFile(sourceFile, 'not a folder', 'utf8')
    const { validateProjectSourceFolders } = await import('./projectStore')

    await expect(validateProjectSourceFolders([sourceFolder, sourceFolder]))
      .resolves.toEqual([sourceFolder])
    await expect(validateProjectSourceFolders([sourceFile]))
      .rejects.toThrow(`Source folder is not a directory: ${sourceFile}`)
  })

  it('commits project JSON only through the owning thread lifecycle', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const { createProject, deleteProjectWithThreads, listProjects } = await import('./projectStore')
    const project = await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Disposable', sourceFolders: [sourceFolder] })

    await deleteProjectWithThreads(project.id, [], (commit) => commit())

    expect(await listProjects()).toEqual([
      expect.objectContaining({ id: DEFAULT_WORKSPACE_PROJECT_ID })
    ])
  })

  it('serializes concurrent project mutations without losing updates', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const { createProject, listProjects, updateProject } = await import('./projectStore')

    const [first, second, third] = await Promise.all([
      createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'First', sourceFolders: [sourceFolder] }),
      createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Second', sourceFolders: [sourceFolder] }),
      createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Third', sourceFolders: [sourceFolder] })
    ])
    await Promise.all([
      updateProject(first.id, {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'First updated', sourceFolders: [sourceFolder] }),
      updateProject(second.id, {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Second updated', sourceFolders: [sourceFolder] })
    ])

    expect((await listProjects()).filter((project) => project.id !== DEFAULT_WORKSPACE_PROJECT_ID).map((project) => project.id).sort()).toEqual(
      [first.id, second.id, third.id].sort()
    )
    expect((await listProjects()).filter((project) => project.id !== DEFAULT_WORKSPACE_PROJECT_ID).map((project) => project.name).sort()).toEqual([
      'First updated',
      'Second updated',
      'Third'
    ])
  })

  it('restores project JSON when the database commit callback fails after rename', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const { createProject, deleteProjectWithThreads, listProjects } = await import('./projectStore')
    const project = await createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Keep', sourceFolders: [sourceFolder] })

    await expect(deleteProjectWithThreads(project.id, ['thread-1'], (commit) => {
      commit()
      throw new Error('database commit failed')
    })).rejects.toThrow('database commit failed')

    expect(await listProjects()).toEqual([
      project,
      expect.objectContaining({ id: DEFAULT_WORKSPACE_PROJECT_ID })
    ])
  })

  it('uses durable thread truth to finish or roll back an interrupted deletion', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const store = await import('./projectStore')
    const project = await store.createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Crash', sourceFolders: [sourceFolder] })
    const previous = { version: 0, projects: await store.listProjects() }
    const next = {
      version: 0,
      projects: previous.projects.filter((item) => item.id !== project.id)
    }
    const journal = {
      version: 0,
      projectId: project.id,
      threadIds: ['thread-1'],
      previous,
      next
    }
    await writeFile(join(tempDir, 'db/project-deletion.json'), storedProjectJson(journal), 'utf8')
    await writeSnapshot( storedProjectJson(next), 'utf8')

    const completeDatabaseCommit = vi.fn()
    await expect(store.recoverProjectDeletion(
      (id) => id === 'thread-1',
      completeDatabaseCommit
    )).resolves.toBe(true)
    expect(await store.listProjects()).toEqual(previous.projects)
    expect(completeDatabaseCommit).not.toHaveBeenCalled()

    await writeFile(join(tempDir, 'db/project-deletion.json'), storedProjectJson(journal), 'utf8')
    await writeSnapshot( storedProjectJson(previous), 'utf8')
    await expect(store.recoverProjectDeletion(
      () => false,
      completeDatabaseCommit
    )).resolves.toBe(true)
    expect(await store.listProjects()).toEqual(next.projects)
    expect(completeDatabaseCommit).toHaveBeenCalledOnce()
    expect(completeDatabaseCommit).toHaveBeenCalledWith(project.id)
  })

  it('finishes database cleanup when an interrupted deletion has no conversations', async () => {
    const sourceFolder = join(tempDir, 'source')
    await mkdir(sourceFolder, { recursive: true })
    const store = await import('./projectStore')
    const project = await store.createProject({
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, prompt: '', name: 'Empty', sourceFolders: [sourceFolder] })
    const previous = { version: 0, projects: await store.listProjects() }
    const next = {
      version: 0,
      projects: previous.projects.filter((item) => item.id !== project.id)
    }
    const journal = {
      version: 0,
      projectId: project.id,
      threadIds: [],
      previous,
      next
    }
    await writeFile(join(tempDir, 'db/project-deletion.json'), storedProjectJson(journal), 'utf8')
    await writeSnapshot( storedProjectJson(next), 'utf8')
    const completeDatabaseCommit = vi.fn()

    await expect(store.recoverProjectDeletion(
      () => false,
      completeDatabaseCommit
    )).resolves.toBe(true)

    expect(completeDatabaseCommit).toHaveBeenCalledOnce()
    expect(completeDatabaseCommit).toHaveBeenCalledWith(project.id)
    expect(await store.listProjects()).toEqual(next.projects)
  })

  it('defaults projects to all available capabilities and preserves explicit restrictions', async () => {
    const store = await import('./projectStore')
    const initial = await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)

    const before = initial.capabilities
    const customized = await store.updateProject(initial.id, initial)

    expect(customized.capabilities).toEqual(before)
    expect(customized.capabilities).toMatchObject({ customTools: { mode: 'all' }, pluginMode: 'default', mcp: { defaultMode: 'all' } })
    const restricted = { ...customized.capabilities, customTools: { ...customized.capabilities.customTools, mode: 'off' as const }, pluginMode: 'off' as const }
    await store.updateProject(initial.id, { ...customized, capabilities: restricted })
    const saved = await store.getProject(initial.id)

    expect(saved.capabilities).toEqual(restricted)
  })

  it('persists default workspace settings like a regular project while retaining its fixed identity', async () => {
    const store = await import('./projectStore')
    const initial = await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)
    await mkdir(join(tempDir, 'default-workspace'))

    const updated = await store.updateProject(DEFAULT_WORKSPACE_PROJECT_ID, {
      ...initial,

      icon: 'folder',
      accessMode: 'full_access',
      modelConfigId: 'workspace-model',
      modelParameterPresetId: null,
      sourceFolders: [tempDir, join(tempDir, 'default-workspace')],
      codingMode: true,
      prompt: 'Follow project instructions',
      compressionPrompt: 'Keep decisions: {conversation}',
      restrictSubagents: true,
      capabilities: { ...initial.capabilities, memory: false, skills: { ...initial.capabilities.skills, mode: 'off' } }
    })

    expect(updated).toMatchObject({
      id: DEFAULT_WORKSPACE_PROJECT_ID,
      name: initial.name,
      accessMode: 'full_access',
      modelConfigId: 'workspace-model',
      modelParameterPresetId: null,
      sourceFolders: [tempDir, join(tempDir, 'default-workspace')],
      codingMode: true, prompt: 'Follow project instructions',
      compressionPrompt: 'Keep decisions: {conversation}', restrictSubagents: true,
      capabilities: { memory: false, skills: { mode: 'off' } }
    })
    expect(updated.createdAt).toBe(initial.createdAt)
    await expect(store.updateProjectState(DEFAULT_WORKSPACE_PROJECT_ID, { pinned: true }))
      .rejects.toThrow('fixed position')
    await expect(store.deleteProjectWithThreads(DEFAULT_WORKSPACE_PROJECT_ID, [], (commit) => commit()))
      .rejects.toThrow('cannot be deleted')
    expect((await store.listProjects()).at(-1)).toEqual(updated)
    expect(await store.getProject(initial.id)).toEqual(updated)
    const raw = JSON.parse(await readSnapshot())
    expect(raw.version).toBe(0)
    expect(raw.projects.find((item: Project) => item.id === initial.id)).toMatchObject({
      coding_mode: true, restrict_subagents: true,
      compression_prompt: 'Keep decisions: {conversation}'
    })

  })
  it('keeps projects readable and allows correcting an unavailable default directory', async () => {
    const store = await import('./projectStore')
    const other = await store.createProject({ ...projectSettings(), name: 'Other', prompt: '' })
    const project = await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)

    const before = await readSnapshot()
    const directory = join(tempDir, 'default-workspace')
    await writeFile(directory, 'Keep this file')
    expect(await store.listProjects()).toContainEqual(other)
    expect(await store.getProject(other.id)).toEqual(other)
    expect(JSON.parse(await readSnapshot())).toEqual(JSON.parse(before))
    await expect(store.updateProject(project.id, { ...project, sourceFolders: [directory], icon: 'braces' })).rejects.toThrow('not a directory')
    expect(JSON.parse(await readSnapshot())).toEqual(JSON.parse(before))
    expect(await store.updateProject(project.id, { ...project, sourceFolders: [tempDir], icon: 'braces' }))
      .toMatchObject({ sourceFolders: [tempDir], icon: 'braces' })
    expect(await readFile(directory, 'utf8')).toBe('Keep this file')
  })

  it('allows unchanged names when fixed default naming collides with an existing v0 project', async () => {
    const store = await import('./projectStore')
    const project = await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)

    const other = await store.createProject({ ...projectSettings(), name: 'Other', prompt: '' })
    const raw = JSON.parse(await readSnapshot())
    raw.projects.find((item: Project) => item.id === project.id).name = 'Previously renamed default'
    raw.projects.find((item: Project) => item.id === other.id).name = project.name
    await writeSnapshot( JSON.stringify(raw))
    expect(await store.updateProject(project.id, { ...project, icon: 'braces', modelConfigId: 'model' }))
      .toMatchObject({ name: project.name, icon: 'braces', modelConfigId: 'model' })
    expect(await store.updateProject(other.id, { ...projectSettings(), name: project.name, prompt: 'Updated' }))
      .toMatchObject({ prompt: 'Updated' })
    await expect(store.createProject({ ...projectSettings(), name: project.name, prompt: '' }))
      .rejects.toThrow('already exists')
    const third = await store.createProject({ ...projectSettings(), name: 'Third', prompt: '' })
    await expect(store.updateProject(third.id, { ...projectSettings(), name: project.name, prompt: '' }))
      .rejects.toThrow('already exists')
  })

  it('rejects renaming the default workspace and validates its editable settings without writing invalid changes', async () => {
    const store = await import('./projectStore')
    const project = await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)

    const before = await readSnapshot()
    await expect(store.updateProject(project.id, { ...project, name: 'Renamed' }))
      .rejects.toThrow('The default project name cannot be changed')
    const changes = [{ compressionPrompt: 'Missing placeholder' }, { capabilities: {} }]
    for (const change of changes) {
      await expect(store.updateProject(project.id, { ...project, ...change } as ProjectCreateRequest)).rejects.toThrow()
    }
    expect(JSON.parse(await readSnapshot())).toEqual(JSON.parse(before))
    expect(await store.getProject(project.id)).toEqual(project)
  })

  it('reads saved v0 default workspace settings and previews unsaved changes without overwriting them', async () => {
    const store = await import('./projectStore')
    const project = await store.getProject(DEFAULT_WORKSPACE_PROJECT_ID)
    const original = JSON.parse(await readSnapshot())
    Object.assign(original.projects[0], {
      name: 'Previous custom name', sourceFolders: [join(tempDir, 'old-folder')],
      prompt: 'Old custom prompt', advanced_settings: true, coding_mode: true, restrict_subagents: true,
      compression_prompt: 'Saved summary: {conversation}',
      capabilities: serializeCapabilities({ ...defaultCapabilities, skills: { ...defaultCapabilities.skills, mode: 'off' } }),
      icon: 'braces', iconColor: 'blue', model_config_id: 'custom-model', model_parameter_preset_id: null,
      collapsed: true
    })
    const before = JSON.stringify(original)
    await writeSnapshot( before)
    const effective = await store.getProject(project.id)
    expect(effective).toEqual({ ...project, icon: 'braces', iconColor: 'blue', modelConfigId: 'custom-model', modelParameterPresetId: null, collapsed: true,
      sourceFolders: [join(tempDir, 'old-folder')], prompt: 'Old custom prompt', codingMode: true, restrictSubagents: true,
      compressionPrompt: 'Saved summary: {conversation}',
      capabilities: { ...defaultCapabilities, skills: { ...defaultCapabilities.skills, mode: 'off' } }
    })
    expect((await store.listProjects()).at(-1)).toEqual(effective)
    expect(JSON.parse(await readSnapshot())).toEqual(JSON.parse(before))
    const request = { ...effective, sourceFolders: [tempDir],
      capabilities: defaultCapabilities, restrictSubagents: true, codingMode: true,
      compressionPrompt: 'Draft summary: {conversation}', prompt: 'Draft override', modelConfigId: undefined, modelParameterPresetId: undefined }
    expect(await store.prepareProjectPreview(request, project.id)).toMatchObject({
      id: project.id, name: project.name, sourceFolders: [tempDir], capabilities: defaultCapabilities,
      restrictSubagents: true, codingMode: true,
      compressionPrompt: 'Draft summary: {conversation}', prompt: 'Draft override'
    })
    expect(JSON.parse(await readSnapshot())).toEqual(JSON.parse(before))
    expect(await store.updateProjectState(project.id, { collapsed: false })).toEqual({ ...effective, collapsed: false })
    expect(await store.getProject(project.id)).toEqual({ ...effective, collapsed: false })
  })

})
