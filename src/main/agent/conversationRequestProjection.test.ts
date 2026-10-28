import { describe, expect, it, vi } from 'vitest'
import type { ResolvedModelConfig } from '@shared/types'
import { createConversationModel } from './conversationModel'
import { projectConversationInput } from './conversationContext'
import { conversationChatInput } from '../../providers/conversationInput'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

const config: ResolvedModelConfig = {
  id: 'fixture', displayName: '', providerId: 'fixture', providerName: 'Fixture', protocol: 'anthropic_messages',
  baseUrl: 'https://fixture.invalid', model: 'fixture', apiKey: 'fixture', parameters: {}, parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true }, stream: true, maxContextTokens: 128000, maxOutputTokens: 16000,
  contextCompressionThreshold: 0.8, contextCompressionEnabled: true
}

function response(stream: boolean, invalid = false) {
  const message = { type: 'message', id: 'fixture', model: 'fixture', role: 'assistant', stop_reason: invalid ? 'tool_use' : 'end_turn',
    stop_sequence: null, content: invalid ? [
      { type: 'tool_use' as const, id: 'bad', name: 'read', input: '{' },
      { type: 'tool_use' as const, id: 'valid', name: 'read', input: {} }
    ] : [{ type: 'text' as const, text: 'done' }], usage: { input_tokens: 2, output_tokens: 1 } }
  if (!stream) return Response.json(message)
  const events = [
    { type: 'message_start', message: { ...message, content: [], stop_reason: null, usage: { input_tokens: 2, output_tokens: 0 } } },
    ...message.content.flatMap((block, index) => [
      { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : { ...block, text: '' } },
      { type: 'content_block_delta', index, delta: block.type === 'tool_use'
        ? { type: 'input_json_delta', partial_json: typeof block.input === 'string' ? block.input : JSON.stringify(block.input) }
        : { type: 'text_delta', text: block.text } },
      { type: 'content_block_stop', index }
    ]),
    { type: 'message_delta', delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' }
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } })
}



describe('Chat Completions request integration', () => {
  it('does not replay an uploaded user audio ID as an assistant output reference', () => {
    const message = { kind: 'user' as const, content: [{ type: 'audio', id: 'user-upload', data: 'AA==', mimeType: 'audio/wav' }], source: { contentFormat: 'portable' as const, metadata: {}, extras: {} } }
    expect(conversationChatInput([message])).toEqual([
      { role: 'user', content: [{ type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } }] }
    ])
  })
  it.each([false, true])('sends the same multimodal history used by estimation (streaming %s)', async streaming => {
    const requests: Record<string, unknown>[] = []
    const model = createConversationModel({ ...config, protocol: 'openai_chat_completions', stream: streaming }, { providerFetch: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)))
        const base = { id: 'response', model: 'fixture', created: 1 }
        if (!streaming) return Response.json({ ...base, object: 'chat.completion', choices: [
          { index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }
        ] })
        return new Response(`data: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [
          { index: 0, finish_reason: null, delta: { role: 'assistant', content: 'done' } }
        ] })}\n\ndata: ${JSON.stringify({ ...base, object: 'chat.completion.chunk', choices: [
          { index: 0, finish_reason: 'stop', delta: {} }
        ] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } })
      } })
    const history = [{ kind: 'system' as const, content: 'rules'},
      { kind: 'user' as const, content: [
      { type: 'text', text: 'inspect' },
      { type: 'file', source_type: 'base64', data: 'AA==', mime_type: 'application/pdf', metadata: { filename: 'report.pdf' } }
    ]},
      { kind: 'assistant' as const, content: '', calls: [{ id: 'call-image', name: 'image', args: {} }]},
      { kind: 'tool' as const, content: [
      { type: 'text', text: 'picture' }, { type: 'image', source_type: 'base64', data: 'BB==', mime_type: 'image/png' }
    ], resultFor: 'call-image'} ]
    const before = structuredClone(history)
    const result = await model.invoke({ messages: history, tools: [], signal: new AbortController().signal })
    expect(result.text).toBe('done')
    expect(requests).toHaveLength(1)
    const projected = projectConversationInput(history, 'openai_chat_completions').messages
    expect(requests[0].messages).toEqual(projected)
    expect(projected).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'user', content: expect.arrayContaining([
        { type: 'file', file: { file_data: 'data:application/pdf;base64,AA==', filename: 'report.pdf' } }
      ]) }),
      expect.objectContaining({ role: 'tool', tool_call_id: 'call-image' }),
      expect.objectContaining({ role: 'user', content: expect.arrayContaining([
        { type: 'image_url', image_url: { url: 'data:image/png;base64,BB==' } }
      ]) })
    ]))
    expect(history).toEqual(before)
  })

  it('projects portable history without leaking provider reasoning or dropping tool identity', () => {
    const messages = [{ kind: 'system' as const, content: [{ type: 'text', text: 'rules' }], source: { contentFormat: 'portable' as const, metadata: {}, extras: {} } },
      { kind: 'assistant' as const, content: [{ type: 'reasoning', reasoning: 'private provider payload' }, { type: 'text', text: 'working' }], calls: [{ id: 'lookup', name: 'find', args: { text: '查询' } }], source: { contentFormat: 'portable' as const, metadata: { output: [{ encrypted_content: 'opaque' }]}, extras: {} } },
      { kind: 'tool' as const, content: 'done', resultFor: 'lookup', source: { contentFormat: 'portable' as const, metadata: {}, extras: {} } }
    ]
    const result = conversationChatInput(messages, 'gpt-5')
    expect(result).toEqual([
      { role: 'developer', content: [{ type: 'text', text: 'rules' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'working' }], tool_calls: [
        { type: 'function', id: 'lookup', function: { name: 'find', arguments: '{"text":"查询"}' } }
      ] },
      { role: 'tool', tool_call_id: 'lookup', content: [{ type: 'text', text: 'done' }] }
    ])
    expect(conversationChatInput([{ kind: 'custom' as const, content: 'custom provider role', role: 'critic'} ]))
      .toEqual([{ role: 'critic', content: 'custom provider role' }])
  })
})

describe('Anthropic conversation request integration', () => {
  it('preserves tool schema, cache hints, strict false and configured output format', async () => {
    const bodies: Record<string, unknown>[] = []
    const format = { type: 'json_schema', schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false } }
    const model = createConversationModel({ ...config, parameters: { output_config: { format } } }, { streaming: false, providerFetch: async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)))
      return Response.json({ id: 'structured', type: 'message', role: 'assistant', model: 'fixture',
        content: [{ type: 'text', text: '{"answer":"done"}' }], stop_reason: 'end_turn', usage: { input_tokens: 2, output_tokens: 1 } })
    } })
    const schema = { type: 'object', properties: { query: { type: 'string' } }, oneOf: [{ required: ['query'] }], additionalProperties: false }
    const result = await model.invoke({ messages: [{ kind: 'user', content: 'answer' }], signal: new AbortController().signal,
      tools: [{ name: 'read', description: '', inputSchema: schema, extras: { strict: false, cache_control: { type: 'ephemeral' }, defer_loading: false } }] })
    expect(result.text).toBe('{"answer":"done"}')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatchObject({ output_config: { format }, tools: [
      { name: 'read', input_schema: schema, strict: false, cache_control: { type: 'ephemeral' }, defer_loading: false }
    ] })
  })
  it.each([false, true])('uses the estimated multimodal history (streaming %s)', async streaming => {
    const requests: Record<string, unknown>[] = []
    const model = createConversationModel(config, { streaming, providerFetch: async (_url, init) => {
      const request = JSON.parse(String(init?.body))
      requests.push(request)
      return response(request.stream)
    } })
    const history = [{ kind: 'system' as const, content: [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }]},
      { kind: 'user' as const, content: [{ type: 'text', text: 'inspect' },
        { type: 'file', source_type: 'base64', data: 'AA==', mime_type: 'application/pdf' }]},
      { kind: 'assistant' as const, content: '', calls: [{ id: 'image', name: 'read', args: { limit: 0 } }]},
      { kind: 'tool' as const, content: 'unavailable', resultFor: 'image', resultStatus: 'error' as const} ]
    const before = structuredClone(history)
    expect((await model.invoke({ messages: history, tools: [], signal: new AbortController().signal })).text).toBe('done')
    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject(projectConversationInput(history, 'anthropic_messages'))
    expect(requests[0].messages).toEqual(expect.arrayContaining([
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'image', content: 'unavailable', is_error: true }] }
    ]))
    expect(history).toEqual(before)
  })

})

describe('Anthropic tool argument boundary', () => {
  it.each([false, true])('retains literal JSON values but rejects malformed stream encoding (streaming %s)', async streaming => {
    const providerFetch = vi.fn(async () => response(streaming, true))
    const model = createConversationModel(config, { streaming, providerFetch })
    const request = { messages: [{ kind: 'user' as const, content: 'read' }], tools: [], signal: new AbortController().signal }
    if (streaming) await expect(model.invoke(request)).rejects.toThrow('Anthropic returned malformed tool input JSON')
    else expect((await model.invoke(request)).message.calls).toEqual([
      expect.objectContaining({ id: 'bad', name: 'read', args: '{' }),
      expect.objectContaining({ id: 'valid', name: 'read', args: {} })
    ])
    expect(providerFetch).toHaveBeenCalledOnce()
  })
})
