import { createConversationInstance } from './conversationInstance'
import type { RunObserver } from '../../runtime/runExecution'
import { createProviderRequestCaptureFetch, type CapturedProviderRequest } from './providerRequestCapture'
import { toolPackageFixture, selectedTools } from '../../test/toolPackageFixture'
import { customToolDefaults } from '@shared/customTools'
import { orderedToolCatalog } from '@shared/toolRegistry'
import { isCommandShellToolName } from '@shared/commandShell'
import * as toolsStore from '../toolsStore'
import * as runtimeTools from '../llm/runtimeTools'
import { createAgentAccessModeResolver } from './agentRuntimeResources'
import { requiresToolApproval } from './toolAuthorization'
import * as mcpRuntimeService from '../mcpRuntimeService'
import { defineContentTool } from '../../runtime/toolDefinition'
import { z } from 'zod/v3'
import Database from 'better-sqlite3'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentThread } from '@shared/agentTypes'
import type { AppConfigSnapshot, Project } from '@shared/types'
import { resolveProviderModelConfig } from '@shared/modelConfig'
import { defaultCapabilities, capabilityFeatures } from '@shared/agentCapabilities'
import { config, thread, defaultWorkspaceProject, previewProvider, previewConfig } from '../../test/agentConfigurationFixture'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { ManagedCallService } from './managedCallService'
import { captureAgentSystemPrompt, captureAgentModelRequest } from './conversationPreview'
import { prepareAgentSystemPrompt, shouldIncludeCommandShell } from './agentRuntimeResources'
import { buildSubagentSystemPrompt } from './subagentPrompt'
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
beforeAll(async () => { testPaths.root = await mkdtemp(join(tmpdir(), 'anas-native-agent-resources-')) })
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
async function pauseForRules(database: NativeConversationDatabase, owner: { threadId: string; runId: string }) {
  await database.runs.enter('input', owner)
  const state = database.runs.store.load(owner.threadId)!
  database.runs.store.waitForContext({ ...owner, expectedRevisionId: state.revisionId }, {
    id: 'rules', generation: 'generation', kind: 'context_read', callIds: [], path: '/fixture/AGENTS.md', resumePhase: 'prepare_model',
    request: { actionRequests: [{ name: 'read_file', args: { path: '/fixture/AGENTS.md' }, description: 'Read rules' }],
      reviewConfigs: [{ actionName: 'read_file', allowedDecisions: ['approve', 'reject'] }] }
  }, { ...state.context, projectRules: { runId: owner.runId, roots: [], trustedFolders: [], documents: [], directories: [], initialScopes: [], activeScopes: [], blockedCalls: [], rejectedCalls: [], checkedWrites: [], blockedReason: '', fatalError: '' },
    rulePreparation: { runId: owner.runId, initialized: true, reads: [] } })
}
function createUnresolvedManagedCall(database: NativeConversationDatabase, thread: AgentThread) {
  const runId = 'managed-call-run'
  database.runs.createRun({ threadId: thread.id, runId, operation: 'agent',
    message: { id: 'input', value: { id: 'input', kind: 'user', content: 'Work', context: { runId } } } })
  const id = '11111111-1111-8111-8111-111111111111'
  database.managed.createManagedCall({ id, threadId: thread.id, runId, kind: 'http', summary: 'Request still needs supervision' })
  database.managed.markManagedCallDetached(id, thread.id)
  database.managed.finishManagedCall({ callId: id, threadId: thread.id, status: 'completed', result: 'done' })
}

describe('runtime command shell context', () => {
  it('keeps the Windows PowerShell switch independent from command execution', () => {
    const settings = config().settings
    const features = { ...capabilityFeatures(defaultCapabilities), commandExecution: false }

    expect(shouldIncludeCommandShell('win32', settings, features)).toBe(true)

    settings.environmentContext.powerShell = false
    expect(shouldIncludeCommandShell('win32', settings, features)).toBe(false)
  })

  it('preserves the existing POSIX command execution gate', () => {
    const settings = config().settings
    const features = { ...capabilityFeatures(defaultCapabilities), commandExecution: false }

    expect(shouldIncludeCommandShell('linux', settings, features)).toBe(false)
  })
})

describe('prepareAgentSystemPrompt workspace context', () => {
  beforeEach(() => {
    projectStoreMocks.getProject.mockReset()
    memoryStoreMocks.buildMemoryRulesPrompt.mockReset()
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
  })

  it('includes the built-in default workspace and relative path rules', async () => {
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())

    const prepared = await prepareAgentSystemPrompt(thread(), config())
    const workspace = prepared.systemPrompt.sections.find((section) => section.kind === 'workspace')

    expect(workspace?.content).toContain('The active project is "Default Workspace".')
    expect(workspace?.content).toContain('`/workspace/default`')
    expect(workspace?.content).toContain('Resolve every relative path from the primary/default folder')
  })

  it('includes a tagged workspace context when the task has a project', async () => {
    const project: Project = {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, codingMode: false, advancedSettings: true, prompt: '',
      id: 'project-1',
      name: 'Anas',
      kind: 'workspace',
      pinned: false,
      collapsed: false,
      sourceFolders: ['/workspace/Anas', '/workspace/docs'],
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z'
    }
    projectStoreMocks.getProject.mockImplementation(async (projectId: string) => (
      projectId === project.id ? project : defaultWorkspaceProject()
    ))

    const prepared = await prepareAgentSystemPrompt(thread(project.id), config())
    const workspace = prepared.systemPrompt.sections.find((section) => section.kind === 'workspace')

    expect(workspace?.content).toMatch(/^<workspace_context>\n/)
    expect(workspace?.content).toContain('The active project is "Anas".')
    expect(workspace?.content).toContain('`/workspace/Anas`')
    expect(workspace?.content).toContain('`/workspace/docs`')
    expect(workspace?.content).toContain('relative paths refer only to the primary/default folder')
    expect(workspace?.content).toMatch(/\n<\/workspace_context>$/)
  })

  it('uses only the custom prompt and does not load agent context in simple chat', async () => {
    const project: Project = {
      id: 'simple-chat-1',
      name: 'Plain chat',
      kind: 'simple_chat',
      pinned: false,
      collapsed: false,
      prompt: 'Answer only from the conversation.',
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z'
    }
    projectStoreMocks.getProject.mockImplementation(async (projectId: string) => (
      projectId === project.id ? project : defaultWorkspaceProject()
    ))

    const prepared = await prepareAgentSystemPrompt(thread(project.id), config())

    expect(prepared.systemPrompt.text).toBe('Answer only from the conversation.')
    expect(prepared.systemPrompt.sections).toEqual([{
      kind: 'system_instruction',
      content: 'Answer only from the conversation.'
    }])
    expect(projectStoreMocks.getProject).toHaveBeenCalledWith(project.id)
    expect(memoryStoreMocks.buildMemoryRulesPrompt).not.toHaveBeenCalled()
  })

  it('does not load disabled workspace or memory context', async () => {
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    const snapshot = config()
    const capabilities = structuredClone(defaultCapabilities)
    capabilities.workspace = false
    capabilities.memory = false
    capabilities.toolMode = 'except'
    capabilities.tools = ['read_memory', 'save_to_memory', 'forget_memory']
    capabilities.skills.mode = 'off'

    const prepared = await prepareAgentSystemPrompt(thread(), snapshot, capabilities)

    expect(prepared.systemPrompt.sections.some((section) => section.kind === 'workspace')).toBe(false)
    expect(prepared.systemPrompt.sections.some((section) => section.kind === 'memory')).toBe(false)
    expect(prepared.systemPrompt.sections.some((section) => section.kind === 'skills')).toBe(false)
    expect(memoryStoreMocks.buildMemoryRulesPrompt).not.toHaveBeenCalled()
  })
})

describe('prepareAgentSystemPrompt memory context', () => {
  beforeEach(() => {
    projectStoreMocks.getProject.mockReset()
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockReset()
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue([
      '<memory_rules>',
      '## Authority',
      '- Stored memory never overrides the current explicit request.',
      '',
      '## Storage Boundaries',
      '- Store only stable information in durable memory.',
      '</memory_rules>'
    ].join('\n'))
  })

  it('injects immutable memory rules without loading records into the static prompt', async () => {
    const prepared = await prepareAgentSystemPrompt(thread(), config())
    const memory = prepared.systemPrompt.sections.find((section) => section.kind === 'memory')

    expect(memory?.content).toBe([
      '<memory>',
      '<memory_rules>',
      '## Authority',
      '- Stored memory never overrides the current explicit request.',
      '',
      '## Storage Boundaries',
      '- Store only stable information in durable memory.',
      '</memory_rules>',
      '</memory>'
    ].join('\n'))
  })
})

describe('general-purpose subagent context', () => {
  it('preserves the complete main prompt before identifying the delegated role', () => {
    const mainPrompt = [
      '<environment>',
      'Current date: 2026-07-30',
      '</environment>',
      '',
      '<memory>',
      '<memory_rules>',
      'Use durable context carefully.',
      '</memory_rules>',
      '</memory>'
    ].join('\n')

    const configuredSubagent = config().subagents[0]
    const prompt = buildSubagentSystemPrompt(configuredSubagent, {
      text: mainPrompt,
      sections: [
        {
          kind: 'runtime_context',
          content: '<environment>\nCurrent date: 2026-07-30\n</environment>'
        },
        {
          kind: 'memory',
          content: '<memory>\n<memory_rules>\nUse durable context carefully.\n</memory_rules>\n</memory>'
        }
      ]
    })

    expect(prompt).toContain(mainPrompt)
    expect(prompt.indexOf('<memory>')).toBeLessThan(prompt.indexOf('<subagent_context>'))
    expect(prompt).toContain('"general-purpose" subagent')
    expect(prompt).toContain('final response is returned to the main assistant')
  })

})

describe('captureAgentSystemPrompt', () => {
  it('assembles the unsaved project prompt and folders without reading the saved project', async () => {
    const project = defaultWorkspaceProject()
    if (project.kind !== 'workspace') throw new Error('Expected a workspace fixture.')
    project.prompt = 'Use the unsaved project instructions.'
    project.sourceFolders = [testPaths.root]
    project.codingMode = true
    projectStoreMocks.getProject.mockRejectedValue(new Error('Must use the draft.'))
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    const database = openDatabase()
    try {
      const prompt = await captureAgentSystemPrompt(thread(project.id), database.resources, previewConfig(), project)
      expect(prompt).toContain(project.prompt)
      expect(prompt).toContain(testPaths.root)
      expect(prompt).toContain('<coding_instruction>')
      expect(projectStoreMocks.getProject).not.toHaveBeenCalled()
    } finally { database.close() }
  })

  it('does not attach live background-call supervision to a non-persistent preview', async () => {
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    const snapshot = previewConfig(false)
    snapshot.subagents = []
    const database = openDatabase()
    const previewThread = configuredThread(database, { title: 'Preview with retained call' })
    createUnresolvedManagedCall(database, previewThread)

    try {
      await expect(captureAgentSystemPrompt(previewThread, database.resources, snapshot))
        .resolves.toContain('<assistant_profile>')
    } finally {
      database.close()
    }
  })

  it('recalls memory for the preview without sending a model request', async () => {
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    const provider = previewProvider()
    const defaultModel = resolveProviderModelConfig(provider, provider.models[0])
    const snapshot: AppConfigSnapshot = {
      ...config(),
      providers: [provider],
      defaultModelId: defaultModel.id,
      defaultModel
    }
    const database = openDatabase()
    const previewThread = configuredThread(database, { title: 'Memory preview' })
    const recall = vi.spyOn(database.resources.memoryStore, 'relevantMemories').mockResolvedValue([])
    const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'))

    try {
      await captureAgentSystemPrompt(previewThread, database.resources, snapshot)

      expect(recall).toHaveBeenCalledExactlyOnceWith('hello world', previewThread.projectId, undefined)
      expect(network).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })

  it('does not silently replace a missing thread-bound model with the global default', async () => {
    const provider = previewProvider()
    const defaultModel = resolveProviderModelConfig(provider, provider.models[0])
    const snapshot: AppConfigSnapshot = {
      ...config(),
      providers: [provider],
      defaultModelId: defaultModel.id,
      defaultModel
    }
    const database = openDatabase()
    const previewThread = configuredThread(database, {
      title: 'Stale model binding',
      modelConfigId: 'deleted-model-config'
    })

    try {
      await expect(captureAgentSystemPrompt(previewThread, database.resources, snapshot))
        .rejects.toThrow('deleted-model-config')
    } finally {
      database.close()
    }
  })

  it('uses the Anas prompt without Deep Agents behavior tutorials', async () => {
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    const provider = previewProvider()
    const defaultModel = resolveProviderModelConfig(provider, provider.models[0])
    const snapshot: AppConfigSnapshot = {
      ...config(),
      providers: [provider],
      defaultModelId: defaultModel.id,
      defaultModel
    }
    const database = openDatabase()
    const previewThread = configuredThread(database, { title: 'Preview' })

    try {
      const prompt = await captureAgentSystemPrompt(previewThread, database.resources, snapshot)

      expect(prompt).toContain('<assistant_profile>')
      expect(prompt).toContain('<user_profile>')
      expect(prompt).not.toContain('You are a Deep Agent')
      expect(prompt).not.toContain('## `write_todos`')
      expect(prompt).not.toContain('## `task` (subagent spawner)')
      expect(prompt).not.toContain('## Filesystem Tools')
      expect(languageStoreMocks.resolveConfiguredLanguage).toHaveBeenCalledWith('en')
    } finally {
      database.close()
    }
  })

  it('sends exactly the custom prompt in simple chat mode', async () => {
    const skillCatalog = vi.spyOn(skillsStore, 'listSkillSnapshot').mockRejectedValue(new Error('Skill catalog must not be used by simple chat.'))
    const project: Project = {
      id: 'simple-chat-1',
      name: 'Plain chat',
      kind: 'simple_chat',
      pinned: false,
      collapsed: false,
      prompt: 'You are a plain conversational model.',
      createdAt: '2026-07-29T00:00:00.000Z',
      updatedAt: '2026-07-29T00:00:00.000Z'
    }
    projectStoreMocks.getProject.mockImplementation(async (projectId: string) => (
      projectId === project.id ? project : defaultWorkspaceProject()
    ))
    const provider = previewProvider()
    const defaultModel = resolveProviderModelConfig(provider, provider.models[0])
    const snapshot: AppConfigSnapshot = {
      ...config(),
      providers: [provider],
      defaultModelId: defaultModel.id,
      defaultModel
    }
    const database = openDatabase()
    const previewThread = configuredThread(database, { title: 'Simple chat preview', projectId: project.id })

    try {
      await expect(captureAgentSystemPrompt(previewThread, database.resources, snapshot))
        .resolves.toBe('You are a plain conversational model.')
      expect(skillCatalog).not.toHaveBeenCalled()
    } finally {
      database.close()
    }
  })
})

it.each([false, true])('previews the selected planning tools and product prompt without creating execution state (planning=%s)', async planning => {
  const project = defaultWorkspaceProject()
  if (project.kind !== 'workspace') throw new Error('Expected workspace')
  project.capabilities.planning = planning
  projectStoreMocks.getProject.mockResolvedValue(project)
  memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
  const database = openDatabase(), owner = configuredThread(database), snapshot = previewConfig()
  const network = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network request'))
  try {
    const prompt = await captureAgentSystemPrompt(owner, database.resources, snapshot)
    const preview = JSON.parse(await captureAgentModelRequest(owner, database.resources, snapshot, new ManagedCallService(database.managed, database.results)))
    const tools = preview.request.body.tools.map((tool: { function: { name: string } }) => tool.function.name)
    expect(tools.includes('write_todos')).toBe(planning)
    expect(tools).not.toContain('task')
    expect(preview.request.body.messages[0].content).toBe(prompt)
    expect(prompt).toContain('<assistant_profile>')
    expect(prompt).not.toContain('You are a Deep Agent')
    expect(prompt).not.toContain('## `write_todos`')
    expect(prompt).not.toContain('## Filesystem Tools')
    expect(database.runs.store.load(owner.id)).toBeUndefined()
    expect(network).not.toHaveBeenCalled()
  } finally { database.close() }
})

function createRun(database: NativeConversationDatabase, threadId: string, runId: string, content: string) {
  return database.runs.createRun({ threadId, runId, operation: 'agent', message: {
    id: runId + ':input', value: { id: runId + ':input', kind: 'user', content, context: { runId } }
  } })
}
function observer(): RunObserver {
  return { started: vi.fn(), startModel: vi.fn(() => 'observation'), discardModel: vi.fn(),
    model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
}

describe('native main and delegated model budgets', () => {
  it.each([false, true])('limits the main run but allows a delegated task to continue (child %s)', async child => {
    const snapshot = previewConfig()
    snapshot.settings.maxModelCallsPerRun = 1
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: [] })
    const database = openDatabase(), owner = configuredThread(database)
    const run = createRun(database, owner.id, 'budget-root', 'Plan the work.')
    const call = child ? database.runs.createSubagentCall({ id: 'budget-child', ownerThreadId: owner.id,
      parentThreadId: owner.id, parentRunId: run.id, childThreadId: 'budget-child-thread', childRunId: 'budget-child-run',
      config: snapshot.subagents[0], description: 'Plan the work.', childThread: { projectId: owner.projectId }
    }) : undefined
    if (child) {
      database.runs.resolveRunConfiguration({ threadId: owner.id, runId: run.id }, { customTools: [], codingMode: false,
        capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: false } })
      await pauseForRules(database, { threadId: owner.id, runId: run.id })
    }
    const parentState = database.runs.store.load(owner.id)
    const target = call ? database.getThread(call.childThreadId)! : owner
    const runId = call?.childRunId ?? run.id
    let requests = 0
    const providerFetch = vi.fn<typeof fetch>(async () => {
      requests++
      const calls = requests < 3 ? [{ id: `plan-${requests}`, type: 'function', function: { name: 'write_todos',
        arguments: JSON.stringify({ todos: [{ content: 'Verify behavior', status: requests === 1 ? 'in_progress' : 'completed' }] }) } }] : []
      return Response.json({ id: `response-${requests}`, object: 'chat.completion', created: 1, model: 'preview-model',
        choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: {
          role: 'assistant', content: calls.length ? '' : 'Completed', ...(calls.length ? { tool_calls: calls } : {}) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    })
    try {
      const instance = await createConversationInstance(target, database.resources, snapshot,
        { requestId: runId, subagentCall: call, prepareWorkspace: false, providerFetch }, database.execution)
      try {
        const result = await instance.execution.execute('input', { threadId: target.id, runId,
          signal: new AbortController().signal }, observer())
        const state = database.runs.store.load(target.id)!
        expect(result.result.status).toBe(child ? 'fulfilled' : 'rejected')
        expect(state.phase).toBe(child ? 'completed' : 'failed')
        expect(requests).toBe(child ? 3 : 1)
        expect(state.context.modelCalls).toBe(requests)
        expect(state.context.todos).toEqual([{ content: 'Verify behavior', status: child ? 'completed' : 'in_progress' }])
        if (child) {
          expect(state.messages.at(-1)?.value.content).toBe('Completed')
          expect(database.runs.store.load(owner.id)).toEqual(parentState)
          expect(database.messages.activities.getRun(run.id)?.status).toBe('interrupted')
          expect(database.runs.getRunConfiguration({ threadId: owner.id, runId: run.id })?.capabilities.backgroundTools).toBe(false)
          expect(database.runs.getRunConfiguration({ threadId: target.id, runId })?.capabilities.backgroundTools).toBe(true)
        }
        else if (result.result.status === 'rejected') expect(String(result.result.reason)).toMatch(/model.*call.*limit/i)
      } finally { await instance.dispose() }
    } finally { database.close() }
  })
})

describe('native model request preview', () => {
  beforeEach(() => {
    projectStoreMocks.getProject.mockReset().mockResolvedValue(defaultWorkspaceProject())
    memoryStoreMocks.buildMemoryRulesPrompt.mockReset().mockResolvedValue('')
    vi.mocked(toolsStore.listToolSnapshot).mockReset().mockResolvedValue({ roots: [], tools: [] })
  })
  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'matches the actual %s request without creating preview execution state', async protocol => {
      const snapshot = previewConfig()
      snapshot.providers[0].protocol = protocol
      snapshot.defaultModel = resolveProviderModelConfig(snapshot.providers[0], snapshot.providers[0].models[0])
      appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
      projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
      const database = openDatabase(), owner = configuredThread(database)
      let sent: CapturedProviderRequest | undefined
      const network = vi.spyOn(globalThis, 'fetch').mockImplementation(createProviderRequestCaptureFetch(value => { sent = value }))
      try {
        const managedCalls = new ManagedCallService(database.managed, database.results)
        const preview = JSON.parse(await captureAgentModelRequest(owner, database.resources, snapshot, managedCalls))
        expect(network).not.toHaveBeenCalled()
        expect(database.runs.store.load(owner.id)).toBeUndefined()
        expect(database.messages.activities.getLatestRunForThread(owner.id)).toBeNull()
        const run = createRun(database, owner.id, 'preview-comparison', 'hello world')
        const instance = await createConversationInstance(owner, database.resources, snapshot,
          { requestId: run.id, managedCalls, prepareWorkspace: false }, database.execution)
        try {
          const executed = await instance.execution.execute('input', { threadId: owner.id, runId: run.id,
            signal: new AbortController().signal }, observer())
          expect(executed.result.status).toBe('rejected')
          expect(sent, executed.result.status === 'rejected' ? String(executed.result.reason) : '').toBeDefined()
          expect(preview.request.body).toEqual(sent!.body)
          expect(preview.request.url).toBe(sent!.url)
          expect(await captureAgentSystemPrompt(owner, database.resources, snapshot)).toBe(
            protocol === 'anthropic_messages'
              ? (sent!.body as { system: { text: string }[] }).system.map(block => block.text).join('')
              : protocol === 'openai_responses'
                ? (sent!.body as { input: { content: string }[] }).input[0].content
                : (sent!.body as { messages: { content: string }[] }).messages[0].content
          )
        } finally { await instance.dispose() }
      } finally { network.mockRestore(); database.close() }
    }
  )

  it.each([false, true].flatMap(backgroundTools => [false, true].map(selected => ({ backgroundTools, selected }))))('offers custom PTY tools and input only when selected with background tools ($backgroundTools/$selected)', async ({ backgroundTools, selected }) => {
    const snapshot = previewConfig()
    snapshot.customTools = [false, true].map(interactive => toolPackageFixture({ ...customToolDefaults, interactive,
      id: interactive ? 'interactive' : 'ordinary', name: interactive ? 'ask_custom' : 'read_custom',
      description: 'Custom fixture.', command: 'node fixture.cjs {{args}}', inputSchema: { type: 'object', properties: {} } }))
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), advancedSettings: true,
      capabilities: { ...structuredClone(defaultCapabilities), backgroundTools, subagents: { mode: 'off' as const, names: [] }, planning: false,
        toolMode: 'selected', tools: [], customTools: selectedTools(['ordinary', ...(selected ? ['interactive'] : [])]),
        mcp: { defaultMode: 'selected', servers: [] } } })
    const database = openDatabase()
    try {
      const thread = configuredThread(database)
      const preview = JSON.parse(await captureAgentModelRequest(thread, database.resources, snapshot, new ManagedCallService(database.managed, database.results)))
      const names = preview.request.body.tools.map((entry: { name?: string; function?: { name: string } }) => entry.function?.name ?? entry.name)
      expect(names).toContain('read_custom')
      expect(names.includes('ask_custom')).toBe(backgroundTools && selected)
      expect(names.includes('write_call')).toBe(backgroundTools && selected)
      expect(names.some(isCommandShellToolName)).toBe(false)
    } finally { database.close() }
  })
  it.each(['openai_responses', 'openai_chat_completions', 'anthropic_messages'] as const)(
    'orders selected tools and reordered MCP servers in the actual %s request', async (protocol) => {
      const snapshot = previewConfig()
      snapshot.providers[0].protocol = protocol
      snapshot.defaultModel = resolveProviderModelConfig(snapshot.providers[0], snapshot.providers[0].models[0])
      snapshot.customTools = ['second', 'first', 'hidden'].map((id) => toolPackageFixture({ ...customToolDefaults, id, name: `submit_${id}`, description: 'Submit data.', command: 'python /preview-only.py {{args}}', inputSchema: { type: 'object', properties: {} } }))
      vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
      snapshot.mcpServers = ['beta', 'alpha'].map((id, index) => ({
        id, index, name: id, enabled: true, type: 'stdio', command: 'unused', args: [], env: {}, workingDir: '', timeoutMs: 1000, url: ''
      }))
      projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), advancedSettings: true,
        capabilities: { ...structuredClone(defaultCapabilities), subagents: { mode: 'off' as const, names: [] }, planning: true,
          toolMode: 'selected', tools: ['http_request', 'run_shell', 'read_file'], customTools: selectedTools(['first', 'second']),
          mcp: { defaultMode: 'all', servers: [{ id: 'alpha', mode: 'selected', tools: ['mcp_alpha_only'] }] } } })
      const names = ['mcp_alpha_only', 'mcp_alpha_hidden', 'mcp_beta_second', 'mcp_beta_first']
      vi.spyOn(mcpRuntimeService, 'getCachedMcpRuntime').mockResolvedValue({
        tools: names.map(name => defineContentTool({ name, description: name, inputSchema: z.object({}), execute: async () => 'ok' })),
        loaded: [
          { id: 'alpha', index: 1, name: 'alpha', toolCount: 2, toolNames: names.slice(0, 2) },
          { id: 'beta', index: 0, name: 'beta', toolCount: 2, toolNames: names.slice(2) }
        ], errors: [], ping: vi.fn(), close: vi.fn()
      })
      const database = openDatabase()
      try {
        const owner = configuredThread(database, { title: 'Ordered tools' })
        const preview = JSON.parse(await captureAgentModelRequest(owner, database.resources, snapshot, new ManagedCallService(database.managed, database.results)))
        const actual = preview.request.body.tools.map((entry: { name?: string; function?: { name: string } }) =>
          entry.function?.name ?? entry.name).map((name: string) => isCommandShellToolName(name) ? 'run_shell' : name)
        expect(actual).toEqual([
          'write_todos', 'read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call',
          'read_file', 'run_shell', 'http_request', 'submit_second', 'submit_first', 'mcp_beta_second', 'mcp_beta_first', 'mcp_alpha_only'
        ])
      } finally { database.close() }
    }
  )

  it.each([false, true])('sends tools in catalog order for an executing agent (child %s)', async child => {
    const snapshot = previewConfig()
    snapshot.providers[0].protocol = 'openai_responses'
    snapshot.providers[0].parameters = { tools: [{ type: 'web_search' }] }
    snapshot.defaultModel = resolveProviderModelConfig(snapshot.providers[0], snapshot.providers[0].models[0])
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const database = openDatabase()
    const owner = configuredThread(database, { title: 'Tool ordering' })
    const run = createRun(database, owner.id, 'tool-order-root', 'Check available tools.')
    database.runs.resolveRunConfiguration({ threadId: owner.id, runId: run.id }, {
      customTools: [], codingMode: false, capabilities: structuredClone(defaultCapabilities)
    })
    const call = child ? database.runs.createSubagentCall({
      id: '12929292-9292-8292-8292-929292929292', ownerThreadId: owner.id, parentThreadId: owner.id, parentRunId: run.id,
      childThreadId: '13939393-9393-8393-8393-939393939393', childRunId: '14949494-9494-8494-9494-949494949494',
      config: snapshot.subagents[0], description: 'Verify tool order.', childThread: { title: 'Child', projectId: owner.projectId }
    }) : undefined
    let sent: CapturedProviderRequest | undefined
    const providerFetch = createProviderRequestCaptureFetch(value => { sent = value })
    try {
      const target = call ? database.getThread(call.childThreadId)! : owner
      const instance = await createConversationInstance(target, database.resources, snapshot, {
        requestId: call?.childRunId ?? run.id, subagentCall: call, prepareWorkspace: false, providerFetch,
        managedCalls: new ManagedCallService(database.managed, database.results)
      }, database.execution)
      try {
        const result = await instance.execution.execute('input', { threadId: target.id, runId: call?.childRunId ?? run.id,
          signal: new AbortController().signal }, observer())
        expect(result.result.status).toBe('rejected')
        expect(sent, result.result.status === 'rejected' ? String(result.result.reason) : '').toBeDefined()
        const definitions = (sent!.body as { tools: Array<{ name?: string; type?: string }> }).tools
        const names = definitions.flatMap(entry => entry.name ? [entry.name] : [])
          .map(name => isCommandShellToolName(name) ? 'run_shell' : name)
        expect(names).toEqual(orderedToolCatalog.map(entry => entry.id).filter(id => names.includes(id)))
        expect(names[0]).toBe('write_todos')
        expect(names).toContain('read_subagent')
        expect(definitions.at(-1)).toEqual({ type: 'web_search' })
      } finally { await instance.dispose() }
    } finally { database.close() }
  })

  it.each([
    { vision: true, selected: false, expected: ['view_image', 'view_multiple_images'] },
    { vision: false, selected: false, expected: [] },
    { vision: true, selected: true, expected: ['view_multiple_images'] }
  ])('advertises image tools according to model vision $vision and selection $selected', async ({ vision, selected, expected }) => {
    const snapshot = previewConfig()
    snapshot.providers[0].models[0].capabilities.vision = vision
    snapshot.defaultModel = resolveProviderModelConfig(snapshot.providers[0], snapshot.providers[0].models[0])
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), advancedSettings: true,
      capabilities: { ...structuredClone(defaultCapabilities), ...(selected ? { toolMode: 'selected', tools: ['view_multiple_images'] } : {}) } })
    const database = openDatabase()
    try {
      const owner = configuredThread(database, { title: 'Image tools' })
      const preview = JSON.parse(await captureAgentModelRequest(owner, database.resources, snapshot, new ManagedCallService(database.managed, database.results)))
      const names = preview.request.body.tools.map((entry: { function: { name: string } }) => entry.function.name)
      expect(names.filter((name: string) => ['view_image', 'view_multiple_images'].includes(name))).toEqual(expected)
    } finally { database.close() }
  })

  it.each([
    { mode: 'custom' as const, names: ['researcher', 'disabled-agent'], advanced: true, expected: ['researcher'] },
    { mode: 'custom' as const, names: [], advanced: true, expected: [] },
    { mode: 'off' as const, names: ['general-purpose', 'researcher'], advanced: true, expected: [] as string[] },
    { mode: 'default' as const, names: [], advanced: true, expected: ['general-purpose', 'researcher'] },
    { mode: 'custom' as const, names: [], advanced: false, expected: ['general-purpose', 'researcher'] }
  ])('advertises only project-selected subagents ($mode, advanced $advanced, names $names)', async ({ mode, names, advanced, expected }) => {
    const snapshot = previewConfig()
    snapshot.subagents = [snapshot.subagents[0], { ...snapshot.subagents[0], name: 'researcher', description: 'Research only' },
      { ...snapshot.subagents[0], name: 'disabled-agent', enabled: false }]
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), advancedSettings: advanced,
      restrictSubagents: false, capabilities: { ...structuredClone(defaultCapabilities), subagents: { mode, names } } })
    const database = openDatabase()
    try {
      const owner = configuredThread(database, { title: 'Selected agents' })
      const preview = JSON.parse(await captureAgentModelRequest(owner, database.resources, snapshot, new ManagedCallService(database.managed, database.results)))
      const tools = preview.request.body.tools.map((entry: { function?: { name: string; description: string }; name: string; description: string }) => entry.function ?? entry)
      const start = tools.find((entry: { name: string }) => entry.name === 'start_subagent')
      if (!expected.length) expect(start).toBeUndefined()
      else for (const name of ['general-purpose', 'researcher', 'disabled-agent']) {
        expect(start.description.includes(`- ${name}:`)).toBe(expected.includes(name))
      }
      const supervision = expect.arrayContaining(['read_subagent', 'wait_subagent', 'cancel_subagent'])
      if (mode === 'off' && advanced) expect(tools.map((entry: { name: string }) => entry.name)).not.toEqual(supervision)
      else expect(tools.map((entry: { name: string }) => entry.name)).toEqual(supervision)
    } finally { database.close() }
  })

  it.each((['openai_responses', 'openai_chat_completions', 'anthropic_messages'] as const)
    .flatMap((protocol) => [true, false].flatMap((backgroundTools) => [true, false].map((codingMode) => ({ protocol, backgroundTools, codingMode })))))(
    'captures the complete $protocol request with background tools $backgroundTools and coding mode $codingMode without network access',
    async ({ protocol, backgroundTools, codingMode }) => {
      projectStoreMocks.getProject.mockResolvedValue(defaultWorkspaceProject())
      memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('Remember the current task.')
      const provider = {
        ...previewProvider(),
        protocol,
        ...(protocol === 'openai_responses'
          ? {
              parameters: { tools: [{ type: 'web_search' }] }
            }
          : {})
      }
      const defaultModel = resolveProviderModelConfig(provider, provider.models[0])
      const snapshot: AppConfigSnapshot = {
        ...config(),
        providers: [provider],
        defaultModelId: defaultModel.id,
        defaultModel
      }
      projectStoreMocks.getProject.mockResolvedValue({ customTools: [], ...defaultWorkspaceProject(), codingMode, capabilities: { ...structuredClone(defaultCapabilities), backgroundTools } })
      const database = openDatabase()
      const previewThread = configuredThread(database, { title: 'Request preview' })
      const networkFetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
        new Error('Unexpected network access.')
      )

      try {
        const content = await captureAgentModelRequest(
          previewThread,
          database.resources,
          snapshot,
          new ManagedCallService(database.managed, database.results)
        )
        const preview = JSON.parse(content) as {
          simulated_input: string
          request: {
            headers: Record<string, string>
            body: {
              input?: unknown[]
              model: string
              messages?: unknown[]
              tools: unknown[]
            }
          }
        }

        expect(preview.simulated_input).toBe('hello world')
        expect(preview.request.headers[protocol === 'anthropic_messages' ? 'x-api-key' : 'authorization'])
          .toBe(protocol === 'anthropic_messages' ? 'test' : 'Bearer test')
        expect(preview.request.body.model).toBe('preview-model')
        expect(JSON.stringify(preview.request.body.messages ?? preview.request.body.input)).toContain('hello world')
        const requestText = JSON.stringify(preview.request.body)
        expect(requestText.split('<coding_instruction>').length - 1).toBe(codingMode ? 1 : 0)
        const toolDefinitions = preview.request.body.tools.flatMap((value) => {
          if (!value || typeof value !== 'object' || Array.isArray(value)) return []
          const definition = value as Record<string, unknown>
          if (typeof definition.name === 'string') return [definition]
          const functionDefinition = definition.function
          return functionDefinition
            && typeof functionDefinition === 'object'
            && !Array.isArray(functionDefinition)
            && typeof (functionDefinition as Record<string, unknown>).name === 'string'
            ? [functionDefinition as Record<string, unknown>]
            : []
        })
        const toolNames = toolDefinitions.map((definition) => definition.name)
        const normalizedNames = toolNames.map((name) => isCommandShellToolName(String(name)) ? 'run_shell' : name)
        expect(normalizedNames).toEqual(orderedToolCatalog.map((entry) => entry.id).filter((id) => normalizedNames.includes(id)))
        expect(toolNames).toEqual(expect.arrayContaining([
          'write_todos',
          'sleep',
          'start_subagent',
          'read_subagent',
          'wait_subagent',
          'cancel_subagent'
        ]))
        const readFile = toolDefinitions.find((definition) => definition.name === 'read_file')
        expect(readFile).toBeDefined()
        expect(String(readFile?.description).includes('10 seconds')).toBe(backgroundTools)
        for (const name of ['read_call', 'read_call_output', 'wait_call', 'cancel_call']) {
          expect(toolNames.includes(name)).toBe(backgroundTools)
        }
        expect(toolNames).not.toContain('task')
        if (protocol === 'openai_responses') {
          expect(preview.request.body.tools).toContainEqual(expect.objectContaining({ type: 'web_search' }))
        }
        expect(networkFetch).not.toHaveBeenCalled()
      } finally {
        networkFetch.mockRestore()
        database.close()
      }
    }
  )
})

describe('native user input source', () => {
  it.each([false, true])('uses the current owner access mode without mutating the assembled thread (delegated=%s)', async delegated => {
    const database = openDatabase()
    const owner = configuredThread(database, { accessMode: 'full_access' })
    const child = configuredThread(database, { accessMode: 'full_access' })
    const selected = delegated ? child : owner
    const accessMode = createAgentAccessModeResolver(database.resources, selected.id, delegated ? { ownerThreadId: owner.id } : undefined)
    try {
      for (const mode of ['full_access', 'read_only_allowed', 'strict_approval', 'full_access'] as const) {
        database.setAccessMode(owner.id, mode)
        expect(selected.accessMode).toBe('full_access')
        expect(database.getThread(owner.id)?.accessMode).toBe(mode)
        expect(database.getThread(child.id)?.accessMode).toBe('full_access')
        expect(await requiresToolApproval({ toolName: 'pwsh', commandShellToolName: 'pwsh', args: { command: 'pwd' },
          primaryFolder: testPaths.root, trustedFolders: [], accessMode: accessMode() })).toBe(mode !== 'full_access')
      }
    } finally { database.close() }
  })

  it.each([0, 1, 2])('identifies the owning conversation for delegation depth %s', async depth => {
    const snapshot = previewConfig()
    const project = defaultWorkspaceProject()
    vi.mocked(toolsStore.listToolSnapshot).mockResolvedValue({ roots: [], tools: snapshot.customTools })
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    projectStoreMocks.getProject.mockResolvedValue(project)
    memoryStoreMocks.buildMemoryRulesPrompt.mockResolvedValue('')
    const database = openDatabase()
    const owner = configuredThread(database, { title: 'Owning conversation' })
    let thread = owner
    let run = createRun(database, owner.id, 'source-root', 'Investigate')
    let call: ReturnType<typeof database.runs.createSubagentCall> | undefined
    try {
      for (let level = 1; level <= depth; level++) {
        call = database.runs.createSubagentCall({
          id: `source-call-${level}`, ownerThreadId: owner.id, parentThreadId: thread.id, parentRunId: run.id,
          parentSubagentId: call?.id, childThreadId: `source-child-${level}`, childRunId: `source-run-${level}`,
          config: snapshot.subagents[0], description: 'Investigate the task.',
          childThread: { title: `Hidden child ${level}`, projectId: owner.projectId }
        })
        thread = database.getThread(call.childThreadId)!
        run = database.messages.activities.getRun(call.childRunId)!
      }
      const definitions = vi.spyOn(runtimeTools, 'runtimeToolDefinitions')
      const instance = await createConversationInstance(thread, database.resources, snapshot, {
        requestId: run.id, subagentCall: call, prepareWorkspace: false
      }, database.execution)
      try {
        const source = definitions.mock.lastCall![0].userInputSource!
        expect(await source()).toEqual({ projectName: project.name, threadTitle: owner.title,
          ...(call ? { agentName: call.agentName } : {}) })
        database.updateThread(owner.id, { title: 'Renamed conversation' })
        projectStoreMocks.getProject.mockResolvedValue({ ...project, name: 'Renamed project' })
        expect(await source()).toEqual({ projectName: 'Renamed project', threadTitle: 'Renamed conversation',
          ...(call ? { agentName: call.agentName } : {}) })
      } finally { await instance.dispose() }
    } finally { database.close() }
  })
})

describe('native run configuration freezing', () => {
  beforeEach(() => {
    memoryStoreMocks.buildMemoryRulesPrompt.mockReset().mockResolvedValue('')
    vi.mocked(toolsStore.listToolSnapshot).mockReset().mockResolvedValue({ roots: [], tools: [] })
  })

  it.each([false, true])('freezes coding mode %s across recreation and reopen, then refreshes the next run', async codingMode => {
    const snapshot = previewConfig()
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const project = { ...defaultWorkspaceProject(), codingMode, advancedSettings: false, compressionPrompt: 'Keep sources: {conversation}' }
    projectStoreMocks.getProject.mockResolvedValue(project)
    const file = join(testPaths.root, `coding-configuration-${codingMode}.sqlite`)
    let database = openDatabase(file)
    const owner = configuredThread(database), run = createRun(database, owner.id, 'coding-first', 'Inspect')
    const identity = { threadId: owner.id, runId: run.id }
    const definitions = vi.spyOn(runtimeTools, 'runtimeToolDefinitions')
    try {
      const initial = await createConversationInstance(owner, database.resources, snapshot,
        { requestId: run.id, prepareWorkspace: false }, database.execution)
      const originalStatus = await initial.context.status({ messages: [] })
      const originalTools = (await definitions.mock.results.at(-1)!.value).map((tool: { name: string }) => tool.name)
      await initial.dispose()
      const configuration = database.runs.getRunConfiguration(identity)!
      expect(configuration.codingMode).toBe(codingMode)
      expect(configuration.compressionPrompt).toBeUndefined()
      expect(configuration.capabilities).toMatchObject({ memory: true, workspace: true, toolMode: 'all' })
      expect((await prepareAgentSystemPrompt(owner, snapshot)).systemPrompt.text.includes('<coding_instruction>')).toBe(codingMode)
      await pauseForRules(database, identity)
      projectStoreMocks.getProject.mockResolvedValue({ ...project, codingMode: !codingMode, compressionPrompt: 'New sources: {conversation}' })
      database.close(); database = openDatabase(file)
      expect(database.readSnapshot(owner.id).interrupts).toHaveLength(1)
      const resumed = await createConversationInstance(owner, database.resources, snapshot,
        { requestId: run.id, prepareWorkspace: false }, database.execution)
      expect(database.runs.getRunConfiguration(identity)).toEqual(configuration)
      expect((await resumed.context.status({ messages: [] })).breakdown.systemInstructionTokens).toBe(originalStatus.breakdown.systemInstructionTokens)
      expect((await definitions.mock.results.at(-1)!.value).map((tool: { name: string }) => tool.name)).toEqual(originalTools)
      await resumed.dispose()
      expect((await prepareAgentSystemPrompt(owner, snapshot, configuration.capabilities, configuration.codingMode)).systemPrompt.text.includes('<coding_instruction>')).toBe(codingMode)
      expect((await prepareAgentSystemPrompt(owner, snapshot)).systemPrompt.text.includes('<coding_instruction>')).toBe(!codingMode)
      database.runs.requestCancellation(identity); database.runs.completeCancellation(identity)
      const next = createRun(database, owner.id, 'coding-next', 'Continue')
      const instance = await createConversationInstance(owner, database.resources, snapshot,
        { requestId: next.id, prepareWorkspace: false }, database.execution)
      expect(database.runs.getRunConfiguration({ threadId: owner.id, runId: next.id })?.codingMode).toBe(!codingMode)
      expect((await instance.context.status({ messages: [] })).breakdown.systemInstructionTokens).not.toBe(originalStatus.breakdown.systemInstructionTokens)
      await instance.dispose()
    } finally { database.close() }
  })

  it('retains a running task compression template after customization is disabled and refreshes the next run', async () => {
    const snapshot = previewConfig()
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    const project = { ...defaultWorkspaceProject(), advancedSettings: true, compressionPrompt: 'Keep sources: {conversation}' }
    projectStoreMocks.getProject.mockResolvedValue(project)
    const file = join(testPaths.root, 'compression-configuration.sqlite')
    let database = openDatabase(file)
    const owner = configuredThread(database), run = createRun(database, owner.id, 'compression-first', 'Inspect')
    const identity = { threadId: owner.id, runId: run.id }
    let request: unknown
    const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
      request = JSON.parse(String(init?.body))
      return Response.json({ id: 'summary', object: 'chat.completion', created: 1, model: 'preview-model',
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Concise summary' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    })
    try {
      const initial = await createConversationInstance(owner, database.resources, snapshot,
        { requestId: run.id, prepareWorkspace: false, providerFetch }, database.execution)
      expect(database.runs.getRunConfiguration(identity)?.compressionPrompt).toBe(project.compressionPrompt)
      await initial.dispose()
      projectStoreMocks.getProject.mockResolvedValue({ ...project, advancedSettings: false })
      database.close(); database = openDatabase(file)
      for (const phase of ['resumed', 'next', 'enabled'] as const) {
        if (phase !== 'resumed') {
          const previous = { threadId: owner.id, runId: phase === 'next' ? run.id : 'compression-next' }
          database.runs.requestCancellation(previous); database.runs.completeCancellation(previous)
          if (phase === 'enabled') projectStoreMocks.getProject.mockResolvedValue(project)
          createRun(database, owner.id, `compression-${phase}`, 'Continue')
        }
        const runId = phase === 'resumed' ? run.id : `compression-${phase}`
        const instance = await createConversationInstance(owner, database.resources, snapshot,
          { requestId: runId, prepareWorkspace: false, providerFetch }, database.execution)
        try {
          expect(database.runs.getRunConfiguration({ threadId: owner.id, runId })?.compressionPrompt)
            .toBe(phase === 'next' ? undefined : project.compressionPrompt)
          const summary = await instance.context.compress({ messages: [
            { id: 'history-user', kind: 'user', content: 'Find the source file' },
            { id: 'history-answer', kind: 'assistant', content: 'The source is main.ts' }
          ] }, new AbortController().signal)
          expect(summary.summaryText).toBe('Concise summary')
          expect(JSON.stringify(request).includes('Keep sources:')).toBe(phase !== 'next')
          expect(JSON.stringify(request)).toContain('The source is main.ts')
        } finally { await instance.dispose() }
      }
      expect(providerFetch).toHaveBeenCalledTimes(3)
    } finally { database.close() }
  })
})

describe('native model resources during execution', () => {
  beforeEach(() => {
    memoryStoreMocks.buildMemoryRulesPrompt.mockReset().mockResolvedValue('')
    vi.mocked(toolsStore.listToolSnapshot).mockReset().mockResolvedValue({ roots: [], tools: [] })
  })

  it.each(['plan', 'approval', 'invalid-number'] as const)('preserves mixed %s batches through actual product tools and durable replies', async source => {
    await writeFile(join(testPaths.root, 'batch-input.txt'), 'Fixture contents')
    const snapshot = previewConfig()
    snapshot.subagents = []
    appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
    projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), sourceFolders: [testPaths.root], codingMode: true,
      capabilities: { ...structuredClone(defaultCapabilities), planning: true, toolMode: 'selected', tools: ['read_file', 'update_config'],
        memory: false, skills: { mode: 'off', project: false, entries: [] } } })
    const database = openDatabase(), target = configuredThread(database)
    const run = createRun(database, target.id, 'mixed-batch', 'Process the batch.')
    const managedCalls = new ManagedCallService(database.managed, database.results), execute = vi.spyOn(managedCalls, 'start')
    const todos = [{ content: 'A valid plan', status: 'pending' }]
    const calls = source === 'plan' ? [
      { id: 'invalid', name: 'write_todos', args: { todos: 'wrong' } }, { id: 'valid', name: 'write_todos', args: { todos } }
    ] : source === 'approval' ? [
      { id: 'invalid', name: 'read_file', args: { path: 4 } },
      { id: 'automatic', name: 'read_file', args: { path: 'batch-input.txt' } },
      { id: 'review', name: 'update_config', args: { config: 'settings', key: 'theme', value: 'dark' } }
    ] : [
      { id: 'invalid', name: 'read_file', args: { path: 'batch-input.txt', extra: { limit: Infinity } } },
      { id: 'valid', name: 'read_file', args: { path: 'batch-input.txt' } }
    ]
    let requests = 0
    const providerFetch = vi.fn<typeof fetch>(async () => {
      const batch = requests++ === 0 ? calls : source === 'invalid-number' && requests === 2
        ? [{ id: 'corrected', name: 'read_file', args: { path: 'batch-input.txt' } }] : []
      return Response.json({ id: `response-${requests}`, object: 'chat.completion', created: 1, model: 'preview-model',
        choices: [{ index: 0, finish_reason: batch.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: batch.length ? '' : 'Done',
          ...(batch.length ? { tool_calls: batch.map(call => ({ id: call.id, type: 'function', function: { name: call.name,
            arguments: source === 'invalid-number' && call.id === 'invalid' ? '{"path":"batch-input.txt","extra":{"limit":1e400}}' : JSON.stringify(call.args) } })) } : {}) } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
    })
    try {
      const instance = await createConversationInstance(target, database.resources, snapshot,
        { requestId: run.id, prepareWorkspace: false, managedCalls, providerFetch }, database.execution)
      try {
        const request = { threadId: target.id, runId: run.id, signal: new AbortController().signal }
        const observed = observer()
        let result = await instance.execution.execute('input', request, observed)
        expect(result.result, result.result.status === 'rejected' ? String(result.result.reason) : '').toMatchObject({ status: 'fulfilled' })
        if (source === 'approval') {
          const state = database.runs.store.load(target.id)!, approval = state.approvals[0]
          expect(state.phase).toBe('waiting')
          expect(state.approvals).toHaveLength(1)
          expect(execute).not.toHaveBeenCalled()
          expect(observed.approval).toHaveBeenCalledExactlyOnceWith({ call: { ...calls[2], id: approval.callIds[0] },
            approval: { status: 'pending_approval', interruptId: approval.id, actionIndex: 0 }, subagentId: undefined })
          expect(database.readSnapshot(target.id).interrupts).toEqual(database.runs.readInterrupts({ threadId: target.id, runId: run.id }))
          database.runs.saveAnswers({ threadId: target.id, runId: run.id, expectedRevisionId: state.revisionId }, [{
            id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'reject', message: 'Leave settings alone' }] }
          }])
          result = await instance.execution.execute('resume', request, observer())
        }
        expect(result.result.status).toBe('fulfilled')
        const state = database.runs.store.load(target.id)!, messages = state.messages.map(record => record.value)
        const results = messages.filter(message => message.kind === 'tool')
        expect(state.phase).toBe('completed')
        expect(results).toHaveLength(calls.length + (source === 'invalid-number' ? 1 : 0))
        expect(new Set(results.map(message => message.resultFor)).size).toBe(results.length)
        expect(results[0]).toMatchObject({ resultFor: 'invalid', resultStatus: 'error' })
        expect(messages.find(message => message.kind === 'assistant')?.calls?.map(call => call.id)).toEqual(calls.map(call => call.id))
        expect(messages.filter(message => message.kind === 'assistant')).toHaveLength(source === 'invalid-number' ? 3 : 2)
        if (source === 'plan') expect(state.context.todos).toEqual(todos)
        else if (source === 'approval') expect(results.every(message => message.resultStatus === 'error')).toBe(true)
        else {
          expect(results[0].content).toContain('/extra/limit')
          expect(messages.find(message => message.kind === 'assistant')?.calls?.[0].args).toEqual(calls[0].args)
          expect(results.slice(1).map(message => message.resultStatus)).toEqual(['success', 'success'])
        }
        expect(execute).toHaveBeenCalledTimes(source === 'invalid-number' ? 2 : 0)
      } finally { await instance.dispose() }
    } finally { await managedCalls.shutdown(); database.close() }
  })

  it.each([false, true].flatMap(child => [256_000, 1_000_000].map(maxContextTokens => ({ child, maxContextTokens }))))(
    'enforces the selected model read budget ($maxContextTokens, child $child)', async ({ child, maxContextTokens }) => {
      const path = join(testPaths.root, `read-budget-${child}-${maxContextTokens}.txt`)
      await writeFile(path, 'x'.repeat(300_000))
      const snapshot = previewConfig()
      snapshot.providers[0].models.push({ ...snapshot.providers[0].models[0], id: 'read-budget-model', maxContextTokens, contextCompressionEnabled: false })
      appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
      projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), sourceFolders: [testPaths.root] })
      const database = openDatabase(), owner = configuredThread(database, { modelConfigId: 'read-budget-model' })
      const parent = createRun(database, owner.id, 'read-budget-run', 'Read the file.')
      const call = child ? database.runs.createSubagentCall({ id: 'read-budget-child', ownerThreadId: owner.id,
        parentThreadId: owner.id, parentRunId: parent.id, childThreadId: 'read-budget-child-thread', childRunId: 'read-budget-child-run',
        config: snapshot.subagents[0], description: 'Read the file.', childThread: { projectId: owner.projectId } }) : undefined
      const target = call ? database.getThread(call.childThreadId)! : owner, runId = call?.childRunId ?? parent.id
      const managedCalls = new ManagedCallService(database.managed, database.results)
      let requests = 0
      const providerFetch = vi.fn<typeof fetch>(async () => {
        requests++
        return Response.json({ id: `response-${requests}`, object: 'chat.completion', created: 1, model: 'preview-model',
          choices: [{ index: 0, finish_reason: requests === 1 ? 'tool_calls' : 'stop', message: { role: 'assistant',
            content: requests === 1 ? '' : 'Read complete', ...(requests === 1 ? { tool_calls: [{ id: 'read-budget', type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path }) } }] } : {}) } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      })
      try {
        const instance = await createConversationInstance(target, database.resources, snapshot,
          { requestId: runId, subagentCall: call, prepareWorkspace: false, managedCalls, providerFetch }, database.execution)
        try {
          const result = await instance.execution.execute('input', { threadId: target.id, runId, signal: new AbortController().signal }, observer())
          expect(result.result.status).toBe('fulfilled')
          const read = database.runs.store.load(target.id)!.messages.map(record => record.value)
            .find(message => message.kind === 'tool' && message.resultFor === 'read-budget')!
          const output = JSON.parse(String(read.content))
          if (maxContextTokens < 300_000) expect(output).toMatchObject({ ok: false, error: expect.stringContaining(String(maxContextTokens)) })
          else expect(output).toMatchObject({ ok: true, byteLimit: maxContextTokens, returnedBytes: 300_000 })
          expect(requests).toBe(2)
        } finally { await instance.dispose() }
      } finally { await managedCalls.shutdown(); database.close() }
    }
  )

  it.each([false, true].flatMap(memory => [false, true].map(tools => ({ memory, tools }))))(
    'runs automatic recall $memory independently from memory tools $tools', async ({ memory, tools }) => {
      const names = ['read_memory', 'save_to_memory', 'forget_memory'], snapshot = previewConfig()
      snapshot.subagents = []
      projectStoreMocks.getProject.mockResolvedValue({ ...defaultWorkspaceProject(), sourceFolders: [testPaths.root],
        capabilities: { ...structuredClone(defaultCapabilities), memory, subagents: { mode: 'off', names: [] }, backgroundTools: false,
          planning: false, toolMode: 'selected', tools: tools ? names : [], skills: { mode: 'off', project: false, entries: [] } } })
      appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
      const database = openDatabase(), target = configuredThread(database)
      const run = createRun(database, target.id, 'memory-options', 'Recall project preferences.')
      const recall = vi.spyOn(database.resources.memoryStore, 'relevantMemories').mockResolvedValue([])
      const providerFetch = vi.fn<typeof fetch>(async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as { tools?: { function: { name: string } }[] }
        const selected = request.tools?.map(tool => tool.function.name) ?? []
        for (const name of names) expect(selected.includes(name)).toBe(tools)
        return Response.json({ id: 'memory-response', object: 'chat.completion', created: 1, model: 'preview-model',
          choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
      })
      try {
        const instance = await createConversationInstance(target, database.resources, snapshot,
          { requestId: run.id, prepareWorkspace: false, providerFetch }, database.execution)
        try {
          const result = await instance.execution.execute('input', { threadId: target.id, runId: run.id, signal: new AbortController().signal }, observer())
          expect(result.result.status).toBe('fulfilled')
          expect(recall).toHaveBeenCalledTimes(memory ? 1 : 0)
          expect(providerFetch).toHaveBeenCalledOnce()
        } finally { await instance.dispose() }
      } finally { database.close() }
    }
  )
})

it.each([false, true])('keeps background tools %s through a saved approval and refreshes the next native run', async enabled => {
  const snapshot = previewConfig()
  appConfigMocks.getAppConfigSnapshot.mockResolvedValue(snapshot)
  const project = { ...defaultWorkspaceProject(), capabilities: { ...structuredClone(defaultCapabilities), backgroundTools: enabled } }
  projectStoreMocks.getProject.mockResolvedValue(project)
  const file = join(testPaths.root, `background-configuration-${enabled}.sqlite`)
  let database = openDatabase(file)
  const thread = configuredThread(database), run = createRun(database, thread.id, 'background-first', 'Inspect')
  const owner = { threadId: thread.id, runId: run.id }, definitions = vi.spyOn(runtimeTools, 'runtimeToolDefinitions')
  try {
    const initial = await createConversationInstance(thread, database.resources, snapshot, { requestId: run.id, prepareWorkspace: false }, database.execution)
    expect(definitions.mock.calls.at(-1)?.[0].backgroundTools).toBe(enabled)
    await initial.dispose(); await pauseForRules(database, owner)
    const saved = database.runs.getRunConfiguration(owner)
    projectStoreMocks.getProject.mockResolvedValue({ ...project, capabilities: { ...project.capabilities, backgroundTools: !enabled } })
    database.close(); database = openDatabase(file)
    const interrupt = database.readSnapshot(thread.id).interrupts[0]
    database.runs.saveResponses({ ...owner, responses: [{ interruptId: interrupt.id, expectedGeneration: interrupt.approvalGeneration, decisions: [{ type: 'approve' }] }] })
    await database.runs.enter('resume', owner)
    const resumed = await createConversationInstance(thread, database.resources, snapshot, { requestId: run.id, prepareWorkspace: false }, database.execution)
    expect(database.runs.getRunConfiguration(owner)).toEqual(saved)
    expect(definitions.mock.calls.at(-1)?.[0].backgroundTools).toBe(enabled)
    await resumed.dispose()
    database.runs.store.finish({ ...owner, expectedRevisionId: database.runs.store.load(thread.id)!.revisionId }, 'completed')
    const next = createRun(database, thread.id, 'background-next', 'Continue')
    const instance = await createConversationInstance(thread, database.resources, snapshot, { requestId: next.id, prepareWorkspace: false }, database.execution)
    expect(database.runs.getRunConfiguration({ threadId: thread.id, runId: next.id })?.capabilities.backgroundTools).toBe(!enabled)
    expect(definitions.mock.calls.at(-1)?.[0].backgroundTools).toBe(!enabled)
    await instance.dispose()
    expect(database.runs.getRunConfiguration(owner)).toEqual(saved)
  } finally { database.close() }
})
