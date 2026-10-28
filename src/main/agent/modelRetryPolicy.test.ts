import Database from 'better-sqlite3'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import type { RunObserver } from '../../runtime/runExecution'
import { defineContentTool, type ToolDefinition } from '../../runtime/toolDefinition'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'
import { createConversationModelPreparation } from './conversationModelExecution'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { z } from 'zod/v3'
import type { ResolvedModelConfig } from '@shared/types'
import { describe, expect, it, vi } from 'vitest'
import {
  classifyModelRetryError,
  invokeModelWithRetry
} from '../../runtime/modelRetry'
import { ProjectRulesError, isModelSelectionError, ModelSelectionError, isModelRequestChangedError, ModelRequestChangedError } from '../../runtime/errors'

const runtimeLoggerMocks = vi.hoisted(() => ({ runtimeLog: vi.fn() }))

vi.mock('../runtimeLogger', () => runtimeLoggerMocks)
vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))

function httpError(status: number, message = `HTTP ${status}`): Error {
  return Object.assign(new Error(message), { status })
}


const defaultModel: ResolvedModelConfig = {
  id: 'fixture', displayName: '', providerId: 'fixture', providerName: 'Fixture', protocol: 'openai_chat_completions',
  baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'test', parameters: {}, parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 8192, maxOutputTokens: 256,
  contextCompressionThreshold: 0.8, contextCompressionEnabled: false
}
function nativeRun(model = defaultModel, providerFetch?: typeof globalThis.fetch, tools: ToolDefinition[] = []) {
  const database = new Database(':memory:')
  database.pragma('foreign_keys=ON'); database.exec(nativeExecutionSchema)
  const store = new NativeExecutionStore(database)
  const observer: RunObserver = { started: vi.fn(), startModel: vi.fn(() => 'observation'), discardModel: vi.fn(),
    model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
  const services: ConversationExecutionServices = {
    store, enter: async () => { store.start({ threadId: 'thread', runId: 'run', context: { modelCalls: 0, todos: [] },
      messages: [{ id: 'input', value: { kind: 'user', content: 'Continue' } }] }) },
    prepareModel: createConversationModelPreparation({ store, resolveModel: async () => model,
      systemPrompt: () => '', tools: () => tools, requiresTools: () => tools.length > 0, maxModelCalls: 1, providerFetch,
      outputLanguage: { code: 'en', name: 'English' }, compressionTracking: {},
      saveToolResult: async () => { throw new Error('Unexpected result save') } }),
    afterModel: async () => ({ kind: 'complete' }),
    prepareTools: vi.fn(async () => { throw new Error('Invalid response must not reach tool preflight') }),
    executeTool: vi.fn(async () => { throw new Error('Invalid response must not dispatch a sibling') }),
    directions: async () => [], drain: vi.fn(async () => {}), retry: { initialDelayMs: 0, maxRetries: 2 }
  }
  return { store, services, observer, close: () => database.close(),
    run: () => conversationExecution(services).execute('input', { threadId: 'thread', runId: 'run', signal: new AbortController().signal }, observer) }
}

describe('model retry policy', () => {
  it('only restarts preparation for configuration changes when provider retries are already owned by the adapter', async () => {
    const exhaustedProviderError = httpError(503)
    const invoke = vi.fn()
      .mockRejectedValueOnce(new ModelRequestChangedError())
      .mockRejectedValue(exhaustedProviderError)
    const onRetry = vi.fn()

    await expect(invokeModelWithRetry(invoke, {
      initialDelayMs: 0,
      retryWhen: isModelRequestChangedError,
      onRetry
    })).rejects.toBe(exhaustedProviderError)
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'configuration_changed' }))
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('re-enters native preparation after configuration changes without charging another logical model call', async () => {
    const h = nativeRun(), onRetry = vi.fn(), invoke = vi.fn()
    h.services.retry!.onRetry = onRetry
    const prepare = vi.fn(async (state: Parameters<ConversationExecutionServices['prepareModel']>[0]) => {
      if (prepare.mock.calls.length === 1) throw new ModelRequestChangedError()
      return { kind: 'model' as const, invoke: async () => {
        invoke()
        return { message: { id: 'response', value: { kind: 'assistant' as const, content: 'done' } }, calls: [],
          context: { ...state.context, modelCalls: state.context.modelCalls + 1 } }
      } }
    })
    h.services.prepareModel = prepare
    try {
      expect((await h.run()).result.status).toBe('fulfilled')
      expect(prepare).toHaveBeenCalledTimes(2)
      expect(invoke).toHaveBeenCalledOnce()
      expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ reason: 'configuration_changed' }))
      expect(h.store.load('thread')!.context.modelCalls).toBe(1)
    } finally { h.close() }
  })

  it('never retries a model-selection failure with a transient cause', async () => {
    const failure = new ModelSelectionError('Model settings could not be loaded', { cause: httpError(503) })
    const h = nativeRun(), onRetry = vi.fn()
    h.services.retry!.onRetry = onRetry
    h.services.prepareModel = vi.fn(async () => { throw failure })
    try {
      const result = await h.run()
      expect(result.result).toEqual({ status: 'rejected', reason: failure })
      expect(isModelSelectionError(failure)).toBe(true)
      expect(h.services.prepareModel).toHaveBeenCalledOnce()
      expect(onRetry).not.toHaveBeenCalled()
      expect(h.store.load('thread')!.context.modelCalls).toBe(0)
    } finally { h.close() }
  })

  it.each([true, false].flatMap(streaming => [false, true].map(structured => ({ streaming, structured }))))('rejects invalid tool responses instead of completing or executing sibling calls (streaming $streaming, structured $structured)', async ({ streaming, structured }) => {
    const reportName = 'review_report'
    let requests = 0
    const execute = vi.fn(() => 'done')
    const fetch: typeof globalThis.fetch = async () => {
        requests += 1
        if (requests > 1) throw new Error('Unexpected second model request')
        const toolCalls = [
          { index: 0, type: 'function', function: { arguments: '' } },
          { index: 1, id: 'valid-call', type: 'function', function: { name: structured ? reportName : 'test_tool', arguments: '{}' } }
        ]
        if (!streaming) return new Response(JSON.stringify({ id: 'invalid-response', object: 'chat.completion', created: 1,
          model: 'qwen-fixture', choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '好的', tool_calls: toolCalls } }] }),
          { headers: { 'content-type': 'application/json' } })
        const chunks = [
          { role: 'assistant', content: '好的' },
          { tool_calls: toolCalls }
        ].map((delta) => ({ id: 'invalid-response', object: 'chat.completion.chunk', created: 1, model: 'qwen-fixture',
          choices: [{ index: 0, delta, finish_reason: null }] }))
        return new Response([...chunks, { id: 'invalid-response', object: 'chat.completion.chunk', created: 1, model: 'qwen-fixture',
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }]
          .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
          { headers: { 'content-type': 'text/event-stream' } })
    }
    const definition = defineContentTool({ name: structured ? reportName : 'test_tool', description: 'Test', inputSchema: z.object({}), execute })
    const h = nativeRun({ ...defaultModel, stream: streaming }, fetch, [definition])
    try {
      const result = await h.run()
      expect(result.result.status).toBe('rejected')
      if (result.result.status === 'rejected') expect(String(result.result.reason)).toContain('invalid tool call')
      expect(execute).not.toHaveBeenCalled()
      expect(h.services.prepareTools).not.toHaveBeenCalled()
      expect(h.services.executeTool).not.toHaveBeenCalled()
      expect(h.store.load('thread')!.messages.map(message => message.id)).toEqual(['input'])
      expect(requests).toBe(1)
    } finally { h.close() }
  })

  it('never retries a terminal rule error even when its detail resembles a transient failure', () => {
    const error = new Error('Middleware failed', { cause: Object.assign(new ProjectRulesError('timeout while reading rules'), { status: 503 }) })
    expect(classifyModelRetryError(error)).toEqual({ retry: false })
  })
  it.each([
    [httpError(400, 'Invalid request schema'), false, undefined],
    [httpError(401, 'Authentication failed'), false, undefined],
    [httpError(404), false, undefined],
    [httpError(429, 'Exceeded your current quota'), false, undefined],
    [Object.assign(httpError(429, 'Rate limit'), { error: { code: 'insufficient_quota' } }), false, undefined],
    [httpError(501), false, undefined],
    [Object.assign(new Error('Context length exceeded'), { status: 503 }), false, undefined],
    [Object.assign(new Error('Cancelled'), { name: 'AbortError' }), false, undefined],
    [httpError(408), true, 'timeout'],
    [httpError(429, 'Rate limit exceeded'), true, 'rate_limit'],
    [httpError(503), true, 'server'],
    [Object.assign(new Error('socket reset'), { code: 'ECONNRESET' }), true, 'network'],
    [Object.assign(new Error('request timed out'), { name: 'TimeoutError' }), true, 'timeout'],
    [new TypeError('fetch failed'), true, 'network']
  ] as const)('classifies %# without retrying deterministic failures', (error, retry, reason) => {
    expect(classifyModelRetryError(error)).toMatchObject({ retry, ...(reason ? { reason } : {}) })
  })

  it.each([400, 401, 403, 404, 413, 422])('stops rejected requests without retrying (HTTP %s)', async (status) => {
    const error = httpError(status, 'Invalid request body')
    const invoke = vi.fn().mockRejectedValue(error)

    await expect(invokeModelWithRetry(invoke, { initialDelayMs: 1 })).rejects.toMatchObject({
      name: 'ModelSelectionError',
      code: 'MODEL_SELECTION_INVALID',
      message: expect.stringContaining(`HTTP ${status}`),
      cause: error
    })
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('retries transient failures to the configured limit with exponential backoff', async () => {
    const invoke = vi.fn()
      .mockRejectedValueOnce(httpError(503))
      .mockRejectedValueOnce(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))
      .mockResolvedValue('ok')
    const onRetry = vi.fn()

    await expect(invokeModelWithRetry(invoke, {
      initialDelayMs: 1,
      maxRetries: 2,
      onRetry
    })).resolves.toBe('ok')
    expect(invoke).toHaveBeenCalledTimes(3)
    expect(onRetry).toHaveBeenNthCalledWith(1, expect.objectContaining({
      attempt: 1,
      delayMs: 1,
      maxAttempts: 3,
      reason: 'server'
    }))
    expect(onRetry).toHaveBeenNthCalledWith(2, expect.objectContaining({
      attempt: 2,
      delayMs: 2,
      reason: 'network'
    }))
  })

  it('stops after the configured transient retry limit', async () => {
    const error = httpError(503)
    const invoke = vi.fn().mockRejectedValue(error)

    await expect(invokeModelWithRetry(invoke, {
      initialDelayMs: 0,
      maxRetries: 2
    })).rejects.toBe(error)
    expect(invoke).toHaveBeenCalledTimes(3)
  })

  it('does not start a provider attempt when already cancelled', async () => {
    const controller = new AbortController()
    const reason = new DOMException('Cancelled before the request.', 'AbortError')
    controller.abort(reason)
    const invoke = vi.fn()

    await expect(invokeModelWithRetry(invoke, { signal: controller.signal })).rejects.toBe(reason)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('cancels an active backoff without starting another provider attempt', async () => {
    const controller = new AbortController()
    let retryStarted!: () => void
    const retrying = new Promise<void>((resolveRetry) => {
      retryStarted = resolveRetry
    })
    const invoke = vi.fn().mockRejectedValue(httpError(503))
    const operation = invokeModelWithRetry(invoke, {
      initialDelayMs: 60_000,
      onRetry: retryStarted,
      signal: controller.signal
    })

    await retrying
    const reason = new DOMException('Cancelled by the user.', 'AbortError')
    controller.abort(reason)
    await expect(operation).rejects.toBe(reason)
    expect(invoke).toHaveBeenCalledTimes(1)
  })

  it('counts one logical model call while observing every provider attempt', async () => {
    let requests = 0
    const server = createServer((_request, response) => {
      requests += 1
      response.setHeader('content-type', 'application/json')
      if (requests < 3) {
        response.statusCode = 503
        response.end(JSON.stringify({
          error: { message: 'Temporary provider failure.', type: 'server_error', code: 'server_error' }
        }))
        return
      }
      response.end(JSON.stringify({
        id: 'chatcmpl-retry-test',
        object: 'chat.completion',
        created: 1,
        model: 'retry-test',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'completed' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }))
    })
    await new Promise<void>((resolveListen, rejectListen) => {
      server.once('error', rejectListen)
      server.listen(0, '127.0.0.1', resolveListen)
    })
    const address = server.address() as AddressInfo
    const config: ResolvedModelConfig = {
      id: 'retry-test',
      displayName: '',
      providerId: 'provider-retry',
      providerName: 'Retry Test',
      protocol: 'openai_chat_completions',
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      model: 'retry-test',
      apiKey: 'test-key',
      parameters: {},
      parameterPresetMode: 'none',
      capabilities: { vision: false, toolUse: false },
      stream: false,
      maxContextTokens: 8_192,
      maxOutputTokens: 256,
      contextCompressionThreshold: 0.8,
      contextCompressionEnabled: false
    }

    try {
      runtimeLoggerMocks.runtimeLog.mockClear()
      const h = nativeRun(config)
      try {
        expect((await h.run()).result.status).toBe('fulfilled')
        expect(requests).toBe(3)
        expect(h.store.load('thread')!).toMatchObject({ phase: 'completed', context: { modelCalls: 1 } })
        expect(h.store.load('thread')!.messages).toHaveLength(2)
        expect(runtimeLoggerMocks.runtimeLog.mock.calls.filter((call) => call[2] === 'Provider request started.')).toHaveLength(3)
      } finally { h.close() }
    } finally {
      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose())
      })
    }
  })
})
