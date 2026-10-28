import { describe, expect, it } from 'vitest'
import { openAiRequestParameters, openAiToolDefinition, type OpenAiRequestSettings } from './openAiParameters'

const settings: OpenAiRequestSettings = { model: 'fixture', protocol: 'chat', streaming: true, parameters: {} }

describe('native OpenAI parameters', () => {
  it.each(['chat', 'responses'] as const)('preserves configured native and empty values without mutating settings (%s)', protocol => {
    const configured = { ...settings, protocol, parameters: { temperature: null, stop: [], parallel_tool_calls: false, user: '', top_p: 0, custom: { enabled: false } } }
    const before = structuredClone(configured)
    expect(openAiRequestParameters(configured)).toMatchObject({ model: 'fixture', ...configured.parameters })
    expect(configured).toEqual(before)
  })

  it('sends the right output limit for ordinary, reasoning and Responses models', () => {
    expect(openAiRequestParameters({ ...settings, maxOutputTokens: 123 })).toMatchObject({ max_tokens: 123 })
    expect(openAiRequestParameters({ ...settings, model: 'gpt-5', maxOutputTokens: 123 })).toMatchObject({ max_completion_tokens: 123 })
    expect(openAiRequestParameters({ ...settings, model: 'gpt-5-chat-latest', maxOutputTokens: 123 })).toMatchObject({ max_tokens: 123 })
    expect(openAiRequestParameters({ ...settings, protocol: 'responses', maxOutputTokens: 123 })).toMatchObject({ max_output_tokens: 123 })
    expect(openAiRequestParameters(settings)).not.toHaveProperty('max_tokens')
  })

  it.each(['auto', 'none', 'required', 'any', 'read'] as const)('preserves tool selection %s on both endpoints', selected => {
    for (const protocol of ['chat', 'responses'] as const) {
      expect(openAiRequestParameters({ ...settings, protocol }, { tool_choice: selected }).tool_choice).toEqual(selected === 'any' ? 'required'
        : selected !== 'read' ? selected : protocol === 'responses' ? { type: 'function', name: 'read' } : { type: 'function', function: { name: 'read' } })
    }
  })

  it('preserves explicit tool strictness, schema composition and deferred loading', () => {
    const declaration = { type: 'function', defer_loading: true, function: { name: 'read', strict: false, parameters: {
      anyOf: [{ type: 'object', properties: { path: { type: 'string' } } }, { type: 'object', properties: { id: { type: 'number' } } }]
    } } }
    const before = structuredClone(declaration)
    expect(openAiToolDefinition(declaration, 'responses')).toMatchObject({ ...declaration.function, type: 'function', defer_loading: true })
    expect(openAiToolDefinition(declaration, 'chat')).toEqual(declaration)
    expect(openAiToolDefinition(declaration, 'responses', true)).toMatchObject({ strict: true })
    expect(declaration).toEqual(before)
  })

  it('maps freeform grammars in both directions and keeps image generation settings immutable', () => {
    const native = { type: 'custom', name: 'patch', format: { type: 'grammar', syntax: 'lark', definition: 'start: /.+/' } }
    const chat = openAiToolDefinition(native, 'chat')
    expect(chat).toMatchObject({ type: 'custom', custom: { name: 'patch', format: { type: 'grammar', grammar: { syntax: 'lark', definition: 'start: /.+/' } } } })
    expect(openAiToolDefinition(chat, 'responses')).toEqual(native)
    const image = { type: 'image_generation' }
    expect(openAiToolDefinition(image, 'responses', undefined, true)).toEqual({ ...image, partial_images: 1 })
    expect(openAiToolDefinition({ ...image, partial_images: 0 }, 'responses', undefined, true)).toHaveProperty('partial_images', 0)
    expect(image).toEqual({ type: 'image_generation' })
  })

  it('maps structured output and native cache/reasoning options without leaking execution options', () => {
    const options = { response_format: { type: 'json_schema', json_schema: { name: 'report', schema: { type: 'object' }, strict: false } },
      promptCacheKey: 'cache', promptCacheRetention: '24h', reasoning: { effort: 'low' }, signal: new AbortController().signal, callbacks: ['private'] }
    const body = openAiRequestParameters({ ...settings, protocol: 'responses', model: 'gpt-5', parameters: { reasoning: { summary: 'auto' } } }, options)
    expect(body).toMatchObject({ text: { format: { type: 'json_schema', name: 'report', schema: { type: 'object' }, strict: false } },
      prompt_cache_key: 'cache', prompt_cache_retention: '24h', reasoning: { effort: 'low', summary: 'auto' } })
    expect(body).not.toHaveProperty('signal')
    expect(body).not.toHaveProperty('callbacks')
  })
})
