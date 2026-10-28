import { describe, expect, it } from 'vitest'
import { anthropicRequestParameters, anthropicToolDefinition, defaultAnthropicOutputTokens, type AnthropicRequestSettings } from './anthropicParameters'

const settings: AnthropicRequestSettings = { model: 'fixture', streaming: false, maxOutputTokens: 1000, parameters: {} }

describe('native Anthropic request parameters', () => {
  it.each([{ betas: false }, { betas: ['valid', 1] }, { output_config: false }, { thinking: null }])('reports malformed native controls instead of dropping them: %j', parameters => {
    expect(() => anthropicRequestParameters({ ...settings, parameters })).toThrow('must be')
  })
  it('preserves configured zero, false, empty collections and provider extensions without mutating settings', () => {
    const selected = { ...settings, parameters: { temperature: 0, top_k: 0, top_p: 0, stop_sequences: [],
      metadata: { user_id: '' }, cache_control: null, native_extension: { enabled: false }, thinking: { type: 'disabled' } } }
    const before = structuredClone(selected)
    expect(anthropicRequestParameters(selected)).toEqual({ ...selected.parameters, model: 'fixture', stream: false, max_tokens: 1000 })
    expect(selected).toEqual(before)
  })

  it.each([['fixture', 4096], ['claude-3-5-sonnet-20241022', 8192], ['claude-opus-4-1-20250805', 16384], ['claude-fable-5-1', 16384]])('keeps the imported default for %s', (model, tokens) => {
      expect(defaultAnthropicOutputTokens(model)).toBe(tokens)
      expect(anthropicRequestParameters({ ...settings, model, maxOutputTokens: undefined }).max_tokens).toBe(tokens)
    })

  it('combines explicit and required beta headers and merges call-time structured output with configured effort', () => {
    const result = anthropicRequestParameters({ ...settings, model: 'claude-opus-4-7', parameters: {
      betas: ['custom-beta'], output_config: { effort: 'medium', task_budget: { tokens: 1000 } },
      context_management: { edits: [{ type: 'compact_20260112' }] }
    } }, { betas: ['custom-beta', 'call-beta'], outputConfig: { format: { type: 'json_schema', schema: { type: 'object' } } },
      tools: [{ type: 'computer_20251124', name: 'computer', display_width_px: 100, display_height_px: 100 }] })
    expect(result).toMatchObject({ output_config: { effort: 'medium', task_budget: { tokens: 1000 },
      format: { type: 'json_schema', schema: { type: 'object' } } },
      betas: ['custom-beta', 'call-beta', 'computer-use-2025-11-24', 'compact-2026-01-12', 'task-budgets-2026-03-13'] })
  })

  it.each([
    { model: 'claude-opus-4-7', parameters: { thinking: { type: 'enabled', budget_tokens: 100 } }, reason: 'thinking.type="enabled"' },
    { model: 'claude-opus-4-7', parameters: { thinking: { type: 'adaptive', budget_tokens: 100 } }, reason: 'budget_tokens' },
    { model: 'claude-fable-5-1', parameters: { thinking: { type: 'disabled' } }, reason: 'thinking.type="disabled"' },
    { model: 'claude-opus-4-7', parameters: { top_k: 0 }, reason: 'topK' },
    { model: 'claude-opus-4-7', parameters: { temperature: 0 }, reason: 'temperature' },
    { model: 'claude-opus-4-6', parameters: { thinking: { type: 'enabled', budget_tokens: 100 }, top_p: 1 }, reason: 'topP' }
  ])('reports incompatible $reason for $model before sending a request', ({ model, parameters, reason }) => {
    expect(() => anthropicRequestParameters({ ...settings, model, parameters })).toThrow(reason)
  })

  it('keeps implicit thinking absent and omits sampling defaults for adaptive-only models', () => {
    expect(anthropicRequestParameters({ ...settings, model: 'claude-opus-4-7', parameters: { temperature: 1, top_p: 1 } }))
      .toEqual({ model: 'claude-opus-4-7', max_tokens: 1000, stream: false })
    expect(anthropicRequestParameters({ ...settings, parameters: { thinking: { type: 'enabled', budget_tokens: 100 }, temperature: 1 } }))
      .toEqual({ model: 'fixture', max_tokens: 1000, stream: false, thinking: { type: 'enabled', budget_tokens: 100 } })
  })

  it('validates forced tool selection and conflicting stops without silently dropping controls', () => {
    const tools = [{ name: 'read', input_schema: { type: 'object' } }]
    expect(anthropicRequestParameters(settings, { tools, toolChoice: 'read' }).tool_choice).toEqual({ type: 'tool', name: 'read' })
    expect(anthropicRequestParameters(settings, { tools, toolChoice: 'required' }).tool_choice).toEqual({ type: 'any' })
    expect(anthropicRequestParameters(settings, { tools: [], toolChoice: 'none', stop: [] })).toMatchObject({ tools: [], tool_choice: { type: 'none' }, stop_sequences: [] })
    expect(() => anthropicRequestParameters(settings, { tools, toolChoice: 'missing' })).toThrow('not available')
    expect(() => anthropicRequestParameters(settings, { tools: [], toolChoice: 'required' })).toThrow('at least one')
    expect(() => anthropicRequestParameters({ ...settings, parameters: { stop_sequences: [] } }, { stop: [] })).toThrow('both')
  })

  it('retains complete tool schemas and explicit false strictness', () => {
    const schema = { $defs: { one: { type: 'object', properties: { value: { type: 'number' } } } }, oneOf: [{ $ref: '#/$defs/one' }] }
    const native = { name: 'read', description: '', input_schema: schema, cache_control: { type: 'ephemeral' }, defer_loading: false, strict: true }
    expect(anthropicToolDefinition(native, false)).toEqual({ ...native, strict: false })
    expect(anthropicToolDefinition({ type: 'function', function: { name: 'read', description: '', parameters: schema, strict: false } }))
      .toEqual({ name: 'read', description: '', input_schema: schema, strict: false })
  })
})
