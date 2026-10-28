import { describe, expect, it, vi } from 'vitest'
import { AnthropicMessages } from './anthropicMessages'
import { IncompleteModelResponseError, isModelContextOverflow } from '../runtime/errors'

const message = {
  id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'tool_use', stop_sequence: null,
  content: [
    { type: 'thinking', thinking: 'Plan', signature: 'opaque-signature' },
    { type: 'redacted_thinking', data: 'opaque-data' },
    { type: 'tool_use', id: 'tool_1', name: 'read_file', input: { path: 'a.txt' } }
  ],
  usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 4 }
}
const request = { model: 'fixture', max_tokens: 1024, messages: [{ role: 'user' as const, content: 'Hello' }] }
const events = [
  { type: 'message_start', message: { ...message, content: [] } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'opaque-signature' } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 0 } },
  { type: 'message_stop' }
]
const sse = (values: typeof events) => values.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')

describe('native Anthropic Messages transport', () => {
  it.each([false, true])('preserves request, beta headers, reasoning, tools and zero usage (beta=%s)', async beta => {
    const requests: { url: string; body: unknown; headers: Headers }[] = []
    const provider = new AnthropicMessages({ apiKey: 'fixture-key', baseURL: 'https://fixture.invalid/v1',
      fetch: async (url, init) => {
        requests.push({ url: String(url), body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) })
        return Response.json(message)
      } })
    const input = { ...request, temperature: 0, stop_sequences: [], metadata: { user_id: '' },
      ...(beta ? { betas: ['interleaved-thinking-2025-05-14'] } : {}) }
    expect(await provider.complete(input, { headers: { 'x-request-id': 'fixture-id' } })).toEqual(message)
    expect(requests[0].body).toEqual({ ...request, temperature: 0, stop_sequences: [], metadata: { user_id: '' }, stream: false })
    expect(requests[0].url).toContain('/v1/messages')
    expect(requests[0].headers.get('x-api-key')).toBe('fixture-key')
    expect(requests[0].headers.get('x-request-id')).toBe('fixture-id')
    expect(requests[0].headers.get('anthropic-beta')).toBe(beta ? 'interleaved-thinking-2025-05-14' : null)
  })

  it.each([false, true])('preserves native streaming events (beta=%s)', async beta => {
    const provider = new AnthropicMessages({ apiKey: 'fixture', fetch: async () => new Response(sse(events), {
      headers: { 'content-type': 'text/event-stream' }
    }) })
    const stream = await provider.openStream({ ...request, ...(beta ? { betas: ['interleaved-thinking-2025-05-14'] } : {}) })
    const received = []
    for await (const event of stream) received.push(event)
    expect(received).toEqual(events)
    expect(stream.controller.signal.aborted).toBe(true)
  })

  it.each(['complete', 'openStream'] as const)('keeps raw errors and disables SDK retries for %s', async method => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { type: 'overloaded_error', message: 'Unavailable' } }, { status: 529 }))
    const provider = new AnthropicMessages({ apiKey: 'fixture', fetch, maxRetries: 4 })
    await expect(provider[method](request, { maxRetries: 4 })).rejects.toMatchObject({ status: 529 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not open a request after cancellation', async () => {
    const controller = new AbortController()
    const reason = new Error('Cancelled')
    controller.abort(reason)
    const fetch = vi.fn<typeof globalThis.fetch>()
    const provider = new AnthropicMessages({ apiKey: 'fixture', fetch })
    for (const method of ['complete', 'openStream'] as const) {
      await expect(provider[method](request, { signal: controller.signal })).rejects.toBe(reason)
    }
    expect(fetch).not.toHaveBeenCalled()
  })

  it('rejects clean EOF without message_stop', async () => {
    const provider = new AnthropicMessages({ apiKey: 'fixture', fetch: async () => new Response(sse(events.slice(0, -1)), {
      headers: { 'content-type': 'text/event-stream' }
    }) })
    const stream = await provider.openStream(request)
    await expect((async () => { for await (const _event of stream) { /* drain */ } })()).rejects.toBeInstanceOf(IncompleteModelResponseError)
    expect(stream.controller.signal.aborted).toBe(true)
  })

  it('releases the response on early consumer return', async () => {
    const cancel = vi.fn()
    const provider = new AnthropicMessages({ apiKey: 'fixture', fetch: async () => new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode(sse(events.slice(0, 1)))) }, cancel
    }), { headers: { 'content-type': 'text/event-stream' } }) })
    for await (const event of await provider.openStream(request)) {
      expect(event.type).toBe('message_start')
      break
    }
    expect(cancel).toHaveBeenCalledOnce()
  })
})

describe('native context overflow classification', () => {
  it.each([
    { error: { code: 'context_length_exceeded' } },
    { message: 'Input tokens exceed the configured limit' },
    { cause: { message: 'The request exceeds the context window' } },
    { message: 'maximum context length is 1000 tokens' },
    { status: 400, message: 'prompt is too long: 2000 tokens > 1000 maximum' }
  ])('recognizes native capacity errors through nested causes: %j', error => {
    expect(isModelContextOverflow(new Error('Provider rejected request', { cause: error }))).toBe(true)
  })

  it('rejects unrelated errors and terminates cyclic causes', () => {
    const error: Record<string, unknown> = { status: 503, message: 'prompt is too long' }
    error.cause = error
    expect(isModelContextOverflow(error)).toBe(false)
    expect(isModelContextOverflow({ status: 400, message: 'Invalid tool input' })).toBe(false)
    expect(isModelContextOverflow(undefined)).toBe(false)
  })
})
