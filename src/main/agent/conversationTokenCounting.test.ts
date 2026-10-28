import { modelParameterInputTokens } from '../../runtime/modelInputBudget'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { ResolvedModelConfig } from '@shared/types'
import { createConversationModel } from './conversationModel'
import { describe, expect, it, vi } from 'vitest'
import { countConversationTokens } from './conversationContext'
import { approximateContentTokens } from '../../runtime/modelInputBudget'
import { ModelSelectionError } from '../../runtime/errors'
import { conversationChatInput } from '../../providers/conversationInput'
import { projectedModelInputTokens } from '../../runtime/modelInputBudget'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

function completedOpenAiResponse(): Response {
  return new Response(JSON.stringify({
    id: 'chat_counting', object: 'chat.completion', created: 1, model: 'fixture',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }],
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
  }), { headers: { 'content-type': 'application/json' } })
}

describe('local token counting', () => {
  it('does not count provider cache controls as prompt text or strip same-named tool data', () => {
    const plain = { kind: 'system' as const, content: 'Required instructions' }
    const cached = { kind: 'system' as const, content: [{ type: 'text', text: 'Required instructions', cache_control: { type: 'ephemeral' } }] }
    expect(countConversationTokens([cached], [], { protocol: 'anthropic_messages' }))
      .toBe(countConversationTokens([plain], [], { protocol: 'anthropic_messages' }))
    const toolJson = JSON.stringify({ cache_control: 'User data '.repeat(500) })
    expect(approximateContentTokens(toolJson)).toBe(Math.ceil(toolJson.length / 4))
  })

  it('counts Responses instructions once for the complete request alongside messages and tools', () => {
    const messages = [{ kind: 'user' as const, content: 'First input' }, { kind: 'assistant' as const, content: 'Earlier answer' }, { kind: 'user' as const, content: 'Follow-up' }]
    const tools = [{ type: 'function', name: 'lookup', description: 'Find project information', parameters: { type: 'object' } }]
    const parameters = { instructions: 'Required provider instructions. '.repeat(100) }
    const protocol = 'openai_responses' as const
    expect(countConversationTokens(messages, tools, { protocol, parameters }))
      .toBe(countConversationTokens(messages, tools, { protocol }) + Math.ceil(parameters.instructions.length / 4))
    expect(modelParameterInputTokens(protocol, parameters)).toBe(Math.ceil(parameters.instructions.length / 4))
    expect(countConversationTokens(messages, tools, { protocol, parameters: { instructions: null } }))
      .toBe(countConversationTokens(messages, tools, { protocol }))
  })

  it('rejects invalid Responses instructions as a terminal configuration error', () => {
    for (const instructions of [false, 100, {}, []]) {
      expect(() => countConversationTokens([], [], { protocol: 'openai_responses', parameters: { instructions } }))
        .toThrow(ModelSelectionError)
    }
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('counts the %s structured-output schema once without charging sampling settings', (protocol) => {
    const schema = { type: 'object', description: 'Required output structure. '.repeat(100), properties: { image: { type: 'string' } } }
    const format = protocol === 'anthropic_messages' ? { type: 'json_schema', schema }
      : protocol === 'openai_responses' ? { type: 'json_schema', name: 'answer', schema }
        : { type: 'json_schema', json_schema: { name: 'answer', schema } }
    const parameters = protocol === 'anthropic_messages' ? { output_config: { format }, temperature: 0.5 }
      : protocol === 'openai_responses' ? { text: { format }, temperature: 0.5 }
        : { response_format: format, temperature: 0.5 }
    const messages = [{ kind: 'user' as const, content: 'Question' }, { kind: 'assistant' as const, content: 'Prior response' }, { kind: 'user' as const, content: 'Continue' }]
    expect(countConversationTokens(messages, [], { protocol, parameters }))
      .toBe(countConversationTokens(messages, [], { protocol }) + Math.ceil(JSON.stringify(format).length / 4))
    expect(modelParameterInputTokens(protocol, { temperature: 0.5, top_p: 0.9 })).toBe(0)
  })

  it('counts the raw Responses output that will be replayed instead of only visible text', () => {
    const visibleOnly = { kind: 'assistant' as const, content: 'Short answer' }
    const responsesMessage = { kind: 'assistant' as const, content: 'Short answer', source: { metadata: {
        output: [
          {
            id: 'rs_1',
            type: 'reasoning',
            encrypted_content: 'x'.repeat(2_000),
            summary: []
          },
          {
            id: 'msg_1',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'output_text', text: 'Short answer', annotations: [] }]
          }
        ]
      }, extras: {} } }

    const options = { protocol: 'openai_responses' as const }
    expect(countConversationTokens([responsesMessage], [], options))
      .toBeGreaterThan(countConversationTokens([visibleOnly], [], options) + 400)
  })

  it('does not count visible Responses text twice when raw output is available', () => {
    const rawOutput = [{
      id: 'msg_1',
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'x'.repeat(1_000), annotations: [] }]
    }]
    const shortVisible = { kind: 'assistant' as const, content: 'x', source: { metadata: { output: rawOutput }, extras: {} } }
    const longVisible = { kind: 'assistant' as const, content: 'y'.repeat(10_000), source: { metadata: { output: rawOutput }, extras: {} } }

    const options = { protocol: 'openai_responses' as const }
    expect(countConversationTokens([longVisible], [], options))
      .toBe(countConversationTokens([shortVisible], [], options))

    const visibleImage = { kind: 'assistant' as const, content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(20_000)}` } }], source: { metadata: { output: rawOutput }, extras: {} } }
    expect(countConversationTokens([visibleImage], [], options))
      .toBe(countConversationTokens([shortVisible], [], options))
  })

  it('counts each Responses generated image once while preserving replay metadata', () => {
    const metadata = { type: 'image_generation_call', id: 'ig_flower', status: 'completed' }
    const count = (output: Record<string, unknown>[]) => countConversationTokens([
      { kind: 'assistant' as const, content: '', source: { metadata: { output }, extras: {} } }
    ], [], { protocol: 'openai_responses' })
    const expected = Math.ceil(JSON.stringify(metadata).length / 4) + 1024
    expect(count([{ ...metadata, result: 'AA==' }])).toBe(expected)
    expect(count([{ ...metadata, result: 'A'.repeat(100_000) }])).toBe(expected)
    expect(count([{ ...metadata, result: 'AA==' }, { ...metadata, id: 'ig_second', result: 'AA==' }]))
      .toBeGreaterThanOrEqual(2048)
    for (const result of [null, '']) expect(count([{ ...metadata, result }])).toBeLessThan(100)
    expect(count([{ ...metadata, result: 'AA==', revised_prompt: 'x'.repeat(8_000) }]))
      .toBeGreaterThan(expected + 2000)
  })

  it('counts each native Responses code interpreter image while retaining logs and call metadata', () => {
    const count = (urls: string[], logs = 'Chart generated') => countConversationTokens([
      { kind: 'assistant' as const, content: '', source: { metadata: { output: [{
        type: 'code_interpreter_call', id: 'ci_chart', status: 'completed', container_id: 'cntr_chart', code: 'plot()',
        outputs: [{ type: 'logs', logs }, ...urls.map(url => ({ type: 'image', url }))]
      }] }, extras: {} } }
    ], [], { protocol: 'openai_responses' })
    const short = 'https://example.test/chart.png'
    const long = `data:image/png;base64,${'A'.repeat(100_000)}`
    const withoutImages = count([])
    const oneImage = count([short])
    const twoImages = count([short, short])
    expect(oneImage - withoutImages).toBeGreaterThanOrEqual(1024)
    expect(oneImage - withoutImages).toBeLessThanOrEqual(1025)
    expect(twoImages - oneImage).toBeGreaterThanOrEqual(1024)
    expect(twoImages - oneImage).toBeLessThanOrEqual(1025)
    expect(count([long, long])).toBe(twoImages)
    expect(count([short, short], `Chart generated${'x'.repeat(8_000)}`)).toBe(twoImages + 2_000)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('counts code-interpreter-shaped %s tool arguments and logs as ordinary JSON text', (protocol) => {
    const value = { type: 'code_interpreter_call', outputs: [{ type: 'image', url: 'A'.repeat(16_000) }] }
    const messages = [
      { kind: 'assistant' as const, content: '', calls: [{ id: 'call_json', name: 'write_json', args: value }] },
      { kind: 'tool' as const, resultFor: 'call_json', content: JSON.stringify(value) }
    ]
    expect(countConversationTokens(messages, [], { protocol })).toBeGreaterThan(8_000)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('treats image-generation-shaped %s tool JSON as text', (protocol) => {
    const value = { type: 'image_generation_call', result: 'A'.repeat(16_000) }
    const messages = [
      { kind: 'assistant' as const, content: '', calls: [{ id: 'call_json', name: 'write_json', args: value }] },
      { kind: 'tool' as const, resultFor: 'call_json', content: JSON.stringify(value) }
    ]
    expect(countConversationTokens(messages, [], { protocol })).toBeGreaterThan(8_000)
  })

  it('does not use historical output usage as the next request content', () => {
    const message = { kind: 'assistant' as const, content: 'Answer', usage: {
        input_tokens: 10,
        output_tokens: 2_000,
        total_tokens: 2_010,
        output_token_details: { reasoning: 1_990 }
      }, source: { metadata: {
        output: [{ id: 'rs_server_retained', type: 'reasoning', summary: [] }]
      }, extras: {} } }

    for (const protocol of [undefined, 'openai_responses', 'openai_chat_completions', 'anthropic_messages'] as const) {
      expect(countConversationTokens([message], [], { protocol })).toBeLessThan(100)
    }
  })

  it('continues to count ordinary messages and tool definitions', () => {
    const messages = [{ kind: 'user' as const, content: 'A'.repeat(400) }]
    const withoutTools = countConversationTokens(messages)
    const withTools = countConversationTokens(messages, [{
      type: 'function',
      function: {
        name: 'search',
        description: 'Search the web',
        parameters: { type: 'object', properties: {} }
      }
    }])

    expect(withoutTools).toBeGreaterThan(90)
    expect(withTools).toBeGreaterThan(withoutTools)
  })

  it('counts generic tool calls once when the AI message already has standard content blocks', () => {
    const call = { id: 'call_lookup', name: 'lookup', args: { query: 'text'.repeat(100) } }
    const original = { kind: 'assistant' as const, content: '', calls: [call] }
    const standard = { kind: 'assistant' as const, content: [{ type: 'tool_call', ...call }], calls: [call], source: { metadata: { output_version: 'v1' }, extras: {}, contentFormat: 'portable' as const } }
    expect(countConversationTokens([standard])).toBe(countConversationTokens([original]))
  })

  it('counts Anthropic thinking blocks that are replayed with their signatures', () => {
    const withoutThinking = { kind: 'assistant' as const, content: 'Answer' }
    const withThinking = { kind: 'assistant' as const, content: [
        { type: 'thinking', thinking: 'x'.repeat(2_000), signature: 'signed-reasoning' },
        { type: 'text', text: 'Answer' }
      ] }

    const options = { protocol: 'anthropic_messages' as const }
    expect(countConversationTokens([withThinking], [], options))
      .toBeGreaterThan(countConversationTokens([withoutThinking], [], options) + 400)
  })

  it.each(['image', 'image_url', 'input_image'])('assigns one fixed image budget to %s regardless of payload length', (type) => {
    for (const payload of ['https://example.com/a.png', `data:image/png;base64,${'A'.repeat(100_000)}`]) {
      const image = type === 'image'
        ? { type, source_type: 'url', url: payload }
        : type === 'image_url'
          ? { type, image_url: { url: payload } }
          : { type, image_url: payload }
      const content = [{ type: 'text', text: 'A'.repeat(400) }, image] as ConversationMessage['content']
      expect(countConversationTokens([{ kind: 'user' as const, content }])).toBe(1124)
      expect(approximateContentTokens(content)).toBe(1124)
    }
  })

  it('counts every image once alongside Responses text blocks', () => {
    const content: ConversationMessage['content'] = [
      { type: 'input_text', text: 'A'.repeat(400) },
      { type: 'input_image', image_url: 'https://example.com/one.png' },
      { type: 'image_url', image_url: { url: 'https://example.com/two.png' } }
    ]
    const message = { kind: 'user' as const, content }
    expect(countConversationTokens([message])).toBe(2148)
    expect(countConversationTokens([message], [], { protocol: 'openai_responses' })).toBe(2148)
    expect(approximateContentTokens(content)).toBe(2148)
    expect(message.content).toEqual(content)
  })

  it.each(['input_text', 'output_text'])('counts %s with ordinary text without losing tool-call framing', (type) => {
    const message = { kind: 'tool' as const, resultFor: 'call', content: [
      { type: 'text', text: 'ab' }, { type, text: 'cd' }
    ] }
    const ordinary = { kind: 'tool' as const, resultFor: 'call', content: 'abcd' }
    expect(countConversationTokens([message])).toBe(countConversationTokens([ordinary]))
    expect(approximateContentTokens(message.content)).toBe(1)
  })

  it('includes Chat Completions image transport labels and copied text exactly once', () => {
    const messages = [
      { kind: 'tool' as const, resultFor: 'first', name: 'view_image', content: [
        { type: 'text', text: 'First chart description. '.repeat(20) },
        { type: 'image_url', image_url: { url: 'https://example.com/first.png' } }
      ] },
      { kind: 'tool' as const, resultFor: 'second', name: 'view_image', content: [
        { type: 'input_text', text: 'Second chart description. '.repeat(20) },
        { type: 'input_image', image_url: 'https://example.com/second.png' }
      ] }
    ]
    const original = structuredClone(messages)
    const transmitted = conversationChatInput(messages)
    const options = { protocol: 'openai_chat_completions' as const }
    expect(countConversationTokens(messages, [], options)).toBeGreaterThan(countConversationTokens(messages))
    expect(countConversationTokens(messages, [], options)).toBe(projectedModelInputTokens({ messages: transmitted }))
    expect(countConversationTokens(messages, [], { protocol: 'openai_responses' })).toBeLessThan(countConversationTokens(messages, [], options))
    expect(structuredClone(messages)).toEqual(original)
  })

  it('counts only the content actually sent after switching Responses history to Chat Completions', async () => {
    const previous = { kind: 'assistant' as const, content: [{ type: 'text', text: 'Done' }], usage: { input_tokens: 10, output_tokens: 20_000, total_tokens: 20_010 }, source: { metadata: {
        output_version: 'v1', model_provider: 'openai',
        output: [{ type: 'reasoning', id: 'rs_previous', encrypted_content: 'x'.repeat(32_000), summary: [] }]
      }, extras: { reasoning: { encrypted_content: 'x'.repeat(32_000) } }, contentFormat: 'portable' as const } }
    const messages = [{ kind: 'user' as const, content: 'Start' }, previous, { kind: 'user' as const, content: 'Continue' }]
    const bodies: Record<string, unknown>[] = []
    const model = createConversationModel({
      id: 'fixture', displayName: '', providerId: 'fixture', providerName: 'Fixture', protocol: 'openai_chat_completions',
      baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'test-key', parameters: {}, parameterPresetMode: 'none',
      capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
      contextCompressionThreshold: 0.8, contextCompressionEnabled: true
    }, { providerFetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return completedOpenAiResponse()
    } })
    await model.invoke({ messages, tools: [], signal: new AbortController().signal })
    expect(JSON.stringify(bodies[0].messages)).not.toContain('encrypted_content')
    expect(JSON.stringify(bodies[0].messages).length).toBeLessThan(200)
    expect(countConversationTokens(messages, [], { protocol: 'openai_chat_completions' })).toBeLessThan(20)
    expect(countConversationTokens(messages, [], { protocol: 'openai_responses' })).toBeGreaterThan(8_000)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('ignores image payload lengths inside actual %s tool result framing', (protocol) => {
    const makeMessages = (url: string) => [{ kind: 'tool' as const, resultFor: 'call_image', content: [
      { type: 'text', text: 'Image result' }, { type: 'image_url', image_url: { url } }
    ] }]
    const short = countConversationTokens(makeMessages('https://example.com/image.png'), [], { protocol })
    const long = countConversationTokens(makeMessages(`data:image/png;base64,${'A'.repeat(100_000)}`), [], { protocol })
    expect(short).toBeGreaterThanOrEqual(1024)
    expect(long).toBe(short)
    expect(long).toBeLessThan(1124)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('counts image-shaped JSON tool arguments as text for %s', (protocol) => {
    const message = { kind: 'assistant' as const, content: '', calls: [{
      id: 'call_json', name: 'write_json', args: { type: 'image', data: 'A'.repeat(16_000) }
    }] }
    const estimated = countConversationTokens([message], [], { protocol })
    expect(estimated).toBeGreaterThan(4_000)
    expect(estimated).toBeLessThan(4_200)
  })
})
