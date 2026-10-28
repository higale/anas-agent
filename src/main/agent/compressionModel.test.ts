import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedModelConfig } from '@shared/types'
import { createCompressionModel, contextCompressionTimeoutMs } from './compressionModel'
import { prepareCompression } from '../../runtime/compression'
import { CodingModelTraceCollector } from '../../evaluation/codingModelTrace'
import { fingerprint } from '../../evaluation/codingEvidence'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: () => 'test-only' }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

const selected: ResolvedModelConfig = {
  id: 'summary', displayName: '', providerId: 'fixture', providerName: 'Fixture',
  model: 'test', protocol: 'openai_chat_completions', baseUrl: 'http://unused.invalid/v1',
  parameters: {}, parameterPresetMode: 'none', capabilities: { vision: false, toolUse: false },
  stream: true, maxContextTokens: 10000, maxOutputTokens: 0,
  contextCompressionEnabled: true, contextCompressionThreshold: 0.8
}
function gate() {
  let resolve!: () => void
  const promise = new Promise<void>(ready => { resolve = ready })
  return { promise, resolve }
}
const protocols = ['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const

function response(protocol: typeof protocols[number], text = 'Summary') {
  if (protocol === 'anthropic_messages') return {
    id: 'summary', type: 'message', role: 'assistant', model: 'test', stop_reason: 'end_turn', stop_sequence: null,
    content: [{ type: 'thinking', thinking: 'Private reasoning', signature: 'signature' }, { type: 'text', text }],
    usage: { input_tokens: 0, output_tokens: 3, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 }
  }
  if (protocol === 'openai_responses') return {
    id: 'summary', object: 'response', status: 'completed', model: 'test',
    output: [{ type: 'reasoning', id: 'reason', summary: [{ type: 'summary_text', text: 'Private reasoning' }] },
      { type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }],
    usage: { input_tokens: 0, output_tokens: 3, total_tokens: 3, input_tokens_details: { cached_tokens: 0 } }
  }
  return { id: 'summary', object: 'chat.completion', model: 'test', choices: [
    { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text, reasoning_content: 'Private reasoning' } }
  ], usage: { prompt_tokens: 0, completion_tokens: 3, total_tokens: 3, prompt_tokens_details: { cached_tokens: 0 } } }
}

afterEach(() => vi.useRealTimers())

describe('native compression model', () => {
  it.each(protocols)('keeps %s summary text, identity, usage and pending commit separate from graph messages', async protocol => {
    const bodies: Record<string, unknown>[] = [], trace = new CodingModelTraceCollector()
    const providerFetch: typeof fetch = async (_input, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json(response(protocol))
    }
    const completed = vi.fn(), failed = vi.fn()
    const generate = createCompressionModel({ ...selected, protocol }, { providerFetch,
      compressionTracking: { onCompressionStart: () => 'staged', onCompressionCompleted: completed, onCompressionFailed: failed },
      observe: (prompt, request) => trace.observeSummary({ requestId: 'run', requestRole: 'compression' }, prompt, request) })
    await prepareCompression({ activeUserRequest: 'Keep the task' }, async preparation => {
      const summary = await generate('Conversation', undefined, preparation)
      expect(summary).toMatchObject({ id: 'summary', text: expect.stringContaining('Summary'), usage: {
        input_tokens: protocol === 'anthropic_messages' ? 3 : 0, output_tokens: 3
      } })
      expect(summary.text).toContain('Keep the task')
      expect(summary.text).not.toContain('Private reasoning')
      expect(preparation.generated).toMatchObject([{ id: 'staged', state: 'pending', text: summary.text }])
      expect(completed).not.toHaveBeenCalled()
    })
    expect(failed).not.toHaveBeenCalled()
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ model: 'test', stream: false })
    expect(bodies[0]).not.toHaveProperty('tools')
    if (protocol === 'anthropic_messages') expect(bodies[0].max_tokens).toBe(4096)
    else expect(bodies[0]).not.toHaveProperty(protocol === 'openai_responses' ? 'max_output_tokens' : 'max_tokens')
    expect(trace.snapshot()).toMatchObject({ tokens: { coverage: 'complete', observedCalls: 1 }, trace: { calls: [{
      requestId: 'run', status: 'completed', inputs: [{ contentFingerprint: fingerprint('Conversation') }],
      outputs: [{ id: 'summary', contentFingerprint: fingerprint('Summary') }]
    }] } })
    expect(JSON.stringify(trace.snapshot())).not.toContain('Conversation')
  })

  it.each(protocols)('aborts an in-flight %s request without retrying or completing a summary', async protocol => {
    const controller = new AbortController(), entered = gate()
    const reason = new Error('User cancelled'), failed = vi.fn(), completed = vi.fn()
    const providerFetch = vi.fn<typeof fetch>(async (_input, init) => {
      entered.resolve()
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(reason), { once: true }))
    })
    const generate = createCompressionModel({ ...selected, protocol }, { providerFetch,
      compressionTracking: { onCompressionStart: () => 'cancelled', onCompressionFailed: failed, onCompressionCompleted: completed } })
    const result = generate('Conversation', controller.signal)
    const rejected = expect(result).rejects.toBe(reason)
    await entered.promise
    controller.abort(reason)
    await rejected
    expect(providerFetch).toHaveBeenCalledOnce()
    expect(failed).toHaveBeenCalledWith('cancelled')
    expect(completed).not.toHaveBeenCalled()
  })

  it.each(protocols)('applies the existing two-minute %s request timeout', async protocol => {
    vi.useFakeTimers()
    const controller = new AbortController(), entered = gate()
    const reason = new Error('Stop after observing the transport timeout'), aborted = vi.fn()
    const providerFetch = vi.fn<typeof fetch>(async (_input, init) => {
      entered.resolve()
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => {
        aborted()
        controller.abort(reason)
        reject(reason)
      }, { once: true }))
    })
    const pending = createCompressionModel({ ...selected, protocol }, { providerFetch, signal: controller.signal })('Conversation')
    const rejected = expect(pending).rejects.toBe(reason)
    await entered.promise
    await vi.advanceTimersByTimeAsync(contextCompressionTimeoutMs - 1)
    expect(aborted).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(aborted).toHaveBeenCalledOnce()
    expect(providerFetch).toHaveBeenCalledOnce()
  })
})
