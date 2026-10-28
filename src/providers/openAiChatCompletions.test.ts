import { describe, expect, it, vi } from 'vitest'
import { OpenAiChatCompletions } from './openAiChatCompletions'

const completion = {
  id: 'chat_fixture', object: 'chat.completion', created: 1, model: 'fixture',
  choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', reasoning_content: 'Inspect first',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"path":"a"}' } }] } }],
  usage: { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10,
    prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 0 } }
}

describe('native Chat Completions transport', () => {
  it('retains compatible-provider fields, tool calls and exact usage', async () => {
    let sent: unknown
    const provider = new OpenAiChatCompletions({ apiKey: 'fixture', fetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body))
      return Response.json(completion)
    } })
    const request = { model: 'fixture', messages: [{ role: 'user' as const, content: 'Inspect a' }],
      temperature: 0, top_p: null, stop: [], parallel_tool_calls: false }
    expect(await provider.complete(request)).toMatchObject(completion)
    expect(sent).toEqual({ ...request, stream: false })
  })

  it('passes tool argument fragments and a usage-only terminal chunk through unchanged', async () => {
    const chunks = [
      { id: 'chat_1', choices: [{ index: 0, delta: { reasoning_content: 'Think', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{' } }] } }] },
      { id: 'chat_1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '}' } }] }, finish_reason: 'tool_calls' }] },
      { id: 'chat_1', choices: [], usage: completion.usage }
    ]
    const provider = new OpenAiChatCompletions({ apiKey: 'fixture', fetch: async () => new Response(
      chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n',
      { headers: { 'content-type': 'text/event-stream' } }
    ) })
    const received = []
    for await (const chunk of provider.stream({ model: 'fixture', messages: [] })) received.push(chunk)
    expect(received).toEqual(chunks)
  })

  it('parses structured output without changing the provider response', async () => {
    const provider = new OpenAiChatCompletions({ apiKey: 'fixture', fetch: async () => Response.json({ ...completion,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '{"ok":true}', refusal: null } }] }) })
    const result = await provider.complete({ model: 'fixture', messages: [], response_format: { type: 'json_schema',
      json_schema: { name: 'result', strict: true, schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false } }
    } })
    expect(result.choices[0].message).toMatchObject({ content: '{"ok":true}', parsed: { ok: true } })
  })

  it('sends one request on transient failure regardless of SDK retry options', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { message: 'Unavailable' } }, { status: 503 }))
    const provider = new OpenAiChatCompletions({ apiKey: 'fixture', maxRetries: 4, fetch })
    await expect(provider.complete({ model: 'fixture', messages: [] }, { maxRetries: 4 })).rejects.toMatchObject({ status: 503 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('honors cancellation before either request mode', async () => {
    const controller = new AbortController()
    const reason = new Error('Cancelled')
    controller.abort(reason)
    const fetch = vi.fn<typeof globalThis.fetch>()
    const provider = new OpenAiChatCompletions({ apiKey: 'fixture', fetch })
    await expect(provider.complete({ model: 'fixture', messages: [] }, { signal: controller.signal })).rejects.toBe(reason)
    await expect(provider.stream({ model: 'fixture', messages: [] }, { signal: controller.signal }).next()).rejects.toBe(reason)
    expect(fetch).not.toHaveBeenCalled()
  })
})
