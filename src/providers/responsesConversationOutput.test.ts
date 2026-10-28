import { describe, expect, it } from 'vitest'
import { encodeConversationMessage, decodeConversationMessage } from '../runtime/conversationStorage'
import { OpenAiResponses } from './openAiResponses'
import { openAiResponsesConversationResponse } from './conversationOutput'
import { streamResponsesConversation } from './conversationStream'
import { conversationResponsesInput, conversationContentBlocks } from './conversationInput'
import type { NativeResponse, NativeResponseEvent } from './openAiResponsesOutput'

const output = [
  { type: 'reasoning', id: 'rs', encrypted_content: 'signed', summary: [{ type: 'summary_text', text: 'Plan' }] },
  { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Do it', annotations: [] }] },
  { type: 'function_call', id: 'fc', call_id: 'call_f', name: 'read_file', arguments: '{"path":"a"}', status: 'completed' },
  { type: 'custom_tool_call', id: 'ct', call_id: 'call_c', name: 'apply_patch', input: 'patch\ntext', status: 'completed' },
  { type: 'computer_call', id: 'pc', call_id: 'call_p', action: { type: 'click', x: 1, y: 2, button: 'left' }, pending_safety_checks: [], status: 'completed' },
  { type: 'web_search_call', id: 'ws', status: 'completed', action: { type: 'search', query: 'q' } }
]
const response = { id: 'resp', object: 'response', model: 'fixture', status: 'completed', output } as NativeResponse
async function* frames(items: unknown[] = [{ type: 'response.completed', response }]): AsyncGenerator<NativeResponseEvent> {
  for (const item of items) yield item as NativeResponseEvent
}


describe('native Responses persistence', () => {
  it.each([false, true])('uses the SDK complete and streaming path without losing tool identity (stream=%s)', async streaming => {
    const provider = new OpenAiResponses({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1', fetch: async () => streaming
      ? new Response('event: response.completed\ndata: ' + JSON.stringify({ type: 'response.completed', response, sequence_number: 0 }) + '\n\n',
        { headers: { 'content-type': 'text/event-stream' } }) : Response.json(response) })
    const request = { model: 'fixture', input: 'Go' }
    const result = streaming ? await streamResponsesConversation(provider.stream(request), () => {})
      : openAiResponsesConversationResponse(await provider.complete(request))
    expect(result.message.calls).toMatchObject([
      { id: 'call_f', name: 'read_file', args: { path: 'a' } },
      { id: 'call_c', name: 'apply_patch', kind: 'custom', args: { input: 'patch\ntext' } },
      { id: 'call_p', name: 'computer_use', kind: 'computer', args: { action: output[4].action } }
    ])
    expect(result.message.source?.metadata.output).toEqual(output)
    expect(result.message.usage).toBeUndefined()
  })

  it.each(['complete', 'stream'] as const)('saves and replays native reasoning, function, custom and computer calls (%s)', async mode => {
    const result = mode === 'complete' ? openAiResponsesConversationResponse(response) : await streamResponsesConversation(frames(), () => {})
    const restored = decodeConversationMessage(encodeConversationMessage(result.message))
    expect(restored.source?.metadata).toMatchObject({ output })
    expect(conversationContentBlocks(restored).filter(block => block.type === 'tool_call')).toMatchObject([
      { id: 'call_f', name: 'read_file', args: { path: 'a' } },
      { id: 'call_c', name: 'apply_patch', args: { input: 'patch\ntext' } },
      { id: 'call_p', name: 'computer_use', args: { action: output[4].action } }
    ])
    const replay = conversationResponsesInput([{ kind: 'user', content: 'Go' }, restored,
      { kind: 'tool', resultFor: 'call_c', content: 'Applied' }], { model: 'fixture', zeroRetention: false })
    expect(replay).toEqual(expect.arrayContaining([...output, { type: 'custom_tool_call_output', call_id: 'call_c', output: 'Applied' }]))
  })

  it('streams the first delta and final suffix once', async () => {
    let visible = ''
    const result = await streamResponsesConversation(frames([
      { type: 'response.created', response: { ...response, output: [], status: 'in_progress' } },
      { type: 'response.output_text.delta', item_id: 'msg', output_index: 1, content_index: 0, delta: 'Do ' },
      { type: 'response.completed', response }
    ]), event => { if (event.kind === 'delta' && event.channel === 'text') visible += event.text })
    expect(visible).toBe('Do it'); expect(result.text).toBe('Do it')
  })

  it('releases the source iterator on provider failure', async () => {
    let closed = false
    async function* failing(): AsyncGenerator<NativeResponseEvent> {
      try { yield { type: 'response.failed', response: { ...response, status: 'failed', error: { code: 'server_error', message: 'Failed' } }, sequence_number: 1 } }
      finally { closed = true }
    }
    await expect(streamResponsesConversation(failing(), () => {})).rejects.toThrow('Failed')
    expect(closed).toBe(true)
  })

  it('retains SDK structured parsing and refusals without inventing usage', () => {
    const { message } = openAiResponsesConversationResponse({ ...response, output: [{ type: 'message', id: 'm', role: 'assistant', status: 'completed', content: [
      { type: 'output_text', text: '{"ok":true}', annotations: [], parsed: { ok: true } }, { type: 'refusal', refusal: 'No' }
    ] }] } as unknown as NativeResponse)
    expect(message.source?.extras).toMatchObject({ parsed: { ok: true }, refusal: 'No' })
    expect(message.usage).toBeUndefined()
  })
})
