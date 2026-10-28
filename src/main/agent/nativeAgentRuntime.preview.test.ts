import { NativeAgentRuntime } from './nativeAgentRuntime'
import { AgentStorage } from './agentStorage'
import type { NativeConversationDatabase } from './nativeConversationDatabase'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { diffViewSettingsFixture } from '../../test/diffViewSettingsFixture'
import { environmentContextFixture } from '../../test/environmentContextFixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AppConfigSnapshot, AppSettings, ModelProviderConfigDetail, ProjectModelSelection } from '@shared/types'
import { modelContextKey, resolveProviderModelConfig } from '@shared/modelConfig'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import type { AgentContextStatus } from '../../shared/agentTypes'
import * as modelSelection from './modelSelection'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'

const previewMocks = vi.hoisted(() => ({
  captureAgentModelRequest: vi.fn(),
  captureAgentSystemPrompt: vi.fn(),
  projectConversationContextStatus: vi.fn(),
  getAppConfigSnapshot: vi.fn(),
  createConversationInstance: vi.fn()
}))

vi.mock('../config/appConfig', async (importOriginal) => ({
  ...await importOriginal<typeof import('../config/appConfig')>(),
  getAppConfigSnapshot: previewMocks.getAppConfigSnapshot
}))

vi.mock('./conversationInstance', () => ({
  createConversationInstance: previewMocks.createConversationInstance
}))

vi.mock('./conversationPreview', () => ({
  captureAgentModelRequest: previewMocks.captureAgentModelRequest,
  captureAgentSystemPrompt: previewMocks.captureAgentSystemPrompt,
  projectConversationContextStatus: previewMocks.projectConversationContextStatus
}))

function provider(index: number, name: string): ModelProviderConfigDetail {
  return {
    index,
    id: `provider-${index}`,
    name,
    protocol: 'openai_chat_completions',
    baseUrl: 'https://preview.invalid/v1',
    modelListUrl: '',
    parameters: {},
    models: [{
      index: 0,
      id: `model-${index}`,
      displayName: '',
      model: `model-${index}`,
      parameters: {},
      parameterPresetMode: 'none',
      capabilities: { vision: true, toolUse: true },
      stream: true,
      maxContextTokens: 100_000,
      maxOutputTokens: 4_000,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: true
    }]
  }
}

describe('NativeAgentRuntime system prompt preview', () => {
  let database: NativeConversationDatabase
  let nativeStorage: AgentStorage<NativeConversationDatabase> | undefined
  let nativeRuntime: NativeAgentRuntime | undefined
  let nativeRoot: string | undefined

  afterEach(async () => {
    await nativeRuntime?.shutdown()
    nativeStorage?.close()
    if (nativeRoot) rmSync(nativeRoot, { recursive: true, force: true })
    nativeRuntime = undefined; nativeStorage = undefined; nativeRoot = undefined
    previewMocks.captureAgentModelRequest.mockReset()
    previewMocks.captureAgentSystemPrompt.mockReset()
    previewMocks.projectConversationContextStatus.mockReset()
    previewMocks.getAppConfigSnapshot.mockReset()
    previewMocks.createConversationInstance.mockReset()
    vi.restoreAllMocks()
  })

  function openPreview() {
    nativeRoot = mkdtempSync(join(tmpdir(), 'anas-native-preview-'))
    nativeStorage = AgentStorage.openNative(nativeRoot)
    database = nativeStorage.previewDatabase()
    return database
  }

  function runtimeForPreview() {
    return nativeRuntime = new NativeAgentRuntime(database, nativeRoot!, { push: () => {} })
  }

  it('does not initialize configured MCP or model dependencies for a history snapshot', async () => {
    openPreview()
    const thread = database.createThread({ title: 'Offline history' })
    const owner = { threadId: thread.id, runId: randomUUID() }, inputId = `${owner.runId}:input`
    database.runs.createRun({ ...owner, operation: 'agent', message: { id: inputId,
      value: { id: inputId, kind: 'user', content: 'Saved history', context: { runId: owner.runId } } } })
    await database.runs.enter('input', owner)
    const scope = () => ({ ...owner, expectedRevisionId: database.runs.store.load(thread.id)!.revisionId })
    database.runs.store.acceptModel(scope(), { id: 'saved-answer', value: { kind: 'assistant', content: 'Saved answer', context: { runId: owner.runId } } }, [],
      { modelCalls: 1, todos: [{ content: 'Saved todo', status: 'completed' }] })
    database.runs.store.finish(scope(), 'completed')
    const configuredProvider = provider(0, 'Configured')
    const defaultModel = resolveProviderModelConfig(configuredProvider, configuredProvider.models[0])
    previewMocks.getAppConfigSnapshot.mockResolvedValue({ customTools: [],
        providers: [configuredProvider],
      subagents: [],
      mcpServers: [{
        index: 0,
        name: 'Offline MCP',
        enabled: true,
        type: 'http',
        url: 'https://offline.invalid/mcp',
        id: 'offline-mcp',
        command: '',
        args: [],
        workingDir: '',
        timeoutMs: 30_000,
        env: {}
      }],
      settings: {
        profile: {
          assistant: { name: 'Anas', role: 'Assistant', instructions: '', newAvatarPath: '' },
          user: { preferredName: '', personalInfo: '' }
        },
        speechReply: { enabled: false, voice: '', speed: 1 },
        language: 'en',
        theme: 'dark',
        fontSize: 14,
        chatContentWidth: 'narrow',
        attachmentTextMaxChars: 200_000,
        attachmentTextOverflow: 'truncate',
        logLevel: 'info',
        logRetentionDays: 14,
        maxModelCallsPerRun: 100,
        environmentContext: environmentContextFixture(),
        sidebarVisible: true,
        sidebarWidth: 260,
      workspacePanelWidth: 480, ...diffViewSettingsFixture,
        sidebarCollapsedSections: {
          projects: false,
          simpleChats: false
        },
        backupDir: ''
      },
      defaultModelId: defaultModel.id,
      defaultModel
    } satisfies AppConfigSnapshot)
    previewMocks.createConversationInstance.mockRejectedValue(
      new Error('Configured MCP is offline.')
    )
    const runtime = runtimeForPreview()

    await expect(runtime.getSnapshot(thread.id)).resolves.toMatchObject({
      thread: { id: thread.id },
      messages: [{ id: inputId, role: 'user' }, { id: 'saved-answer', role: 'assistant' }],
      todos: [{ content: 'Saved todo', status: 'completed' }],
      interrupts: []
    })
    expect((await runtime.loadEarlierMessages({ threadId: thread.id, beforeIndex: 0 })).messages.map(message => message.id)).toEqual([inputId, 'saved-answer'])
    expect(previewMocks.getAppConfigSnapshot).not.toHaveBeenCalled()
    expect(previewMocks.createConversationInstance).not.toHaveBeenCalled()
    expect(previewMocks.projectConversationContextStatus).not.toHaveBeenCalled()
  })

  it('uses project draft settings without changing the persisted main model', async () => {
    openPreview()
    const thread = database.createThread({ title: 'Preview', projectId: 'preview-chat' })
    const firstProvider = provider(0, 'First')
    const selectedProvider = provider(1, 'Selected')
    const firstModel = resolveProviderModelConfig(firstProvider, firstProvider.models[0])
    const settings: AppSettings = {
      profile: {
        assistant: { name: 'Anas', role: 'Assistant', instructions: '', newAvatarPath: '' },
        user: { preferredName: '', personalInfo: '' }
      },
      speechReply: { enabled: false, voice: '', speed: 1 },
      language: 'en',
      theme: 'dark',
      fontSize: 14,
      chatContentWidth: 'narrow',
      attachmentTextMaxChars: 200_000,
      attachmentTextOverflow: 'truncate',
      logLevel: 'info',
      logRetentionDays: 14,
      maxModelCallsPerRun: 100,
      environmentContext: environmentContextFixture(),
      sidebarVisible: true,
      sidebarWidth: 260,
      workspacePanelWidth: 480, ...diffViewSettingsFixture,
      sidebarCollapsedSections: {
        projects: false,
        simpleChats: false
      },
      backupDir: ''
    }
    previewMocks.getAppConfigSnapshot.mockResolvedValue({ customTools: [],
        providers: [firstProvider, selectedProvider],
      subagents: [],
      mcpServers: [],
      settings,
      defaultModelId: firstModel.id,
      defaultModel: firstModel
    } satisfies AppConfigSnapshot)
    previewMocks.captureAgentSystemPrompt.mockResolvedValue('FINAL SYSTEM PROMPT')
    const runtime = runtimeForPreview()

    const preview = await runtime.previewSystemContext({
      projectId: thread.projectId,
      project: { kind: 'simple_chat', name: 'Draft', prompt: 'Unsaved prompt' },
      settings
    })

    expect(preview).toEqual({ content: 'FINAL SYSTEM PROMPT' })
    expect(previewMocks.captureAgentSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: thread.projectId, userTurnCount: 0 }),
      database.resources,
      expect.objectContaining({
        settings,
        defaultModel: firstModel
      }),
      expect.objectContaining({ prompt: 'Unsaved prompt', name: 'Draft' })
    )
  })

  it('binds a synthetic new-thread preview to the currently selected model', async () => {
    openPreview()
    const defaultProvider = provider(0, 'Default')
    const selectedProvider = provider(1, 'Selected')
    const defaultModel = resolveProviderModelConfig(defaultProvider, defaultProvider.models[0])
    const selectedModel = resolveProviderModelConfig(selectedProvider, selectedProvider.models[0])
    const settings = {
      profile: {
        assistant: { name: 'Anas', role: 'Assistant', instructions: '', newAvatarPath: '' },
        user: { preferredName: '', personalInfo: '' }
      },
      speechReply: { enabled: false, voice: '', speed: 1 },
      language: 'en',
      theme: 'dark',
      fontSize: 14,
      chatContentWidth: 'narrow',
      attachmentTextMaxChars: 200_000,
      attachmentTextOverflow: 'truncate',
      logLevel: 'info',
      logRetentionDays: 14,
      maxModelCallsPerRun: 100,
      environmentContext: environmentContextFixture(),
      sidebarVisible: true,
      sidebarWidth: 260,
      workspacePanelWidth: 480, ...diffViewSettingsFixture,
      sidebarCollapsedSections: { projects: false, simpleChats: false },
      backupDir: ''
    } satisfies AppSettings
    previewMocks.getAppConfigSnapshot.mockResolvedValue({ customTools: [],
        providers: [defaultProvider, selectedProvider],
      subagents: [],
      mcpServers: [],
      settings,
      defaultModelId: defaultModel.id,
      defaultModel
    } satisfies AppConfigSnapshot)
    previewMocks.captureAgentSystemPrompt.mockResolvedValue('SELECTED MODEL PROMPT')
    const runtime = runtimeForPreview()

    await expect(runtime.previewSystemContext({
      projectId: '0',
      project: { kind: 'simple_chat', name: 'Draft', prompt: '', modelConfigId: selectedModel.id },
      settings
    })).resolves.toEqual({ content: 'SELECTED MODEL PROMPT' })
    expect(previewMocks.captureAgentSystemPrompt).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'system-context-preview',
        modelConfigId: selectedModel.id,
        projectId: '0'
      }),
      database.resources,
      expect.objectContaining({ defaultModel }),
      expect.objectContaining({ modelConfigId: selectedModel.id })
    )
  })

  const previewSelections: Array<{
    name: string
    project?: ProjectModelSelection
    current?: ProjectModelSelection
    defaultIndex?: number
    incompleteIndex?: number
    empty?: boolean
    expectedIndex?: number
    expectedPreset?: string
  }> = [
    { name: 'project before default', project: { modelConfigId: 'model-2', modelParameterPresetId: 'custom' }, defaultIndex: 1, expectedIndex: 2, expectedPreset: 'custom' },
    { name: 'explicit empty project preset', project: { modelConfigId: 'model-2', modelParameterPresetId: null }, defaultIndex: 1, expectedIndex: 2 },
    { name: 'inherited project preset', project: { modelConfigId: 'model-2' }, defaultIndex: 1, expectedIndex: 2, expectedPreset: 'preset-2' },
    { name: 'removed project preset', project: { modelConfigId: 'model-2', modelParameterPresetId: 'deleted' }, defaultIndex: 1, expectedIndex: 2, expectedPreset: 'preset-2' },
    { name: 'default before first', defaultIndex: 1, expectedIndex: 1, expectedPreset: 'preset-1' },
    { name: 'no default leaves selection empty' },
    { name: 'incomplete default leaves selection empty', defaultIndex: 1, incompleteIndex: 1 },
    { name: 'does not select the next provider model', incompleteIndex: 0 },
    { name: 'removed project model', project: { modelConfigId: 'deleted', modelParameterPresetId: 'custom' }, defaultIndex: 1, expectedIndex: 1, expectedPreset: 'preset-1' },
    { name: 'incomplete project model', project: { modelConfigId: 'model-2', modelParameterPresetId: 'custom' }, incompleteIndex: 2, defaultIndex: 1, expectedIndex: 1, expectedPreset: 'preset-1' },
    { name: 'no configured models', empty: true },
    { name: 'current model without a default', current: { modelConfigId: 'model-2', modelParameterPresetId: 'custom' }, expectedIndex: 2, expectedPreset: 'custom' },
    { name: 'current explicit empty reasoning', current: { modelConfigId: 'model-2', modelParameterPresetId: null }, expectedIndex: 2 },
    { name: 'default before current', defaultIndex: 1, current: { modelConfigId: 'model-2', modelParameterPresetId: 'custom' }, expectedIndex: 1, expectedPreset: 'preset-1' },
    { name: 'project before current', project: { modelConfigId: 'model-1' }, current: { modelConfigId: 'model-2' }, expectedIndex: 1, expectedPreset: 'preset-1' },
    { name: 'deleted current model', current: { modelConfigId: 'deleted' } },
    { name: 'incomplete current model', current: { modelConfigId: 'model-2' }, incompleteIndex: 2 }
  ]

  it.each(previewSelections)('shares preview selection without persisting it: $name', async (scenario) => {
    const connection = openPreview()
    const thread = connection.createThread({ title: 'Request preview', projectId: 'preview-chat' })
    const providers = scenario.empty ? [] : ['First', 'Default', 'Project'].map((name, index) => {
      const entry = provider(index, name)
      entry.models[0].parameterPresetMode = 'custom'
      entry.models[0].defaultParameterPresetId = `preset-${index}`
      entry.models[0].parameterPresets = [
        { id: `preset-${index}`, name: 'Model default', parameters: { temperature: 0.5 } },
        { id: 'custom', name: 'Project custom', parameters: { temperature: 0.1 } }
      ]
      if (scenario.incompleteIndex === index) entry.baseUrl = ''
      return entry
    })
    const defaultProvider = scenario.defaultIndex === undefined ? undefined : providers[scenario.defaultIndex]
    const defaultModel = defaultProvider && resolveProviderModelConfig(defaultProvider, defaultProvider.models[0])
    const settings = {
      profile: {
        assistant: { name: 'Anas', role: 'Assistant', instructions: '', newAvatarPath: '' },
        user: { preferredName: '', personalInfo: '' }
      },
      speechReply: { enabled: false, voice: '', speed: 1 },
      language: 'en',
      theme: 'dark',
      fontSize: 14,
      chatContentWidth: 'narrow',
      attachmentTextMaxChars: 200_000,
      attachmentTextOverflow: 'truncate',
      logLevel: 'info',
      logRetentionDays: 14,
      maxModelCallsPerRun: 100,
      environmentContext: environmentContextFixture(),
      sidebarVisible: true,
      sidebarWidth: 260,
      workspacePanelWidth: 480, ...diffViewSettingsFixture,
      sidebarCollapsedSections: { projects: false, simpleChats: false },
      backupDir: ''
    } satisfies AppSettings
    const config: AppConfigSnapshot = { customTools: [],
        providers,
      subagents: [],
      mcpServers: [],
      settings,
      defaultModelId: defaultModel?.id,
      defaultModel
    }
    const savedConfig = structuredClone(config)
    previewMocks.getAppConfigSnapshot.mockResolvedValue(config)
    previewMocks.captureAgentModelRequest.mockResolvedValue('{"request":{}}')
    previewMocks.captureAgentSystemPrompt.mockResolvedValue('SYSTEM PROMPT')
    const runtime = runtimeForPreview()
    const resource = connection.resources
    const input = {
      projectId: thread.projectId,
      project: { kind: 'simple_chat' as const, name: 'Draft', prompt: 'Unsaved prompt', ...scenario.project },
      currentModelSelection: scenario.current,
      settings
    }
    const draftBefore = structuredClone(input.project)
    if (scenario.expectedIndex === undefined) {
      await expect(runtime.previewSystemContext(input)).resolves.toEqual({ content: '', unavailableReason: 'model_not_selected' })
      await expect(runtime.previewModelRequest(input)).resolves.toEqual({ content: '', unavailableReason: 'model_not_selected' })
      expect(previewMocks.captureAgentSystemPrompt).not.toHaveBeenCalled()
      expect(previewMocks.captureAgentModelRequest).not.toHaveBeenCalled()
    } else {
      await expect(runtime.previewSystemContext(input)).resolves.toEqual({ content: 'SYSTEM PROMPT' })
      await expect(runtime.previewModelRequest(input)).resolves.toEqual({ content: '{"request":{}}' })
      const expectedThread = expect.objectContaining({
        projectId: thread.projectId,
        userTurnCount: 0,
        modelConfigId: `model-${scenario.expectedIndex}`,
        modelParameterPresetId: scenario.expectedPreset
      })
      expect(previewMocks.captureAgentSystemPrompt).toHaveBeenCalledWith(
        expectedThread, resource, config, expect.objectContaining(draftBefore)
      )
      expect(previewMocks.captureAgentModelRequest).toHaveBeenCalledWith(
        expectedThread, resource, config,
        expect.objectContaining({ read: expect.any(Function), wait: expect.any(Function) }),
        expect.objectContaining(draftBefore)
      )
    }
    expect(config).toEqual(savedConfig)
    expect(input.project).toEqual(draftBefore)
    expect(connection.getThread(thread.id)).toEqual(thread)
    expect(connection.getThread('system-context-preview')).toBeNull()
    expect(connection.getThread('model-request-preview')).toBeNull()
  })
  async function contextFixture(operation: 'agent' | 'compression' = 'agent') {
    openPreview()
    const configured = provider(0, 'Configured'), model = resolveProviderModelConfig(configured, configured.models[0])
    const resolver = vi.fn(async () => model)
    vi.spyOn(modelSelection, 'createAgentModelResolver').mockReturnValue(resolver)
    previewMocks.getAppConfigSnapshot.mockResolvedValue({ providers: [configured], defaultModel: model })
    const thread = database.createThread({ modelConfigId: model.id })
    const initial = { threadId: thread.id, runId: randomUUID() }
    database.runs.createRun({ ...initial, operation: 'agent', message: { id: `${initial.runId}:input`,
      value: { id: `${initial.runId}:input`, kind: 'user', content: 'Previous history', context: { runId: initial.runId } } } })
    await database.runs.enter('input', initial)
    database.runs.store.finish({ ...initial, expectedRevisionId: database.runs.store.load(thread.id)!.revisionId }, 'completed')
    const owner = { threadId: thread.id, runId: randomUUID() }
    database.runs.createRun({ ...owner, operation, ...(operation === 'agent' ? { message: { id: `${owner.runId}:input`,
      value: { id: `${owner.runId}:input`, kind: 'user' as const, content: 'Current task', context: { runId: owner.runId } } } } : {}) })
    const configuration = { customTools: [], codingMode: true, capabilities: structuredClone(defaultCapabilities) }
    database.runs.resolveRunConfiguration(owner, configuration)
    await database.runs.enter('input', owner)
    const scope = () => ({ ...owner, expectedRevisionId: database.runs.store.load(thread.id)!.revisionId })
    const status: AgentContextStatus = { modelConfigId: model.id, modelContextKey: modelContextKey(model), estimatedInputTokens: 40, currentContextTokens: 40,
      maxContextTokens: 1000, maxOutputTokens: 100, inputCapacityTokens: 900, compressionEnabled: true, compressionThreshold: 0.8,
      compressionThresholdTokens: 720, compressionApplied: false, manualCompressionAvailable: true,
      breakdown: { profileTokens: 0, systemInstructionTokens: 0, runtimeContextTokens: 0, workspaceTokens: 0, memoryTokens: 0,
        skillTokens: 0, toolDefinitionTokens: 0, messageTokens: 40, attachmentTokens: 0 } }
    previewMocks.projectConversationContextStatus.mockResolvedValue(status)
    return { owner, configuration, scope, status, model, resolver, runtime: runtimeForPreview() }
  }

  it.each([
    ['agent', 'running'], ['agent', 'interrupted'], ['agent', 'completed'], ['agent', 'failed'], ['agent', 'cancelled'],
    ['compression', 'running'], ['compression', 'interrupted'], ['compression', 'completed']
  ] as const)('uses saved native configuration only for a resumable %s run (%s)', async (operation, phase) => {
    const h = await contextFixture(operation)
    if (phase === 'interrupted') database.runs.store.waitForContext(h.scope(), { id: 'rules', generation: 'generation', kind: 'context_read',
      path: '/fixture/AGENTS.md', callIds: [], resumePhase: 'prepare_model', request: {
        actionRequests: [{ name: 'read_file', args: { path: '/fixture/AGENTS.md' }, description: 'Read rules' }],
        reviewConfigs: [{ actionName: 'read_file', allowedDecisions: ['approve', 'reject'] }] } }, {
      ...database.runs.store.load(h.owner.threadId)!.context,
      projectRules: { runId: h.owner.runId, roots: [], trustedFolders: [], documents: [], directories: [], initialScopes: [], activeScopes: [], blockedCalls: [], rejectedCalls: [], checkedWrites: [], blockedReason: '', fatalError: '' },
      rulePreparation: { runId: h.owner.runId, initialized: true, reads: [] }
    })
    else if (phase !== 'running') database.runs.store.finish(h.scope(), phase, phase === 'failed' ? 'Failure' : undefined)
    const saved = database.runs.store.load(h.owner.threadId), observation = database.readSnapshot(h.owner.threadId).contextStatus
    expect(await h.runtime.getContextStatus(h.owner.threadId)).toEqual(h.status)
    const continuation = phase === 'running' || phase === 'interrupted'
    expect(previewMocks.projectConversationContextStatus.mock.calls[0][4]).toMatchObject({
      requestId: continuation ? h.owner.runId : undefined, configuration: continuation ? h.configuration : undefined
    })
    expect(previewMocks.createConversationInstance).not.toHaveBeenCalled()
    expect(database.runs.store.load(h.owner.threadId)).toEqual(saved)
    expect(database.readSnapshot(h.owner.threadId).contextStatus).toEqual(observation)
  })

  it.each(['history', 'terminal', 'model', 'unstable'] as const)('rechecks native context after %s changes during projection', async change => {
    const h = await contextFixture()
    let count = 0
    previewMocks.projectConversationContextStatus.mockImplementation(async () => {
      count++
      if (count === 1 || change === 'unstable') {
        if (change === 'history') database.runs.store.acceptModel(h.scope(), { id: 'new-answer',
          value: { kind: 'assistant', content: 'Committed while reading', context: { runId: h.owner.runId } } }, [], { modelCalls: 1, todos: [] })
        else if (change === 'terminal') database.runs.store.finish(h.scope(), 'completed')
        else if (change === 'model') {
          database.updateThread(h.owner.threadId, { modelConfigId: 'changed-model' })
          h.resolver.mockResolvedValue({ ...h.model, id: 'changed-model', model: 'changed-model' })
        } else database.runs.store.prepareContext(h.scope(), { ...database.runs.store.load(h.owner.threadId)!.context, modelCalls: count })
      }
      const model = count > 1 && change === 'model' ? await h.resolver() : h.model
      return { ...h.status, modelContextKey: modelContextKey(model), estimatedInputTokens: count * 100 }
    })
    const actual = await h.runtime.getContextStatus(h.owner.threadId)
    expect(count).toBe(change === 'unstable' ? 3 : 2)
    if (change === 'unstable') expect(actual).toBeUndefined()
    else expect(actual?.estimatedInputTokens).toBe(200)
    const latest = previewMocks.projectConversationContextStatus.mock.calls.at(-1)!
    if (change === 'history') expect(latest[3].messages.at(-1).content).toBe('Committed while reading')
    if (change === 'terminal') expect(latest[4]).toMatchObject({ requestId: undefined, configuration: undefined })
    expect(previewMocks.createConversationInstance).not.toHaveBeenCalled()
    expect(database.readSnapshot(h.owner.threadId).contextStatus).toBeUndefined()
  })

  it('reads saved context status from native history without preparing an agent or model', async () => {
    const h = await contextFixture()
    database.messages.observations.recordContextStatus(h.owner.threadId, h.status)
    previewMocks.getAppConfigSnapshot.mockClear(); h.resolver.mockClear()
    expect((await h.runtime.getSnapshot(h.owner.threadId)).contextStatus).toEqual(h.status)
    expect(previewMocks.getAppConfigSnapshot).not.toHaveBeenCalled()
    expect(previewMocks.projectConversationContextStatus).not.toHaveBeenCalled()
    expect(previewMocks.createConversationInstance).not.toHaveBeenCalled()
    expect(h.resolver).not.toHaveBeenCalled()
  })

  it('rebuilds paused context during disposal and accepts one approval resume only after ownership is released', async () => {
    const h = await contextFixture()
    const cleanup = vi.spyOn(database.resources.fileEditStore, 'deleteFileEditRecordsForRequest')
    let finishDisposal!: () => void, markDisposing!: () => void, finishAssembly!: () => void
    const disposal = new Promise<void>(resolve => { finishDisposal = resolve }), disposing = new Promise<void>(resolve => { markDisposing = resolve })
    const assembly = new Promise<void>(resolve => { finishAssembly = resolve })
    let disposals = 0, requests = 0
    const services: ConversationExecutionServices = { store: database.runs.store, enter: database.execution.enter,
      prepareModel: async state => {
        if (!state.context.rulePreparation?.reads.length) return { kind: 'wait', approval: { id: 'rules', generation: 'generation', kind: 'context_read',
          path: '/fixture/AGENTS.md', callIds: [], resumePhase: 'prepare_model', request: {
            actionRequests: [{ name: 'read_file', args: { path: '/fixture/AGENTS.md' }, description: 'Read rules' }],
            reviewConfigs: [{ actionName: 'read_file', allowedDecisions: ['approve', 'reject'] }] } }, context: {
          ...state.context, projectRules: { runId: h.owner.runId, roots: [], trustedFolders: [], documents: [], directories: [], initialScopes: [], activeScopes: [], blockedCalls: [], rejectedCalls: [], checkedWrites: [], blockedReason: '', fatalError: '' },
          rulePreparation: { runId: h.owner.runId, initialized: true, reads: [] }
        } }
        return { kind: 'model', invoke: async () => {
          requests++
          return { message: { id: 'resumed-answer', value: { kind: 'assistant', content: 'Approved once', context: { runId: h.owner.runId } } }, calls: [], context: { ...state.context, modelCalls: 1 } }
        } }
      }, afterModel: async () => ({ kind: 'complete' }), prepareTools: async () => ({ calls: [] }),
      executeTool: async () => { throw new Error('No tool expected') }, directions: async () => [], drain: async () => {}, retry: { maxRetries: 0 } }
    const instance = { execution: conversationExecution(services),
      context: { projectedStatus: async () => ({ ...h.status, estimatedInputTokens: 10 }) },
      dispose: async () => { if (++disposals === 1) { markDisposing(); await disposal } } }
    try {
      const paused = h.runtime.start(h.owner, 'continue', async () => instance)
      await disposing
      expect(h.runtime.isActive(h.owner)).toBe(true)
      expect(database.messages.activities.getRun(h.owner.runId)?.status).toBe('interrupted')
      expect((await h.runtime.getContextStatus(h.owner.threadId))?.estimatedInputTokens).toBe(40)
      expect(previewMocks.projectConversationContextStatus.mock.calls.at(-1)![4]).toMatchObject({ requestId: h.owner.runId, configuration: h.configuration })
      const interrupt = h.runtime.readSnapshot(h.owner.threadId).interrupts[0]
      const input = { ...h.owner, responses: [{ interruptId: interrupt.id, expectedGeneration: interrupt.approvalGeneration, decisions: [{ type: 'approve' as const }] }] }
      const create = vi.fn(async () => { await assembly; return instance })
      const head = database.runs.store.load(h.owner.threadId)
      expect(() => h.runtime.resumeRun(input, create)).toThrow('before its executor has settled')
      expect(create).not.toHaveBeenCalled()
      expect(database.runs.store.load(h.owner.threadId)).toEqual(head)
      expect(h.runtime.readSnapshot(h.owner.threadId).interrupts).toHaveLength(1)
      finishDisposal(); expect((await paused.completed).status).toBe('interrupted'); await paused.drained
      expect(cleanup.mock.calls.filter(([id]) => id === h.owner.runId)).toEqual([])
      await expect(h.runtime.submitRunWithAttachments({ threadId: h.owner.threadId, runId: randomUUID(), submissionId: randomUUID(), text: 'Do not overlap' }, create)).rejects.toThrow()
      await expect(h.runtime.startCompression(h.owner.threadId, create)).rejects.toThrow()
      const selected = { threadId: h.owner.threadId, messageId: `${h.owner.runId}:input` }
      await expect(h.runtime.truncateMessages(selected)).rejects.toThrow()
      await expect(h.runtime.regenerateMessage({ ...selected, runId: randomUUID() }, create)).rejects.toThrow()
      expect(() => h.runtime.resumeRun({ ...input, runId: 'missing' }, create)).toThrow('does not belong')
      expect(() => h.runtime.resumeRun({ ...input, threadId: 'other' }, create)).toThrow('does not belong')
      expect(create).not.toHaveBeenCalled()
      expect(database.runs.store.load(h.owner.threadId)).toEqual(head)
      const resumed = h.runtime.resumeRun(input, create)
      expect(h.runtime.readSnapshot(h.owner.threadId).interrupts).toEqual([])
      expect(() => h.runtime.resumeRun(input, create)).toThrow('before its executor has settled')
      expect(create).toHaveBeenCalledTimes(1)
      expect(requests).toBe(0)
      finishAssembly(); expect((await resumed.completed).status).toBe('completed'); await resumed.drained
      expect(requests).toBe(1)
      expect(database.runs.store.readHistory(h.owner.threadId)?.messages.filter(message => message.id === 'resumed-answer')).toHaveLength(1)
      expect(database.runs.store.load(h.owner.threadId)?.context.rulePreparation?.reads).toEqual([{ path: '/fixture/AGENTS.md', approved: true }])
      expect(database.runs.getRunConfiguration(h.owner)).toEqual(h.configuration)
      expect(cleanup.mock.calls.filter(([id]) => id === h.owner.runId)).toHaveLength(1)
    } finally { finishDisposal(); finishAssembly(); await h.runtime.waitForIdle() }
  })

})
