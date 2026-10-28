import { describe, expect, it, vi } from 'vitest'
import type { ModelProtocol, ResolvedModelConfig } from '@shared/types'
import { createConversationModel, type ConversationModel } from '../main/agent/conversationModel'
import type { ConversationMessage } from '../runtime/conversationMessage'
import { CodingModelTraceCollector } from './codingModelTrace'
import { fingerprint } from './codingEvidence'

vi.mock('../main/config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../main/runtimeLogger', () => ({ runtimeLog: vi.fn() }))
const usage = { input_tokens: 10, output_tokens: 3, total_tokens: 13 }
const config: ResolvedModelConfig = {
  id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol: 'openai_chat_completions',
  baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
  contextCompressionThreshold: 0.8, contextCompressionEnabled: true
}
const protocols: ModelProtocol[] = ['openai_chat_completions', 'openai_responses', 'anthropic_messages']
function nativeModel(protocol: ModelProtocol, withUsage = true): ConversationModel {
  const id = 'repeated-provider-id'
  const payload = protocol === 'anthropic_messages'
    ? { id, type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'done' }],
      stop_reason: 'end_turn', stop_sequence: null, ...(withUsage ? { usage } : {}) }
    : protocol === 'openai_responses'
      ? { id, object: 'response', status: 'completed', model: 'fixture', output: [{ type: 'message', id: 'message',
        role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }], ...(withUsage ? { usage } : {}) }
      : { id, object: 'chat.completion', model: 'fixture', created: 1,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }],
        ...(withUsage ? { usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } } : {}) }
  return createConversationModel({ ...config, protocol }, { providerFetch: async () => Response.json(payload) })
}
const request = (messages: ConversationMessage[] = [{ kind: 'user', content: 'read' }]) => ({
  messages, tools: [], signal: new AbortController().signal
})

describe('coding model trace', () => {
  it('keeps the first terminal observation and bounds native message evidence', () => {
    const collector = new CodingModelTraceCollector({ calls: 1, messages: 1 })
    expect(collector.beginCall('call', {}, [
      { type: 'human', content: 'older' }, { type: 'human', content: 'latest' }
    ])).toBe(true)
    expect(collector.beginCall('call', {}, [])).toBe(false)
    collector.completeCall('call', [
      { type: 'ai', content: 'first' }, { type: 'ai', content: 'second' }
    ], { input_tokens: 0, output_tokens: 3, total_tokens: 3 })
    collector.failCall('call', new Error('late failure'))
    collector.completeCall('call', [], usage)
    collector.completeCall('unknown', [], usage)
    const snapshot = collector.snapshot()
    expect(snapshot).toMatchObject({ trace: { calls: [{
      status: 'completed', inputCount: 2, outputCount: 2, messagesTruncated: true,
      inputs: [{ contentFingerprint: fingerprint('latest') }],
      outputs: [{ contentFingerprint: fingerprint('first') }],
      usage: { inputTokens: 0, outputTokens: 3, totalTokens: 3 }
    }] }, tokens: { observedCalls: 1, coverage: 'complete' } })
    expect(snapshot.trace.calls[0].inputs).toHaveLength(1)
    expect(snapshot.trace.calls[0].outputs).toHaveLength(1)
    snapshot.trace.calls[0].inputs.splice(0)
    expect(collector.snapshot().trace.calls[0].inputs).toHaveLength(1)
    expect(collector.beginCall('overflow', {}, [])).toBe(false)
    expect(collector.snapshot().tokens.coverage).toBe('partial')
  })

  it.each(protocols)('preserves the %s request, result and tool evidence through observation', async protocol => {
    const trace = new CodingModelTraceCollector()
    const underlying = nativeModel(protocol, false), invoke = vi.spyOn(underlying, 'invoke')
    const model = trace.observeModel(underlying, { requestId: 'app-run', requestRole: 'main' })
    const input = request([
      { id: 'user-1', kind: 'user', content: 'inspect file' },
      { id: 'ai-1', kind: 'assistant', content: '', calls: [{ id: 'tool-1', name: 'read_file', args: { path: 'work.txt' } }] },
      { id: 'result-1', kind: 'tool', resultFor: 'tool-1', content: 'file contents' }
    ])
    const output = await model.invoke(input)
    expect(invoke).toHaveBeenCalledOnce()
    expect(invoke.mock.calls[0][0]).toBe(input)
    expect(await invoke.mock.results[0].value).toBe(output)
    expect(trace.snapshot()).toMatchObject({ tokens: { coverage: 'unavailable', totals: null }, trace: { calls: [{
      requestId: 'app-run', role: 'main', status: 'completed', inputCount: 3,
      inputs: [
        { id: 'user-1', type: 'user', contentFingerprint: fingerprint('inspect file') },
        { id: 'ai-1', toolCalls: [{ id: 'tool-1', name: 'read_file', argsFingerprint: fingerprint({ path: 'work.txt' }) }] },
        { id: 'result-1', type: 'tool', toolResultFor: 'tool-1' }
      ]
    }] } })
    expect(JSON.stringify(trace.snapshot())).not.toContain('file contents')
  })

  it.each(protocols)('counts %s requests separately when provider message IDs repeat', async protocol => {
    const collector = new CodingModelTraceCollector()
    const model = collector.observeModel(nativeModel(protocol), { requestRole: 'main' })
    await model.invoke(request())
    await model.invoke(request())
    const { trace, tokens } = collector.snapshot()
    expect(new Set(trace.calls.map(call => call.callbackRunId)).size).toBe(2)
    expect(trace.calls.map(call => call.outputs[0].id)).toEqual(['repeated-provider-id', 'repeated-provider-id'])
    expect(tokens).toMatchObject({ coverage: 'complete', observedCalls: 2, callsWithUsage: 2,
      totals: { inputTokens: 20, outputTokens: 6, totalTokens: 26 } })
  })

  it('forwards streamed progress and records the merged response and usage once', async () => {
    const collector = new CodingModelTraceCollector()
    const header = { id: 'streamed', object: 'chat.completion.chunk', model: 'fixture', created: 1 }
    const frames = [
      { ...header, choices: [{ index: 0, finish_reason: null, delta: { role: 'assistant', content: 'first ' } }] },
      { ...header, choices: [{ index: 0, finish_reason: null, delta: { content: 'second' } }] },
      { ...header, choices: [{ index: 0, finish_reason: 'stop', delta: {} }] },
      { ...header, choices: [], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } }
    ]
    const underlying = createConversationModel({ ...config, stream: true }, { providerFetch: async () =>
      new Response(frames.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }) })
    const observe = vi.fn()
    const response = await collector.observeModel(underlying).invoke({ ...request(), observe })
    expect(response.text).toBe('first second')
    expect(observe).toHaveBeenCalled()
    expect(collector.snapshot()).toMatchObject({
      tokens: { coverage: 'complete', observedCalls: 1, totals: { totalTokens: 13 } },
      trace: { calls: [{ status: 'completed', outputCount: 1 }] }
    })
    expect(collector.snapshot().trace.calls[0].outputs[0].contentFingerprint).toBe(fingerprint(response.message.content))
  })

  it('preserves missing and failed usage as unknown and propagates the same model error', async () => {
    const collector = new CodingModelTraceCollector()
    await collector.observeModel(nativeModel('anthropic_messages')).invoke(request())
    await collector.observeModel(nativeModel('openai_chat_completions', false)).invoke(request())
    const failure = new Error('provider failed')
    await expect(collector.observeModel({ invoke: async () => { throw failure } }).invoke(request())).rejects.toBe(failure)
    expect(collector.snapshot()).toMatchObject({
      tokens: { coverage: 'partial', observedCalls: 3, callsWithUsage: 1, totals: { totalTokens: 13 } },
      trace: { calls: [{ usage: { totalTokens: 13 } }, { usage: null }, { status: 'failed', error: 'provider failed', usage: null }] }
    })
  })

  it('bounds evidence without skipping requests or reporting omitted calls as complete usage', async () => {
    const collector = new CodingModelTraceCollector({ calls: 1, messages: 1 })
    const underlying = nativeModel('anthropic_messages'), invoke = vi.spyOn(underlying, 'invoke')
    const model = collector.observeModel(underlying)
    await model.invoke(request([{ kind: 'user', content: 'first' }, { kind: 'user', content: 'last' }]))
    await model.invoke(request())
    expect(invoke).toHaveBeenCalledTimes(2)
    const snapshot = collector.snapshot()
    expect(snapshot).toMatchObject({ trace: { callsTruncated: true, calls: [{ inputCount: 2, messagesTruncated: true }] },
      tokens: { coverage: 'partial', observedCalls: 1, callsWithUsage: 1 } })
    expect(snapshot.trace.calls[0].inputs).toHaveLength(1)
    expect(snapshot.trace.calls[0].inputs[0].contentFingerprint).toBe(fingerprint('last'))
    snapshot.trace.calls[0].status = 'failed'
    expect(collector.snapshot().trace.calls[0].status).toBe('completed')
  })

  it('does not report zero usage for an unobserved sample', () => {
    expect(new CodingModelTraceCollector().snapshot().tokens).toMatchObject({ coverage: 'unavailable', observedCalls: 0, totals: null })
  })

  it('records failed native summaries and bounds their evidence without blocking later requests', async () => {
    const collector = new CodingModelTraceCollector({ calls: 2, messages: 1 })
    const failure = new Error('Summary failed')
    await collector.observeSummary({ requestRole: 'compression' }, 'private prompt', async () => ({ id: 'same', text: 'private result', usage }))
    await expect(collector.observeSummary({}, 'second', async () => { throw failure })).rejects.toBe(failure)
    const omitted = vi.fn(async () => ({ id: 'same', text: 'still executes', usage }))
    expect((await collector.observeSummary({}, 'third', omitted)).text).toBe('still executes')
    expect(omitted).toHaveBeenCalledOnce()
    expect(collector.snapshot()).toMatchObject({ trace: { callsTruncated: true, calls: [
      { status: 'completed', outputs: [{ id: 'same' }] }, { status: 'failed', error: 'Summary failed', usage: null }
    ] }, tokens: { coverage: 'partial', observedCalls: 2, callsWithUsage: 1, totals: { totalTokens: 13 } } })
    expect(JSON.stringify(collector.snapshot())).not.toContain('private')
  })
})
