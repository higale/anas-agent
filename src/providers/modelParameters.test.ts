import { describe, expect, it } from 'vitest'
import { anthropicModelParameters, openAiModelParameters } from './modelParameters'

describe('native model parameters', () => {
  it.each([openAiModelParameters, anthropicModelParameters])('preserves explicit empty values and provider extensions without modifying settings (%#)', normalize => {
    const original = Object.freeze({ temperature: 0, topP: 0, native: { enabled: false, text: '', values: [] }, tools: [] })
    expect(normalize(original)).toEqual({ temperature: 0, top_p: 0, native: original.native, tools: [] })
    expect(original).toHaveProperty('topP', 0)
    expect(original).not.toHaveProperty('top_p')
    expect(normalize({})).toEqual({})
  })

  it.each([null, '', []])('preserves OpenAI stop value %j and nullable sampling fields', stop => {
    expect(openAiModelParameters({ temperature: null, topP: null, frequencyPenalty: 0, presencePenalty: null, n: null, stop }))
      .toEqual({ temperature: null, top_p: null, frequency_penalty: 0, presence_penalty: null, n: null, stop })
  })

  it.each([openAiModelParameters, anthropicModelParameters])('validates both aliases and retains the original precedence (%#)', normalize => {
    expect(normalize({ topP: 0.1, top_p: 0.5 })).toMatchObject({ top_p: 0.1 })
    expect(() => normalize({ topP: 0.1, top_p: 'invalid' })).toThrow('top_p')
    expect(() => normalize({ temperature: undefined })).toThrow('temperature')
  })

  it('keeps Anthropic thinking and output configuration native, and rejects nullable sampling', () => {
    const config = { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' }, topK: 0, stop_sequences: [] }
    expect(anthropicModelParameters(config)).toEqual({ thinking: config.thinking, output_config: config.output_config, top_k: 0, stop_sequences: [] })
    expect(() => anthropicModelParameters({ temperature: null })).toThrow('temperature')
    expect(() => anthropicModelParameters({ stop_sequences: ['ok', 0] })).toThrow('stop_sequences')
  })
})
