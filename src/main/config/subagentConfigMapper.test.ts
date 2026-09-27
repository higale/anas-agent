import { defaultCapabilities, serializeCapabilities } from '@shared/agentCapabilities'
import { describe, expect, it } from 'vitest'
import { normalizeSubagent, rawSubagentFromSave } from './subagentConfigMapper'

describe('subagent configuration mapping', () => {
  it.each([undefined, null, 'precise'])('round trips independent model selection and preset %s', (modelParameterPresetId) => {
    const config = { name: 'delegate', enabled: true, description: 'Delegate.', systemPrompt: 'Complete work.',
      capabilities: structuredClone(defaultCapabilities), modelConfigId: 'model-b', modelParameterPresetId }
    const raw = rawSubagentFromSave(config)
    expect(raw.model_config_id).toBe('model-b')
    expect(raw.model_parameter_preset_id).toBe(modelParameterPresetId)
    expect(normalizeSubagent(raw, 0)).toMatchObject({ modelConfigId: 'model-b' })
    expect(normalizeSubagent(raw, 0).modelParameterPresetId).toBe(modelParameterPresetId)
    const cleared = rawSubagentFromSave({ ...config, modelConfigId: undefined, modelParameterPresetId: undefined }, raw)
    expect(cleared).not.toHaveProperty('model_config_id')
    expect(cleared).not.toHaveProperty('model_parameter_preset_id')
  })

  it('rejects malformed model references and presets without a model', () => {
    const config = { name: 'delegate', enabled: true, description: 'Delegate.', systemPrompt: 'Complete work.', capabilities: structuredClone(defaultCapabilities) }
    expect(() => rawSubagentFromSave({ ...config, modelConfigId: '' })).toThrow('model configuration ID')
    expect(() => rawSubagentFromSave({ ...config, modelParameterPresetId: 'precise' })).toThrow('requires a model')
    expect(() => rawSubagentFromSave({ ...config, modelConfigId: 'model-b', modelParameterPresetId: '' })).toThrow('parameter preset ID')
    expect(normalizeSubagent(rawSubagentFromSave(config), 0)).not.toHaveProperty('modelConfigId')
  })
  it('round trips delegation choices independently of the global default switch', () => {
    const config = { name: 'delegate', enabled: false, description: 'Delegate work.', systemPrompt: 'Complete work.',
      capabilities: { ...structuredClone(defaultCapabilities), subagents: { mode: 'custom' as const, names: ['reviewer', 'missing'] } } }
    const raw = rawSubagentFromSave(config)
    expect(raw.capabilities).toMatchObject({ subagents: config.capabilities.subagents })
    expect(raw).not.toHaveProperty('subagentSelection')
    expect(normalizeSubagent(raw, 0)).toMatchObject(config)
    expect(() => rawSubagentFromSave({ ...config, capabilities: { ...config.capabilities, subagents: { mode: 'custom', names: ['bad name'] } } })).toThrow()
  })

  it('derives built-in status from a known preset and normalizes scoped capabilities', () => {
    expect(normalizeSubagent({
 capabilities: serializeCapabilities({ ...structuredClone(defaultCapabilities), profile: false, workspace: false,
        memory: false, toolMode: 'selected', tools: ['http_request', 'http_request'], skills: { mode: 'custom' as const, project: false, entries: (['baidu-search'] as string[]).map(id => ({ id, shortcut: false, model: true })) } }),
      preset: 'web-researcher',
      name: 'web-researcher',
      enabled: true,
      description: 'Research current information.',
      system_prompt: 'Verify sources.',
    }, 2)).toEqual({
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: false,
        memory: false, toolMode: 'selected', tools: ['http_request'], skills: { mode: 'custom' as const, project: false, entries: (['baidu-search'] as string[]).map(id => ({ id, shortcut: false, model: true })) } },
      index: 2,
      preset: 'web-researcher',
      builtIn: true,
      name: 'web-researcher',
      enabled: true,
      description: 'Research current information.',
      systemPrompt: 'Verify sources.',
    })
  })

  it('preserves a built-in preset when editing while rejecting invalid names', () => {
    const existing = {
      preset: 'general-purpose',
      name: 'general-purpose'
    }
    expect(rawSubagentFromSave({
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true,
        memory: true, toolMode: 'all', tools: [], skills: { mode: 'default' as const, project: false, entries: [] } },
      index: 0,
      name: 'general-purpose',
      enabled: true,
      description: 'General work.',
      systemPrompt: 'Complete the task.',
    }, existing)).toMatchObject({
      preset: 'general-purpose',
      name: 'general-purpose'
    })

    expect(() => rawSubagentFromSave({
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: false,
        memory: false, toolMode: 'selected', tools: [], skills: { mode: 'custom' as const, project: false, entries: [] } },
      name: 'Invalid Agent',
      enabled: false,
      description: '',
      systemPrompt: '',
    })).toThrow(/Subagent names/)

    expect(() => rawSubagentFromSave({
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true,
        memory: true, toolMode: 'all', tools: [], skills: { mode: 'default' as const, project: false, entries: [] } },
      index: 0,
      name: 'renamed-agent',
      enabled: true,
      description: 'General work.',
      systemPrompt: 'Complete the task.',
    }, existing)).toThrow(/cannot be changed/)
  })

  it('requires routing text and a prompt only when the subagent is enabled', () => {
    const disabled = {
 capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: false,
        memory: false, toolMode: 'selected' as const, tools: [], skills: { mode: 'custom' as const, project: false, entries: [] } },
      name: 'draft-agent',
      enabled: false,
      description: '',
      systemPrompt: '',
    }
    expect(rawSubagentFromSave(disabled)).toMatchObject({
      name: 'draft-agent',
      enabled: false
    })
    expect(() => rawSubagentFromSave({
      ...disabled,
      enabled: true
    })).toThrow(/description/)
  })
})
