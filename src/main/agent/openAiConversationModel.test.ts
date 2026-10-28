import type OpenAI from 'openai'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedModelConfig } from '@shared/types'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { createConversationModel } from './conversationModel'
import { countConversationTokens } from './conversationContext'
import { approximateContentTokens } from '../../runtime/modelInputBudget'
import { streamChatConversation } from '../../providers/conversationStream'
import { conversationContentBlocks } from '../../providers/conversationInput'
vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

const config: ResolvedModelConfig = {
  id: 'fixture', displayName: '', providerId: 'fixture', providerName: 'Fixture', protocol: 'anthropic_messages',
  baseUrl: 'https://fixture.invalid', model: 'fixture', apiKey: 'fixture', parameters: {}, parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true }, stream: true, maxContextTokens: 128000, maxOutputTokens: 16000,
  contextCompressionThreshold: 0.8, contextCompressionEnabled: true
}

async function *qwenToolCallStream(): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
  const deltas = [
    { role: 'assistant', tool_calls: [{ index: 0, id: 'call-from-qwen', type: 'function', function: { name: 'lookup', arguments: '' } }] },
    { tool_calls: [{ index: 0, function: { arguments: '{"description":' } }] },
    { tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '"inspect files"}' } }] }
  ]
  for (const [index, delta] of deltas.entries()) yield { id: 'message-1', object: 'chat.completion.chunk', created: 1, model: 'fixture',
    choices: [{ index: 0, delta, finish_reason: index === deltas.length - 1 ? 'tool_calls' : null }] } as OpenAI.Chat.ChatCompletionChunk
}

async function generateNonStreaming(message: ConversationMessage) {
  const model = createConversationModel({ ...config, protocol: 'openai_chat_completions', stream: false }, {
    providerFetch: async () => Response.json({
      id: message.id, object: 'chat.completion', created: 1, model: 'qwen-compatible-model',
      choices: [{ index: 0, finish_reason: message.calls?.length ? 'tool_calls' : 'stop', message: {
        role: 'assistant', content: message.content, reasoning_content: message.source?.extras.reasoning_content,
        tool_calls: message.calls?.map(call => ({ id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }))
      } }]
    })
  })
  return model.invoke({ messages: [{ kind: 'user', content: 'Think first.' }], tools: [], signal: new AbortController().signal })
}

describe('OpenAI native conversation model', () => {
  it.each([false, true])('retains Chat Completions reasoning, tool identity and usage for %s', async streaming => {
    const usage = { prompt_tokens: 10, completion_tokens: 0, total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 0 } }
    const complete = { id: 'chat_modes', object: 'chat.completion', created: 1, model: 'fixture', usage,
      choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Done', reasoning_content: 'Think first',
        tool_calls: [{ id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"path":"a"}' } }] } }] }
    const model = createConversationModel({ ...config, protocol: 'openai_chat_completions', stream: streaming }, { providerFetch: async (_url, init) => {
        if (!JSON.parse(String(init?.body)).stream) return Response.json(complete)
        const chunks = [
          { choices: [{ index: 0, delta: { role: 'assistant', reasoning_content: 'Think ' }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { content: 'Done', reasoning_content: 'first', tool_calls: [
            { index: 0, id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"path":' } }
          ] }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '"a"}' } }] }, finish_reason: 'tool_calls' }] },
          { choices: [], usage }
        ].map(chunk => ({ id: 'chat_modes', object: 'chat.completion.chunk', model: 'fixture', created: 1, ...chunk }))
        return new Response(chunks.map(chunk => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n', {
          headers: { 'content-type': 'text/event-stream' }
        })
      } })
    const input = [{ kind: 'user' as const, content: 'Inspect a'} ]
    const result = await model.invoke({ messages: input, tools: [], signal: new AbortController().signal })
    expect(result.text).toBe('Done')
    expect(result.message.calls).toMatchObject([{ id: 'call_a', name: 'lookup', args: { path: 'a' } }])
    expect(result.message.usage).toMatchObject({ input_tokens: 10, output_tokens: 0, total_tokens: 10,
      input_token_details: { cache_read: 0, cache_creation: 4 }, output_token_details: { reasoning: 0 } })
    expect(conversationContentBlocks(result.message)).toContainEqual(expect.objectContaining({ type: 'reasoning', reasoning: 'Think first' }))
  })

  it.each([false, true])('uses the same raw Responses replay and tool images for %s and local counting', async streaming => {
    const rawOutput = [
      { type: 'reasoning', id: 'rs_saved', encrypted_content: 'x'.repeat(32_000), summary: [] },
      { type: 'function_call', id: 'fc_saved', call_id: 'call_image', name: 'view_image', arguments: '{"path":"chart.png"}', status: 'completed' }
    ]
    const previous = { kind: 'assistant' as const, content: [{ type: 'reasoning', reasoning: 'Visible summary is not replayed'.repeat(1_000) }], calls: [{ id: 'call_image', name: 'view_image', args: { path: 'chart.png' } }], source: { contentFormat: 'portable' as const, provider: 'openai', metadata: { output: rawOutput}, extras: {} } }
    const messages = [{ kind: 'user' as const, content: 'Inspect'} , previous, { kind: 'tool' as const, content: [{ type: 'text', text: 'Chart' }, { type: 'image_url', image_url: { url: 'https://example.com/chart.png' } }], resultFor: 'call_image'} ]
    const original = structuredClone(messages)
    const requests: Record<string, unknown>[] = []
    const completed = {
      id: 'resp_done', object: 'response', created_at: 1, status: 'completed', model: 'fixture', output_text: 'Done',
      output: [{ type: 'message', id: 'msg_done', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 }
    }
    const model = createConversationModel({ ...config, protocol: 'openai_responses', stream: streaming }, { providerFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        requests.push(body)
        if (!body.stream) return new Response(JSON.stringify(completed), { headers: { 'content-type': 'application/json' } })
        const events = [
          { type: 'response.created', sequence_number: 0, response: { ...completed, output: [], status: 'in_progress' } },
          { type: 'response.output_item.added', sequence_number: 1, output_index: 0, item: { ...completed.output[0], content: [], status: 'in_progress' } },
          { type: 'response.output_text.delta', sequence_number: 2, item_id: 'msg_done', output_index: 0, content_index: 0, delta: 'Done', logprobs: [] },
          { type: 'response.completed', sequence_number: 3, response: completed }
        ]
        return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
      }
    })
    await model.invoke({ messages, tools: [], signal: new AbortController().signal })
    expect(requests).toHaveLength(1)
    expect(requests[0].input).toEqual([
      { type: 'message', role: 'user', content: 'Inspect' },
      ...rawOutput,
      { type: 'function_call_output', call_id: 'call_image', output: [
        { type: 'input_text', text: 'Chart' },
        { type: 'input_image', image_url: 'https://example.com/chart.png', detail: 'auto' }
      ] }
    ])
    const estimated = countConversationTokens(messages, [], { protocol: 'openai_responses' })
    expect(estimated).toBeGreaterThan(9_024)
    expect(estimated).toBeLessThan(9_200)
    expect(structuredClone(messages)).toEqual(original)
  })

  it('counts tokens locally without downloading an OpenAI tokenizer', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    try {
      expect(approximateContentTokens('12345678')).toBe(2)
      expect(fetchSpy).not.toHaveBeenCalled()
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it('keeps provider tool-call metadata when later Qwen deltas contain empty values', async () => {
    const { message } = await streamChatConversation(qwenToolCallStream(), () => {})

    expect(message.calls).toEqual([{
      extensions: { type: 'tool_call' },
      id: 'call-from-qwen',
      name: 'lookup',
      args: { description: 'inspect files' }
    }])
  })

  it('does not invent tool-call metadata when the provider never supplies it', async () => {
    async function* source(): AsyncGenerator<OpenAI.Chat.ChatCompletionChunk> {
      yield { id: 'missing', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0,
        delta: { tool_calls: [{ index: 0, id: '', function: { name: '', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] }
    }
    const { message } = await streamChatConversation(source(), () => {})
    expect(message.calls).toEqual([])
    const invalid = conversationContentBlocks(message).find(block => block.type === 'invalid_tool_call')
    expect(invalid).toMatchObject({ type: 'invalid_tool_call', args: '{}' })
    expect(invalid).not.toHaveProperty('id')
    expect(invalid).not.toHaveProperty('name')
  })

  it('normalizes non-streaming reasoning content into a standard reasoning block', async () => {
    const result = await generateNonStreaming({ kind: 'assistant' as const, content: 'FINAL_RESPONSE', id: 'non-streaming-response', source: {provider: 'openai', metadata: {}, extras: {reasoning_content: 'INTERNAL_REASONING'}}} )

    expect(conversationContentBlocks(result.message)).toEqual([
      { type: 'reasoning', reasoning: 'INTERNAL_REASONING' },
      { type: 'text', text: 'FINAL_RESPONSE' }
    ])
  })

  it('preserves tool calls while normalizing non-streaming reasoning', async () => {
    const result = await generateNonStreaming({ kind: 'assistant' as const, content: '', id: 'non-streaming-tool-response', calls: [{
        id: 'tool-1',
        name: 'search',
        args: { query: 'weather' }
      }], source: {provider: 'openai', metadata: {}, extras: {reasoning_content: 'CHOOSE_TOOL'}}} )
    const message = result.message

    expect(conversationContentBlocks(message)).toEqual([
      { type: 'reasoning', reasoning: 'CHOOSE_TOOL' },
      { type: 'tool_call', id: 'tool-1', name: 'search', args: { query: 'weather' } }
    ])
    expect(message.calls).toEqual([{
      extensions: { type: 'tool_call' },
      id: 'tool-1',
      name: 'search',
      args: { query: 'weather' }
    }])
  })

})
