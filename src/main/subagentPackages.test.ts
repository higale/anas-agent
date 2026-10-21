import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defaultCapabilities, parseCapabilities, resolvePluginCapabilities, resolveSkillSelection, serializeCapabilities } from '@shared/agentCapabilities'
import { customToolDefaults, serializeCustomTool } from '@shared/customTools'
import { resolveToolSelection } from '@shared/toolPackages'
import type { RawSubagentConfig } from './config/rawAppConfig'

vi.mock('electron', () => ({ shell: { trashItem: vi.fn() } }))
vi.mock('./projectStore', () => ({ getProject: vi.fn() }))
let root: string
let packages: typeof import('./subagentPackages')
let files: typeof import('./subagentPackageFiles')
let tools: typeof import('./toolsStore')
let skills: typeof import('./skillsStore')
async function text(path: string, value: string) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, value) }
const agentDefinition = (name: string): RawSubagentConfig => ({ id: name, name, description: 'Own resources.', enabled: true,
  system_prompt: 'Complete work.', capabilities: serializeCapabilities(defaultCapabilities) })
async function addAgent(name: string) {
  await packages.writeSubagentPackages([...(await packages.readSubagentPackages(root)), agentDefinition(name)])
  return (await packages.findSubagentPackage(name)).directory!
}
async function addResources(directory: string) {
  await text(join(directory, 'skills/local-guide/SKILL.md'), '---\nname: local-guide\ndescription: Private guide.\n---\nRead the local report.\n')
  await text(join(directory, 'tools/query/TOOL.json'), JSON.stringify(serializeCustomTool({ ...customToolDefaults,
    id: 'query', name: 'query_local', description: 'Query local reports.', inputSchema: { type: 'object' } })))
  await text(join(directory, 'tools/query/report.txt'), 'keep')
}

beforeEach(async () => {
  vi.resetModules()
  root = await realpath(await mkdtemp(join(tmpdir(), 'anas-agent-packages-')))
  vi.doMock('./config/dataDir', () => ({
    getDataDir: () => root, getBundledDataDir: () => resolve('data'),
    getConfigFile: (file: string) => join(root, 'config', file), getBundledConfigFile: (file: string) => resolve('data/config', file),
    skillsConfigFileName: 'skills.json', customToolsConfigFileName: 'tools.json', subagentsConfigFileName: 'subagents.json',
    getSkillsDir: () => join(root, 'skills'), getSystemSkillsDir: () => join(root, 'skills/_system'),
    getSystemPluginsDir: () => join(root, 'plugins/_system'), getSkillExamplesDir: () => join(root, 'examples/skills')
  }))
  packages = await import('./subagentPackages')
  tools = await import('./toolsStore')
  skills = await import('./skillsStore')
  files = await import('./subagentPackageFiles')
  await packages.initializeSubagentPackages()
})
afterEach(async () => { vi.doUnmock('./config/dataDir'); vi.doUnmock('./atomicJson'); vi.doUnmock('node:fs/promises'); await rm(root, { recursive: true, force: true }) })

describe('Agent directory packages', () => {
  it('loads system definitions and keeps user identities, resources, switches and order when editing', async () => {
    expect((await packages.readSubagentPackages(root)).map(a => a.id)).toEqual(['general-purpose'])
    expect((await packages.readSubagentPackages(root)).every(a => a.directory === join(root, 'subagents/_system', a.id!))).toBe(true)
    const directory = await addAgent('reporter')
    await addResources(directory)
    const values = await packages.readSubagentPackages(root)
    const agent = values.find(a => a.id === 'reporter')!
    agent.name = 'renamed'
    agent.system_prompt = 'Updated instructions.'
    agent.capabilities = serializeCapabilities({ ...defaultCapabilities, customTools: { ...defaultCapabilities.customTools, package: { query: false } } })
    agent.enabled = false
    await packages.writeSubagentPackages([agent, ...values.filter(a => a.id !== agent.id)])
    await packages.initializeSubagentPackages()
    expect((await packages.readSubagentPackages(root))[0]).toMatchObject({ id: 'reporter', name: 'renamed', enabled: false, directory,
      capabilities: { custom_tools: { package: { query: false } } }, system_prompt: 'Updated instructions.' })
    expect(await readFile(join(directory, 'tools/query/report.txt'), 'utf8')).toBe('keep')
    const saved = JSON.parse(await readFile(join(directory, 'AGENT.json'), 'utf8'))
    expect(saved).not.toHaveProperty('enabled')
    expect(saved.capabilities.custom_tools.package).toEqual({ query: false })
    const hostSettings = JSON.parse(await readFile(join(root, 'config/subagents.json'), 'utf8'))
    expect(Object.keys(hostSettings).sort()).toEqual(['disabled', 'external_directories', 'order', 'revision', 'version'])
    expect(await readdir(join(root, 'subagents'))).not.toContain('.transaction')
  })

  it('allows only the enabled switch for built-in Agents and rejects definition edits without writing', async () => {
    const original = await packages.findSubagentPackage('general-purpose')
    const config = await readFile(join(root, 'config/subagents.json'), 'utf8')
    const changes: Partial<RawSubagentConfig>[] = [
      { name: 'renamed' }, { description: 'Changed' }, { system_prompt: 'Changed' },
      { model_config_id: 'chosen-model' }, { model_parameter_preset_id: null }, { preset: undefined },
      { capabilities: serializeCapabilities({ ...defaultCapabilities, memory: false }) }
    ]
    for (const change of changes) {
      await expect(packages.writeSubagentPackages([{ ...original, ...change }])).rejects.toThrow('read-only')
      expect(await readFile(join(root, 'config/subagents.json'), 'utf8')).toBe(config)
      expect(await packages.findSubagentPackage(original.id!)).toEqual(original)
    }
    await packages.writeSubagentPackages([{ ...original, enabled: false }])
    expect(await packages.findSubagentPackage(original.id!)).toEqual({ ...original, enabled: false })
    expect(await packages.readSubagentSettings()).toEqual({ version: 1, order: [original.id], disabled: [original.id], external_directories: [] })
    await expect(packages.writeSubagentPackages([])).rejects.toThrow('cannot be deleted')
    await expect(packages.importSubagentPackages([original.directory!])).rejects.toThrow('built-in')
    await packages.writeSubagentPackages([original])
    expect((await packages.readSubagentSettings()).disabled).toEqual([])
  })

  it('keeps all built-in files read-only, including prompts and package resources', async () => {
    const agent = await packages.findSubagentPackage('general-purpose')
    await addResources(agent.directory!)
    for (const path of ['AGENT.json', 'PROMPT.md', 'skills/local-guide/SKILL.md', 'tools/query/TOOL.json']) {
      const preview = await files.readSubagentFile(agent.id!, path)
      expect(preview.editable).toBe(false)
      await expect(files.saveSubagentFile(agent.id!, path, { content: 'Replace', revision: preview.revision!, resolvedPath: preview.resolvedPath })).rejects.toThrow('read-only')
      expect(await readFile(preview.resolvedPath, 'utf8')).toBe(preview.content)
    }
  })

  it('refreshes only system package files on startup and retains user packages and settings', async () => {
    const directory = await addAgent('reporter')
    const values = await packages.readSubagentPackages(root)
    values.find(a => a.id === 'general-purpose')!.enabled = false
    await packages.writeSubagentPackages(values)
    const config = await readFile(join(root, 'config/subagents.json'), 'utf8')
    await text(join(root, 'subagents/_system/general-purpose/PROMPT.md'), 'Outdated bundled prompt')
    await text(join(root, 'subagents/_system/project-analyst/PROMPT.md'), 'Retired bundled prompt')
    vi.resetModules()
    packages = await import('./subagentPackages')
    await packages.initializeSubagentPackages()
    expect(await readFile(join(root, 'subagents/_system/general-purpose/PROMPT.md'), 'utf8')).toBe(await readFile(resolve('data/subagents/_system/general-purpose/PROMPT.md'), 'utf8'))
    expect(await readdir(join(root, 'subagents/_system'))).toEqual(['general-purpose'])
    expect(await readFile(join(root, 'config/subagents.json'), 'utf8')).toBe(config)
    expect(await packages.findSubagentPackage('general-purpose')).toMatchObject({ enabled: false })
    expect(await packages.findSubagentPackage('reporter')).toMatchObject({ directory, system_prompt: 'Complete work.' })
  })

  it.each(['web-researcher', 'project-analyst'])('imports %s as an editable and removable user package', async id => {
    await expect(packages.findSubagentPackage(id)).rejects.toThrow('unavailable')
    await packages.importSubagentPackages([resolve('data/examples/subagents', id)])
    const agent = await packages.findSubagentPackage(id)
    expect(agent.preset).toBeUndefined()
    expect(agent.directory).toBe(join(root, 'subagents', id))
    const preview = await files.readSubagentFile(id, 'PROMPT.md')
    expect(preview.editable).toBe(true)
    await files.saveSubagentFile(id, 'PROMPT.md', { content: 'My example prompt', revision: preview.revision!, resolvedPath: preview.resolvedPath })
    expect((await packages.findSubagentPackage(id)).system_prompt).toBe('My example prompt')
    await packages.writeSubagentPackages((await packages.readSubagentPackages(root)).filter(item => item.id !== id))
    await expect(packages.findSubagentPackage(id)).rejects.toThrow('unavailable')
    expect(await packages.packageExists(agent.directory!)).toBe(false)
  })

  it('keeps local resources out of global catalogs and resolves only the owning Agent resources', async () => {
    const directory = await addAgent('reporter')
    await addResources(directory)
    await addAgent('other')
    const ownSkills = await skills.listSubagentSkills(['reporter'])
    const ownTools = await tools.listSubagentTools(['reporter'])
    expect((await skills.listSkillSnapshot()).skills.some(s => s.source === 'subagent')).toBe(false)
    expect((await tools.listToolSnapshot()).tools).toEqual([])
    expect((await skills.listSubagentSkills(['other'])).skills).toEqual([])
    expect(await tools.listSubagentTools(['other'])).toEqual([])
    const capability = resolvePluginCapabilities({ ...structuredClone(defaultCapabilities), skills: { mode: 'custom', project: false,
      entries: [{ id: ownSkills.skills[0].id, model: true, shortcut: false }] } }, [])
    expect(capability.skills.entries).toHaveLength(1) // Agent namespaces are not plugin namespaces.
    const selection = resolveSkillSelection({ mode: 'custom', project: false, entries: [] }, ownSkills.skills, true, true)
    expect(selection.entries).toEqual([{ id: 'subagent:reporter:skill:local-guide', model: true, shortcut: false }])
    expect(await skills.buildSkillsPrompt(undefined, selection, [])).toContain(join(directory, 'skills/local-guide/SKILL.md'))
    expect(resolveToolSelection({ mode: 'custom', project: false, entries: [] }, ownTools, true).entries).toEqual(['subagent:reporter:tool:query'])
    expect(resolveToolSelection({ mode: 'off', project: false, entries: [] }, ownTools, true).entries).toEqual([])
    expect(resolveSkillSelection({ ...selection, mode: 'off' }, ownSkills.skills, true, true).entries.every(s => !s.model)).toBe(true)
    const agents = await packages.readSubagentPackages(root)
    agents.find(a => a.id === 'reporter')!.capabilities = serializeCapabilities({ ...defaultCapabilities,
      skills: { ...defaultCapabilities.skills, package: { 'local-guide': false } }, customTools: { ...defaultCapabilities.customTools, package: { query: false } } })
    await packages.writeSubagentPackages(agents)
    expect(resolveToolSelection({ mode: 'all', project: true, entries: [] }, await tools.listSubagentTools(['reporter']), true).entries).toEqual([])
    expect(resolveSkillSelection(selection, (await skills.listSubagentSkills(['reporter'])).skills, true, true).entries.every(s => !s.model)).toBe(true)
    await expect(tools.withToolPackageDirectory(ownTools[0].definition!, async () => 'executed')).rejects.toThrow('unavailable')
  })

  it('rejects a stale settings save after a file edit or a newly imported package', async () => {
    await addAgent('reporter')
    const before = await packages.readSubagentPackages(root)
    const changed = structuredClone(before)
    changed.find(a => a.id === 'reporter')!.description = 'New description'
    const prompt = await files.readSubagentFile('reporter', 'PROMPT.md')
    await files.saveSubagentFile('reporter', 'PROMPT.md', { content: 'External edit', revision: prompt.revision!, resolvedPath: prompt.resolvedPath })
    await expect(packages.writeSubagentPackages(changed, before)).rejects.toThrow('changed')
    expect((await packages.findSubagentPackage('reporter')).system_prompt).toBe('External edit')
    const current = await packages.readSubagentPackages(root)
    await addAgent('newcomer')
    await expect(packages.writeSubagentPackages(current, current)).rejects.toThrow('changed')
    expect((await packages.findSubagentPackage('newcomer')).id).toBe('newcomer')
  })

  it('blocks replacing or deleting a package while its tool directory is in use', async () => {
    const directory = await addAgent('reporter')
    await addResources(directory)
    const [tool] = await tools.listSubagentTools(['reporter'])
    await tools.withToolPackageDirectory(tool.definition!, async pinned => {
      expect(pinned).toBe(join(directory, 'tools/query'))
      const agents = await packages.readSubagentPackages(root)
      agents.find(a => a.id === 'reporter')!.description = 'Changed'
      await expect(packages.writeSubagentPackages(agents)).rejects.toThrow('running')
      await expect(packages.writeSubagentPackages(agents.filter(a => a.id !== 'reporter'))).rejects.toThrow('running')
      expect(await readFile(join(pinned, 'report.txt'), 'utf8')).toBe('keep')
    })
    await packages.writeSubagentPackages((await packages.readSubagentPackages(root)).filter(a => a.id !== 'reporter'))
    await expect(packages.findSubagentPackage('reporter')).rejects.toThrow('unavailable')
  })

  it('validates canonical files, rejects stale edits, and preserves directory identity', async () => {
    const directory = await addAgent('reporter')
    const prompt = await files.readSubagentFile('reporter', 'PROMPT.md')
    await files.saveSubagentFile('reporter', './PROMPT.md', { content: 'Changed prompt', revision: prompt.revision!, resolvedPath: prompt.resolvedPath })
    await expect(files.saveSubagentFile('reporter', 'PROMPT.md', { content: 'Stale prompt', revision: prompt.revision!, resolvedPath: prompt.resolvedPath })).rejects.toThrow('changed outside')
    const manifest = await files.readSubagentFile('reporter', 'AGENT.json')
    const changed = { ...JSON.parse(manifest.content!), id: 'wrong' }
    await expect(files.saveSubagentFile('reporter', './AGENT.json', { content: JSON.stringify(changed), revision: manifest.revision!, resolvedPath: manifest.resolvedPath })).rejects.toThrow('identity')
    await symlink('AGENT.json', join(directory, 'alias.json'))
    await expect(files.saveSubagentFile('reporter', 'alias.json', { content: JSON.stringify(changed), revision: manifest.revision!, resolvedPath: manifest.resolvedPath })).rejects.toThrow('identity')
    expect((await packages.findSubagentPackage('reporter')).system_prompt).toBe('Changed prompt')
  })

  it('applies the settings validation when an enabled Agent manifest is edited as a file', async () => {
    await addAgent('reporter')
    const manifest = await files.readSubagentFile('reporter', 'AGENT.json')
    const content = JSON.stringify({ ...JSON.parse(manifest.content!), description: '' })
    const update = { content, revision: manifest.revision!, resolvedPath: manifest.resolvedPath }
    await expect(files.saveSubagentFile('reporter', 'AGENT.json', update)).rejects.toThrow('description must not be empty')
    expect(await readFile(manifest.resolvedPath, 'utf8')).toBe(manifest.content)
    const agents = await packages.readSubagentPackages(root)
    await packages.writeSubagentPackages(agents.map(agent => agent.id === 'reporter' ? { ...agent, enabled: false } : agent))
    await files.saveSubagentFile('reporter', 'AGENT.json', update)
    expect(await packages.findSubagentPackage('reporter')).toMatchObject({ enabled: false, description: '' })
  })

  it.each([false, true])('recovers a directory replacement according to its durable settings commit (%s)', async committed => {
    const directory = await addAgent('reporter')
    await addResources(directory)
    const before = await readFile(join(root, 'config/subagents.json'), 'utf8')
    const after = JSON.stringify({ ...JSON.parse(before), revision: 'new' })
    const stage = join(root, 'subagents/.transaction')
    await mkdir(stage)
    await rename(directory, join(stage, 'previous'))
    await packages.writeSubagentDefinition(directory, { ...agentDefinition('reporter'), system_prompt: 'Replacement' })
    await text(join(stage, 'transaction.json'), JSON.stringify({ version: 0, directory: 'reporter', hadPackage: true, remove: false, before, after }))
    if (committed) await writeFile(join(root, 'config/subagents.json'), after)
    const agent = await packages.findSubagentPackage('reporter')
    expect(agent.system_prompt).toBe(committed ? 'Replacement' : 'Complete work.')
    if (!committed) expect(await readFile(join(directory, 'tools/query/report.txt'), 'utf8')).toBe('keep')
    expect(await readdir(join(root, 'subagents'))).not.toContain('.transaction')
  })

  it('imports the whole folder, rejects collisions and linked files, and never imports its destination', async () => {
    const source = join(root, 'incoming')
    await packages.writeSubagentDefinition(source, { ...agentDefinition('imported'), capabilities: serializeCapabilities({ ...defaultCapabilities,
      skills: { ...defaultCapabilities.skills, package: { 'local-guide': false } }, customTools: { ...defaultCapabilities.customTools, package: { query: false } } }) })
    await addResources(source)
    await packages.importSubagentPackages([source])
    const directory = (await packages.findSubagentPackage('imported')).directory!
    expect(await readFile(join(directory, 'tools/query/report.txt'), 'utf8')).toBe('keep')
    expect(parseCapabilities((await packages.findSubagentPackage('imported')).capabilities)).toMatchObject({
      skills: { package: { 'local-guide': false } }, customTools: { package: { query: false } } })
    expect((await tools.listSubagentTools(['imported']))[0].enabled).toBe(false)
    expect((await skills.listSubagentSkills(['imported'])).skills[0].modelAvailable).toBe(false)
    await expect(packages.importSubagentPackages([source])).rejects.toThrow('already exists')
    const imported = await packages.findSubagentPackage('imported')
    await packages.writeSubagentDefinition(source, { ...imported, id: 'copied', name: 'copied' })
    await packages.importSubagentPackages([source])
    expect((await tools.listSubagentTools(['copied']))[0]).toMatchObject({ id: 'subagent:copied:tool:query', enabled: false })
    expect((await skills.listSubagentSkills(['copied'])).skills[0]).toMatchObject({ id: 'subagent:copied:skill:local-guide', modelAvailable: false })
    await packages.writeSubagentDefinition(source, agentDefinition('linked'))
    await symlink('PROMPT.md', join(source, 'alias'))
    await expect(packages.importSubagentPackages([source])).rejects.toThrow('regular files')
    await expect(packages.importSubagentPackages([root])).rejects.toThrow('ancestor')
    expect((await readdir(join(root, 'subagents'))).some(name => name.startsWith('.import'))).toBe(false)
  })

  it('imports multiple complete packages in one selection', async () => {
    const sources = ['first', 'second'].map(name => join(root, 'incoming', name))
    for (const [index, source] of sources.entries()) {
      await packages.writeSubagentDefinition(source, agentDefinition(index === 0 ? 'first' : 'second'))
      await addResources(source)
    }
    await packages.importSubagentPackages(sources)
    for (const name of ['first', 'second']) {
      const agent = await packages.findSubagentPackage(name)
      expect(await readFile(join(agent.directory!, 'tools/query/report.txt'), 'utf8')).toBe('keep')
      expect(agent.system_prompt).toBe('Complete work.')
    }
    expect((await readdir(join(root, 'subagents'))).some(name => name.startsWith('.import'))).toBe(false)
  })

  it('does not import any selected package when a later one conflicts with an existing Agent', async () => {
    const existing = await addAgent('existing')
    const before = await readFile(join(existing, 'AGENT.json'), 'utf8')
    const fresh = join(root, 'incoming/fresh'), collision = join(root, 'incoming/collision')
    await packages.writeSubagentDefinition(fresh, agentDefinition('fresh'))
    await packages.writeSubagentDefinition(collision, agentDefinition('existing'))
    await expect(packages.importSubagentPackages([fresh, collision])).rejects.toThrow('already exists')
    expect((await packages.readSubagentPackages(root)).map(a => a.id)).toEqual(['general-purpose', 'existing'])
    expect(await readFile(join(existing, 'AGENT.json'), 'utf8')).toBe(before)
  })

  it('rejects imports beyond the directory limit without making the existing catalog unreadable', async () => {
    const destination = join(root, 'subagents')
    await Promise.all(Array.from({ length: 2046 }, (_, index) => writeFile(join(destination, `.retained-${index}`), 'keep')))
    const first = join(root, 'incoming/first'), second = join(root, 'incoming/second')
    await packages.writeSubagentDefinition(first, agentDefinition('first'))
    await packages.writeSubagentDefinition(second, agentDefinition('second'))
    const before = (await readdir(destination)).sort()
    await expect(packages.importSubagentPackages([first, second])).rejects.toThrow('limit of 2048')
    expect((await readdir(destination)).sort()).toEqual(before)
    expect((await packages.readSubagentPackages(root)).map(agent => agent.id)).toEqual(['general-purpose'])
    await packages.importSubagentPackages([first])
    expect((await packages.readSubagentPackages(root)).map(agent => agent.id)).toEqual(['general-purpose', 'first'])
  })

  it.each(['id', 'name'] as const)('rejects duplicate %s values within a multi-selection', async key => {
    const first = join(root, 'incoming/first'), second = join(root, 'incoming/second')
    await packages.writeSubagentDefinition(first, agentDefinition('first'))
    await packages.writeSubagentDefinition(second, { ...agentDefinition('second'), [key]: 'first' })
    await expect(packages.importSubagentPackages([first, second])).rejects.toThrow('already exists')
    expect((await packages.readSubagentPackages(root)).map(a => a.id)).toEqual(['general-purpose'])
  })

  it('keeps valid packages unpublished if a later package fails while copying', async () => {
    const first = join(root, 'incoming/first'), second = join(root, 'incoming/second')
    await packages.writeSubagentDefinition(first, agentDefinition('first'))
    await packages.writeSubagentDefinition(second, agentDefinition('second'))
    await symlink('PROMPT.md', join(second, 'alias'))
    await expect(packages.importSubagentPackages([first, second])).rejects.toThrow('regular files')
    expect(await readdir(join(root, 'subagents'))).toEqual(['_system'])
  })

  it('rolls back earlier packages when publishing a later package fails', async () => {
    const first = join(root, 'incoming/first'), second = join(root, 'incoming/second')
    await packages.writeSubagentDefinition(first, agentDefinition('first'))
    await packages.writeSubagentDefinition(second, agentDefinition('second'))
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    vi.doMock('node:fs/promises', () => ({ ...fs, rename: async (from: string, to: string) => {
      if (to === join(root, 'subagents/second')) throw new Error('Disk write failed')
      return fs.rename(from, to)
    } }))
    vi.resetModules()
    packages = await import('./subagentPackages')
    await expect(packages.importSubagentPackages([first, second])).rejects.toThrow('Disk write failed')
    expect(await readdir(join(root, 'subagents'))).toEqual(['_system'])
  })

  it('rejects the old array format without migrating, overwriting, or deleting it', async () => {
    const before = JSON.stringify({ version: 0, subagents: [agentDefinition('old')] })
    await writeFile(join(root, 'config/subagents.json'), before)
    await expect(packages.readSubagentPackages(root)).rejects.toThrow('Unsupported')
    await expect(packages.writeSubagentPackages([])).rejects.toThrow('Unsupported')
    expect(await readFile(join(root, 'config/subagents.json'), 'utf8')).toBe(before)
  })
})

describe('external Agent directories', () => {
  async function external(name = 'external') {
    const source = join(root, name)
    await packages.writeSubagentDefinition(join(source, 'reporter'), agentDefinition('reporter'))
    await addResources(join(source, 'reporter'))
    await packages.addExternalSubagentDirectory(source)
    const entry = (await packages.listSubagentRoots()).find(item => item.path === source)!
    return { source, entry, directory: join(source, 'reporter') }
  }

  it('defaults absent external roots to empty without changing existing settings', async () => {
    const value = { version: 1, disabled: ['general-purpose'] }
    await writeFile(join(root, 'config/subagents.json'), JSON.stringify(value))
    expect((await packages.readSubagentSettings()).external_directories).toEqual([])
    expect((await packages.findSubagentPackage('general-purpose')).enabled).toBe(false)
    expect(JSON.parse(await readFile(join(root, 'config/subagents.json'), 'utf8'))).toEqual(value)
  })

  it('references packages in place, edits definitions and files, and discovers private resources', async () => {
    const { entry, directory, source } = await external()
    expect(entry).toMatchObject({ kind: 'external', available: true, agentIds: ['reporter'], errors: [] })
    const agent = await packages.findSubagentPackage('reporter')
    expect(agent.directory).toBe(directory)
    expect((await tools.listSubagentTools(['reporter']))[0].directory).toBe(join(directory, 'tools/query'))
    expect((await skills.listSubagentSkills(['reporter'])).skills[0].dirPath).toBe(join(directory, 'skills/local-guide'))
    const before = await packages.readSubagentPackages(root)
    await packages.writeSubagentPackages(before.map(item => item.id === 'reporter' ? { ...item, system_prompt: 'Updated external prompt', enabled: false } : item), before)
    expect(await readFile(join(directory, 'PROMPT.md'), 'utf8')).toBe('Updated external prompt\n')
    expect(await readFile(join(directory, 'tools/query/report.txt'), 'utf8')).toBe('keep')
    const preview = await files.readSubagentFile('reporter', 'PROMPT.md')
    expect(preview.editable).toBe(true)
    await files.saveSubagentFile('reporter', 'PROMPT.md', { content: 'Edited file', resolvedPath: preview.resolvedPath, revision: preview.revision! })
    expect((await packages.findSubagentPackage('reporter')).system_prompt).toBe('Edited file')
    expect(await packages.packageExists(join(root, 'subagents/reporter'))).toBe(false)
    expect(await readdir(source)).toEqual(['reporter'])
    expect(await packages.packageExists(join(root, 'subagents/.transaction'))).toBe(false)
  })

  it('renames and orders references, and removes a reference without touching the package', async () => {
    const { entry, directory } = await external()
    const other = join(root, 'second')
    await mkdir(other)
    await packages.addExternalSubagentDirectory(other)
    const second = (await packages.listSubagentRoots()).at(-1)!
    await packages.updateExternalSubagentDirectory(entry.id, { name: 'Shared agents' })
    await packages.updateExternalSubagentDirectory(second.id, { direction: -1 })
    expect((await packages.listSubagentRoots()).slice(2).map(item => item.name)).toEqual(['second', 'Shared agents'])
    await packages.updateExternalSubagentDirectory(entry.id, { remove: true })
    await expect(packages.findSubagentPackage('reporter')).rejects.toThrow('unavailable')
    expect((await packages.readSubagentPackage(directory)).name).toBe('reporter')
    expect(await readFile(join(directory, 'tools/query/report.txt'), 'utf8')).toBe('keep')
  })

  it('retains offline package switches through unrelated edits, and reports missing or invalid packages', async () => {
    const { source, entry } = await external()
    const before = await packages.readSubagentPackages(root)
    await packages.writeSubagentPackages(before.map(item => item.id === 'reporter' ? { ...item, enabled: false } : item))
    await rename(source, `${source}-offline`)
    expect((await packages.listSubagentRoots()).find(item => item.id === entry.id)).toMatchObject({ available: false, issue: 'not_found', agentIds: [] })
    const available = await packages.readSubagentPackages(root)
    available[0].enabled = false
    await packages.writeSubagentPackages(available)
    await rename(`${source}-offline`, source)
    expect((await packages.findSubagentPackage('reporter')).enabled).toBe(false)
    await text(join(source, 'broken/AGENT.json'), '{}')
    const restored = (await packages.listSubagentRoots()).find(item => item.id === entry.id)!
    expect(restored.agentIds).toEqual(['reporter'])
    expect(restored.errors[0].path).toBe(join(source, 'broken'))
    expect((await packages.readSubagentPackages(root)).map(item => item.id)).toContain('reporter')
  })

  it('rejects overlapping roots and single-package roots, and reports duplicate identities without hiding local packages', async () => {
    const { source, directory, entry } = await external()
    await expect(packages.addExternalSubagentDirectory(source)).rejects.toThrow('overlaps')
    await expect(packages.addExternalSubagentDirectory(root)).rejects.toThrow('overlaps')
    await expect(packages.addExternalSubagentDirectory(join(root, 'subagents/_system'))).rejects.toThrow('overlaps')
    await expect(packages.addExternalSubagentDirectory(directory)).rejects.toThrow('parent directory')
    await packages.writeSubagentDefinition(join(source, 'duplicate'), { ...agentDefinition('general-purpose'), name: 'different-name' })
    expect((await packages.listSubagentRoots()).find(item => item.id === entry.id)?.errors[0].message).toContain('Duplicate')
    expect((await packages.findSubagentPackage('general-purpose')).preset).toBe('general-purpose')
  })

  it.each([false, true])('recovers external volume transaction with committed=%s', async committed => {
    const { directory, source, entry } = await external()
    const marker = join(root, 'subagents/.transaction')
    const payload = join(source, '.anas-subagent-recovery-test')
    await mkdir(marker); await mkdir(payload)
    const before = await readFile(join(root, 'config/subagents.json'), 'utf8')
    const after = JSON.stringify({ ...JSON.parse(before), revision: 'commit-external' })
    await rename(directory, join(payload, 'previous'))
    await packages.writeSubagentDefinition(directory, { ...agentDefinition('reporter'), system_prompt: 'Replacement' })
    await text(join(marker, 'transaction.json'), JSON.stringify({ version: 0, directory: 'reporter', hadPackage: true, remove: false, before, after,
      externalRootId: entry.id, stageId: 'recovery-test' }))
    if (committed) await writeFile(join(root, 'config/subagents.json'), after)
    expect((await packages.findSubagentPackage('reporter')).system_prompt).toBe(committed ? 'Replacement' : 'Complete work.')
    expect(await packages.packageExists(payload)).toBe(false)
    expect(await packages.packageExists(marker)).toBe(false)
  })

  it('does not replay external filesystem transactions while validating a backup', async () => {
    const { directory, source, entry } = await external()
    const backup = join(root, 'backup')
    const payload = join(source, '.anas-subagent-retained')
    await mkdir(payload)
    const before = await readFile(join(root, 'config/subagents.json'), 'utf8')
    const after = JSON.stringify({ ...JSON.parse(before), revision: 'backup-commit' })
    await rename(directory, join(payload, 'previous'))
    await text(join(backup, 'config/subagents.json'), before)
    await text(join(backup, 'subagents/.transaction/transaction.json'), JSON.stringify({ version: 0, directory: 'reporter', hadPackage: true, remove: false, before, after,
      externalRootId: entry.id, stageId: 'retained' }))
    await expect(packages.readSubagentPackages(backup)).rejects.toThrow('original data directory')
    expect(await packages.packageExists(join(payload, 'previous'))).toBe(true)
    expect(await packages.packageExists(directory)).toBe(false)
  })

  it('deletes an external package only when the Agent itself is deleted', async () => {
    const { directory, entry } = await external()
    const before = await packages.readSubagentPackages(root)
    await packages.writeSubagentPackages(before.filter(agent => agent.id !== 'reporter'), before)
    expect(await packages.packageExists(directory)).toBe(false)
    expect((await packages.listSubagentRoots()).find(item => item.id === entry.id)?.agentIds).toEqual([])
  })
})
