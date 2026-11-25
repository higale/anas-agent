import { defaultCapabilities } from '@shared/agentCapabilities'
import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { presentConversationMessage } from './agent/conversationPresentation'

const tempDirs: string[] = []
const trashItem = vi.hoisted(() => vi.fn<(path: string) => Promise<void>>())
vi.mock('electron', () => ({ shell: { trashItem } }))

function skillText(name: string, description = `${name} description`, body = `Use ${name}.`): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`
}

async function writeText(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content, 'utf8')
}

async function writeSkill(parent: string, name: string): Promise<string> {
  const path = join(parent, name)
  await writeText(join(path, 'SKILL.md'), skillText(name))
  return path
}

async function loadSkillsStore(externalDirectories: unknown[] = []) {
  vi.resetModules()
  const root = await mkdtemp(join(tmpdir(), 'anas-skills-'))
  tempDirs.push(root)
  trashItem.mockReset().mockImplementation(async path => {
    const trash = join(root, 'trash')
    await mkdir(trash, { recursive: true })
    await rename(path, join(trash, basename(path)))
  })
  const bundledDataDir = join(root, 'bundled-data')
  const bundledConfigDir = join(root, 'bundled-config')
  const configDir = join(root, 'config')
  const skillsDir = join(root, 'skills')
  const systemDir = join(bundledDataDir, 'skills')
  const examplesDir = join(root, 'examples/skills')
  const workspace = join(root, 'workspace')
  const projectCapabilities = structuredClone(defaultCapabilities)
  const projectSettings: { skillDirectories?: string[] } = { }
  await Promise.all([
    mkdir(join(bundledDataDir, 'skills'), { recursive: true }),
    mkdir(join(bundledDataDir, 'examples/skills'), { recursive: true }),
    mkdir(skillsDir, { recursive: true }),
    mkdir(workspace, { recursive: true }),
    writeText(join(bundledConfigDir, 'skills.json'), `${JSON.stringify({ version: 0, external_directories: externalDirectories, availability: {} }, null, 2)}\n`)
  ])
  vi.doMock('./config/dataDir', () => ({
    skillsConfigFileName: 'skills.json',
    getBundledConfigFile: (name: string) => join(bundledConfigDir, name),
    getBundledDataDir: () => bundledDataDir,
    getBundledExamplesDir: () => dirname(examplesDir),
    getConfigFile: (name: string) => join(configDir, name),
    getSkillExamplesDir: () => examplesDir,
    getSkillsDir: () => skillsDir,
    getDataDir: () => root,
    getSystemSkillsDir: () => systemDir
  }))
  vi.doMock('./config/appConfig', () => ({ getAppConfigSnapshot: async () => ({ customTools: [] }) }))
  vi.doMock('./projectStore', () => ({
    getProject: async (id: string) => ({
 capabilities: projectCapabilities, restrictSubagents: false, ...projectSettings, prompt: '', id, name: 'Test', sourceFolders: [workspace] })
  }))
  return {
    projectCapabilities,
    projectSettings,
    root,
    bundledSystemDir: join(bundledDataDir, 'skills'),
    bundledExamplesDir: join(bundledDataDir, 'examples/skills'),
    configFile: join(configDir, 'skills.json'),
    examplesDir,
    skillsDir,
    systemDir,
    workspace,
    store: await import('./skillsStore')
  }
}

afterEach(async () => {
  vi.doUnmock('node:fs/promises')
  vi.doUnmock('./renameDirectoryExclusive')
  vi.doUnmock('./config/dataDir')
  vi.doUnmock('./projectStore')
  vi.doUnmock('./config/appConfig')
  vi.resetModules()
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('skillsStore', () => {
  it('keeps bundled project and saved external references unavailable without rewriting configuration', async () => {
    const h = await loadSkillsStore()
    await writeSkill(h.systemDir, 'bundled-guide')
    await writeSkill(h.examplesDir, 'example-guide')
    const alias = join(h.root, 'bundle-alias')
    await symlink(h.systemDir, alias, process.platform === 'win32' ? 'junction' : 'dir')
    await h.store.initializeSkillsStore()
    const saved = JSON.stringify({ ...JSON.parse(await readFile(h.configFile, 'utf8')),
      external_directories: [{ id: 'saved-bundle', name: 'Bundle', shortcut_alias: 'bundle', path: alias }] })
    await writeFile(h.configFile, saved)
    h.projectSettings.skillDirectories = [h.systemDir, h.examplesDir, alias, dirname(h.systemDir)]
    const snapshot = await h.store.listSkillSnapshot('project')
    expect(snapshot.roots.filter(item => item.kind === 'project' || item.kind === 'external').every(item => !item.available)).toBe(true)
    expect(snapshot.skills.map(item => item.id)).toEqual(['system:bundled-guide'])
    expect((await h.store.readSkillFile('project', 'system:bundled-guide', 'SKILL.md')).editable).toBe(false)
    await expect(h.store.saveSkillFile('project', 'system:bundled-guide', 'SKILL.md', {} as never)).rejects.toThrow('read-only')
    await expect(h.store.addExternalSkillDirectory(alias)).rejects.toThrow('already managed')
    await expect(h.store.addExternalSkillDirectory(dirname(h.systemDir))).rejects.toThrow('already managed')
    expect(await readFile(h.configFile, 'utf8')).toBe(saved)
    await h.store.importSkillDirectories([join(h.examplesDir, 'example-guide')])
    const user = (await h.store.listSkillSnapshot()).skills.find(item => item.source === 'user')!
    expect((await h.store.readSkillFile(undefined, user.id, 'SKILL.md')).editable).toBe(true)
  })

  it.each([1024, 1025, 1510])('keeps a %i-character description usable through import, model context, shortcuts, editing, and restore', async length => {
    const h = await loadSkillsStore()
    const description = '长'.repeat(length)
    const source = join(h.root, 'import', 'long-description')
    const content = skillText('long-description', description)
    await writeText(join(source, 'SKILL.md'), content)
    await h.store.importSkillDirectories([source])
    const skill = (await h.store.listSkillSnapshot()).skills.find(item => item.name === 'long-description')!
    expect(skill).toMatchObject({ description, modelAvailable: true, userAvailable: true, shortcut: '/long-description' })
    expect(skill.loadError).toBeUndefined()
    expect(await h.store.buildSkillsPrompt({ agent: { kind: 'main' }, selection: defaultCapabilities.skills })).toContain(description)
    expect((await h.store.buildUserSkillInvocation(undefined, skill.name, undefined, 'Use it')).promptText).toContain(content)
    const before = await h.store.readSkillFile(undefined, skill.id, 'SKILL.md')
    const edited = skillText(skill.name, `${description}更长`)
    await h.store.saveSkillFile(undefined, skill.id, 'SKILL.md', {
      content: edited, revision: before.revision!, resolvedPath: before.resolvedPath
    })
    expect(await readFile(join(skill.dirPath, 'SKILL.md'), 'utf8')).toBe(edited)
    await expect(h.store.validateRestoredSkillsDirectory(h.skillsDir, true)).resolves.toBeUndefined()
    await h.store.updateSkillAvailability(undefined, skill.id, { modelAvailable: false, userAvailable: false })
    const disabled = (await h.store.listSkillSnapshot()).skills.find(item => item.id === skill.id)!
    expect(disabled).toMatchObject({ description: `${description}更长`, modelAvailable: false, userAvailable: false })
    expect(disabled.loadError).toBeUndefined()
    expect(await h.store.buildSkillsPrompt({ agent: { kind: 'main' }, selection: defaultCapabilities.skills })).not.toContain(description)
    expect(await h.store.buildUserSkillInvocation(undefined, skill.name, undefined, '')).toMatchObject({ errorCode: 'user_unavailable' })
  })

  it('discovers project-only custom roots, previews unsaved changes, and preserves local-first precedence and explicit shortcuts', async () => {
    const h = await loadSkillsStore()
    const first = join(h.root, 'custom-one')
    const second = join(h.root, 'custom-two')
    await writeSkill(join(h.workspace, '.agents/skills'), 'shared')
    await writeSkill(first, 'shared')
    await writeSkill(first, 'custom')
    await writeSkill(second, 'custom')
    await writeSkill(h.skillsDir, 'custom')
    expect((await h.store.listSkillSnapshot('project')).skills.some(skill => skill.source === 'project')).toBe(false)
    h.projectSettings.skillDirectories = [first, second]
    const snapshot = await h.store.listSkillSnapshot('project')
    const custom = snapshot.skills.find(skill => skill.name === 'custom' && skill.rootName === 'custom-one')!
    expect(custom).toMatchObject({ source: 'project', modelAvailable: true, userAvailable: true, shortcut: '/custom' })
    expect(custom.modelShadowedBy).toBeUndefined()
    expect(snapshot.skills.find(skill => skill.name === 'shared' && skill.rootName === 'custom-one')?.modelShadowedBy).toBeUndefined()
    expect(snapshot.skills.find(skill => skill.name === 'custom' && skill.rootName === 'custom-two')?.modelShadowedBy).toBe('custom-one')
    expect(snapshot.skills.find(skill => skill.name === 'custom' && skill.source === 'user')?.modelShadowedBy).toBe('custom-one')
    expect((await h.store.listSkillSnapshot()).skills.some(skill => skill.source === 'project')).toBe(false)
    expect((await h.store.listSkillSnapshot('project', [])).skills.some(skill => skill.id === custom.id)).toBe(false)
    expect((await h.store.listSkillSnapshot('project', [second, first])).skills.find(skill => skill.id === custom.id)?.modelShadowedBy).toBe('custom-two')
    const preview = await h.store.buildSkillsPrompt({ agent: { kind: 'main' }, projectId: 'project', selection: defaultCapabilities.skills, pluginTools: [], skillDirectories: [second] })
    expect(preview).toContain(join(second, 'custom', 'SKILL.md'))
    expect(preview).not.toContain(join(first, 'custom', 'SKILL.md'))
    const explicit = await h.store.buildUserSkillInvocation('project', 'shared', 'project-custom-one', 'Use this')
    expect(explicit.promptText).toContain(join(first, 'shared', 'SKILL.md'))
    expect((await h.store.listSkillSnapshot('project')).skills.find(skill => skill.id === custom.id)?.modelShadowedBy).toBeUndefined()
  })

  it('retains unavailable roots and preserves each aliased source identity', async () => {
    const h = await loadSkillsStore()
    const root = join(h.root, 'custom')
    await writeSkill(root, 'guide')
    const alias = join(h.root, 'custom-alias')
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const missing = join(h.root, 'offline')
    const snapshot = await h.store.listSkillSnapshot('project', [root, alias, missing])
    const guides = snapshot.skills.filter(skill => skill.name === 'guide')
    expect(guides).toHaveLength(2)
    expect(new Set(guides.map(skill => skill.id)).size).toBe(2)
    expect(guides.map(skill => skill.dirPath)).toEqual([join(root, 'guide'), join(alias, 'guide')])
    expect(snapshot.roots.find(item => item.path === missing)).toMatchObject({ kind: 'project', removable: true, available: false, issue: 'not_found' })
    expect(snapshot.roots.find(item => item.path === alias)).toMatchObject({ removable: true, available: true })
    await expect(h.store.listSkillSnapshot('project', ['relative'])).rejects.toThrow('absolute')
  })

  it.each(['default', 'custom'] as const)('preserves %s user selections and explicit aliases when a project references the same directory', async mode => {
    const h = await loadSkillsStore()
    const directory = await writeSkill(h.skillsDir, 'guide')
    h.projectCapabilities.skills = { mode, project: false, entries: [{ id: 'user:guide', model: true, shortcut: true }] }
    expect((await h.store.buildUserSkillInvocation('project', 'guide', 'user', 'check')).promptText).toContain('Use guide.')
    h.projectSettings.skillDirectories = [h.skillsDir]
    const snapshot = await h.store.listSkillSnapshot('project')
    const projectSkill = snapshot.skills.find(skill => skill.name === 'guide' && skill.source === 'project')!
    expect(snapshot.skills.find(skill => skill.id === 'user:guide')).toBeDefined()
    expect((await h.store.buildUserSkillInvocation('project', 'guide', 'user', 'check')).promptText).toContain('Use guide.')
    expect(await h.store.buildSkillsPrompt({ agent: { kind: 'main' }, projectId: 'project', selection: h.projectCapabilities.skills })).toContain(join(directory, 'SKILL.md'))
    await h.store.updateSkillAvailability(undefined, 'user:guide', { modelAvailable: false, userAvailable: false })
    expect(await h.store.buildUserSkillInvocation('project', 'guide', 'user', 'check')).toMatchObject({ errorCode: 'user_unavailable' })
    h.projectCapabilities.skills = { mode: 'custom', project: false, entries: [{ id: projectSkill.id, model: true, shortcut: true }] }
    expect((await h.store.buildUserSkillInvocation('project', 'guide', projectSkill.shortcutAlias, 'check')).promptText).toContain('Use guide.')
  })

  it('reads bundled skills directly and preserves ignored legacy copies during startup and restore', async () => {
    const h = await loadSkillsStore()
    await writeSkill(h.bundledSystemDir, 'system-guide')
    await writeSkill(h.skillsDir, 'personal-guide')
    await writeText(join(h.skillsDir, '_system/stale/SKILL.md'), skillText('stale'))
    const snapshot = await h.store.listSkillSnapshot()
    expect(snapshot.skills.map(skill => skill.id).sort()).toEqual(['system:system-guide', 'user:personal-guide'])
    expect(snapshot.skills.every(skill => !skill.loadError)).toBe(true)
    expect(await readFile(join(h.skillsDir, '_system/stale/SKILL.md'), 'utf8')).toBe(skillText('stale'))
    await expect(h.store.validateRestoredSkillsDirectory(h.skillsDir, true)).resolves.toBeUndefined()
    await expect(h.store.addExternalSkillDirectory(h.systemDir)).rejects.toThrow('already managed')
    expect(await readFile(join(h.skillsDir, 'personal-guide/SKILL.md'), 'utf8')).toContain('personal-guide')
  })

  it.each(['skill-fixture', 'subagent'])('keeps plugin %s separate from subagent grants across shortcut modes', async id => {
    const h = await loadSkillsStore()
    const source = join(h.root, 'plugin-source')
    await writeText(join(source, 'skills/guide/SKILL.md'), skillText('guide', 'Plugin guide', 'Use plugin instructions.'))
    await writeText(join(source, 'PLUGIN.json'), JSON.stringify({ version: 0, id, name: 'Plugin guide', plugin_version: '1.0.0', api_version: 2,
      skills: [{ id: 'guide', path: 'skills/guide/SKILL.md' }] }))
    const { store: plugins } = (await import('./plugins/pluginRuntime')).pluginRuntime()
    await plugins.install(join(source, 'PLUGIN.json'))
    h.projectCapabilities.skills.entries = [
      { id: `${id}:skill:guide`, shortcut: true, model: true },
      { id: 'subagent:missing:skill:guide', shortcut: false, model: true }
    ]
    for (const mode of ['default', 'custom'] as const) {
      h.projectCapabilities.pluginMode = mode
      for (const ordinaryMode of ['default', 'custom', 'off'] as const) {
        h.projectCapabilities.skills.mode = ordinaryMode
        for (const alias of [undefined, `plugin:${id}`]) {
          expect((await h.store.buildUserSkillInvocation('project', 'guide', alias, 'check')).promptText).toContain('Use plugin instructions.')
        }
      }
    }
    h.projectCapabilities.pluginMode = 'off'
    expect(await h.store.buildUserSkillInvocation('project', 'guide', `plugin:${id}`, '')).toMatchObject({ errorCode: 'user_unavailable' })
  })

  it.each(['plugin', 'tool'] as const)('saves usage choices while the %s is disabled without enabling execution', async kind => {
    const h = await loadSkillsStore()
    const source = join(h.root, 'plugin-source')
    await writeText(join(source, 'skills/guide/SKILL.md'), skillText('guide'))
    await writeText(join(source, 'backend.cjs'), 'throw new Error("Must not execute plugin code.")')
    await writeText(join(source, 'PLUGIN.json'), JSON.stringify({ version: 0, id: 'skill-fixture', name: 'Skill fixture', plugin_version: '1.0.0', api_version: 2,
      backend: 'backend.cjs', tools: [{ id: 'echo', handler: 'echo', description: 'Echo', input_schema: { type: 'object' }, effect: 'read' }],
      skills: [{ id: 'guide', path: 'skills/guide/SKILL.md', tools: ['echo'] }] }))
    const { store: plugins } = (await import('./plugins/pluginRuntime')).pluginRuntime()
    await plugins.install(join(source, 'PLUGIN.json'))
    if (kind === 'plugin') await plugins.setEnabled('skill-fixture', false)
    else await plugins.setCapabilityEnabled('skill-fixture', 'tool', ['echo'], false)
    const skillId = 'skill-fixture:skill:guide'
    for (const [field, value] of [['userAvailable', false], ['userAvailable', true], ['modelAvailable', false], ['modelAvailable', true]] as const) {
      const updated = await h.store.updateSkillAvailability(undefined, skillId, { [field]: value })
      const configured = { modelAvailable: true, userAvailable: true, [field]: value }
      expect(updated.skills.find(skill => skill.id === skillId)).toMatchObject({
        modelAvailable: false, userAvailable: false, configuredAvailability: configured
      })
      expect(JSON.parse(await readFile(h.configFile, 'utf8')).availability[skillId]).toEqual({
        model_available: configured.modelAvailable, user_available: configured.userAvailable
      })
      expect((await h.store.buildUserSkillInvocation('project', 'guide', 'plugin:skill-fixture', '')).promptText).toBe('')
      expect(await h.store.buildSkillsPrompt({ agent: { kind: 'main' }, projectId: 'project', pluginTools: ['skill-fixture:tool:echo'] })).toBe('')
    }
    if (kind === 'plugin') await plugins.setEnabled('skill-fixture', true)
    else await plugins.setCapabilityEnabled('skill-fixture', 'tool', ['echo'], true)
    expect((await h.store.listSkillSnapshot()).skills.find(skill => skill.id === skillId)).toMatchObject({ modelAvailable: true, userAvailable: true })
    expect((await h.store.buildUserSkillInvocation('project', 'guide', 'plugin:skill-fixture', '')).promptText).toContain('Use guide.')
  })

  it('uses plugin files in place, preserves ordinary skill precedence and checks tool dependencies for explicit calls', async () => {
    const h = await loadSkillsStore()
    const source = join(h.root, 'plugin-source')
    const original = skillText('duplicate', 'Plugin instructions', 'Keep this exact body.')
    await writeText(join(source, 'skills/duplicate/SKILL.md'), original)
    await writeText(join(source, 'skills/duplicate/script.py'), 'print(1)')
    await writeText(join(source, 'backend.cjs'), 'throw new Error("Static discovery must not execute this backend.")')
    await writeText(join(source, 'PLUGIN.json'), JSON.stringify({ version: 0, id: 'skill-fixture', name: 'Skill fixture', plugin_version: '1.0.0', api_version: 2,
      backend: 'backend.cjs', tools: [{ id: 'echo', handler: 'echo', description: 'Echo', input_schema: { type: 'object' }, effect: 'read' }],
      skills: [{ id: 'guide', path: 'skills/duplicate/SKILL.md', tools: ['echo'] }] }))
    const { store: plugins } = (await import('./plugins/pluginRuntime')).pluginRuntime()
    await plugins.install(join(source, 'PLUGIN.json'))
    await writeSkill(h.skillsDir, 'duplicate')
    const catalog = await h.store.listSkillSnapshot('project')
    const skill = catalog.skills.find(skill => skill.source === 'plugin')!
    expect(skill).toMatchObject({ id: 'skill-fixture:skill:guide', shortcutAlias: 'plugin:skill-fixture', modelShadowedBy: 'User', requiredTools: ['skill-fixture:tool:echo'], })
    expect(skill.dirPath).toBe(await realpath(join(h.root, 'plugins', 'skill-fixture', 'skills', 'duplicate')))
    expect((await h.store.readSkillFile('project', skill.id, 'SKILL.md')).editable).toBe(false)
    await expect(h.store.saveSkillFile('project', skill.id, 'SKILL.md', {} as never)).rejects.toThrow('read-only')
    expect((await h.store.buildUserSkillInvocation('project', 'duplicate', 'plugin:skill-fixture', 'check')).promptText).toContain(original)
    for (const kind of ['plugin', 'tool'] as const) {
      if (kind === 'plugin') await plugins.setEnabled('skill-fixture', false)
      else await plugins.setCapabilityEnabled('skill-fixture', 'tool', ['echo'], false)
      const disabled = (await h.store.listSkillSnapshot()).skills.find(item => item.id === skill.id)!
      expect(disabled).toMatchObject({ modelAvailable: false, userAvailable: false })
      expect((await h.store.buildUserSkillInvocation('project', 'duplicate', 'plugin:skill-fixture', 'check')).errorCode)
        .toBe(kind === 'plugin' ? 'source_not_found' : 'user_unavailable')
      if (kind === 'plugin') await plugins.setEnabled('skill-fixture', true)
      else await plugins.setCapabilityEnabled('skill-fixture', 'tool', ['echo'], true)
      expect((await h.store.buildUserSkillInvocation('project', 'duplicate', 'plugin:skill-fixture', 'check')).promptText).toContain(original)
    }
    h.projectCapabilities.pluginMode = 'off'
    expect(await h.store.buildUserSkillInvocation('project', 'duplicate', 'plugin:skill-fixture', 'check')).toMatchObject({ errorCode: 'user_unavailable' })
    await h.store.updateSkillAvailability(undefined, skill.id, { modelAvailable: true })
    h.projectCapabilities.pluginMode = 'custom'
    h.projectCapabilities.skills = { mode: 'off', project: false, entries: [{ id: skill.id, shortcut: true, model: true }] }
    expect(await h.store.buildUserSkillInvocation('project', 'duplicate', 'plugin:skill-fixture', 'check')).toMatchObject({ errorCode: 'tools_unavailable', missingTools: ['skill-fixture:tool:echo'] })
    h.projectCapabilities.pluginTools = ['skill-fixture:tool:echo']
    const invocation = await h.store.buildUserSkillInvocation('project', 'duplicate', 'plugin:skill-fixture', 'check')
    expect(invocation.promptText).toContain(original)
    expect(invocation.promptText).toContain('skill-fixture:tool:echo: plugin__skill-fixture__echo')
    const selection = h.projectCapabilities.skills
    expect(await h.store.buildSkillsPrompt({ agent: { kind: 'main' }, projectId: 'project', selection: selection })).toBe('')
    expect(await h.store.buildSkillsPrompt({ agent: { kind: 'main' }, projectId: 'project', selection: selection, pluginTools: h.projectCapabilities.pluginTools })).toContain('Plugin instructions')
    await plugins.setEnabled('skill-fixture', false)
    expect((await h.store.listSkillSnapshot('project')).skills.some(skill => skill.source === 'plugin')).toBe(false)
    await plugins.setEnabled('skill-fixture', true)
    expect((await h.store.listSkillSnapshot('project')).skills.find(skill => skill.source === 'plugin')?.id).toBe(skill.id)
    await writeText(join(source, 'skills/duplicate/SKILL.md'), skillText('duplicate', 'Updated instructions'))
    const replacement = await plugins.prepareInstall(join(source, 'PLUGIN.json'))
    await plugins.finishInstall(replacement.token, { replace: true })
    expect((await h.store.listSkillSnapshot('project')).skills.find(skill => skill.source === 'plugin')).toMatchObject({ id: skill.id, description: 'Updated instructions' })
    await plugins.uninstall('skill-fixture')
    expect((await h.store.listSkillSnapshot('project')).skills.some(skill => skill.source === 'plugin')).toBe(false)
  })
  it.each([true, 'retired-value'])('ignores retired script approval settings without rewriting files (%s)', async global => {
    const h = await loadSkillsStore()
    await writeSkill(h.skillsDir, 'query')
    await h.store.listSkillSnapshot()
    const config = JSON.parse(await readFile(h.configFile, 'utf8'))
    config.script_auto_approve = global
    config.script_auto_approve_skills = ['user:query', false]
    config.availability = { 'user:query': { model_available: false, user_available: true } }
    const before = JSON.stringify(config)
    await writeText(h.configFile, before)
    await expect(h.store.validateSkillsConfigFile(h.configFile)).resolves.toBeUndefined()
    const snapshot = await h.store.listSkillSnapshot()
    expect(snapshot.skills[0]).toMatchObject({ id: 'user:query', modelAvailable: false, userAvailable: true })
    expect(snapshot).not.toHaveProperty('scriptAutoApprove')
    expect(snapshot.skills[0]).not.toHaveProperty('scriptAutoApprove')
    expect(await readFile(h.configFile, 'utf8')).toBe(before)
    await h.store.updateSkillAvailability(undefined, 'user:query', { modelAvailable: true })
    const saved = JSON.parse(await readFile(h.configFile, 'utf8'))
    expect(saved).toMatchObject({ version: 0, external_directories: config.external_directories,
      availability: { 'user:query': { model_available: true, user_available: true } } })
    expect(saved).not.toHaveProperty('script_auto_approve')
    expect(saved).not.toHaveProperty('script_auto_approve_skills')
  })

  it('injects instructions with their resource directory and preserves the exact prompt in the UI projection', async () => {
    const fixture = await loadSkillsStore()
    const directory = join(fixture.skillsDir, 'summarize')
    const contents = skillText('summarize', 'Summary', 'Read references/style.md, then run scripts/run.py.')
    await writeText(join(directory, 'SKILL.md'), contents)
    await writeText(join(directory, 'references', 'style.md'), 'RESOURCE_BODY_ONLY_LOADED_ON_DEMAND')

    const invocation = await fixture.store.buildUserSkillInvocation(undefined, 'summarize', undefined, 'the report')
    expect(invocation.promptText).toContain(`<skill>\n<name>summarize</name>\n<path>${join(directory, 'SKILL.md')}</path>\n${contents}\n</skill>`)
    expect(invocation.promptText.startsWith('/summarize the report\n\n')).toBe(true)
    expect(invocation.promptText).not.toContain('RESOURCE_BODY_ONLY_LOADED_ON_DEMAND')
    const message = { kind: 'user' as const, content: invocation.promptText, context: { displayText: invocation.displayText } }
    const projected = presentConversationMessage(message, 'skill-message')
    expect(projected.content).toEqual([{ type: 'text', text: '/summarize the report' }])
    expect(projected.skillInvocation?.promptText).toBe(message.content)
    expect(projected.skillInvocation?.promptText).toBe(invocation.promptText)

    await writeText(join(directory, 'SKILL.md'), skillText('summarize', 'Summary', 'Updated instructions.'))
    const refreshed = await fixture.store.buildUserSkillInvocation(undefined, 'summarize', undefined, 'the report')
    expect(refreshed.promptText).toContain('Updated instructions.')
    expect(refreshed.promptText).not.toContain('Read references/style.md')
  })

  it.each(['\n', '\r\n'])('preserves the entire Skill file and keeps the user request outside it (%j)', async (newline) => {
    const fixture = await loadSkillsStore()
    const contents = '---\nname: arguments\ndescription: Arguments\ncompatibility: Python 3\nmetadata:\n  author: Example\n---\n\n    Keep indentation.\n$ARGUMENTS $0 $1 $ARGUMENTS[0] $HOME <example>\n\n'.replaceAll('\n', newline)
    await writeText(join(fixture.skillsDir, 'arguments', 'SKILL.md'), contents)
    const request = '用户需求  保留空格\n$ARGUMENTS $0 <example>\n/Users/tester/Desktop/报告 '
    const invocation = await fixture.store.buildUserSkillInvocation(undefined, 'arguments', undefined, request)
    expect(invocation.promptText.endsWith(`\n${contents}\n</skill>`)).toBe(true)
    expect(invocation.promptText.startsWith(`/arguments ${request}\n\n`)).toBe(true)
    expect(invocation.displayText).toBe(`/arguments ${request}`)
    const withoutRequest = await fixture.store.buildUserSkillInvocation(undefined, 'arguments', undefined, '')
    expect(withoutRequest.displayText).toBe('/arguments')
    expect(withoutRequest.promptText.endsWith(`\n${contents}\n</skill>`)).toBe(true)
    expect(withoutRequest.promptText).not.toContain('ARGUMENTS:')
  })

  it('rejects empty instructions', async () => {
    const fixture = await loadSkillsStore()
    const path = join(fixture.skillsDir, 'arguments', 'SKILL.md')
    await writeText(path, skillText('arguments', 'Arguments', '   '))
    await expect(fixture.store.buildUserSkillInvocation(undefined, 'arguments', undefined, '')).rejects.toThrow('empty')
  })

  it('exposes absolute file paths for available Skills, without installation configuration', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.bundledSystemDir, 'authoring-guide')
    await writeSkill(fixture.skillsDir, 'personal-guide')
    const unusedFolder = join(fixture.root, 'unused-project')
    const prompt = await fixture.store.buildSkillsPrompt({ agent: { kind: 'main' }, selection: defaultCapabilities.skills, skillDirectories: [unusedFolder] })
    expect(prompt).toContain('<skills_instructions>')
    expect(prompt).toContain(`(file: ${join(fixture.systemDir, 'authoring-guide', 'SKILL.md')})`)
    expect(prompt).toContain(`(file: ${join(fixture.skillsDir, 'personal-guide', 'SKILL.md')})`)
    expect(prompt).not.toContain(fixture.examplesDir)
    expect(prompt).not.toContain(unusedFolder)
    expect(prompt).not.toContain(fixture.workspace)
    expect(prompt).not.toContain('Anas Settings')
  })

  it('previews explicit draft skill directories and preserves skill identity after project creation', async () => {
    const fixture = await loadSkillsStore()
    const directory = join(fixture.workspace, '.agents', 'skills')
    await writeSkill(directory, 'draft-skill')
    expect((await fixture.store.listSkillSnapshot('new-project')).skills.some(skill => skill.source === 'project')).toBe(false)
    const preview = await fixture.store.listSkillSnapshot(undefined, [directory])
    const skill = preview.skills.find((item) => item.name === 'draft-skill')!
    expect(skill).toBeDefined()
    fixture.projectSettings.skillDirectories = [directory]
    const saved = await fixture.store.listSkillSnapshot('new-project')
    expect(saved.skills.find((item) => item.name === 'draft-skill')?.id).toBe(skill.id)
    const selection = { mode: 'custom' as const, project: false, entries: [{ id: skill.id, shortcut: true, model: true }] }
    await expect(fixture.store.buildSkillsPrompt({ agent: { kind: 'main' }, projectId: 'new-project', selection: selection })).resolves.toContain('draft-skill')

    const replacement = join(fixture.root, 'replacement')
    await writeSkill(replacement, 'replacement-skill')
    const edited = await fixture.store.listSkillSnapshot('new-project', [replacement])
    expect(edited.skills.map((item) => item.name)).toContain('replacement-skill')
    expect(edited.skills.map((item) => item.name)).not.toContain('draft-skill')
    const draftPrompt = await fixture.store.buildSkillsPrompt({ agent: { kind: 'main' }, projectId: 'new-project', selection: defaultCapabilities.skills, skillDirectories: [replacement] })
    expect(draftPrompt).toContain('replacement-skill')
    expect(draftPrompt).not.toContain('draft-skill')
    const cleared = await fixture.store.listSkillSnapshot('new-project', [])
    expect(cleared.roots.some((root) => root.kind === 'project')).toBe(false)
    await expect(fixture.store.listSkillSnapshot(undefined, ['relative-folder'])).rejects.toThrow('absolute directory paths')
  })

  it.each([['relative-folder'], [null], null])('rejects invalid resource directory references %j', async directories => {
    const fixture = await loadSkillsStore()
    await expect(fixture.store.listSkillSnapshot('project', directories as string[])).rejects.toThrow('absolute directory paths')
  })

  it('supports project shortcut-only overrides and disables both paths with the Skill capability', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'shortcut-only')
    const skill = (await fixture.store.listSkillSnapshot()).skills.find((item) => item.name === 'shortcut-only')!
    await fixture.store.updateSkillAvailability(undefined, skill.id, { modelAvailable: false, userAvailable: true })
    fixture.projectCapabilities.skills = { mode: 'custom', project: false, entries: [{ id: skill.id, shortcut: true, model: false }] }
    const invocation = await fixture.store.buildUserSkillInvocation('project-1', skill.name, undefined, 'details')
    expect(invocation).toMatchObject({ handled: true, promptText: expect.stringContaining('SKILL.md') })
    expect(invocation.promptText).toContain(`<path>${join(fixture.skillsDir, 'shortcut-only', 'SKILL.md')}</path>`)
    const shortcutPrompt = await fixture.store.buildSkillsPrompt({ agent: { kind: 'main' }, projectId: 'project-1', selection: fixture.projectCapabilities.skills })
    expect(shortcutPrompt).toContain('### How to use skills')
    expect(shortcutPrompt).not.toContain('shortcut-only')
    fixture.projectCapabilities.skills.mode = 'off'
    await expect(fixture.store.buildUserSkillInvocation('project-1', skill.name, undefined, '')).resolves.toMatchObject({ errorCode: 'user_unavailable' })
    await expect(fixture.store.buildSkillsPrompt({ agent: { kind: 'main' }, projectId: 'project-1', selection: fixture.projectCapabilities.skills })).resolves.toBe('')
  })
  it('shares one configuration initialization across simultaneous catalog and prompt reads', async () => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let releaseCopy!: () => void
    const copyAllowed = new Promise<void>((resolve) => { releaseCopy = resolve })
    let notifyCopyStarted!: () => void
    const copyStarted = new Promise<void>((resolve) => { notifyCopyStarted = resolve })
    const copyConfig = vi.fn(async (...args: Parameters<typeof fs.copyFile>) => {
      notifyCopyStarted()
      await copyAllowed
      return fs.copyFile(...args)
    })
    const probe = vi.fn(fs.stat)
    vi.doMock('node:fs/promises', () => ({ ...fs, copyFile: copyConfig, stat: probe }))
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.bundledSystemDir, 'system-skill')
    const initialization = fixture.store.initializeSkillsStore()
    await copyStarted
    const settled = Promise.allSettled([
      initialization,
      fixture.store.initializeSkillsStore(),
      fixture.store.listSkillSnapshot(),
      fixture.store.listSkillSnapshot('project-id'),
      fixture.store.buildSkillsPrompt({ agent: { kind: 'main' } })
    ])
    try {
      releaseCopy()
      const results = await settled
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason
      }
      expect(copyConfig).toHaveBeenCalledOnce()
      expect(probe.mock.calls.filter(([path]) => path === fixture.configFile)).toHaveLength(1)
      expect(results[4]).toMatchObject({ status: 'fulfilled', value: expect.stringContaining('system-skill') })
      expect(JSON.parse(await readFile(fixture.configFile, 'utf8'))).toEqual({ version: 0, external_directories: [], availability: {} })
    } finally {
      releaseCopy()
      await settled
    }
  })

  it('retries initialization after correcting an invalid bundled skill without changing user files', async () => {
    const fixture = await loadSkillsStore()
    await writeText(join(fixture.systemDir, 'system-skill/SKILL.md'), 'invalid skill')
    await writeSkill(fixture.skillsDir, 'personal')
    await expect(fixture.store.initializeSkillsStore()).rejects.toThrow()
    await writeSkill(fixture.systemDir, 'system-skill')
    await fixture.store.initializeSkillsStore()
    expect((await fixture.store.listSkillSnapshot()).skills.map(skill => skill.id).sort()).toEqual(['system:system-skill', 'user:personal'])
    await expect(readFile(join(fixture.skillsDir, '_system/system-skill/SKILL.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('discovers system, Anas user, current-project, and configured external roots', async () => {
    const external = join(tmpdir(), `anas-external-${Date.now()}`)
    tempDirs.push(external)
    const fixture = await loadSkillsStore([{ id: 'external', name: 'External', shortcut_alias: 'external', path: external }])
    await Promise.all([
      writeSkill(fixture.bundledSystemDir, 'shared'),
      writeSkill(fixture.bundledExamplesDir, 'sample'),
      writeSkill(fixture.examplesDir, 'stale'),
      writeSkill(join(fixture.skillsDir, '_system'), 'stale-system'),
      writeSkill(fixture.skillsDir, 'user-one'),
      writeSkill(join(fixture.workspace, '.agents', 'skills'), 'project-one'),
      writeSkill(external, 'external-one')
    ])

    fixture.projectSettings.skillDirectories = [join(fixture.workspace, '.agents', 'skills')]
    const snapshot = await fixture.store.listSkillSnapshot('project-id')

    expect(snapshot.roots.map((root) => root.kind)).toEqual(['system', 'user', 'project', 'external'])
    expect(snapshot.skills.map((skill) => [skill.name, skill.source])).toEqual([
      ['project-one', 'project'],
      ['user-one', 'user'],
      ['external-one', 'external'],
      ['shared', 'system']
    ])
    // Example refresh belongs to the application lifecycle, not Skill discovery.
    await expect(readFile(join(fixture.examplesDir, 'sample', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(fixture.examplesDir, 'stale', 'SKILL.md'), 'utf8')).resolves.toContain('stale description')
    await expect(readFile(join(fixture.skillsDir, '_system/stale-system/SKILL.md'), 'utf8')).resolves.toContain('stale-system description')
  })

  it('treats a symlinked Skill directory as a first-class Skill', async () => {
    const fixture = await loadSkillsStore()
    const target = await writeSkill(join(fixture.root, 'targets'), 'linked-skill')
    await symlink(target, join(fixture.skillsDir, 'linked-skill'), 'dir')

    const snapshot = await fixture.store.listSkillSnapshot()
    const skill = snapshot.skills.find((item) => item.name === 'linked-skill')

    expect(skill).toMatchObject({ source: 'user', linked: true, linkTarget: target, resolvedDirPath: await realpath(target) })
    await expect(fixture.store.listSkillFiles(undefined, skill!.id)).resolves.toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'SKILL.md', kind: 'text' })
    ]))
  })

  it('accepts nested extension metadata that Anas does not consume', async () => {
    const fixture = await loadSkillsStore()
    await writeText(join(fixture.skillsDir, 'nested-metadata', 'SKILL.md'), `---
name: nested-metadata
description: Uses host-specific extension metadata.
metadata:
  version: "1.0.0"
  requires:
    bins: ["example"]
---
Body
`)

    const skill = (await fixture.store.listSkillSnapshot()).skills.find((item) => item.name === 'nested-metadata')

    expect(skill?.loadError).toBeUndefined()
  })

  it('browses file and directory symlinks even when their targets are outside the Skill root', async () => {
    const fixture = await loadSkillsStore()
    const skillDir = await writeSkill(fixture.skillsDir, 'linked-files')
    const outsideFile = join(fixture.root, 'outside', 'notes.txt')
    const outsideDir = join(fixture.root, 'outside', 'docs')
    await Promise.all([writeText(outsideFile, 'outside content'), writeText(join(outsideDir, 'guide.md'), 'guide')])
    await Promise.all([symlink(outsideFile, join(skillDir, 'notes.txt')), symlink(outsideDir, join(skillDir, 'docs'), 'dir')])
    const skill = (await fixture.store.listSkillSnapshot()).skills.find((item) => item.name === 'linked-files')!

    const files = await fixture.store.listSkillFiles(undefined, skill.id)
    expect(files).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'notes.txt', kind: 'symlink', resolvedPath: await realpath(outsideFile), linkDirectory: false }),
      expect.objectContaining({ name: 'docs', kind: 'symlink', resolvedPath: await realpath(outsideDir), linkDirectory: true })
    ]))
    await expect(fixture.store.readSkillFile(undefined, skill.id, 'notes.txt')).resolves.toMatchObject({ content: 'outside content', linkTarget: outsideFile, resolvedPath: await realpath(outsideFile) })
    await expect(fixture.store.listSkillFiles(undefined, skill.id, 'docs')).resolves.toEqual([expect.objectContaining({ name: 'guide.md' })])
  })

  it('resolves duplicate names separately for model and user availability', async () => {
    const external = join(tmpdir(), `anas-external-${Date.now()}`)
    tempDirs.push(external)
    const fixture = await loadSkillsStore([{ id: 'external', name: 'External', shortcut_alias: 'external', path: external }])
    await Promise.all([writeSkill(fixture.bundledSystemDir, 'duplicate'), writeSkill(fixture.skillsDir, 'duplicate'), writeSkill(external, 'duplicate')])
    let snapshot = await fixture.store.listSkillSnapshot()
    const userSkill = snapshot.skills.find((skill) => skill.source === 'user')!
    snapshot = await fixture.store.updateSkillAvailability(undefined, userSkill.id, { modelAvailable: false, userAvailable: true })

    expect(snapshot.skills.find((skill) => skill.source === 'user')).toMatchObject({ shortcut: '/duplicate', modelAvailable: false })
    expect(snapshot.skills.find((skill) => skill.source === 'external')).toMatchObject({ userShadowedBy: 'User' })
    expect(snapshot.skills.find((skill) => skill.source === 'external')?.modelShadowedBy).toBeUndefined()
    expect(JSON.parse(await readFile(fixture.configFile, 'utf8')).availability[userSkill.id]).toEqual({ model_available: false, user_available: true })
  })

  it('merges concurrent availability field updates without losing either change', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'toggle-skill')
    const skill = (await fixture.store.listSkillSnapshot()).skills.find((candidate) => candidate.name === 'toggle-skill')!

    await Promise.all([
      fixture.store.updateSkillAvailability(undefined, skill.id, { modelAvailable: false }),
      fixture.store.updateSkillAvailability(undefined, skill.id, { userAvailable: false })
    ])

    expect((await fixture.store.listSkillSnapshot()).skills.find((candidate) => candidate.id === skill.id)).toMatchObject({
      modelAvailable: false,
      userAvailable: false
    })
  })

  it('removes the shortcut when user availability is disabled', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.bundledSystemDir, 'system-only')
    let snapshot = await fixture.store.listSkillSnapshot()
    const skill = snapshot.skills.find((candidate) => candidate.name === 'system-only')!

    snapshot = await fixture.store.updateSkillAvailability(undefined, skill.id, { modelAvailable: true, userAvailable: false })

    expect(snapshot.skills.find((candidate) => candidate.id === skill.id)?.shortcut).toBeUndefined()
    await expect(fixture.store.buildUserSkillInvocation(undefined, 'system-only', 'system', '')).resolves.toMatchObject({
      handled: true,
      errorCode: 'user_unavailable'
    })
  })

  it('keeps globally disabled Skills out of explicit project and subagent selections', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'subagent-only')
    const skill = (await fixture.store.listSkillSnapshot()).skills.find((candidate) => candidate.name === 'subagent-only')!
    await fixture.store.updateSkillAvailability(undefined, skill.id, {
      modelAvailable: false,
      userAvailable: false
    })

    await expect(fixture.store.buildSkillsPrompt({ agent: { kind: 'main' } })).resolves.not.toContain('subagent-only')
    await expect(fixture.store.buildSkillsPrompt({ agent: { kind: 'main' }, selection: { mode: 'custom', project: false, entries: [{ id: skill.id, model: true, shortcut: false }] } })).resolves.not.toContain(
      `(file: ${join(fixture.skillsDir, 'subagent-only', 'SKILL.md')})`
    )
  })

  it('uses saved project skill choices directly', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'example')
    fixture.projectCapabilities.skills.mode = 'off'
    await expect(fixture.store.buildUserSkillInvocation('project', 'example', undefined, '')).resolves.toMatchObject({ errorCode: 'user_unavailable' })
    fixture.projectCapabilities.skills.mode = 'default'
    await expect(fixture.store.buildUserSkillInvocation('project', 'example', undefined, '')).resolves.toMatchObject({ promptText: expect.stringContaining('SKILL.md') })
  })

  it('supports qualified shortcuts and keeps an unqualified shortcut on the highest-priority user-visible Skill', async () => {
    const external = join(tmpdir(), `anas-external-${Date.now()}`)
    tempDirs.push(external)
    const fixture = await loadSkillsStore([{ id: 'external', name: 'External', shortcut_alias: 'external', path: external }])
    await Promise.all([
      writeText(join(fixture.skillsDir, 'duplicate', 'SKILL.md'), skillText('duplicate', 'User', 'USER_SOURCE $ARGUMENTS')),
      writeText(join(external, 'duplicate', 'SKILL.md'), skillText('duplicate', 'External', 'EXTERNAL_SOURCE $ARGUMENTS'))
    ])

    const unqualified = await fixture.store.buildUserSkillInvocation(undefined, 'duplicate', undefined, 'one')
    const qualified = await fixture.store.buildUserSkillInvocation(undefined, 'duplicate', 'external', 'two')

    expect(unqualified.displayText).toBe('/duplicate one')
    expect(unqualified.promptText).toContain(join(fixture.skillsDir, 'duplicate', 'SKILL.md'))
    expect(unqualified.promptText).toContain('USER_SOURCE $ARGUMENTS')
    expect(unqualified.promptText.startsWith('/duplicate one\n\n')).toBe(true)
    expect(unqualified.promptText).not.toContain('EXTERNAL_SOURCE')
    expect(qualified.displayText).toBe('/duplicate@external two')
    expect(qualified.promptText).toContain(join(external, 'duplicate', 'SKILL.md'))
    expect(qualified.promptText).toContain('EXTERNAL_SOURCE $ARGUMENTS')
    expect(qualified.promptText.startsWith('/duplicate@external two\n\n')).toBe(true)
    expect(qualified.promptText).not.toContain('USER_SOURCE')
  })

  it('distinguishes a missing source from a Skill missing within an existing source', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'user-only')

    await expect(fixture.store.buildUserSkillInvocation(undefined, 'user-only', 'missing', '')).resolves.toMatchObject({
      handled: true,
      errorCode: 'source_not_found'
    })
    await expect(fixture.store.buildUserSkillInvocation(undefined, 'user-only', 'system', '')).resolves.toMatchObject({
      handled: true,
      errorCode: 'source_skill_not_found'
    })
  })

  it('rejects oversized SKILL.md content without reading it into the catalog', async () => {
    const fixture = await loadSkillsStore()
    await writeText(join(fixture.skillsDir, 'oversized', 'SKILL.md'), `${skillText('oversized')} ${'x'.repeat(1024 * 1024)}`)

    const skill = (await fixture.store.listSkillSnapshot()).skills.find((candidate) => candidate.name === 'oversized')

    expect(skill?.loadError).toMatchObject({ code: 'unreadable_skill_file' })
  })

  it('adds, reorders, and removes external roots without modifying their contents', async () => {
    const fixture = await loadSkillsStore()
    const first = join(fixture.root, 'first-root')
    const second = join(fixture.root, 'second-root')
    await Promise.all([writeSkill(first, 'first-skill'), writeSkill(second, 'second-skill')])

    await fixture.store.addExternalSkillDirectory(first)
    let snapshot = await fixture.store.addExternalSkillDirectory(second)
    const externalRoots = snapshot.roots.filter((root) => root.kind === 'external')
    expect(externalRoots.map((root) => root.path)).toEqual([first, second])

    snapshot = await fixture.store.updateExternalSkillDirectory(externalRoots[1].id, { name: 'Personal Skills', shortcutAlias: 'personal' })
    expect(snapshot.roots.find((root) => root.id === externalRoots[1].id)).toMatchObject({
      name: 'Personal Skills',
      shortcutAlias: 'personal',
      path: second
    })
    expect(JSON.parse(await readFile(fixture.configFile, 'utf8')).external_directories[1]).toMatchObject({
      name: 'Personal Skills',
      shortcut_alias: 'personal',
      path: second
    })
    await expect(fixture.store.buildUserSkillInvocation(undefined, 'second-skill', 'personal', '')).resolves.toMatchObject({
      displayText: '/second-skill@personal',
      promptText: expect.stringContaining(join(second, 'second-skill', 'SKILL.md'))
    })

    snapshot = await fixture.store.moveExternalSkillDirectory(externalRoots[1].id, -1)
    expect(snapshot.roots.filter((root) => root.kind === 'external').map((root) => root.path)).toEqual([second, first])

    snapshot = await fixture.store.removeExternalSkillDirectory(externalRoots[0].id)
    expect(snapshot.roots.filter((root) => root.kind === 'external').map((root) => root.path)).toEqual([second])
    await expect(readFile(join(first, 'first-skill', 'SKILL.md'), 'utf8')).resolves.toContain('first-skill')
  })

  it('imports multiple selected Skill directories into Anas User', async () => {
    const fixture = await loadSkillsStore()
    const first = await writeSkill(join(fixture.root, 'imports'), 'first-import')
    const second = await writeSkill(join(fixture.root, 'imports'), 'second-import')
    await writeText(join(second, 'references', 'guide.md'), 'Imported reference')

    const result = await fixture.store.importSkillDirectories([first, second])

    expect(result.names).toEqual(['first-import', 'second-import'])
    expect(result.failures).toEqual([])
    expect((await fixture.store.listSkillSnapshot()).skills.filter((skill) => skill.source === 'user').map((skill) => skill.name)).toEqual([
      'first-import',
      'second-import'
    ])
    await expect(readFile(join(fixture.skillsDir, 'second-import', 'references', 'guide.md'), 'utf8')).resolves.toBe('Imported reference')
    const firstPath = `(file: ${join(fixture.skillsDir, 'first-import', 'SKILL.md')})`
    const secondPath = `(file: ${join(fixture.skillsDir, 'second-import', 'SKILL.md')})`
    const defaultPrompt = await fixture.store.buildSkillsPrompt({ agent: { kind: 'main' } })
    expect(defaultPrompt).toContain(firstPath)
    expect(defaultPrompt).toContain(secondPath)
    const customPrompt = await fixture.store.buildSkillsPrompt({ agent: { kind: 'main' }, selection: {
      mode: 'custom', project: false,
      entries: [{ id: 'user:first-import', model: true, shortcut: true }]
    } })
    expect(customPrompt).toContain(firstPath)
    expect(customPrompt).not.toContain(secondPath)
  })

  it('imports the source manifest, binary files, hidden files and linked folders as independent editable contents', async () => {
    const h = await loadSkillsStore()
    const source = join(h.examplesDir, 'manual'), assets = join(h.root, 'assets')
    await mkdir(source, { recursive: true })
    await writeText(join(assets, 'guide.md'), skillText('manual', 'Original'))
    await writeText(join(h.skillsDir, 'shared', 'guide.md'), skillText('manual', 'Different destination sibling'))
    await symlink(assets, join(h.examplesDir, 'shared'), process.platform === 'win32' ? 'junction' : 'dir')
    await symlink('../shared/guide.md', join(source, 'SKILL.md'), 'file')
    await symlink(assets, join(source, 'guides'), process.platform === 'win32' ? 'junction' : 'dir')
    await mkdir(join(assets, '.empty'))
    await writeFile(join(assets, 'helper.bin'), Buffer.from([0, 255, 1]))
    await chmod(join(assets, 'helper.bin'), 0o555)
    await chmod(join(assets, 'guide.md'), 0o444)
    expect(await h.store.importSkillDirectories([source])).toEqual({ names: ['manual'], failures: [] })
    const installed = join(h.skillsDir, 'manual')
    expect((await lstat(join(installed, 'SKILL.md'))).isFile()).toBe(true)
    expect((await lstat(join(installed, 'guides'))).isDirectory()).toBe(true)
    expect(await readdir(join(installed, 'guides', '.empty'))).toEqual([])
    const helper = join(installed, 'guides', 'helper.bin')
    expect(await readFile(helper)).toEqual(Buffer.from([0, 255, 1]))
    if (process.platform !== 'win32') expect((await lstat(helper)).mode & 0o700).toBe(0o700)
    await rename(assets, join(h.root, 'moved'))
    const preview = await h.store.readSkillFile(undefined, 'user:manual', 'SKILL.md')
    expect(preview).toMatchObject({ content: skillText('manual', 'Original'), editable: true })
    await h.store.saveSkillFile(undefined, 'user:manual', 'SKILL.md', {
      content: skillText('manual', 'Edited'), revision: preview.revision!, resolvedPath: preview.resolvedPath
    })
    expect(await readFile(join(installed, 'SKILL.md'), 'utf8')).toBe(skillText('manual', 'Edited'))
    expect(await readFile(join(h.root, 'moved', 'guide.md'), 'utf8')).toBe(skillText('manual', 'Original'))
  })

  it.each(['dangling', 'circular', 'destination'])('reports a %s resource and continues with the next complete Skill', async kind => {
    const h = await loadSkillsStore()
    const bad = await writeSkill(h.examplesDir, 'incomplete')
    const good = await writeSkill(h.examplesDir, 'good')
    const target = kind === 'circular' ? bad : kind === 'destination' ? h.skillsDir : join(h.root, 'missing')
    await symlink(target, join(bad, 'resource'), process.platform === 'win32' ? 'junction' : 'dir')
    const result = await h.store.importSkillDirectories([bad, good])
    expect(result).toMatchObject({ names: ['good'], failures: [{ name: 'incomplete', error: { code: 'failed' } }] })
    expect(await readdir(h.skillsDir)).toEqual(['good'])
  })

  it('rejects import into a linked bundled destination and allows retry into linked user storage', async () => {
    const h = await loadSkillsStore()
    const source = await writeSkill(h.examplesDir, 'example-guide')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    await rmdir(h.skillsDir)
    await symlink(h.bundledSystemDir, h.skillsDir, linkType)
    await expect(h.store.importSkillDirectories([source])).rejects.toThrow()
    expect(await readdir(h.bundledSystemDir)).toEqual([])

    await unlink(h.skillsDir)
    await symlink(h.workspace, h.skillsDir, linkType)
    const result = await h.store.importSkillDirectories([source])
    expect(result).toEqual({ names: ['example-guide'], failures: [] })
    expect(await readFile(join(h.workspace, 'example-guide/SKILL.md'), 'utf8')).toBe(skillText('example-guide'))
  })

  it('keeps the committed Skill in the original directory when the user link changes', async () => {
    const native = await vi.importActual<typeof import('./renameDirectoryExclusive')>('./renameDirectoryExclusive')
    const linkType = process.platform === 'win32' ? 'junction' : 'dir'
    vi.doMock('./renameDirectoryExclusive', () => ({ renameDirectoryExclusive: (from: string, to: string) => {
      native.renameDirectoryExclusive(from, to)
      if (basename(to) === 'first-import') {
        unlinkSync(h.skillsDir)
        symlinkSync(h.bundledSystemDir, h.skillsDir, linkType)
      }
    } }))
    const h = await loadSkillsStore()
    await rmdir(h.skillsDir)
    await symlink(h.workspace, h.skillsDir, linkType)
    const first = await writeSkill(h.examplesDir, 'first-import')
    const second = await writeSkill(h.examplesDir, 'second-import')
    expect(await h.store.importSkillDirectories([first, second])).toMatchObject({
      names: ['first-import'], failures: [{ name: 'second-import', error: { code: 'failed' } }]
    })
    expect(await readdir(h.bundledSystemDir)).toEqual([])
    expect(await readdir(h.workspace)).toEqual(['first-import'])
  })

  it('keeps successful and edited Skills and continues after one publication fails', async () => {
    const native = await vi.importActual<typeof import('./renameDirectoryExclusive')>('./renameDirectoryExclusive')
    vi.doMock('./renameDirectoryExclusive', () => ({ renameDirectoryExclusive: (from: string, to: string) => {
      if (basename(to) === 'second-import') {
        writeFileSync(join(h.skillsDir, 'first-import', 'guide.bin'), Buffer.from([0, 9, 8, 7]))
        throw new Error('Disk full')
      }
      native.renameDirectoryExclusive(from, to)
    } }))
    const h = await loadSkillsStore()
    const sources = await Promise.all(['first-import', 'second-import', 'third-import'].map(name => writeSkill(h.examplesDir, name)))
    await writeFile(join(sources[0], 'guide.bin'), Buffer.from([0, 1, 2, 3]))
    expect(await h.store.importSkillDirectories(sources)).toEqual({
      names: ['first-import', 'third-import'], failures: [{ name: 'second-import', error: { code: 'failed', detail: 'Disk full' } }]
    })
    expect(await readdir(h.skillsDir)).toEqual(['first-import', 'third-import'])
    expect(await readFile(join(h.skillsDir, 'first-import', 'guide.bin'))).toEqual(Buffer.from([0, 9, 8, 7]))
    expect(trashItem).toHaveBeenCalledOnce()
  })

  it.each(['destination', 'stage'])('leaves a replaced %s untouched after an interruption', async replaced => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let marker = ''
    vi.doMock('node:fs/promises', () => ({ ...fs, copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      await fs.copyFile(...args)
      if (!String(args[1]).includes('.import-')) return
      const stage = dirname(String(args[1]))
      const path = replaced === 'destination' ? dirname(stage) : stage
      await fs.rename(path, join(h.root, 'previous'))
      await mkdir(path)
      marker = join(path, 'restored.txt')
      await writeFile(marker, 'user content')
      throw new Error('Copy interrupted')
    } }))
    const h = await loadSkillsStore()
    const source = await writeSkill(h.examplesDir, 'only-skill')
    const result = await h.store.importSkillDirectories([source])
    expect(result).toMatchObject({ names: [], failures: [{ name: 'only-skill', stagingPath: expect.any(String) }] })
    expect(await readFile(marker, 'utf8')).toBe('user content')
    expect(trashItem).not.toHaveBeenCalled()
  })

  it.each([true, false])('preserves incomplete copies when the recycle bin is available: %s', async available => {
    const fs = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')
    let stage = ''
    vi.doMock('node:fs/promises', () => ({ ...fs, copyFile: async (...args: Parameters<typeof fs.copyFile>) => {
      await fs.copyFile(...args)
      if (!String(args[1]).includes('.import-')) return
      if (basename(String(args[0])) === 'guide.md') {
        stage = dirname(dirname(String(args[1])))
        await writeFile(join(stage, 'references', 'notes.md'), 'user edit')
        throw new Error('Copy interrupted')
      }
    } }))
    const h = await loadSkillsStore()
    if (!available) trashItem.mockRejectedValue(new Error('Recycle bin unavailable'))
    const source = await writeSkill(h.examplesDir, 'partial')
    await writeText(join(source, 'references', 'guide.md'), 'original')
    const result = await h.store.importSkillDirectories([source])
    expect(result).toEqual({ names: [], failures: [{ name: 'partial', error: { code: 'failed', detail: 'Copy interrupted' },
      ...(!available ? { stagingPath: stage } : {}) }] })
    expect(trashItem).toHaveBeenCalledWith(stage)
    const retained = available ? join(h.root, 'trash', basename(stage)) : stage
    expect(await readFile(join(retained, 'references', 'notes.md'), 'utf8')).toBe('user edit')
    expect(await readdir(h.skillsDir)).toEqual(available ? [] : [basename(stage)])
  })

  it.each([true, false])('keeps a concurrent directory at publication and continues (empty: %s)', async empty => {
    const native = await vi.importActual<typeof import('./renameDirectoryExclusive')>('./renameDirectoryExclusive')
    vi.doMock('./renameDirectoryExclusive', () => ({ renameDirectoryExclusive: (from: string, to: string) => {
      if (basename(to) === 'occupied') {
        mkdirSync(to)
        if (!empty) writeFileSync(join(to, 'notes.md'), 'existing')
      }
      native.renameDirectoryExclusive(from, to)
    } }))
    const h = await loadSkillsStore()
    const sources = await Promise.all(['occupied', 'fresh'].map(name => writeSkill(h.examplesDir, name)))
    expect(await h.store.importSkillDirectories(sources)).toEqual({
      names: ['fresh'], failures: [{ name: 'occupied', error: { code: 'already_exists', name: 'occupied' } }]
    })
    expect(await readdir(join(h.skillsDir, 'occupied'))).toEqual(empty ? [] : ['notes.md'])
  })

  it('checks the catalog capacity before committing any Skill and ignores private staging directories', async () => {
    const h = await loadSkillsStore()
    for (let start = 0; start < 2047; start += 64) {
      await Promise.all(Array.from({ length: Math.min(64, 2047 - start) }, (_, i) =>
        writeFile(join(h.skillsDir, `entry-${start + i}`), '')))
    }
    await mkdir(join(h.skillsDir, '.import-previous'))
    const sources = await Promise.all(['first-import', 'second-import'].map(name => writeSkill(h.examplesDir, name)))
    await expect(h.store.importSkillDirectories(sources)).rejects.toThrow('2048')
    expect(await h.store.importSkillDirectories([sources[0]])).toEqual({ names: ['first-import'], failures: [] })
    expect((await h.store.listSkillSnapshot()).skills.map(skill => skill.name)).toContain('first-import')
  })

  it('does not partially import a multi-selection when one Skill already exists', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'existing')
    const fresh = await writeSkill(join(fixture.root, 'imports'), 'fresh')
    const existing = await writeSkill(join(fixture.root, 'imports'), 'existing')

    const failure = await fixture.store.importSkillDirectories([fresh, existing]).catch((reason) => reason)

    expect(fixture.store.toSkillImportError(failure)).toEqual({ code: 'already_exists', name: 'existing' })
    await expect(readFile(join(fixture.skillsDir, 'fresh', 'SKILL.md'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('derives a useful source name for a selected directory named skills and keeps shortcut aliases unique', async () => {
    const fixture = await loadSkillsStore()
    const first = join(fixture.root, 'company', 'skills')
    const second = join(fixture.root, 'personal', 'skills')
    await Promise.all([writeSkill(first, 'first-skill'), writeSkill(second, 'second-skill')])

    await fixture.store.addExternalSkillDirectory(first)
    const snapshot = await fixture.store.addExternalSkillDirectory(second)
    const externalRoots = snapshot.roots.filter((root) => root.kind === 'external')

    expect(externalRoots.map((root) => [root.name, root.shortcutAlias])).toEqual([
      ['company', 'company'],
      ['personal', 'personal']
    ])
    await expect(fixture.store.updateExternalSkillDirectory(externalRoots[1].id, {
      name: 'Other company',
      shortcutAlias: 'company'
    })).rejects.toThrow('already in use')
  })

  it('does not add a built-in or current-project Skill root again as an external source', async () => {
    const fixture = await loadSkillsStore()
    const projectSkills = join(fixture.workspace, '.agents', 'skills')
    await writeSkill(projectSkills, 'project-skill')
    fixture.projectSettings.skillDirectories = [projectSkills]
    await mkdir(fixture.examplesDir, { recursive: true })
    await fixture.store.initializeSkillsStore()

    await expect(fixture.store.addExternalSkillDirectory(fixture.skillsDir, 'project-id')).rejects.toThrow('already managed')
    await expect(fixture.store.addExternalSkillDirectory(fixture.systemDir, 'project-id')).rejects.toThrow('already managed')
    await expect(fixture.store.addExternalSkillDirectory(fixture.examplesDir, 'project-id')).rejects.toThrow('already managed')
    await expect(fixture.store.addExternalSkillDirectory(projectSkills, 'project-id')).rejects.toThrow('already managed')
  })

  it('reports a broken Skill-directory link locally without hiding other Skills', async () => {
    const fixture = await loadSkillsStore()
    await writeSkill(fixture.skillsDir, 'healthy')
    await symlink(join(fixture.root, 'missing-target'), join(fixture.skillsDir, 'broken'), 'dir')

    const snapshot = await fixture.store.listSkillSnapshot()

    expect(snapshot.skills.find((skill) => skill.name === 'healthy')?.loadError).toBeUndefined()
    expect(snapshot.skills.find((skill) => skill.name === 'broken')).toMatchObject({ linked: true, loadError: { code: 'missing_skill_file' } })
  })
})

it('edits user skill files while keeping system files read-only', async () => {
  const fixture = await loadSkillsStore()
  await writeSkill(fixture.bundledSystemDir, 'system-one')
  await writeSkill(fixture.skillsDir, 'user-one')
  const store = await import('./skillsStore')
  await store.initializeSkillsStore()
  const snapshot = await store.listSkillSnapshot()
  const user = snapshot.skills.find(skill => skill.source === 'user')!
  const system = snapshot.skills.find(skill => skill.source === 'system')!
  const before = await store.readSkillFile(undefined, user.id, 'SKILL.md')
  expect(before.editable).toBe(true)
  await store.saveSkillFile(undefined, user.id, 'SKILL.md', { content:skillText('user-one','Updated description'),revision:before.revision!,resolvedPath:before.resolvedPath })
  expect((await store.listSkillSnapshot()).skills.find(skill => skill.id === user.id)?.description).toBe('Updated description')
  const systemFile = await store.readSkillFile(undefined, system.id, 'SKILL.md')
  expect(systemFile.editable).toBe(false)
  await expect(store.saveSkillFile(undefined, system.id, 'SKILL.md', {content:systemFile.content!,revision:systemFile.revision!,resolvedPath:systemFile.resolvedPath})).rejects.toThrow('read-only')
})
