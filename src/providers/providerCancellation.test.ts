import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { OpenAiChatCompletions } from './openAiChatCompletions'
import { OpenAiResponses } from './openAiResponses'
import { AnthropicMessages } from './anthropicMessages'
import { IncompleteModelResponseError } from '../runtime/errors'

describe('provider HTTP cancellation', () => {
  it.each(['responses', 'chat'] as const)('rejects a truncated %s stream even when the HTTP response ended cleanly', async protocol => {
    const data = protocol === 'responses'
      ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Partial"}\n\n'
      : 'data: {"id":"chat_1","choices":[{"index":0,"delta":{"content":"Partial"}}]}\n\n'
    const options = { apiKey: 'fixture', fetch: async () => new Response(data + 'data: [DONE]\n\n', {
      headers: { 'content-type': 'text/event-stream' }
    }) }
    const stream = protocol === 'responses'
      ? new OpenAiResponses(options).stream({ model: 'fixture', input: [] })
      : new OpenAiChatCompletions(options).stream({ model: 'fixture', messages: [] })
    expect((await stream.next()).done).toBe(false)
    await expect(stream.next()).rejects.toBeInstanceOf(IncompleteModelResponseError)
  })

  it.each(['responses', 'chat', 'anthropic'] as const)('closes an in-flight %s response without another request', async protocol => {
    let requests = 0
    let closed = false
    const server = createServer((_request, response) => {
      requests += 1
      response.once('close', () => { closed = true })
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(protocol === 'responses'
        ? 'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n'
        : protocol === 'anthropic' ? 'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n'
        : 'data: {"id":"chat_1","choices":[{"index":0,"delta":{"content":"Hello"}}]}\n\n')
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const controller = new AbortController()
    const options = { apiKey: 'fixture', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1` }
    const source = protocol === 'responses'
      ? new OpenAiResponses(options).stream({ model: 'fixture', input: [] }, { signal: controller.signal })
      : protocol === 'anthropic'
      ? await new AnthropicMessages(options).openStream({ model: 'fixture', messages: [], max_tokens: 1024 }, { signal: controller.signal })
      : new OpenAiChatCompletions(options).stream({ model: 'fixture', messages: [] }, { signal: controller.signal })
    const stream = source[Symbol.asyncIterator]()
    try {
      expect((await stream.next()).done).toBe(false)
      controller.abort(new Error('User cancelled'))
      await expect(stream.next()).rejects.toBeInstanceOf(Error)
      await expect.poll(() => closed).toBe(true)
      expect(requests).toBe(1)
    } finally {
      controller.abort()
      await stream.return?.(undefined).catch(() => undefined)
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})
