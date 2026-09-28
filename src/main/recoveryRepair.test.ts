import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import settings from '../../data/config/settings.json'
import subagents from '../../data/config/subagents.json'
import models from '../../data/config/models.json'
import capabilities from '../../data/config/capabilities.json'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'
import { resettableConfigFiles } from '@shared/recovery'
import { inspectRecoveryRepair, repairDocument, repairRecoveryData } from './recoveryRepair'
import { preserveRecoveryData } from './recoveryData'
import { AgentStorage } from './agent/agentStorage'
import { readInputHistoryStoreFile } from './inputHistoryStore'
import * as avatarRepair from './recoveryAvatar'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'anas-field-repair-'))
  roots.push(root)
  const data = join(root, 'data')
  await mkdir(join(data, 'config'), { recursive: true })
  for (const file of ['capabilities.json', 'settings.json', 'subagents.json', 'models.json', 'mcp_servers.json', 'tools.json', 'skills.json']) {
    await writeFile(join(data, 'config', file), await readFile(join(process.cwd(), 'data/config', file)))
  }
  return { root, data }
}

describe('field-level recovery', () => {
  it.each([undefined, 1, 99])('rescues input history version %s without pruning, reordering, or changing pinned entries', async version => {
    const { root, data } = await fixture()
    const items = Array.from({ length: 59 }, (_, index) => ({ text: `Prompt ${index}`, pinned: index % 3 === 0,
      createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-28T00:00:00.000Z' }))
    const before = JSON.stringify({ version, maxHistory: 10, items })
    const path = join(data, 'input_history.json')
    await writeFile(path, before)
    await expect(readInputHistoryStoreFile(path)).rejects.toThrow('invalid format')
    const plan = await inspectRecoveryRepair(data)
    expect(plan.files.find(file => file.name === 'input_history.json')?.repairableFields).toEqual(['input_history.json: version'])
    expect(await readFile(path, 'utf8')).toBe(before)
    const result = await repairRecoveryData(data, 'input_history.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved).toEqual([])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 0, maxHistory: 10, items })
    expect(await readFile(join(result.preservationPath!, 'data/input_history.json'), 'utf8')).toBe(before)
    await expect(readInputHistoryStoreFile(path)).resolves.toMatchObject({ version: 0, maxHistory: 10 })
    expect((await inspectRecoveryRepair(data)).files.find(file => file.name === 'input_history.json')?.repairableFields).toEqual([])
  })

  it('exposes asset failures even with valid metadata and delegates repair to the asset transaction', async () => {
    const { data } = await fixture()
    await mkdir(join(data, 'assets'))
    await writeFile(join(data, 'assets/avatar-transform.json'), JSON.stringify({ version: 0, crop: { x: 0, y: 0, width: 100, height: 100 }, rotation: 0 }))
    vi.spyOn(avatarRepair, 'inspectAvatarRepair').mockResolvedValue({ fields: ['Recover source from crop'], issues: ['Source image cannot be decoded'] })
    const expected = { preservationPath: '/saved', repaired: ['Recover source from crop'], unresolved: [] }
    const repair = vi.spyOn(avatarRepair, 'repairAvatarData').mockResolvedValue(expected)
    const plan = await inspectRecoveryRepair(data)
    const canonical = await realpath(data)
    expect(plan.files.find(file => file.name === 'assets/avatar-transform.json')).toMatchObject({
      path: join(canonical, 'assets'), repairableFields: ['Recover source from crop'], error: 'Source image cannot be decoded'
    })
    const preserve = vi.fn(async () => '/saved')
    expect(await repairRecoveryData(data, 'assets/avatar-transform.json', preserve)).toEqual(expected)
    expect(repair).toHaveBeenCalledExactlyOnceWith(canonical, preserve)
  })

  it('does not create optional stores during inspection or discard history with unreadable items', async () => {
    const { root, data } = await fixture()
    expect((await inspectRecoveryRepair(data)).candidates).toEqual([])
    await expect(readFile(join(data, 'input_history.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const before = '{"version":1,"items":[{"text":7}]}'
    await writeFile(join(data, 'input_history.json'), before)
    const result = await repairRecoveryData(data, 'input_history.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved.join('\n')).toContain('items[0] could not be recovered')
    expect(await readFile(join(data, 'input_history.json'), 'utf8')).toBe(before)
    expect(await readFile(join(result.preservationPath!, 'data/input_history.json'), 'utf8')).toBe(before)
  })

  it.each([0, 1])('recovers readable history independently of bad entries at version %s', async version => {
    const { root, data } = await fixture()
    const first = { text: 'Keep pinned', pinned: true, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-28T00:00:00Z' }
    const second = { text: 'Keep ordinary', pinned: false, createdAt: '2026-09-02T00:00:00Z', updatedAt: '2026-09-27T00:00:00Z' }
    const before = JSON.stringify({ version, maxHistory: 100, items: [first, { text: 7, pinned: true }, second, null] })
    const path = join(data, 'input_history.json')
    await writeFile(path, before)
    const plan = await inspectRecoveryRepair(data)
    expect(plan.files.find(file => file.name === 'input_history.json')?.error).toContain('items[1]')
    expect(plan.files.find(file => file.name === 'input_history.json')?.repairableFields.length).toBeGreaterThan(0)
    expect(await readFile(path, 'utf8')).toBe(before)
    const result = await repairRecoveryData(data, 'input_history.json', async () => {
      expect(await readFile(path, 'utf8')).toBe(before)
      return preserveRecoveryData(data, root)
    })
    expect(result.repaired.length).toBeGreaterThan(0)
    expect(result.unresolved).toHaveLength(2)
    expect(result.unresolved.join('\n')).toContain('items[3]')
    expect(await readFile(join(result.preservationPath!, 'data/input_history.json'), 'utf8')).toBe(before)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ version: 0, maxHistory: 100, items: [first, second] })
    expect((await readInputHistoryStoreFile(path)).items).toEqual([first, second])
    const preserve = vi.fn(async () => '/unused')
    expect(await repairRecoveryData(data, 'input_history.json', preserve)).toEqual({ repaired: [], unresolved: [] })
    expect(preserve).not.toHaveBeenCalled()
  })

  it('does not replace partially readable history if the original cannot be preserved', async () => {
    const { data } = await fixture()
    const path = join(data, 'input_history.json')
    const before = '{"version":0,"maxHistory":100,"items":[{"text":"keep"},{"text":7}]}'
    await writeFile(path, before)
    await expect(repairRecoveryData(data, 'input_history.json', async () => { throw new Error('preservation failed') })).rejects.toThrow('preservation failed')
    expect(await readFile(path, 'utf8')).toBe(before)
  })

  it('preserves unparseable input and reports the problem when no safe field repair is available', async () => {
    const { root, data } = await fixture()
    const path = join(data, 'config/tools.json'), before = '{broken tool data'
    await writeFile(path, before)
    const result = await repairRecoveryData(data, 'tools.json', () => preserveRecoveryData(data, root))
    expect(result.repaired).toEqual([])
    expect(result.unresolved).not.toEqual([])
    expect(await readFile(path, 'utf8')).toBe(before)
    expect(await readFile(join(result.preservationPath!, 'data/config/tools.json'), 'utf8')).toBe(before)
  })

  it.each(resettableConfigFiles)('repairs missing version metadata in %s only after preserving its original bytes', async (file) => {
    const { root, data } = await fixture()
    const path = join(data, 'config', file)
    const current = JSON.parse(await readFile(path, 'utf8'))
    const unversioned = structuredClone(current)
    delete unversioned.version
    const before = JSON.stringify(unversioned)
    await writeFile(path, before)
    const plan = await inspectRecoveryRepair(data)
    expect(plan.files.find((status) => status.name === file)?.repairableFields).toEqual([`${file}: version`])
    expect(await readFile(path, 'utf8')).toBe(before)
    const result = await repairRecoveryData(data, file, async () => {
      expect(await readFile(path, 'utf8')).toBe(before)
      return preserveRecoveryData(data, root)
    })
    expect(result.unresolved).toEqual([])
    expect(result.repaired).toEqual([`${file}: version`])
    expect(await readFile(join(result.preservationPath!, 'data/config', file), 'utf8')).toBe(before)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(current)
    const preserve = vi.fn(async () => '/unused')
    expect((await repairRecoveryData(data, file, preserve)).repaired).toEqual([])
    expect(preserve).not.toHaveBeenCalled()
  })

  it('recreates a missing config through explicit repair without changing other config files', async () => {
    const { root, data } = await fixture()
    const path = join(data, 'config/settings.json')
    const other = await readFile(join(data, 'config/models.json'), 'utf8')
    await rm(path)
    expect((await inspectRecoveryRepair(data)).files.find((file) => file.name === 'settings.json')?.repairableFields).toContain('settings.json: version')
    const result = await repairRecoveryData(data, 'settings.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved).toEqual([])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(settings)
    expect(await readFile(join(data, 'config/models.json'), 'utf8')).toBe(other)
    await expect(readFile(join(result.preservationPath!, 'data/config/settings.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it.each([1, 4, 99, null, '0'])('repairs incorrect version metadata %s with current validation and preservation', async (version) => {
    const { root, data } = await fixture()
    const path = join(data, 'config/settings.json')
    const before = JSON.stringify({ ...settings, version })
    await writeFile(path, before)
    const preserve = vi.fn(() => preserveRecoveryData(data, root))
    const result = await repairRecoveryData(data, 'settings.json', preserve)
    expect(result.repaired).toEqual(['settings.json: version'])
    expect(result.unresolved).toEqual([])
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual(settings)
    expect(await readFile(join(result.preservationPath!, 'data/config/settings.json'), 'utf8')).toBe(before)
    expect(preserve).toHaveBeenCalledOnce()
  })

  it('retains per-server MCP policies and only repairs missing domain defaults on explicit recovery', () => {
    const raw: any = structuredClone(subagents)
    const custom = { default_mode: 'selected', servers: [{ id: 'offline', mode: 'all', tools: ['remembered'] }] }
    raw.subagents[0].capabilities.mcp = custom
    delete raw.subagents[1].capabilities.mcp
    const repaired = repairDocument('subagents.json', raw)
    const agents = repaired.value.subagents as any[]
    expect(agents[0].capabilities.mcp).toEqual(custom)
    expect(agents[1].capabilities.mcp).toEqual(subagents.subagents[1].capabilities.mcp)
    expect(repaired.fields.join('\n')).toContain('subagents[1].capabilities.mcp')
    raw.subagents[0].capabilities.mcp.servers[0].mode = 'invalid'
    const invalid: any = repairDocument('subagents.json', raw).value
    expect(invalid.subagents[0].capabilities.mcp).toEqual({ default_mode: 'selected', servers: [] })
    expect(invalid.subagents[0].name).toBe(raw.subagents[0].name)
  })

  it.each(['capabilities.json', 'subagents.json', 'projects.json'])('preserves valid off choices and repairs only invalid capability fields in %s', (file) => {
    const selection = { ...structuredClone(capabilities),
      skills: { mode: 'off', project: true, entries: [{ id: 'user:kept', shortcut: false, model: true }] },
      subagents: { mode: 'off', names: ['web-researcher'] }, workspace: false }
    const project = { id: DEFAULT_WORKSPACE_PROJECT_ID, kind: 'workspace', name: 'Keep project', pinned: false, collapsed: true,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', sourceFolders: ['/keep/path'],
      prompt: 'Keep prompt', coding_mode: true, advanced_settings: true, restrict_subagents: true, capabilities: selection }
    const raw: any = file === 'capabilities.json' ? selection
      : file === 'subagents.json' ? { ...structuredClone(subagents), subagents: [{ ...subagents.subagents[0], capabilities: selection }] }
        : { version: 0, projects: [project] }
    expect(repairDocument(file, raw)).toEqual({ value: raw, fields: [] })
    const broken = structuredClone(raw)
    const target = file === 'capabilities.json' ? broken
      : file === 'subagents.json' ? broken.subagents[0].capabilities : broken.projects[0].capabilities
    target.mcp.default_mode = 'unknown'
    target.tool_mode = 'unknown'
    target.skills.project = 'invalid'
    const repaired = repairDocument(file, broken)
    const expected = structuredClone(raw)
    const expectedSelection = file === 'capabilities.json' ? expected
      : file === 'subagents.json' ? expected.subagents[0].capabilities : expected.projects[0].capabilities
    expectedSelection.skills.project = false
    expect(repaired.value).toEqual(expected)
    expect(repaired.fields).toHaveLength(3)
    expect(repaired.fields.some((field) => field.endsWith('skills.mode'))).toBe(false)
    expect(repairDocument(file, repaired.value)).toEqual({ value: repaired.value, fields: [] })
  })

  it('repairs rejected values with current defaults without converting old choices or discarding sibling settings', () => {
    const raw: any = structuredClone(capabilities)
    raw.subagents = false
    raw.skills.enabled = false
    raw.skills.mode = 'off'
    raw.skills.entries = [{ id: 'keep-skill', shortcut: true, model: false }]
    raw.tools = ['read_file']
    raw.tool_mode = 'selected'
    raw.environment = false
    const repaired = repairDocument('capabilities.json', raw)
    expect(repaired.value).toEqual({ ...raw, subagents: capabilities.subagents,
      skills: { mode: 'off', project: false, entries: raw.skills.entries } })
    expect(repaired.fields).toEqual(expect.arrayContaining(['capabilities.json: subagents', 'capabilities.json: skills.enabled']))
    expect(raw.subagents).toBe(false)
    expect(raw.skills.enabled).toBe(false)
  })

  it('restores invalid selection lists to their defaults while preserving valid modes and other selections', () => {
    const raw: any = structuredClone(capabilities)
    raw.skills = { mode: 'off', project: true, entries: [{ id: 'broken', shortcut: false }] }
    raw.subagents = { mode: 'custom', names: [42] }
    raw.custom_tools = { project: true, entries: ['user:keep'] }
    raw.tool_mode = 'selected'
    raw.tools = [null]
    const repaired = repairDocument('capabilities.json', raw)
    expect(repaired.value).toEqual({ ...raw, tools: [],
      skills: { ...raw.skills, entries: capabilities.skills.entries },
      subagents: { ...raw.subagents, names: capabilities.subagents.names } })
    expect(repaired.fields).toHaveLength(3)
  })

  it('keeps recovery list limits without resetting oversized selections', () => {
    const raw = { ...structuredClone(capabilities), skills: { ...capabilities.skills,
      entries: Array.from({ length: 10_001 }, (_, index) => ({ id: `skill-${index}`, shortcut: false, model: false })) } }
    expect(() => repairDocument('capabilities.json', raw)).toThrow('too many selection items')
    expect(raw.skills.entries).toHaveLength(10_001)
  })

  it.each([undefined, null, 'true', 1, false, true])('repairs invalid coding mode %s only through explicit recovery', (codingMode) => {
    const project = { id: DEFAULT_WORKSPACE_PROJECT_ID, kind: 'workspace', name: 'Keep',
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z',
      coding_mode: codingMode, advanced_settings: false, capabilities }
    const result = repairDocument('projects.json', { version: 0, projects: [project] })
    expect((result.value.projects as Record<string, unknown>[])[0].coding_mode).toBe(codingMode === true)
    expect(result.fields.some((field) => field.includes('coding_mode'))).toBe(typeof codingMode !== 'boolean')
    expect(project.coding_mode).toBe(codingMode)
  })

  it('repairs missing nested capabilities with each built-in subagent’s own defaults', () => {
    const raw: any = structuredClone(subagents)
    delete raw.subagents[1].capabilities.skills
    raw.subagents[1].capabilities.background_tools = 'true'
    raw.subagents[1].capabilities.environment = false
    raw.subagents[1].description = 'Keep custom description'
    const repaired = repairDocument('subagents.json', raw)
    const agent = (repaired.value.subagents as any[])[1]
    expect(agent.capabilities.skills).toEqual(subagents.subagents[1].capabilities.skills)
    expect(agent.capabilities.background_tools).toBe(true)
    expect(agent.capabilities.profile).toBe(false)
    expect(agent.capabilities.environment).toBe(false)
    expect(agent.description).toBe('Keep custom description')
    expect(repaired.fields.join('\n')).toContain('subagents[1].capabilities.skills')
    expect(raw.subagents[1].capabilities.skills).toBeUndefined()
  })

  it('repairs an invalid capability object and enums without widening a valid custom selection', () => {
    const raw: any = structuredClone(subagents)
    raw.subagents[0].capabilities = false
    raw.subagents[1].capabilities.skills.mode = 'invalid'
    raw.subagents[1].capabilities.tools = ['read_file']
    const repaired: any = repairDocument('subagents.json', raw).value
    expect(repaired.subagents[0].capabilities).toEqual(subagents.subagents[0].capabilities)
    expect(repaired.subagents[1].capabilities.skills.mode).toBe('custom')
    expect(repaired.subagents[1].capabilities.tools).toEqual(['read_file'])
  })

  it('keeps valid false, zero, empty strings, custom parameters and empty lists', () => {
    const raw = { ...settings, sidebar_visible: false, log_retention_days: 0, backup_dir: '' }
    expect(repairDocument('settings.json', raw)).toEqual({ value: raw, fields: [] })
    const rawModels = { ...models, providers: [{
      id: 'provider', name: 'Custom', protocol: 'openai_chat_completions', base_url: 'https://example.com',
      api_key: 'keep-key', parameters: { custom: { value: 0 } }, models: []
    }] }
    const repaired: any = repairDocument('models.json', rawModels).value
    expect(repaired.providers[0].api_key).toBe('keep-key')
    expect(repaired.providers[0].parameters).toEqual({ custom: { value: 0 } })
    expect(repaired.providers[0].models).toEqual([])
  })

  it('repairs setting types, out-of-range values and enums at the field level', () => {
    const raw: any = { ...settings, theme: 'purple', font_size: 900, sidebar_visible: 'false', profile: { assistant: { name: 'Keep me' } } }
    const repaired: any = repairDocument('settings.json', raw).value
    expect(repaired.theme).toBe(settings.theme)
    expect(repaired.font_size).toBe(settings.font_size)
    expect(repaired.sidebar_visible).toBe(settings.sidebar_visible)
    expect(repaired.profile.assistant.name).toBe('Keep me')
    expect(repaired.profile.assistant.role).toBe(settings.profile.assistant.role)
  })

  it('repairs skill availability defaults without enabling an explicitly disabled switch', () => {
    const repaired: any = repairDocument('skills.json', { version: 0, external_directories: [], availability: {
      example: { model_available: false, user_available: 'broken' }
    } }).value
    expect(repaired.availability.example).toEqual({ model_available: false, user_available: true })
    expect(repaired.external_directories).toEqual([])
  })

  it('reports broken cross-file model references without clearing the saved model choice', async () => {
    const { data } = await fixture()
    const value = { ...settings, default_model_id: 'missing-model' }
    await writeFile(join(data, 'config/settings.json'), JSON.stringify(value))
    const plan = await inspectRecoveryRepair(data)
    expect(plan.issues.join('\n')).toContain('missing-model')
    expect(plan.candidates).toEqual([])
  })

  it('repairs project fields without changing project identities and rejects unidentifiable projects', () => {
    const project: any = {
      id: DEFAULT_WORKSPACE_PROJECT_ID, kind: 'workspace', name: 'Keep project',
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', sourceFolders: ['/keep/path'],
      capabilities: { ...capabilities, workspace: false }, pinned: false
    }
    const repaired: any = repairDocument('projects.json', { version: 0, projects: [project] }).value
    expect(repaired.projects[0]).toMatchObject({ id: project.id, name: project.name, sourceFolders: ['/keep/path'], advanced_settings: false, collapsed: false })
    expect(repaired.projects[0].capabilities.workspace).toBe(false)
    delete project.id
    expect(() => repairDocument('projects.json', { version: 0, projects: [project] })).toThrow('invalid format')
  })

  it('preserves raw files before writing and leaves unparseable files and database untouched', async () => {
    const { root, data } = await fixture()
    const raw: any = structuredClone(subagents)
    delete raw.subagents[0].capabilities
    const before = JSON.stringify(raw)
    await writeFile(join(data, 'config/subagents.json'), before)
    await writeFile(join(data, 'projects.json'), '{broken')
    await mkdir(join(data, 'sqlite'))
    await writeFile(join(data, 'sqlite/agent.sqlite'), 'leave database untouched')
    const result = await repairRecoveryData(data, 'subagents.json', () => preserveRecoveryData(data, root))
    expect(result.repaired.join('\n')).toContain('capabilities')
    expect(result.unresolved).toEqual([])
    expect((await inspectRecoveryRepair(data)).files.find((file) => file.name === 'projects.json')?.error).toBeTruthy()
    expect(await readFile(join(result.preservationPath!, 'data/config/subagents.json'), 'utf8')).toBe(before)
    expect(await readFile(join(data, 'projects.json'), 'utf8')).toBe('{broken')
    expect(await readFile(join(data, 'sqlite/agent.sqlite'), 'utf8')).toBe('leave database untouched')
    expect((await inspectRecoveryRepair(data)).candidates).toEqual([])
  })

  it('repairs project capability settings without resetting projects or conversation data', async () => {
    const { root, data } = await fixture()
    const project = { id: DEFAULT_WORKSPACE_PROJECT_ID, kind: 'workspace', name: 'Keep project', pinned: false, collapsed: true,
      createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-02T00:00:00Z', sourceFolders: ['/keep/path'],
      prompt: 'Keep prompt', coding_mode: true, advanced_settings: true, restrict_subagents: true,
      capabilities: { ...structuredClone(capabilities), subagents: false } }
    const raw = { projects: [project, { ...structuredClone(project), id: 'second-project', name: 'Keep second project' }] }
    const before = JSON.stringify(raw)
    await writeFile(join(data, 'projects.json'), before)
    const storage = AgentStorage.open(data)
    const thread = storage.createThread({ title: 'Keep conversation' })
    storage.close()
    const plan = await inspectRecoveryRepair(data)
    expect(plan.files.find((file) => file.name === 'projects.json')?.error).toBeUndefined()
    expect(plan.files.find((file) => file.name === 'projects.json')?.repairableFields).toHaveLength(3)
    const result = await repairRecoveryData(data, 'projects.json', () => preserveRecoveryData(data, root))
    expect(result.unresolved).toEqual([])
    expect(result.repaired).toHaveLength(3)
    expect(JSON.parse(await readFile(join(data, 'projects.json'), 'utf8'))).toEqual({ ...raw, version: 0,
      projects: raw.projects.map((entry) => ({ ...entry, capabilities: { ...entry.capabilities, subagents: capabilities.subagents } })) })
    expect(await readFile(join(result.preservationPath!, 'data/projects.json'), 'utf8')).toBe(before)
    const reopened = AgentStorage.open(data)
    try { expect(reopened.getThread(thread.id)?.title).toBe('Keep conversation') } finally { reopened.close() }
    const preserve = vi.fn(async () => '/unused')
    expect((await repairRecoveryData(data, 'projects.json', preserve)).repaired).toEqual([])
    expect(preserve).not.toHaveBeenCalled()
  })

  it('never writes after preservation fails or overwrites a file changed during preservation', async () => {
    const { data } = await fixture()
    const path = join(data, 'config/settings.json')
    await writeFile(path, '{}')
    await expect(repairRecoveryData(data, 'settings.json', async () => { throw new Error('disk full') })).rejects.toThrow('disk full')
    expect(await readFile(path, 'utf8')).toBe('{}')
    const result = await repairRecoveryData(data, 'settings.json', async () => { await writeFile(path, '{"changed":true}'); return '/preserved' })
    expect(result.repaired).toEqual([])
    expect(result.unresolved.join('\n')).toContain('File changed')
    expect(await readFile(path, 'utf8')).toBe('{"changed":true}')
    expect((await readdir(join(data, 'config'))).some((name) => name.endsWith('.tmp'))).toBe(false)
  })

  it('does not back up or rewrite valid files on a repeated repair', async () => {
    const { data } = await fixture()
    const preserve = vi.fn(async () => '/preserved')
    const result = await repairRecoveryData(data, 'settings.json', preserve)
    expect(result.repaired).toEqual([])
    expect(preserve).not.toHaveBeenCalled()
  })

  it('attributes errors to files and repairs only the clicked file even when several need repairs', async () => {
    const { data } = await fixture()
    await writeFile(join(data, 'config/settings.json'), '{"version":0}')
    await writeFile(join(data, 'config/subagents.json'), '{"version":0}')
    await writeFile(join(data, 'config/models.json'), '{broken')
    const plan = await inspectRecoveryRepair(data)
    expect(plan.files.find((file) => file.name === 'settings.json')?.repairableFields.length).toBeGreaterThan(0)
    expect(plan.files.find((file) => file.name === 'models.json')?.error).toBeTruthy()
    expect(plan.files.find((file) => file.name === 'projects.json')?.error).toContain('missing')
    await repairRecoveryData(data, 'settings.json', async () => '/preserved')
    expect(await readFile(join(data, 'config/subagents.json'), 'utf8')).toBe('{"version":0}')
    expect(await readFile(join(data, 'config/models.json'), 'utf8')).toBe('{broken')
    expect(JSON.parse(await readFile(join(data, 'config/settings.json'), 'utf8'))).toEqual(settings)
  })
})
