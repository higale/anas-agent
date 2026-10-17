import { describe, expect, it } from 'vitest'
import {
  newThreadDraftModelSelection,
  projectDraftModelSelection,
  reconcileDraftModelSelection
} from './draftModelSelection'
import { defaultModelConfig, findProviderModelConfig } from './modelConfig'
import type { ModelProviderConfig } from './types'

const model = {
  baseUrl: 'https://provider.example/v1',
  defaultParameterPresetId: 'thinking-on',
  model: 'model-name',
  parameterPresets: [
    { id: 'thinking-on', name: 'Thinking on', parameters: { enable_thinking: true } },
    { id: 'thinking-off', name: 'Thinking off', parameters: { enable_thinking: false } }
  ]
}

describe('draft model selection', () => {
  const providers: ModelProviderConfig[] = [{
    id: 'provider', name: 'Provider', protocol: 'openai_chat_completions',
    baseUrl: 'https://example.com/v1', modelListUrl: '', parameters: {},
    models: [{
      ...defaultModelConfig, ...model, id: 'project-model', index: 0,
      displayName: 'Project Model', parameterPresetMode: 'custom'
    }]
  }]

  it('prioritizes the project model and reasoning over default and current selections', () => {
    const projectSelection = projectDraftModelSelection(providers, {
      modelConfigId: 'project-model', modelParameterPresetId: 'thinking-off'
    })
    expect(newThreadDraftModelSelection({ defaultModel: { ...model, id: 'global' } },
      { ...model, id: 'current' }, null, projectSelection)).toEqual({
      modelConfigId: 'project-model', modelParameterPresetId: 'thinking-off', parameterPresetSource: 'explicit'
    })
  })

  it('distinguishes an explicit empty project reasoning selection from the model default', () => {
    expect(projectDraftModelSelection(providers, {
      modelConfigId: 'project-model', modelParameterPresetId: null
    })).toEqual({ modelConfigId: 'project-model', modelParameterPresetId: null, parameterPresetSource: 'explicit' })
    expect(projectDraftModelSelection(providers, { modelConfigId: 'project-model' }))
      .toMatchObject({ modelParameterPresetId: 'thinking-on', parameterPresetSource: 'model-default' })
  })

  it('falls back to the model default for a deleted project reasoning option', () => {
    expect(projectDraftModelSelection(providers, {
      modelConfigId: 'project-model', modelParameterPresetId: 'removed'
    })).toMatchObject({ modelConfigId: 'project-model', modelParameterPresetId: 'thinking-on' })
  })

  it('resolves protocol-default reasoning options before validating the project selection', () => {
    const protocolProviders: ModelProviderConfig[] = [{
      ...providers[0], protocol: 'openai_responses',
      models: [{ ...providers[0].models[0], parameterPresetMode: 'protocol_default' }]
    }]
    const preset = findProviderModelConfig(protocolProviders, 'project-model')!.parameterPresets![0]
    expect(projectDraftModelSelection(protocolProviders, {
      modelConfigId: 'project-model', modelParameterPresetId: preset.id
    })).toMatchObject({ modelParameterPresetId: preset.id })
  })

  it.each([
    undefined, {}, { modelConfigId: 'deleted' }
  ])('skips an absent or deleted project preference: %j', (project) => {
    expect(newThreadDraftModelSelection({ defaultModel: { ...model, id: 'global' } },
      { ...model, id: 'current' }, null, projectDraftModelSelection(providers, project)))
      .toMatchObject({ modelConfigId: 'global', modelParameterPresetId: 'thinking-on' })
  })

  it.each(['baseUrl', 'model'] as const)('skips an incomplete project %s', (field) => {
    const candidates = [{ ...providers[0],
      ...(field === 'baseUrl' ? { baseUrl: '' } : { models: [{ ...providers[0].models[0], model: '' }] })
    }]
    expect(projectDraftModelSelection(candidates, { modelConfigId: 'project-model' })).toBeUndefined()
  })

  it.each(['current', 'global'])('chooses the global default and its default reasoning before current %s', (currentId) => {
    expect(newThreadDraftModelSelection({ defaultModel: { ...model, id: 'global' } },
      { ...model, id: currentId }, 'thinking-off')).toEqual({
      modelConfigId: 'global', modelParameterPresetId: 'thinking-on', parameterPresetSource: 'model-default'
    })
  })

  it.each([undefined, { ...model, id: 'global', baseUrl: '' }, { ...model, id: 'global', model: '' }])(
    'falls back to the current selection when the default is unavailable: %j', (defaultModel) => {
      expect(newThreadDraftModelSelection({ defaultModel }, { ...model, id: 'current' }, 'thinking-off')).toEqual({
        modelConfigId: 'current', modelParameterPresetId: 'thinking-off', parameterPresetSource: 'explicit'
      })
    }
  )

  it('preserves an explicit empty reasoning selection with the current model', () => {
    expect(newThreadDraftModelSelection({}, { ...model, id: 'current' }, null)).toEqual({
      modelConfigId: 'current', modelParameterPresetId: null, parameterPresetSource: 'explicit'
    })
  })

  it.each([undefined, { ...model, id: 'current', baseUrl: '' }, { ...model, id: 'current', model: '' }])(
    'leaves the model unselected instead of choosing the first configured model: %j', (current) => {
      const config = { defaultModel: undefined, providers }
      expect(newThreadDraftModelSelection(config, current)).toEqual({
        modelConfigId: undefined, modelParameterPresetId: null, parameterPresetSource: 'model-default'
      })
    }
  )

  it('follows a changed default until the draft is manually changed', () => {
    expect(reconcileDraftModelSelection(model, {
      modelConfigId: 'model-1',
      modelParameterPresetId: 'thinking-off',
      parameterPresetSource: 'model-default'
    })).toEqual({
      modelConfigId: 'model-1',
      modelParameterPresetId: 'thinking-on',
      parameterPresetSource: 'model-default'
    })
    expect(reconcileDraftModelSelection(model, {
      modelConfigId: 'model-1',
      modelParameterPresetId: 'thinking-off',
      parameterPresetSource: 'explicit'
    })).toEqual({
      modelConfigId: 'model-1',
      modelParameterPresetId: 'thinking-off',
      parameterPresetSource: 'explicit'
    })
  })

  it('preserves an explicit empty selection but repairs a deleted preset', () => {
    expect(reconcileDraftModelSelection(model, {
      modelConfigId: 'model-1',
      modelParameterPresetId: null,
      parameterPresetSource: 'explicit'
    })).toEqual({
      modelConfigId: 'model-1',
      modelParameterPresetId: null,
      parameterPresetSource: 'explicit'
    })
    expect(reconcileDraftModelSelection(model, {
      modelConfigId: 'model-1',
      modelParameterPresetId: 'deleted',
      parameterPresetSource: 'explicit'
    })).toEqual({
      modelConfigId: 'model-1',
      modelParameterPresetId: 'thinking-on',
      parameterPresetSource: 'model-default'
    })
  })
})
