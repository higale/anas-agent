import type { AgentThread } from '@shared/agentTypes'
import type { Project } from '@shared/types'
import { ModelSelectionError } from '../../runtime/errors'
import { ManagedCallService } from './managedCallService'
import { defineContentTool } from '../../runtime/toolDefinition'
import { z } from 'zod/v3'
import * as mcpRuntimeService from '../mcpRuntimeService'
import type { MockInstance } from 'vitest'
import { prepareAgentRuntimeResources } from './agentRuntimeResources'
import * as subagentTools from './subagentTools'
import { resolveSkillSelection } from '@shared/agentCapabilities'
import { parsePluginManifest } from '@shared/plugins'

import { toolPackageFixture, selectedTools } from '../../test/toolPackageFixture'
import { customToolDefaults } from '@shared/customTools'

import * as toolsStore from '../toolsStore'
import * as runtimeTools from '../llm/runtimeTools'

import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { defaultCapabilities } from '@shared/agentCapabilities'
import { config, thread, defaultWorkspaceProject, previewConfig } from '../../test/agentConfigurationFixture'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'

import { prepareAgentSystemPrompt } from './agentRuntimeResources'

import * as skillsStore from '../skillsStore'

const testPaths = vi.hoisted(() => ({ root: '' }))
const projectStoreMocks = vi.hoisted(() => ({ getProject: vi.fn() }))
const appConfigMocks = vi.hoisted(() => ({ getAppConfigSnapshot: vi.fn() }))
const memoryStoreMocks = vi.hoisted(() => ({ buildMemoryRulesPrompt: vi.fn() }))
const languageStoreMocks = vi.hoisted(() => ({ resolveConfiguredLanguage: vi.fn(async () => ({ code: 'en', name: 'English', builtIn: true })) }))
vi.mock('../config/dataDir', async importOriginal => ({ ...await importOriginal<typeof import('../config/dataDir')>(),
  getDataDir: () => testPaths.root, getConfigFile: (name: string) => join(testPaths.root, 'config', name),
  getSkillsDir: () => join(testPaths.root, 'skills'), getSystemSkillsDir: () => join(testPaths.root, 'skills/_system'),
  getSystemPluginsDir: () => join(testPaths.root, 'plugins/_system'), getSkillExamplesDir: () => join(testPaths.root, 'examples/skills') }))
vi.mock('../projectStore', () => ({ getProject: projectStoreMocks.getProject }))
vi.mock('../config/appConfig', async importOriginal => ({ ...await importOriginal<typeof import('../config/appConfig')>(), getAppConfigSnapshot: appConfigMocks.getAppConfigSnapshot }))
vi.mock('./conversationMemory', async importOriginal => ({ ...await importOriginal<typeof import('./conversationMemory')>(), buildMemoryRulesPrompt: memoryStoreMocks.buildMemoryRulesPrompt }))
vi.mock('../languageStore', () => ({ resolveConfiguredLanguage: languageStoreMocks.resolveConfiguredLanguage }))
vi.mock('../toolsStore', async importOriginal => ({ ...await importOriginal<typeof import('../toolsStore')>(), listToolSnapshot: vi.fn(async () => ({ roots: [], tools: [] })) }))
beforeAll(async () => { testPaths.root = await mkdtemp(join(tmpdir(), 'anas-native-capabilities-')) })
afterAll(async () => { await rm(testPaths.root, { recursive: true, force: true }) })
const memories: Database.Database[] = []
afterEach(() => { vi.restoreAllMocks(); for (const db of memories.splice(0)) db.close() })
function openDatabase(file = ':memory:') {
  const global = new Database(':memory:'); memories.push(global)
  return NativeConversationDatabase.open(file, { memoryStore: new SqliteMemoryStore(global),
    attachmentRoot: join(testPaths.root, 'attachments'), fileEditStore: new FileEditStore(join(testPaths.root, 'file_edits')) })
}
function configuredThread(database: NativeConversationDatabase, input: Parameters<NativeConversationDatabase['runs']['createThread']>[0] = {}) {
  return database.runs.createThread({ modelConfigId: 'preview-model', ...input })
}
function createRun(database: NativeConversationDatabase, threadId: string, runId: string, content: string) {
  return database.runs.createRun({ threadId, runId, operation: 'agent', message: {
    id: runId + ':input', value: { id: runId + ':input', kind: 'user', content, context: { runId } }
  } })
}

describe('native capability snapshots', () => {
  let definitions: MockInstance<typeof runtimeTools.runtimeToolDefinitions>
  beforeEach(() => {
    definitions = vi.spyOn(runtimeTools, 'runtimeToolDefinitions')
    projectStoreMocks.getProject.mockReset().mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockReset().mockResolvedValue('')
    appConfigMocks.getAppConfigSnapshot.mockReset().mockResolvedValue(previewConfig())
    vi.mocked(toolsStore.listToolSnapshot).mockReset().mockResolvedValue({ roots: [], tools: [] })
  })
  it.each([false, true])('keeps default selections stable when resuming a run (child %s)', async (child) => {
    const snapshot = previewConfig()
    const base = snapshot.subagents[0]
    snapshot.subagents = [base, { ...base, name: 'reviewer', enabled: false }]
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    const database = openDatabase()
    const owner = configuredThread(database, { title: 'Stable delegation' })
    const parent = createRun(database, owner.id, 'stable-delegation-root', 'Investigate')
    const call = child ? database.runs.createSubagentCall({
      id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parent.id,
      childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-9494-949494949494',
      config: base, description: 'Use defaults.', childThread: { title: 'Child', projectId: owner.projectId }
    }) : undefined
    const tools = vi.spyOn(subagentTools, 'subagentToolDefinitions')
    const resolved = vi.fn()
    const context = { requestId: call?.childRunId ?? parent.id, subagentCall: call, parentConfiguration: { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), subagents: { mode: 'custom' as const, names: ['general-purpose', 'reviewer'] } } } }
    try {
      const thread = call ? database.getThread(call.childThreadId)! : owner
      await prepareAgentRuntimeResources(thread, database.resources, await appConfigMocks.getAppConfigSnapshot(), { ...context, onConfigurationResolved: resolved }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      database.runs.resolveRunConfiguration({ threadId: thread.id, runId: context.requestId }, resolved.mock.lastCall![0])
      const configuration = database.runs.getRunConfiguration({ threadId: thread.id, runId: context.requestId })
      snapshot.subagents = snapshot.subagents.map(a => ({ ...a, enabled: !a.enabled }))
      await prepareAgentRuntimeResources(thread, database.resources, await appConfigMocks.getAppConfigSnapshot(), { ...context, configuration }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      const start = tools.mock.results.at(-1)!.value.find((tool: { name: string }) => tool.name === 'start_subagent')
      expect(start).toBeUndefined()
      expect(configuration!.capabilities.subagents.names).toEqual(['general-purpose'])
      await prepareAgentRuntimeResources(thread, database.resources, await appConfigMocks.getAppConfigSnapshot(), context, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      const nextStart = tools.mock.results.at(-1)!.value.find((tool: { name: string }) => tool.name === 'start_subagent')
      expect(nextStart.description).toContain('- reviewer:')
      expect(nextStart.description).not.toContain('- general-purpose:')
    } finally { tools.mockRestore(); database.close() }
  })

  it.each((['default', 'custom', 'empty'] as const).flatMap(mode => [false, true].map(nested => ({ mode, nested }))))('intersects a child $mode selection with the root project range (nested $nested)', async ({ mode, nested }) => {
    const snapshot = previewConfig()
    const base = snapshot.subagents[0]
    snapshot.subagents = [base, { ...base, name: 'reviewer', enabled: false }, { ...base, name: 'outside' }]
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = openDatabase()
    const owner = configuredThread(database, { title: 'Delegation selection' })
    const parent = createRun(database, owner.id, 'delegation-root', 'Investigate')
    const call = database.runs.createSubagentCall({
      id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parent.id,
      childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-9494-949494949494',
      config: { ...base, capabilities: { ...base.capabilities, subagents: { mode: mode === 'default' ? 'default' : 'custom', names: mode === 'empty' ? [] : ['reviewer', 'outside'] } } },
      description: 'Delegate within the project.', childThread: { title: 'Child', projectId: owner.projectId }
    })
    const tools = vi.spyOn(subagentTools, 'subagentToolDefinitions')
    try {
      await prepareAgentRuntimeResources(database.getThread(call.childThreadId)!, database.resources, await appConfigMocks.getAppConfigSnapshot(), {
        requestId: call.childRunId, subagentCall: call, parentConfiguration: { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), subagents: { mode: 'custom', names: nested ? ['general-purpose'] : ['general-purpose', 'reviewer'] } },
          ...(nested ? { subagentSelectionLimit: { mode: 'custom' as const, names: ['general-purpose', 'reviewer'] } } : {}) }
      }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      const start = tools.mock.results.at(-1)!.value.find((tool: { name: string }) => tool.name === 'start_subagent')
      if (mode === 'empty' || mode === 'custom') expect(start).toBeUndefined()
      else {
        expect(start.description).toContain(`- ${mode === 'default' ? 'general-purpose' : 'reviewer'}:`)
        expect(start.description).not.toContain('- outside:')
        expect(start.description).not.toContain(`- ${mode === 'default' ? 'reviewer' : 'general-purpose'}:`)
      }
    } finally { tools.mockRestore(); database.close() }
  })

  it('ignores stored project capability restrictions when advanced settings are off', async () => {
    const project = { ...defaultWorkspaceProject(), advancedSettings: false, prompt: 'Hidden project instruction', restrictSubagents: true,
      capabilities: { ...structuredClone(defaultCapabilities), memory: false, workspace: false, toolMode: 'selected' as const, tools: [] } }
    projectStoreMocks.getProject.mockResolvedValue(project)
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(previewConfig())
    const database = openDatabase()
    const owner = configuredThread(database, { title: 'Default capabilities' })
    const resolved = vi.fn()
    try {
      await prepareAgentRuntimeResources(owner, database.resources, await appConfigMocks.getAppConfigSnapshot(), { onConfigurationResolved: resolved }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      expect(resolved.mock.lastCall![0].capabilities).toMatchObject({ memory: true, workspace: true, toolMode: 'all' })
      expect(resolved.mock.lastCall![0].subagentLimit).toBeUndefined()
      expect((await definitions.mock.results.at(-1)!.value).map((tool: { name: string }) => tool.name)).toContain('save_to_memory')
      expect((await prepareAgentSystemPrompt(owner, previewConfig())).systemPrompt.text).not.toContain('Hidden project instruction')
    } finally { database.close() }
  })

  it.each([false, true].flatMap(customized => [false, true].map(restricted => ({ customized, restricted }))))('uses all available capabilities or project customization and freezes each run ($customized, $restricted)', async ({ customized, restricted }) => {
    const snapshot = previewConfig()
    snapshot.subagents.push({ ...snapshot.subagents[0], name: 'reviewer', enabled: false })
    const project = { ...defaultWorkspaceProject(), compressionPrompt: 'Parent-only summary: {conversation}', advancedSettings: customized, restrictSubagents: restricted,
      capabilities: { ...structuredClone(defaultCapabilities), toolMode: 'selected' as const, tools: ['read_file'] } }
    projectStoreMocks.getProject.mockResolvedValue(project)
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    const database = openDatabase()
    const owner = configuredThread(database, { title: 'Editable defaults' })
    const run = createRun(database, owner.id, 'default-policy-root', 'Investigate')
    const resolved = vi.fn()
    try {
      await prepareAgentRuntimeResources(owner, database.resources, await appConfigMocks.getAppConfigSnapshot(), { onConfigurationResolved: resolved }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      const configuration = structuredClone(resolved.mock.lastCall![0])
      const parentTools = (await definitions.mock.results.at(-1)!.value).map((tool: { name: string }) => tool.name)
      expect(configuration.capabilities).toMatchObject({ profile: true, workspace: true,
        toolMode: customized ? 'selected' : 'all', tools: customized ? ['read_file'] : [] })
      expect(Boolean(configuration.subagentLimit)).toBe(customized && restricted)
      expect(configuration.capabilities.subagents.names).toEqual(['general-purpose'])
      const prompt = await prepareAgentSystemPrompt(owner, snapshot)
      expect(prompt.systemPrompt.sections.some(section => section.kind === 'workspace')).toBe(true)
      const call = database.runs.createSubagentCall({
        id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: run.id,
        childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-9494-949494949494',
        config: { ...snapshot.subagents[0], capabilities: structuredClone(defaultCapabilities) }, description: 'Independent child.',
        childThread: { title: 'Child', projectId: owner.projectId }
      })
      await prepareAgentRuntimeResources(database.getThread(call.childThreadId)!, database.resources, await appConfigMocks.getAppConfigSnapshot(), {
        subagentCall: call, parentConfiguration: configuration, onConfigurationResolved: resolved
      }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      expect(configuration.compressionPrompt).toBe(customized ? 'Parent-only summary: {conversation}' : undefined)
      expect(resolved.mock.lastCall![0].compressionPrompt).toBeUndefined()
      const childCapabilities = resolved.mock.lastCall![0].capabilities
      expect(childCapabilities.profile).toBe(true)
      expect(childCapabilities.toolMode).toBe(customized && restricted ? 'selected' : 'all')
      project.capabilities.tools = []
      await prepareAgentRuntimeResources(owner, database.resources, await appConfigMocks.getAppConfigSnapshot(), { configuration }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      expect((await definitions.mock.results.at(-1)!.value).map((tool: { name: string }) => tool.name)).toEqual(parentTools)
      await prepareAgentRuntimeResources(owner, database.resources, await appConfigMocks.getAppConfigSnapshot(), { onConfigurationResolved: resolved }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      expect(resolved.mock.lastCall![0].capabilities.tools).toEqual([])
    } finally { database.close() }
  })

  it.each([false, true])('injects project instructions independently of workspace context (%s)', async (workspace) => {
    const project = { ...defaultWorkspaceProject(), advancedSettings: true, prompt: 'Follow the project rules.',
      capabilities: { ...structuredClone(defaultCapabilities), workspace } }
    projectStoreMocks.getProject.mockResolvedValue(project)
    const prepared = await prepareAgentSystemPrompt(thread(), config())
    const sections = prepared.systemPrompt.sections
    expect(sections.find((section) => section.kind === 'project_instruction')?.content).toContain(project.prompt)
    expect(sections.some((section) => section.kind === 'workspace')).toBe(workspace)
    if (workspace) expect(sections.findIndex((section) => section.kind === 'project_instruction')).toBeLessThan(sections.findIndex((section) => section.kind === 'workspace'))
  })

  it.each((['main', 'independent', 'restricted'] as const).flatMap((scope) => [false, true].map((parentCodingMode) => ({ scope, parentCodingMode }))))('enforces memory tool selection in $scope with parent coding mode $parentCodingMode', async ({ scope, parentCodingMode }) => {
    const project = { customTools: [], ...defaultWorkspaceProject(), codingMode: true, capabilities: { ...{
      ...structuredClone(defaultCapabilities), toolMode: 'except' as const, tools: ['save_to_memory', 'forget_memory']
    }, subagents: { mode: 'custom' as const, names: ['general-purpose'] } } }
    projectStoreMocks.getProject.mockResolvedValue(project)
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('MEMORY RULES')
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(previewConfig())
    const database = openDatabase()
    const owner = configuredThread(database, { title: 'Memory tool selection' })
    const parentRun = createRun(database, owner.id, 'memory-capability-parent', 'Investigate')
    const call = scope === 'main' ? undefined : database.runs.createSubagentCall({
      id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parentRun.id,
      childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-9494-949494949494',
      config: { ...config().subagents[0], capabilities: structuredClone(defaultCapabilities) }, description: 'Use own capabilities.',
      childThread: { title: 'Child', projectId: owner.projectId }
    })
    const resolved = vi.fn()
    try {
      await prepareAgentRuntimeResources(call ? database.getThread(call.childThreadId)! : owner, database.resources, await appConfigMocks.getAppConfigSnapshot(), {
        onConfigurationResolved: resolved,
        requestId: call?.childRunId ?? parentRun.id, subagentCall: call, parentConfiguration: { customTools: [], codingMode: parentCodingMode, capabilities: { ...project.capabilities, subagents: { mode: 'custom', names: [] } }, ...(scope === 'restricted' ? { subagentLimit: { ...project.capabilities, customTools: selectedTools(), skills: resolveSkillSelection(project.capabilities.skills, []) } } : {}) }
      }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      expect(resolved.mock.lastCall![0].codingMode).toBe(scope === 'main' || parentCodingMode)
      expect(resolved.mock.lastCall![0].capabilities.subagents).toEqual(scope === 'main' ? project.capabilities.subagents : { mode: 'custom', names: [] })
      const actual = (await definitions.mock.results.at(-1)!.value).map((tool: { name: string }) => tool.name) as string[]
      expect(actual.filter((name) => ['read_memory', 'save_to_memory', 'forget_memory'].includes(name))).toEqual(
        scope === 'independent' ? ['read_memory', 'save_to_memory', 'forget_memory'] : ['read_memory']
      )
    } finally { database.close() }
  })

  it.each([false, true])('uses the effective project or default custom tool selections (%s)', async customized => {
    const snapshot = previewConfig()
    const definition = { ...customToolDefaults, description: 'Read data.', inputSchema: { type: 'object' }, command: 'node reader.cjs {{args}}' }
    const tools = ['default_reader', 'project_reader', 'unselected_reader'].map(name => toolPackageFixture({ ...definition, id: name, name }))
    tools[2].enabled = false
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools })
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), advancedSettings: customized,
      capabilities: { ...structuredClone(defaultCapabilities), customTools: selectedTools(['project_reader']) } })
    const database = openDatabase()
    const thread = configuredThread(database)
    const resolved = vi.fn()
    try {
      await prepareAgentRuntimeResources(thread, database.resources, await appConfigMocks.getAppConfigSnapshot(), { onConfigurationResolved: resolved }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      expect(resolved.mock.lastCall![0].customTools.map((tool: { id: string }) => tool.id)).toEqual(customized ? ['project_reader'] : ['default_reader', 'project_reader'])
    } finally { database.close() }
  })

  it.each([false, true])('resolves same-name custom tools after the root identity ceiling (%s)', async restricted => {
    const snapshot = previewConfig()
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const base = { ...customToolDefaults, name: 'read_complete', description: 'Read data.',
      inputSchema: { type: 'object', properties: {} }, command: 'node reader.cjs {{args}}' }
    const user = toolPackageFixture({ ...base, id: 'user:reader' })
    const project = { ...toolPackageFixture({ ...base, id: 'project:reader' }), source: 'project' as const, rootId: 'project', rootName: 'Project' }
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: [project, user] })
    const database = openDatabase()
    const owner = configuredThread(database)
    const run = createRun(database, owner.id, 'tool-precedence', 'Investigate')
    const call = database.runs.createSubagentCall({
      id: '15959595-9595-8595-8595-959595959595', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: run.id,
      childThreadId: '16969696-9696-8696-8696-969696969696', childRunId: '17979797-9797-8797-9797-979797979797',
      config: { ...config().subagents[0], capabilities: { ...structuredClone(defaultCapabilities), customTools: { project: true, entries: [user.id] } } },
      description: 'Read data.', childThread: { title: 'Child', projectId: owner.projectId }
    })
    const limit = { ...structuredClone(defaultCapabilities), customTools: selectedTools([user.id]), skills: resolveSkillSelection(defaultCapabilities.skills, []) }
    const resolved = vi.fn()
    try {
      await prepareAgentRuntimeResources(database.getThread(call.childThreadId)!, database.resources, await appConfigMocks.getAppConfigSnapshot(), {
        requestId: call.childRunId, subagentCall: call, onConfigurationResolved: resolved,
        parentConfiguration: { customTools: [], codingMode: false, capabilities: limit, ...(restricted ? { subagentLimit: limit } : {}) }
      }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      expect(resolved.mock.lastCall![0].customTools.map((tool: { id: string }) => tool.id)).toEqual([restricted ? user.id : project.id])
    } finally { database.close() }
  })

  it.each([{ restrict: false, grant: false, enabled: true }, { restrict: true, grant: false, enabled: true }, { restrict: true, grant: true, enabled: true },
    { restrict: false, grant: false, enabled: false }, { restrict: true, grant: true, enabled: false }])(
    'keeps package resources private and applies capability choices and root grants ($restrict, $grant, $enabled)', async ({ restrict, grant, enabled }) => {
      const snapshot = previewConfig()
      snapshot.subagents = ['owner', 'other'].map((id, index) => ({ ...snapshot.subagents[0], id, index, name: id, preset: undefined, builtIn: false,
        capabilities: { ...structuredClone(defaultCapabilities), skills: { mode: 'custom', project: false, entries: [], package: { guide: enabled } }, customTools: { mode: 'custom', project: false, entries: [], package: { query: enabled } } } }))
      appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
      const ownedTools = ['owner', 'other'].map(id => ({ ...toolPackageFixture({ ...customToolDefaults, id: `subagent:${id}:tool:query`, name: 'query', description: 'Private query', inputSchema: { type: 'object' } }), rootId: `subagent:${id}:tool`, source: 'subagent' as const }))
      const ownedSkills = ['owner', 'other'].map(id => ({ id: `subagent:${id}:skill:guide`, rootId: `subagent:${id}:skill`, name: 'guide', description: 'Private guide', source: 'subagent' as const,
        rootName: id, shortcutAlias: id, linked: false, modelAvailable: true, userAvailable: false, scriptAutoApprove: false, dirPath: `/${id}/skills/guide`, relativePath: 'guide' }))
      vi.spyOn(toolsStore, 'listSubagentTools').mockImplementation(async ids => ownedTools.filter(tool => ids.some(id => tool.id.startsWith(`subagent:${id}:`))))
      vi.spyOn(skillsStore, 'listSubagentSkills').mockImplementation(async ids => ({ roots: [], scriptAutoApprove: false, skills: ownedSkills.filter(skill => ids.some(id => skill.id.startsWith(`subagent:${id}:`))) }))
      vi.spyOn(skillsStore, 'listSkillSnapshot').mockResolvedValue({ roots: [], skills: [], scriptAutoApprove: false })
      vi.spyOn(skillsStore, 'buildSkillsPrompt').mockResolvedValue('')
      projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), advancedSettings: true, restrictSubagents: restrict,
        capabilities: { ...structuredClone(defaultCapabilities), subagents: { mode: 'default', names: [] },
          skills: { mode: 'custom', project: false, entries: grant ? ownedSkills.map(s => ({ id: s.id, model: true, shortcut: false })) : [] },
          customTools: { mode: 'custom', project: false, entries: grant ? ownedTools.map(t => t.id) : [] } } })
      const database = openDatabase()
      const owner = configuredThread(database)
      const resolved = vi.fn()
      try {
        await prepareAgentRuntimeResources(owner, database.resources, await appConfigMocks.getAppConfigSnapshot(), { onConfigurationResolved: resolved }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
        const parentConfiguration = resolved.mock.lastCall![0]
        expect(parentConfiguration.customTools).toEqual([])
        expect(parentConfiguration.capabilities.skills.entries).toEqual([])
        if (restrict && grant) {
          expect(parentConfiguration.subagentLimit.customTools.entries).toHaveLength(2)
          expect(parentConfiguration.subagentLimit.skills.entries.filter((s: { model: boolean }) => s.model)).toHaveLength(2)
        }
        const run = createRun(database, owner.id, 'package-parent', 'Investigate')
        const call = database.runs.createSubagentCall({
          id: '15959595-9595-8595-8595-959595959595', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: run.id,
          childThreadId: '16969696-9696-8696-8696-969696969696', childRunId: '17979797-9797-8797-8797-979797979797',
          config: snapshot.subagents[0], description: 'Read own package.', childThread: { title: 'Child', projectId: owner.projectId }
        })
        expect(call.config.id).toBe('owner')
        await prepareAgentRuntimeResources(database.getThread(call.childThreadId)!, database.resources, await appConfigMocks.getAppConfigSnapshot(), {
          requestId: call.childRunId, subagentCall: call, parentConfiguration, onConfigurationResolved: resolved
        }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
        const configured = resolved.mock.lastCall![0]
        const allowed = enabled && (!restrict || grant)
        expect(configured.customTools.map((t: { id: string }) => t.id)).toEqual(allowed ? ['subagent:owner:tool:query'] : [])
        expect(configured.capabilities.skills.entries.filter((s: { model: boolean }) => s.model).map((s: { id: string }) => s.id)).toEqual(allowed ? ['subagent:owner:skill:guide'] : [])
      } finally { database.close() }
    })

  it.each([false, true])('resolves subagent project skills before applying the root ceiling (%s)', async (restricted) => {
    const project = defaultWorkspaceProject()
    projectStoreMocks.getProject.mockResolvedValue(project)
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(previewConfig())
    const catalog = vi.spyOn(skillsStore, 'listSkillSnapshot').mockResolvedValue({ scriptAutoApprove: false, roots: [], skills: [{ scriptAutoApprove: false,
      id: 'current-project:search', rootId: 'current-project', name: 'search', description: 'Project skill',
      source: 'project', rootName: 'Current project', shortcutAlias: 'project', linked: false,
      modelAvailable: false, userAvailable: false, dirPath: '/project/search', relativePath: 'search'
    }] })
    const prompt = vi.spyOn(skillsStore, 'buildSkillsPrompt').mockResolvedValue('')
    const database = openDatabase()
    const owner = configuredThread(database, { title: 'Project skill rule' })
    const parentRun = createRun(database, owner.id, 'project-skill-parent', 'Investigate')
    const call = database.runs.createSubagentCall({
      id: '15959595-9595-8595-8595-959595959595', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parentRun.id,
      childThreadId: '16969696-9696-8696-8696-969696969696', childRunId: '17979797-9797-8797-8797-979797979797',
      config: { ...config().subagents[0], capabilities: { ...structuredClone(defaultCapabilities),
        skills: { mode: 'custom', project: true, entries: [] } } },
      description: 'Use current project skills.', childThread: { title: 'Child', projectId: owner.projectId }
    })
    const resolved = vi.fn()
    const limit = { ...structuredClone(defaultCapabilities), customTools: selectedTools(), skills: { mode: 'custom' as const, project: false,
      entries: [{ id: 'current-project:search', model: false, shortcut: true }] } }
    try {
      await prepareAgentRuntimeResources(database.getThread(call.childThreadId)!, database.resources, await appConfigMocks.getAppConfigSnapshot(), {
        requestId: call.childRunId, subagentCall: call, parentConfiguration: { customTools: [], codingMode: false, capabilities: limit, ...(restricted ? { subagentLimit: limit } : {}) },
        onConfigurationResolved: resolved
      }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      const selection = resolved.mock.lastCall![0].capabilities.skills
      expect(selection).toMatchObject({ project: false, entries: [{ id: 'current-project:search', model: !restricted, shortcut: false }] })
      expect(catalog).toHaveBeenCalledWith(owner.projectId, ['/workspace/default'])
      expect(prompt).toHaveBeenCalledWith(owner.projectId, selection, ['/workspace/default'], resolved.mock.lastCall![0].capabilities.pluginTools)
    } finally { database.close(); catalog.mockRestore(); prompt.mockRestore() }
  })

  it.each(['default', 'custom', 'off'] as const)('resolves subagent plugin %s selection against enabled declarations before freezing the run', async (pluginMode) => {
    const settings = previewConfig()
    const runtime = (await import('../plugins/pluginRuntime')).pluginRuntime()
    const plugins = vi.spyOn(runtime.store, 'list').mockResolvedValue([{ id: 'example', enabled: true, backendStatus: 'stopped',
      manifest: parsePluginManifest({ version: 0, api_version: 2, id: 'example', name: 'Example', plugin_version: '1.0.0', skills: [{ id: 'guide', path: 'guide/SKILL.md' }] }) }])
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(settings)
    const catalog = vi.spyOn(skillsStore, 'listSkillSnapshot').mockResolvedValue({ scriptAutoApprove: false, roots: [], skills: [{
      id: 'example:skill:guide', rootId: 'plugin:example', name: 'guide', description: 'Guide', source: 'plugin', rootName: 'Example', shortcutAlias: 'plugin:example',
      linked: false, scriptAutoApprove: false, modelAvailable: true, userAvailable: true, dirPath: '/plugin/guide', relativePath: 'guide'
    }] })
    const prompt = vi.spyOn(skillsStore, 'buildSkillsPrompt').mockResolvedValue('')
    const database = openDatabase()
    const owner = configuredThread(database, { title: 'Plugin inheritance' })
    const parentRun = createRun(database, owner.id, 'plugin-parent', 'Investigate')
    const call = database.runs.createSubagentCall({ id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parentRun.id,
      childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-8494-949494949494',
      config: { ...config().subagents[0], capabilities: { ...structuredClone(defaultCapabilities), pluginMode, skills: { mode: 'off', project: false, entries: [] } } },
      description: 'Use plugin defaults.', childThread: { title: 'Child', projectId: owner.projectId } })
    const resolved = vi.fn()
    try {
      await prepareAgentRuntimeResources(database.getThread(call.childThreadId)!, database.resources, await appConfigMocks.getAppConfigSnapshot(), { requestId: call.childRunId, subagentCall: call, parentConfiguration: { customTools: [], codingMode: false, capabilities: defaultCapabilities }, onConfigurationResolved: resolved }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      const saved = resolved.mock.lastCall![0].capabilities
      plugins.mockRestore()
      expect(saved.pluginMode).toBe('custom')
      expect(Boolean(saved.skills.entries.find((entry: { id: string; model: boolean }) => entry.id === 'example:skill:guide')?.model)).toBe(pluginMode === 'default')
    } finally { database.close(); catalog.mockRestore(); prompt.mockRestore() }
  })

  it.each([false, true])('applies a root project ceiling only when enabled (%s)', async (restricted) => {
    const project = { ...defaultWorkspaceProject(), capabilities: { ...structuredClone(defaultCapabilities), memory: false, applicationEnvironment: false, toolMode: 'selected' as const, tools: [] } }
    projectStoreMocks.getProject.mockResolvedValue(project)
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('MEMORY RULES')
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(previewConfig())
    const database = openDatabase()
    const owner = configuredThread(database, { title: 'Scoped subagent' })
    const parentRun = createRun(database, owner.id, 'capability-parent', 'Investigate')
    const ownCapabilities = { ...structuredClone(defaultCapabilities), toolMode: 'selected' as const, tools: ['read_memory', 'http_request'] }
    const call = database.runs.createSubagentCall({
      id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: parentRun.id,
      childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-8494-949494949494',
      config: { ...config().subagents[0], capabilities: ownCapabilities }, description: 'Use own capabilities.',
      childThread: { title: 'Child', projectId: owner.projectId }
    })
    const resolved = vi.fn()
    try {
      await prepareAgentRuntimeResources(database.getThread(call.childThreadId)!, database.resources, await appConfigMocks.getAppConfigSnapshot(), {
        requestId: call.childRunId, subagentCall: call, parentConfiguration: { customTools: [], codingMode: false, capabilities: project.capabilities, ...(restricted ? { subagentLimit: { ...project.capabilities, customTools: selectedTools(), skills: resolveSkillSelection(project.capabilities.skills, []) } } : {}) },
        onConfigurationResolved: resolved
      }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      expect(resolved.mock.lastCall?.[0].capabilities).toMatchObject({ memory: !restricted, applicationEnvironment: !restricted })
      expect(definitions.mock.lastCall![0]).toMatchObject({ memory: !restricted, network: !restricted })
    } finally { database.close() }
  })
  it('keeps recovery independent from disabled, deleted, or edited live definitions', async () => {
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    definitions.mockClear()
    const database = openDatabase()
    const owner = configuredThread(database, { title: 'Subagent definition owner' })
    const parentRun = createRun(database, owner.id, 'subagent-definition-parent-run', 'Investigate')
    const original = {
      ...config().subagents[0],
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true, memory: false, toolMode: 'selected' as const, tools: ['read_file'], skills: { mode: 'custom' as const, project: false, entries: [] } },
      preset: undefined,
      builtIn: false,
      name: 'reviewer',
      description: 'Original reviewer definition.',
      systemPrompt: 'Use the original reviewer instructions.',
    }
    const call = database.runs.createSubagentCall({
      id: '92929292-9292-8292-8292-929292929292',
      ownerThreadId: owner.id,
      parentThreadId: owner.id,
      parentRunId: parentRun.id,
      childThreadId: '93939393-9393-8393-8393-939393939393',
      childRunId: '94949494-9494-8494-8494-949494949494',
      config: original,
      description: 'Review independently.',
      childThread: { title: 'Persisted reviewer', projectId: owner.projectId }
    })
    const changed = {
      ...original,
      enabled: true,
      systemPrompt: 'Changed live instructions.',
      capabilities: { ...original.capabilities, workspace: false, memory: true, tools: ['http_request'] }
    }
    const liveDefinitions = [
      [{ ...changed, enabled: false }],
      [],
      [changed]
    ]

    try {
      for (const subagents of liveDefinitions) {
        const snapshot = previewConfig()
        snapshot.subagents = subagents
        appConfigMocks.getAppConfigSnapshot.mockResolvedValueOnce(snapshot)
        await prepareAgentRuntimeResources(database.getThread(call.childThreadId)!, database.resources, await appConfigMocks.getAppConfigSnapshot(), { requestId: call.childRunId, subagentCall: call }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      }

      expect(database.runs.subagents.require(call.id, owner.id)?.config).toEqual(original)
      expect(definitions.mock.calls.slice(-3).map(([options]) => ({
        toolNames: options.toolNames,
        memory: options.memory
      }))).toEqual(Array.from({ length: 3 }, () => ({
        toolNames: ['read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call', 'read_file'], memory: false
      })))
    } finally {
      database.close()
    }
  })
  it('exposes supervision tools for persisted unresolved calls when shell and HTTP are disabled', async () => {
    const snapshot = previewConfig()
    snapshot.subagents = []
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), capabilities: { ...structuredClone(defaultCapabilities), toolMode: 'selected', tools: [], backgroundTools: false } })
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = openDatabase()
    const agentThread = configuredThread(database, { title: 'Supervise retained call' })
    const priorRun = createUnresolvedManagedCall(database, agentThread)
    database.runs.requestCancellation({ threadId: agentThread.id, runId: priorRun.id }); database.runs.completeCancellation({ threadId: agentThread.id, runId: priorRun.id })
    const currentRun = createRun(database, agentThread.id, 'current-supervision-run', 'Investigate')

    try {
      await prepareAgentRuntimeResources(agentThread, database.resources, await appConfigMocks.getAppConfigSnapshot(), {
        requestId: currentRun.id,
        managedCalls: new ManagedCallService(database.managed, database.results)
      }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })

      expect(definitions).toHaveBeenCalledTimes(1)
      expect(definitions).toHaveBeenCalledWith(expect.objectContaining({
        enabled: true,
        shell: false,
        network: false,
        managedCallSupervision: true
      }))
    } finally {
      database.close()
    }
  })

  it('binds MCP tools by per-server policy across catalog changes without affecting builtins', async () => {
    const snapshot = previewConfig()
    snapshot.mcpServers = ['alpha', 'beta'].map((id, index) => ({ id, index, name: id, enabled: true, type: 'stdio', command: 'unused', args: [], env: {}, workingDir: '', timeoutMs: 1000, url: '' }))
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const runtime = vi.spyOn(mcpRuntimeService, 'getCachedMcpRuntime')
    const database = openDatabase()
    const thread = configuredThread(database, { title: 'MCP policies' })
    const capabilities = { ...structuredClone(defaultCapabilities), mcp: { defaultMode: 'selected' as const, servers: [
      { id: 'alpha', mode: 'all' as const, tools: ['unused_saved_choice'] },
      { id: 'beta', mode: 'selected' as const, tools: ['beta_read'] }
    ] } }
    try {
      for (const alphaNames of [['alpha_search'], ['alpha_new']]) {
        const names = [...alphaNames, 'beta_read', 'beta_new']
        runtime.mockResolvedValue({ tools: names.map(name => defineContentTool({ name, description: name, inputSchema: z.object({}), execute: async () => 'ok' })), loaded: [
          { id: 'alpha', index: 0, name: 'alpha', toolCount: alphaNames.length, toolNames: alphaNames },
          { id: 'beta', index: 1, name: 'beta', toolCount: 2, toolNames: ['beta_read', 'beta_new'] }
        ], errors: [], ping: vi.fn(async () => {}), close: vi.fn(async () => {}) })
        await prepareAgentRuntimeResources(thread, database.resources, await appConfigMocks.getAppConfigSnapshot(), { configuration: { customTools: [], codingMode: false, capabilities } }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
        expect(definitions.mock.lastCall![0].mcpTools!.map((entry: { name: string }) => entry.name)).toEqual([...alphaNames, 'beta_read'])
        expect(definitions.mock.lastCall![0].toolNames).toBeUndefined()
      }
      const disabled = { ...capabilities, mcp: { defaultMode: 'selected' as const, servers: [] } }
      runtime.mockClear()
      await prepareAgentRuntimeResources(thread, database.resources, await appConfigMocks.getAppConfigSnapshot(), { configuration: { customTools: [], codingMode: false, capabilities: disabled } }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      expect(runtime).not.toHaveBeenCalled()
      expect(definitions.mock.lastCall![0].mcpTools).toEqual([])
    } finally { runtime.mockRestore(); database.close() }
  })

  it('passes the allowed built-in tool set to the runtime when using exclusions', async () => {
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(previewConfig())
    const database = openDatabase()
    const agentThread = configuredThread(database, { title: 'Excluded file tool' })
    try {
      await prepareAgentRuntimeResources(agentThread, database.resources, await appConfigMocks.getAppConfigSnapshot(), {
        configuration: { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), toolMode: 'except', tools: ['read_multiple_files'] } }
      }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      const options = definitions.mock.lastCall![0]
      expect(options.toolNames).toContain('read_file')
      expect(options.toolNames).toContain('http_request')
      expect(options.toolNames).not.toContain('read_multiple_files')
    } finally { database.close() }
  })

  it('uses an inherited background setting instead of a later global setting', async () => {
    const snapshot = previewConfig()
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = openDatabase()
    const thread = configuredThread(database, { title: 'Inherited capability' })
    const run = createRun(database, thread.id, 'inherited-background-run', 'Investigate')
    const resolved = vi.fn()
    try {
      await prepareAgentRuntimeResources(thread, database.resources, await appConfigMocks.getAppConfigSnapshot(), {
        requestId: run.id,
        configuration: { customTools: [], codingMode: false, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: false } },
        onConfigurationResolved: resolved,
        managedCalls: new ManagedCallService(database.managed, database.results)
      }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      expect(definitions).toHaveBeenCalledWith(expect.objectContaining({ backgroundTools: false }))
      expect(resolved).not.toHaveBeenCalled()
    } finally { database.close() }
  })

  it.each([
    { mode: 'a model without tool use', toolUse: false, simpleChat: false },
    { mode: 'simple chat', toolUse: true, simpleChat: true }
  ])('rejects $mode while the conversation has unresolved background calls', async ({ toolUse, simpleChat }) => {
    const snapshot = previewConfig(toolUse)
    const simpleChatProject: Project = {
      id: 'simple-chat-managed-call',
      name: 'Plain chat',
      kind: 'simple_chat',
      pinned: false,
      collapsed: false,
      prompt: 'Answer plainly.',
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z'
    }
    if (simpleChat) {
      projectStoreMocks.getProject.mockImplementation(async (projectId: string) => (
        projectId === simpleChatProject.id ? simpleChatProject : defaultWorkspaceProject()
      ))
    }
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = openDatabase()
    const agentThread = configuredThread(database, {
      title: 'Unsupported supervision',
      ...(simpleChat ? { projectId: simpleChatProject.id } : {})
    })
    const run = createUnresolvedManagedCall(database, agentThread)

    try {
      const unsupported = prepareAgentRuntimeResources(agentThread, database.resources, await appConfigMocks.getAppConfigSnapshot(), {
        requestId: run.id,
        managedCalls: new ManagedCallService(database.managed, database.results)
      }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      })
      await expect(unsupported).rejects.toBeInstanceOf(ModelSelectionError)
      await expect(unsupported).rejects.toThrow(
        'Continue it in an agent project with a model that supports tool use'
      )
      expect(definitions).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })
  it('treats a model unable to supervise its persisted subagents as a terminal configuration failure', async () => {
    const snapshot = previewConfig(false)
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = openDatabase()
    const thread = configuredThread(database, { title: 'Unsupported child supervision' })
    const run = createRun(database, thread.id, 'unsupported-child-supervision', 'Investigate')
    database.runs.createSubagentCall({
      id: 'persisted-child', ownerThreadId: thread.id, parentThreadId: thread.id, parentRunId: run.id,
      childThreadId: 'persisted-child-thread', childRunId: 'persisted-child-run',
      config: snapshot.subagents[0], description: 'Continue delegated work.', childThread: { projectId: thread.projectId }
    })
    try {
      await expect(prepareAgentRuntimeResources(thread, database.resources, await appConfigMocks.getAppConfigSnapshot(), { requestId: run.id, }, {
        persistent: true, prepareWorkspace: false, requestSubagentApproval: async () => { throw new Error('Unexpected approval during resource preparation') }
      }))
        .rejects.toBeInstanceOf(ModelSelectionError)
    } finally { database.close() }
  })
})

function createUnresolvedManagedCall(database: NativeConversationDatabase, thread: AgentThread) {
  const run = createRun(database, thread.id, 'managed-call-run', 'Work')
  const id = '11111111-1111-8111-8111-111111111111'
  database.managed.createManagedCall({ id, threadId: thread.id, runId: run.id, kind: 'http', summary: 'Request still needs supervision' })
  database.managed.markManagedCallDetached(id, thread.id)
  database.managed.finishManagedCall({ callId: id, threadId: thread.id, status: 'completed', result: 'done' })
  return run
}
