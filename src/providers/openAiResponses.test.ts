import { describe, expect, it, vi } from 'vitest'
import { OpenAiResponses } from './openAiResponses'

const completed = {
  id: 'resp_fixture', object: 'response', created_at: 1, model: 'fixture', status: 'completed',
  output: [
    { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] },
    { type: 'custom_tool_call', id: 'ct_1', call_id: 'call_1', name: 'apply_patch', input: '*** Begin Patch\n*** End Patch', status: 'completed' },
    { type: 'image_generation_call', id: 'img_1', result: 'image-bytes', status: 'completed' }
  ], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 }
}

describe('native OpenAI Responses transport', () => {
  it('preserves native request and response data without framework messages', async () => {
    let sent: unknown
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => {
      sent = JSON.parse(String(init?.body))
      return Response.json(completed)
    })
    const provider = new OpenAiResponses({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1', fetch })
    const request = { model: 'fixture', input: [], temperature: 0, top_p: null, instructions: '', store: false,
      tools: [{ type: 'image_generation' as const }], include: ['reasoning.encrypted_content' as const] }
    expect(await provider.complete(request)).toMatchObject(completed)
    expect(sent).toEqual({ ...request, stream: false })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('keeps structured-output parsing in non-streaming calls', async () => {
    const provider = new OpenAiResponses({ apiKey: 'fixture', fetch: async () => Response.json({ ...completed,
      output: [{ id: 'msg_1', type: 'message', role: 'assistant', status: 'completed',
        content: [{ type: 'output_text', text: '{"ok":true}', annotations: [] }] }] }) })
    const result = await provider.complete({ model: 'fixture', input: [], text: { format: {
      type: 'json_schema', name: 'result', strict: true,
      schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
    } } })
    expect(result).toMatchObject({ output_parsed: { ok: true }, output_text: '{"ok":true}' })
  })

  it('forwards reasoning, custom calls, images and incomplete terminal frames without dropping provider fields', async () => {
    const events = [
      { type: 'response.reasoning_text.delta', output_index: 0, content_index: 0, item_id: 'rs_1', delta: 'Think', sequence_number: 0 },
      { type: 'response.custom_tool_call_input.delta', output_index: 1, item_id: 'ct_1', delta: 'patch', sequence_number: 1 },
      { type: 'response.incomplete', sequence_number: 2, response: { ...completed, status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } }
    ]
    const provider = new OpenAiResponses({ apiKey: 'fixture', fetch: async () => new Response(
      events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
      { headers: { 'content-type': 'text/event-stream' } }
    ) })
    const received = []
    for await (const event of provider.stream({ model: 'fixture', input: [] })) received.push(event)
    expect(received).toEqual(events)
  })

  it('does not add SDK retries on top of the runtime policy', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => Response.json({ error: { message: 'Unavailable' } }, { status: 503 }))
    const provider = new OpenAiResponses({ apiKey: 'fixture', maxRetries: 4, fetch })
    await expect(provider.complete({ model: 'fixture', input: [] }, { maxRetries: 4 })).rejects.toMatchObject({ status: 503 })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('does not send a request after cancellation', async () => {
    const controller = new AbortController()
    const reason = new Error('Cancelled')
    controller.abort(reason)
    const fetch = vi.fn<typeof globalThis.fetch>()
    const provider = new OpenAiResponses({ apiKey: 'fixture', fetch })
    await expect(provider.complete({ model: 'fixture', input: [] }, { signal: controller.signal })).rejects.toBe(reason)
    await expect(provider.stream({ model: 'fixture', input: [] }, { signal: controller.signal }).next()).rejects.toBe(reason)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('releases a response body when the consumer stops reading', async () => {
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Hello"}\n\n'))
      }, cancel
    })
    const provider = new OpenAiResponses({ apiKey: 'fixture', fetch: async () => new Response(body,
      { headers: { 'content-type': 'text/event-stream' } }) })
    for await (const event of provider.stream({ model: 'fixture', input: [] })) {
      expect(event).toMatchObject({ delta: 'Hello' })
      break
    }
    expect(cancel).toHaveBeenCalledOnce()
  })
})
