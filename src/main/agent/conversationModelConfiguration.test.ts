import { approximateContentTokens } from '../../runtime/modelInputBudget'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedModelConfig } from '@shared/types'
import { ModelSelectionError, ModelRequestChangedError, isModelContextOverflow } from '../../runtime/errors'
import { createConversationModel } from './conversationModel'
import { createCompressionModel } from './compressionModel'
import { countConversationTokens } from './conversationContext'
const runtimeLoggerMocks = vi.hoisted(() => ({ runtimeLog: vi.fn() }))
vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => runtimeLoggerMocks)
const baseModel: ResolvedModelConfig = {
  id: 'test',
  displayName: '',
  providerId: 'provider-test',
  providerName: 'Test',
  protocol: 'openai_chat_completions',
  baseUrl: 'https://example.com/v1',
  model: 'test-model',
  apiKey: 'secret',
  parameters: {},
  parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true },
  stream: true,
  maxContextTokens: 128000,
  maxOutputTokens: 16000,
  contextCompressionThreshold: 0.8,
  contextCompressionEnabled: true
}

async function wire(config: ResolvedModelConfig, tools: unknown[] = []) {
  const bodies: Record<string, unknown>[] = []
  const providerFetch: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)))
    if (config.protocol === 'anthropic_messages') return Response.json({ id: 'message', type: 'message', role: 'assistant', model: 'fixture',
      content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } })
    if (config.protocol === 'openai_responses') return Response.json({ id: 'response', object: 'response', status: 'completed', model: 'fixture',
      output: [{ type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }] })
    return Response.json({ id: 'response', object: 'chat.completion', model: 'fixture', created: 1,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] })
  }
  const selected = createConversationModel({ ...config, stream: false }, { providerFetch })
  expect((await selected.invoke({ messages: [{ kind: 'user', content: 'Hello' }], tools, signal: new AbortController().signal })).text).toBe('done')
  return { body: bodies[0], providerFetch }
}

describe('native model configuration and compression requests', () => {
  it.each([false, true])('preserves automatic compression recognition after native Anthropic rejection (stream=%s)', async stream => {
    const providerFetch = vi.fn<typeof fetch>(async () => Response.json({ type: 'error', error: {
      type: 'invalid_request_error', message: 'prompt is too long: 2000 tokens > 1000 maximum'
    } }, { status: 400 }))
    const model = createConversationModel({ ...baseModel, protocol: 'anthropic_messages', stream }, { providerFetch })
    const error = await model.invoke({ messages: [{ kind: 'user', content: 'Hello' }], tools: [], signal: new AbortController().signal }).catch(error => error)
    expect(isModelContextOverflow(error)).toBe(true)
    expect(error).toMatchObject({ status: 400 })
    expect(providerFetch).toHaveBeenCalledOnce()
  })

  it.each([false, true])('forwards Anthropic beta options and configured native fields (stream=%s)', async stream => {
    const requests: { body: unknown; headers: Headers }[] = []
    const message = { id: 'msg_beta', type: 'message', role: 'assistant', model: 'fixture',
      content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn', stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 4 } }
    const model = createConversationModel({ ...baseModel, protocol: 'anthropic_messages', stream,
      parameters: { metadata: { user_id: 'fixture-user' }, temperature: 0, stop_sequences: [], betas: ['interleaved-thinking-2025-05-14'] } }, {
      providerFetch: async (_url, init) => {
        requests.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) })
        if (!stream) return Response.json(message)
        const events = [
          { type: 'message_start', message: { ...message, content: [], stop_reason: null } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Done' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } },
          { type: 'message_stop' }
        ]
        return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
          headers: { 'content-type': 'text/event-stream' }
        })
      }
    })
    const result = await model.invoke({ messages: [{ kind: 'user', content: 'Hello' }], tools: [], signal: new AbortController().signal })
    expect(result.message.content).toBe('Done')
    // Anthropic reports uncached input separately; the application total includes cache creation/read.
    expect(result.message.usage).toMatchObject({ input_tokens: 14, output_tokens: 0,
      input_token_details: { cache_read: 0, cache_creation: 4 } })
    expect(requests[0].body).toMatchObject({ stream, metadata: { user_id: 'fixture-user' }, temperature: 0, stop_sequences: [] })
    expect(requests[0].headers.get('anthropic-beta')).toContain('interleaved-thinking-2025-05-14')
  })

  it.each([
    ...(['openai_chat_completions', 'openai_responses'] as const).flatMap((protocol) =>
      ['temperature', 'topP', 'top_p', 'frequencyPenalty', 'frequency_penalty', 'presencePenalty', 'presence_penalty', 'n'].map((parameter) => ({ protocol, parameter }))),
    ...['temperature', 'topP', 'top_p', 'topK', 'top_k'].map((parameter) => ({ protocol: 'anthropic_messages' as const, parameter }))
  ])('rejects invalid mapped numeric $parameter for $protocol instead of dropping it', async ({ protocol, parameter }) => {
    for (const value of ['0.5', false, {}, NaN, Infinity, ...(protocol === 'anthropic_messages' ? [null] : [])]) {
      expect(() => createConversationModel({ ...baseModel, protocol, parameters: { [parameter]: value } })).toThrow(ModelSelectionError)
      expect(() => createConversationModel({ ...baseModel, protocol, parameters: { [parameter]: value } })).toThrow(parameter)
    }
  })

  it.each(['openai_chat_completions', 'openai_responses'] as const)('preserves legal null sampling and string, array or null stop values in actual %s requests', async (protocol) => {
    const sent: Record<string, unknown>[] = []
    const providerFetch: typeof fetch = async (_url, init) => {
      sent.push(JSON.parse(String(init?.body)))
      const response = protocol === 'openai_responses'
        ? { id: 'resp_nullable', object: 'response', created_at: 1, status: 'completed', model: 'fixture', output: [], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }
        : { id: 'chat_nullable', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
    }
    for (const stop of ['END', ['END', 'DONE'], null]) {
      const parameters = { temperature: null, topP: null, frequencyPenalty: null, presence_penalty: null, n: null, stop, native_provider_setting: { mode: 'custom' } }
      const model = createConversationModel({ ...baseModel, protocol, stream: false, parameters }, { providerFetch })
      await model.invoke({ messages: [{ kind: 'user' as const, content: 'Finish.' }], tools: [], signal: new AbortController().signal })
      expect(sent.at(-1)).toMatchObject({
        temperature: null, top_p: null, frequency_penalty: null, presence_penalty: null, n: null, stop,
        native_provider_setting: { mode: 'custom' }
      })
      expect(sent.at(-1)).not.toHaveProperty('topP')
      expect(sent.at(-1)).not.toHaveProperty('frequencyPenalty')
    }
  })

  it.each([
    { parameters: { thinking: { type: 'enabled', budget_tokens: 2048 } }, reason: 'thinking.type="enabled"' },
    { parameters: { temperature: 0.2 }, reason: 'temperature is not supported' }
  ])('reports unsupported Anthropic model parameter combinations during construction: $reason', async ({ parameters, reason }) => {
    const create = () => createConversationModel({ ...baseModel, protocol: 'anthropic_messages', model: 'claude-opus-4-7', parameters })
    expect(create).toThrow(ModelSelectionError)
    expect(create).toThrow(reason)
  })

  it('requires a configured model id but accepts an empty API key', async () => {
    expect(() => createConversationModel({ ...baseModel, model: '' })).toThrow('incomplete model configuration')
    expect(() => createConversationModel({ ...baseModel, apiKey: undefined })).not.toThrow()
    expect(() => createConversationModel({ ...baseModel, protocol: 'anthropic_messages', apiKey: undefined })).not.toThrow()
  })

  it('invokes both adapters with non-sensitive fallback credentials', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
      const url = input instanceof Request ? input.url : String(input)
      const body = url.endsWith('/messages')
        ? {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            content: [{ type: 'text', text: 'anthropic-ok' }],
            model: 'test-model',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 1 }
          }
        : {
            id: 'chatcmpl-test',
            object: 'chat.completion',
            created: 1,
            model: 'test-model',
            choices: [{
              index: 0,
              message: { role: 'assistant', content: 'openai-ok' },
              finish_reason: 'stop'
            }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
          }
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    })

    try {
      const openAiModel = createConversationModel({ ...baseModel, apiKey: undefined, stream: false })
      const anthropicModel = createConversationModel({
        ...baseModel,
        protocol: 'anthropic_messages',
        apiKey: undefined,
        stream: false
      })

      await expect(openAiModel.invoke({ messages: [{ kind: 'user', content: 'Hello' }], tools: [], signal: new AbortController().signal })).resolves.toMatchObject({ message: { content: 'openai-ok' } })
      await expect(anthropicModel.invoke({ messages: [{ kind: 'user', content: 'Hello' }], tools: [], signal: new AbortController().signal })).resolves.toMatchObject({ message: { content: 'anthropic-ok' } })
      expect(fetchSpy).toHaveBeenCalledTimes(2)
      const requestHeaders = fetchSpy.mock.calls.map(([input, init]) => ({
        headers: input instanceof Request ? input.headers : new Headers(init?.headers),
        url: input instanceof Request ? input.url : String(input)
      }))
      const openAiHeaders = requestHeaders.find((request) => request.url.includes('/chat/completions'))?.headers
      const anthropicHeaders = requestHeaders.find((request) => request.url.endsWith('/messages'))?.headers
      expect(openAiHeaders?.get('authorization')).toBe('Bearer anas-no-auth')
      expect(anthropicHeaders?.get('x-api-key')).toBe('anas-no-auth')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('rejects reserved extra parameters instead of overriding explicit fields', async () => {
    expect(() => createConversationModel({
      ...baseModel,
      parameters: { model: 'shadow-model', stream: false, max_retries: 99 }
    })).toThrow(/max_retries, model, stream/)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'rejects runtime request overrides before constructing %s main or compression requests', async (protocol) => {
        const providerFetch = vi.fn()
      for (const field of ['input', 'messages', 'system', 'conversation', 'previous_response_id', 'prompt']) {
        for (const factory of [createConversationModel, createCompressionModel]) {
          expect(() => factory({ ...baseModel, protocol, parameters: { [field]: 'shadow context' } }, { providerFetch }))
            .toThrow(ModelSelectionError)
        }
      }
      expect(providerFetch).not.toHaveBeenCalled()
    }
  )

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'rejects configured client function declarations before %s main or compression requests', async (protocol) => {
        const providerFetch = vi.fn()
      for (const parameters of [
        { functions: [{ name: 'unregistered', description: 'x'.repeat(20_000), parameters: { type: 'object' } }] },
        { function_call: { name: 'unregistered' } }
      ]) {
        for (const factory of [createConversationModel, createCompressionModel]) {
          expect(() => factory({ ...baseModel, protocol, parameters }, { providerFetch }))
            .toThrow(`reserved keys: ${Object.keys(parameters)[0]}`)
        }
      }
      expect(providerFetch).not.toHaveBeenCalled()
    }
  )

  it('preserves counted Responses instructions on main and forced non-streaming compression requests', async () => {
    const instructions = 'Use the configured answer format. '.repeat(100)
    const selected = { ...baseModel, protocol: 'openai_responses' as const, parameters: { instructions }, stream: false }
    const bodies: Array<Record<string, unknown>> = []
    const providerFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)))
      return new Response(JSON.stringify({ id: 'response_instructions', object: 'response', created_at: 1,
        status: 'completed', model: 'test-model', output_text: 'Done', output: [{
          type: 'message', id: 'msg_instructions', role: 'assistant', status: 'completed',
          content: [{ type: 'output_text', text: 'Done', annotations: [] }]
        }] }), { headers: { 'content-type': 'application/json' } })
    })
    const messages = [{ kind: 'user' as const, content: 'Apply the format.' }]
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch)
    try {
      await createConversationModel(selected, { providerFetch }).invoke({ messages, tools: [], signal: new AbortController().signal })
      await createCompressionModel({ ...selected, stream: true })(messages[0].content)
      expect(bodies).toHaveLength(2)
      for (const body of bodies) expect(body).toMatchObject({ instructions, stream: false,
        input: [{ role: 'user', content: 'Apply the format.' }] })
      expect(countConversationTokens(messages, [], { protocol: selected.protocol, parameters: selected.parameters }))
        .toBe(countConversationTokens(messages, [], { protocol: selected.protocol }) + Math.ceil(instructions.length / 4))
    } finally { fetchSpy.mockRestore() }
  })

  it.each([false, 10, {}, []])('rejects invalid Responses instructions before any request: %j', async (instructions) => {
    const selected = { ...baseModel, protocol: 'openai_responses' as const, parameters: { instructions } }
    expect(() => createConversationModel(selected)).toThrow(ModelSelectionError)
    expect(() => createCompressionModel(selected)).toThrow('instructions')
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('preserves the counted %s output schema in actual provider requests', async (protocol) => {
    const schema = { type: 'object', description: 'Expected answer. '.repeat(100), properties: { answer: { type: 'string' } }, additionalProperties: false, required: ['answer'] }
    const format = protocol === 'anthropic_messages' ? { type: 'json_schema', schema }
      : protocol === 'openai_responses' ? { type: 'json_schema', name: 'answer', strict: true, schema }
        : { type: 'json_schema', json_schema: { name: 'answer', strict: true, schema } }
    const parameters = protocol === 'anthropic_messages' ? { output_config: { format } }
      : protocol === 'openai_responses' ? { text: { format } } : { response_format: format }
    const selected = { ...baseModel, protocol, parameters, stream: false }
    const messages = [{ kind: 'user' as const, content: 'Question' }]
    const bodies: Record<string, unknown>[] = []
    const providerFetch: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      const response = protocol === 'anthropic_messages'
        ? { id: 'msg_schema', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: '{"answer":"Done"}' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }
        : protocol === 'openai_responses'
          ? { id: 'resp_schema', object: 'response', created_at: 1, status: 'completed', model: 'fixture', output: [{ type: 'message', id: 'msg_schema', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: '{"answer":"Done"}', annotations: [] }] }], usage: { input_tokens: 1, output_tokens: 0, total_tokens: 1 } }
          : { id: 'chat_schema', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"answer":"Done"}' } }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
      return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
    }
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(providerFetch)
    try {
      await createConversationModel(selected, { providerFetch }).invoke({ messages, tools: [], signal: new AbortController().signal })
      await createCompressionModel({ ...selected, stream: true })(messages[0].content)
      for (const body of bodies) expect(body).toMatchObject(parameters)
      expect(countConversationTokens(messages, [], { protocol, parameters }))
        .toBe(countConversationTokens(messages, [], { protocol }) + Math.ceil(JSON.stringify(format).length / 4))
    } finally { fetchSpy.mockRestore() }
  })

  it.each([
    { tools: [] },
    { temperature: 'invalid' },
    { model: 'shadow-model' }
  ])('classifies invalid compression parameters as terminal selection errors: %j', async (parameters) => {
    expect(() => createCompressionModel({ ...baseModel, parameters })).toThrow(ModelSelectionError)
  })

  it('observes each actual provider fetch without logging request contents', async () => {
    runtimeLoggerMocks.runtimeLog.mockClear()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ id: 'trace', object: 'chat.completion', model: baseModel.model,
      created: 1, choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Done' } }] }))
    const model = createConversationModel({ ...baseModel, stream: false })

    try {
      expect((await model.invoke({ messages: [{ kind: 'user', content: 'Private prompt' }], tools: [], signal: new AbortController().signal })).message.content).toBe('Done')
      expect(fetchSpy).toHaveBeenCalledTimes(1)
      expect(runtimeLoggerMocks.runtimeLog).toHaveBeenNthCalledWith(
        1,
        'debug',
        'agent-model',
        'Provider request started.',
        expect.objectContaining({ protocol: 'openai_chat_completions', model: 'test-model', requestNumber: 1 })
      )
      expect(runtimeLoggerMocks.runtimeLog).toHaveBeenNthCalledWith(
        2,
        'debug',
        'agent-model',
        'Provider request completed.',
        expect.objectContaining({ status: 200, requestNumber: 1 })
      )
      expect(JSON.stringify(runtimeLoggerMocks.runtimeLog.mock.calls)).not.toContain('/chat/completions')
      expect(JSON.stringify(runtimeLoggerMocks.runtimeLog.mock.calls)).not.toContain('Private prompt')
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('cancels %s compression retries while preserving run diagnostics', async (protocol) => {
    const controller = new AbortController()
    const reason = new Error('Cancelled during compression retry')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
      JSON.stringify({ error: { type: 'server_error', message: 'Temporarily unavailable' } }),
      { status: 503, headers: { 'content-type': 'application/json' } }
    ))
    runtimeLoggerMocks.runtimeLog.mockImplementation((_level, _channel, message) => {
      if (message === 'Retrying a transient model request.') controller.abort(reason)
    })
    const compression = createCompressionModel({ ...baseModel, protocol }, {
      requestId: 'compression-run',
      requestRole: 'compression',
      signal: controller.signal
    })

    try {
      await expect(compression('Summarize this conversation.')).rejects.toBe(reason)
      expect(fetchSpy).toHaveBeenCalledOnce()
      expect(runtimeLoggerMocks.runtimeLog).toHaveBeenCalledWith('warn', 'agent-model', 'Retrying a transient model request.',
        expect.objectContaining({ runId: 'compression-run', attempt: 1, nextAttempt: 2, reason: 'server', status: 503 }))
    } finally {
      fetchSpy.mockRestore()
      runtimeLoggerMocks.runtimeLog.mockReset()
    }
  })

  it.each((['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)
    .flatMap(protocol => [
      { protocol, failure: new ModelSelectionError('The selected model was deleted.') },
      { protocol, failure: new ModelRequestChangedError() }
    ]))(
    'returns $failure.name to preparation before resending a $protocol compression request', async ({ protocol, failure }) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(
        JSON.stringify({ error: { type: 'server_error', message: 'Temporarily unavailable' } }),
        { status: 503, headers: { 'content-type': 'application/json' } }
      ))
      const beforeRequest = vi.fn().mockResolvedValueOnce(undefined).mockRejectedValue(failure)
      try {
        const compression = createCompressionModel({ ...baseModel, protocol }, { beforeRequest })
        await expect(compression('Summarize this conversation.')).rejects.toBe(failure)
        expect(fetchSpy).toHaveBeenCalledTimes(1)
        expect(beforeRequest).toHaveBeenCalledTimes(2)
      } finally { fetchSpy.mockRestore() }
    }
  )

  it.each([
    { protocol: 'openai_chat_completions', parameter: 'stop' }, { protocol: 'openai_responses', parameter: 'stop' },
    { protocol: 'anthropic_messages', parameter: 'stop_sequences' }
  ] as const)('validates the full $parameter list and sends valid values through $protocol', async ({ protocol, parameter }) => {
    for (const value of [1, ['END', 1], ...(protocol === 'anthropic_messages' ? ['END', null] : [])]) {
      expect(() => createConversationModel({ ...baseModel, protocol, parameters: { [parameter]: value } })).toThrow(ModelSelectionError)
    }
    const { body } = await wire({ ...baseModel, protocol, parameters: { [parameter]: ['END', 'DONE'] } })
    expect(body).toMatchObject({ [parameter]: ['END', 'DONE'] })
  })

  it('checks both aliases and sends configured zero and provider-specific fields', async () => {
    expect(() => createConversationModel({ ...baseModel, parameters: { topP: 0.5, top_p: 'invalid' } })).toThrow('top_p')
    const { body } = await wire({ ...baseModel, parameters: { temperature: 0, native_provider_setting: { mode: 'custom' } } })
    expect(body).toMatchObject({ temperature: 0, native_provider_setting: { mode: 'custom' } })
  })

  it('sends the configured model, sampling and registered tools', async () => {
    const { body } = await wire({ ...baseModel, parameters: { temperature: 0.2, enable_thinking: false } }, [
      { name: 'probe', description: 'Probe tool', inputSchema: { type: 'object', properties: {} } }
    ])
    expect(body).toMatchObject({ model: 'test-model', stream: false, temperature: 0.2, enable_thinking: false,
      tools: [{ type: 'function', function: { name: 'probe', description: 'Probe tool', parameters: { type: 'object' } } }] })
  })

  it.each([
    { protocol: 'anthropic_messages', parameters: { thinking: { type: 'adaptive' }, output_config: { effort: 'medium' } } },
    { protocol: 'openai_chat_completions', parameters: { thinking: { type: 'adaptive' }, reasoning_split: true } }
  ] as const)('retains the configured $protocol thinking and output fields', async ({ protocol, parameters }) => {
    expect((await wire({ ...baseModel, protocol, parameters })).body).toMatchObject(parameters)
  })

  it('sends only the prepared Responses server tools, rejecting them on other protocols', async () => {
    const selected = { ...baseModel, protocol: 'openai_responses' as const, parameters: { tools: [{ type: 'web_search' }] } }
    expect((await wire(selected)).body).not.toHaveProperty('tools')
    expect((await wire(selected, selected.parameters.tools)).body.tools).toEqual(selected.parameters.tools)
    expect(() => createConversationModel({ ...baseModel, parameters: selected.parameters })).toThrow('only supported by the OpenAI Responses protocol')
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('uses %s output defaults when the configured maximum is zero', async protocol => {
    const { body } = await wire({ ...baseModel, protocol, maxOutputTokens: 0 })
    if (protocol === 'anthropic_messages') expect(body.max_tokens).toBe(4096)
    else { expect(body).not.toHaveProperty('max_tokens'); expect(body).not.toHaveProperty('max_output_tokens'); expect(body).not.toHaveProperty('max_completion_tokens') }
  })

  it('counts locally without downloading tokenizer data for any protocol', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      expect(approximateContentTokens('Count these tokens locally.')).toBe(7)
      for (const protocol of ['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const) {
        createConversationModel({ ...baseModel, protocol })
        expect(countConversationTokens([{ kind: 'user', content: 'Count these tokens locally.' }], [], { protocol })).toBeGreaterThanOrEqual(7)
      }
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally { fetchSpy.mockRestore() }
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('observes %s summaries once independently of the main result', async protocol => {
    const { providerFetch } = await wire({ ...baseModel, protocol })
    const observe = vi.fn(async (_prompt, generate) => generate())
    const summary = await createCompressionModel({ ...baseModel, protocol }, { providerFetch, observe })('inspect')
    expect(summary.text).toBe('done'); expect(observe).toHaveBeenCalledOnce()
  })
})
