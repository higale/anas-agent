import { afterEach, describe, expect, it } from 'vitest'
import { defaultCapabilities } from '@shared/agentCapabilities'
import { defaultModelConfig, resolveProviderModelConfig } from '@shared/modelConfig'
import type { ModelProviderConfigDetail, SubagentConfig } from '@shared/types'
import { AgentStorage } from './agentStorage'
import type { NativeConversationDatabase } from './nativeConversationDatabase'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ModelSelectionError } from '../../runtime/errors'
import { createAgentModelResolver, resolveModelSelection, resolveSubagentModelSelection, resolveThreadModelSelection } from './modelSelection'

function configuration() {
  const provider: ModelProviderConfigDetail = {
    id: 'provider', name: 'Provider', index: 0, protocol: 'openai_chat_completions',
    baseUrl: 'http://localhost:1234/v1', modelListUrl: '', parameters: {},
    models: ['model-a', 'model-b', 'model-c'].map((id, index) => ({
      ...structuredClone(defaultModelConfig), id, index, displayName: id, model: id,
      parameterPresetMode: 'custom', parameters: { temperature: 0.5 },
      parameterPresets: [{ id: 'precise', name: 'Precise', parameters: { temperature: 0.1 } }]
    }))
  }
  return { providers: [provider], defaultModel: resolveProviderModelConfig(provider, provider.models[0]) }
}

let database: NativeConversationDatabase
let storage: AgentStorage | undefined
let dataRoot: string | undefined
afterEach(() => { storage?.close(); storage = undefined; if (dataRoot) rmSync(dataRoot, { recursive: true, force: true }); dataRoot = undefined })
function openDatabase() {
  dataRoot = mkdtempSync(join(tmpdir(), 'anas-native-model-selection-'))
  storage = AgentStorage.openNative(dataRoot)
  return storage.previewDatabase()
}
function parentRun(threadId: string) {
  const runId = randomUUID(), id = runId + ':input'
  return database.runs.createRun({ threadId, runId, operation: 'agent', message: { id, value: { id, kind: 'user', content: 'Delegate', context: { runId } } } })
}

function addChild(owner: string, parent: string, parentRun: string, id: string, parentSubagentId?: string) {
  const config: SubagentConfig = {
    name: id, index: 0, enabled: true, builtIn: false, description: 'Perform a delegated task.',
    systemPrompt: 'Complete the task.', capabilities: structuredClone(defaultCapabilities)
  }
  return database.runs.createSubagentCall({
    id, ownerThreadId: owner, parentThreadId: parent, parentRunId: parentRun, parentSubagentId,
    childThreadId: `${id}-thread`, childRunId: `${id}-run`, config, description: 'Delegated task',
    childThread: { projectId: database!.getThread(owner)!.projectId }
  })
}

describe('request-time model selection', () => {
  it('binds subagent model defaults once while retaining explicit no-preset and inheritance choices', async () => {
    database = openDatabase()
    const root = database.createThread({ modelConfigId: 'model-a' })
    const run = parentRun(root.id)
    const definition: SubagentConfig = { index: 0, name: 'reviewer', enabled: true, builtIn: false,
      description: 'Review.', systemPrompt: 'Review work.', capabilities: structuredClone(defaultCapabilities), modelConfigId: 'model-b' }
    const config = configuration()
    config.providers[0].models[1].defaultParameterPresetId = 'precise'
    expect(resolveSubagentModelSelection({ ...definition, modelConfigId: undefined }, config)).toEqual({})
    expect(resolveSubagentModelSelection({ ...definition, modelParameterPresetId: null }, config)).toEqual({ modelConfigId: 'model-b', modelParameterPresetId: undefined })
    const child = database.runs.createSubagentCall({ id: 'child', ownerThreadId: root.id, parentThreadId: root.id, parentRunId: run.id,
      childThreadId: 'child-thread', childRunId: 'child-run', config: definition, description: 'Review work.',
      childThread: resolveSubagentModelSelection(definition, config) })
    expect(database.runs.subagents.find(child.id, root.id)?.config.modelConfigId).toBe('model-b')
    const grandchild = addChild(root.id, child.childThreadId, child.childRunId, 'nested', child.id)
    definition.modelConfigId = 'model-c'
    config.providers[0].models[1].defaultParameterPresetId = undefined
    database.updateThread(root.id, { modelConfigId: 'model-c' })
    const resolve = createAgentModelResolver(grandchild.childThreadId, database.resources, { loadConfig: async () => config })
    expect(await resolve()).toMatchObject({ id: 'model-b', parameters: { temperature: 0.1 } })
    config.providers[0].models[1].parameterPresets = []
    await expect(resolve()).rejects.toThrow('preset no longer exists')
    config.providers[0].models.splice(1, 1)
    expect(() => resolveSubagentModelSelection({ ...definition, modelConfigId: 'model-b' }, config)).toThrow('no longer exists')
  })
  it('reads parent selection and model parameters again for every child request, including nested children', async () => {
    database = openDatabase()
    const root = database.createThread({ modelConfigId: 'model-a', modelParameterPresetId: 'precise' })
    const run = parentRun(root.id)
    const child = addChild(root.id, root.id, run.id, 'child')
    const grandchild = addChild(root.id, child.childThreadId, child.childRunId, 'grandchild', child.id)
    const config = configuration()
    const resolve = createAgentModelResolver(grandchild.childThreadId, database.resources, { loadConfig: async () => config })

    const first = await resolve()
    expect(first).toMatchObject({ id: 'model-a', parameters: { temperature: 0.1 } })
    database.updateThread(root.id, { modelConfigId: 'model-b', modelParameterPresetId: null })
    expect(await resolve()).toMatchObject({ id: 'model-b', parameters: { temperature: 0.5 } })
    config.providers[0].models[1].parameters.temperature = 0.7
    config.providers[0].models[1].maxContextTokens = 80_000
    expect(await resolve()).toMatchObject({ id: 'model-b', parameters: { temperature: 0.7 }, maxContextTokens: 80_000 })
    expect(first).toMatchObject({ id: 'model-a', parameters: { temperature: 0.1 } })
    expect(database.getThread(child.childThreadId)?.modelConfigId).toBeUndefined()
    expect(database.getThread(grandchild.childThreadId)?.modelConfigId).toBeUndefined()
  })

  it('lets a child select its own model and makes descendants inherit that nearest selection', async () => {
    database = openDatabase()
    const root = database.createThread({ modelConfigId: 'model-a' })
    const run = parentRun(root.id)
    const child = addChild(root.id, root.id, run.id, 'child')
    const grandchild = addChild(root.id, child.childThreadId, child.childRunId, 'grandchild', child.id)
    const config = configuration()
    database.updateThread(child.childThreadId, { modelConfigId: 'model-c' })
    const resolve = createAgentModelResolver(grandchild.childThreadId, database.resources, { loadConfig: async () => config })
    database.updateThread(root.id, { modelConfigId: 'model-b' })
    expect(await resolve()).toMatchObject({ id: 'model-c' })
    config.providers[0].models[2].parameters.temperature = 0.8
    expect(await resolve()).toMatchObject({ id: 'model-c', parameters: { temperature: 0.8 } })
    config.providers[0].models.splice(2, 1)
    await expect(resolve()).rejects.toThrow(/no longer exists: model-c/)
    database.updateThread(child.childThreadId, { modelConfigId: null })
    expect(await resolve()).toMatchObject({ id: 'model-b' })
    expect(database.getThread(child.childThreadId)?.modelParameterPresetId).toBeUndefined()
    expect(() => database!.updateThread(root.id, { modelConfigId: null })).toThrow(/must select its own model/)
  })

  it('never replaces an absent root selection or deleted model with the current default', async () => {
    database = openDatabase()
    const root = database.createThread()
    const config = configuration()
    const resolve = createAgentModelResolver(root.id, database.resources, { loadConfig: async () => config })
    await expect(resolve()).rejects.toThrow(/No model is selected/)
    database.updateThread(root.id, { modelConfigId: 'deleted' })
    await expect(resolve()).rejects.toThrow(/no longer exists: deleted/)
    expect(resolveModelSelection({}, config, { allowDefault: true }).id).toBe('model-a')
    expect(() => resolveModelSelection({ modelConfigId: 'deleted' }, config, { allowDefault: true })).toThrow(ModelSelectionError)
  })

  it('rejects missing presets, deleted providers and incomplete connection settings', async () => {
    database = openDatabase()
    const root = database.createThread({ modelConfigId: 'model-a', modelParameterPresetId: 'precise' })
    const config = configuration()
    const resolve = createAgentModelResolver(root.id, database.resources, { loadConfig: async () => config })
    config.providers[0].models[0].parameterPresets = []
    await expect(resolve()).rejects.toThrow(/parameter preset no longer exists: precise/)
    database.updateThread(root.id, { modelParameterPresetId: null })
    config.providers[0].baseUrl = ''
    await expect(resolve()).rejects.toThrow(/invalid provider URL/)
    config.providers[0].baseUrl = 'file:///tmp/model'
    await expect(resolve()).rejects.toThrow(/HTTP or HTTPS/)
    config.providers[0].baseUrl = 'http://localhost:1234/v1'
    config.providers[0].models[0].model = ' '
    await expect(resolve()).rejects.toThrow(/no provider model name/)
    config.providers = []
    await expect(resolve()).rejects.toThrow(/no longer exists: model-a/)
  })

  it('uses the selection saved while configuration loading is pending', async () => {
    database = openDatabase()
    const root = database.createThread({ modelConfigId: 'model-a' })
    const config = configuration()
    let finish!: () => void
    const barrier = new Promise<void>((resolve) => { finish = resolve })
    const resolve = createAgentModelResolver(root.id, database.resources, { loadConfig: async () => { await barrier; return config } })
    const pending = resolve()
    database.updateThread(root.id, { modelConfigId: 'model-b' })
    finish()
    expect(await pending).toMatchObject({ id: 'model-b' })
  })

  it('classifies configuration read and ancestry failures as terminal model selection errors', async () => {
    database = openDatabase()
    const root = database.createThread({ modelConfigId: 'model-a' })
    const resolve = createAgentModelResolver(root.id, database.resources, { loadConfig: async () => { throw new Error('max_output_tokens must be smaller than max_context_tokens') } })
    await expect(resolve()).rejects.toMatchObject({ code: 'MODEL_SELECTION_INVALID', message: expect.stringContaining('max_output_tokens') })
    expect(() => resolveThreadModelSelection('missing', database.resources)).toThrow(/no longer exists/)
    expect(() => resolveThreadModelSelection('cycle', {
      getThread: () => ({ ...root, modelConfigId: undefined }),
      getSubagentCallByChildThreadId: () => ({ parentThreadId: 'cycle' }) as ReturnType<NativeConversationDatabase['resources']['getSubagentCallByChildThreadId']>
    })).toThrow(/inheritance contains a cycle/)
  })
})
