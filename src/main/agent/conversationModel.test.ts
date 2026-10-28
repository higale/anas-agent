import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ModelProtocol, ResolvedModelConfig } from '@shared/types'
import { createConversationModel } from './conversationModel'
import { ToolArgumentProgress } from './toolArgumentProgress'
import { modelToolDeclaration } from './modelToolDeclarations'
import { encodeConversationMessage, decodeConversationMessage } from '../../runtime/conversationStorage'
import type { ConversationProgress } from '../../providers/conversationStream'
import { IncompleteModelResponseError, ModelSelectionError } from '../../runtime/errors'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

const protocols: ModelProtocol[] = ['openai_chat_completions', 'openai_responses', 'anthropic_messages']
const config: ResolvedModelConfig = {
  id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol: 'openai_chat_completions',
  baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
  contextCompressionThreshold: 0.8, contextCompressionEnabled: true
}
const args = '{"path":"a.txt","flag":false,"limit":0}'
const tool = { name: 'read', description: 'Read', inputSchema: z.object({ path: z.string(), flag: z.boolean(), limit: z.number() }), execute: vi.fn() }
const request = () => ({ messages: [{ kind: 'user' as const, content: 'Read' }], tools: [tool], signal: new AbortController().signal })

function response(protocol: ModelProtocol, input = args) {
  if (protocol === 'anthropic_messages') return { id: 'response', type: 'message', role: 'assistant', model: 'fixture',
    content: [{ type: 'thinking', thinking: 'plan', signature: 'signed' }, { type: 'text', text: 'Ready' },
      { type: 'tool_use', id: 'call', name: 'read', input: input === args ? JSON.parse(input) : input }],
    stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 5, output_tokens: 0 } }
  if (protocol === 'openai_responses') return { id: 'response', object: 'response', model: 'fixture', status: 'completed',
    output: [{ type: 'reasoning', id: 'reasoning', encrypted_content: 'encrypted', summary: [{ type: 'summary_text', text: 'plan' }] },
      { type: 'message', id: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Ready', annotations: [] }] },
      { type: 'function_call', id: 'item', call_id: 'call', name: 'read', arguments: input, status: 'completed' }],
    usage: { input_tokens: 5, output_tokens: 0, total_tokens: 5 } }
  return { id: 'response', object: 'chat.completion', model: 'fixture', created: 1,
    choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: 'Ready', reasoning_content: 'plan',
      tool_calls: [{ type: 'function', id: 'call', function: { name: 'read', arguments: input } }] } }],
    usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 } }
}

function frames(protocol: ModelProtocol): unknown[] {
  const final = response(protocol)
  if (protocol === 'anthropic_messages') {
    const content = final.content!
    return [{ type: 'message_start', message: { ...final, content: [], stop_reason: null } },
      ...content.flatMap((block, index) => [
        { type: 'content_block_start', index, content_block: block.type === 'tool_use' ? { ...block, input: {} } : block.type === 'text' ? { ...block, text: '' } : { ...block, thinking: '' } },
        { type: 'content_block_delta', index, delta: block.type === 'tool_use' ? { type: 'input_json_delta', partial_json: args }
          : block.type === 'text' ? { type: 'text_delta', text: 'Ready' } : { type: 'thinking_delta', thinking: 'plan' } },
        { type: 'content_block_stop', index }
      ]), { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 0 } }, { type: 'message_stop' }]
  }
  if (protocol === 'openai_responses') return [{ type: 'response.created', response: { ...final, status: 'in_progress', output: [] } },
    ...final.output!.flatMap((item, output_index) => item.type === 'function_call' ? [
      { type: 'response.output_item.added', output_index, item: { ...item, arguments: '' } },
      { type: 'response.function_call_arguments.delta', output_index, item_id: 'item', delta: args },
      { type: 'response.output_item.done', output_index, item }
    ] : [{ type: 'response.output_item.done', output_index, item }]),
    { type: 'response.completed', response: final }]
  const header = { id: 'response', object: 'chat.completion.chunk', model: 'fixture', created: 1 }
  return [{ ...header, choices: [{ index: 0, finish_reason: null, delta: { role: 'assistant', content: 'Re', reasoning_content: 'plan',
    tool_calls: [{ index: 3, id: 'call', type: 'function', function: { name: 'read', arguments: args.slice(0, 10) } }] } }] },
  { ...header, choices: [{ index: 0, finish_reason: null, delta: { content: 'ady',
    tool_calls: [{ index: 3, function: { arguments: args.slice(10) } }] } }] },
  { ...header, choices: [{ index: 0, finish_reason: 'tool_calls', delta: {} }], usage: final.usage }]
}
function sse(events: unknown[]) {
  return new Response(events.map(event => `${typeof (event as { type?: unknown }).type === 'string' ? `event: ${(event as { type: string }).type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
}

describe('native conversation model', () => {
  it.each(protocols.flatMap(protocol => [false, true].map(stream => ({ protocol, stream }))))(
    'invokes $protocol streaming=$stream and replays the stored complete result', async ({ protocol, stream }) => {
      const requests: Record<string, unknown>[] = [], progress: ConversationProgress[] = []
      const model = createConversationModel({ ...config, protocol, stream, parameters: { temperature: 0 } }, {
        providerFetch: async (_url, init) => {
          requests.push(JSON.parse(String(init?.body)))
          return stream ? sse(frames(protocol)) : Response.json(response(protocol))
        }
      })
      const publish = vi.fn(), toolProgress = new ToolArgumentProgress(publish)
      const result = await model.invoke({ ...request(), observe: event => {
        progress.push(event)
        if (event.kind === 'tool_input') toolProgress.accept(event.progress)
      } }).finally(() => toolProgress.dispose())
      expect(result.observationErrors).toEqual([])
      expect(result.text).toBe('Ready')
      expect(result.message.calls).toEqual([expect.objectContaining({ id: 'call', name: 'read', args: JSON.parse(args) })])
      expect(result.message.usage).toMatchObject({ input_tokens: 5, output_tokens: 0, total_tokens: 5 })
      expect(result.message.partial).toBeUndefined()
      expect(requests[0].temperature).toBe(0)
      expect(requests[0].stream).toBe(stream)
      expect(requests[0].tools).toEqual([modelToolDeclaration(tool, protocol)])
      if (stream) {
        expect(progress.filter(event => event.kind === 'delta' && event.channel === 'text').map(event => event.kind === 'delta' ? event.text : '').join('')).toBe('Ready')
        expect(progress.filter(event => event.kind === 'delta' && event.channel === 'reasoning').map(event => event.kind === 'delta' ? event.text : '').join('')).toBe('plan')
        expect(progress).toContainEqual({ kind: 'tool_input', progress: expect.objectContaining({ callId: 'call', characterCount: args.length, complete: false }) })
        expect(progress.at(-1)).toMatchObject({ kind: 'tool_input', progress: { callId: 'call', complete: true } })
        expect(JSON.stringify(progress)).not.toContain('a.txt')
        expect(publish.mock.lastCall?.[0]).toEqual([expect.objectContaining({ callId: 'call', name: 'read', characterCount: args.length, complete: true })])
        expect(JSON.stringify(publish.mock.calls)).not.toContain('a.txt')
      } else expect(progress).toEqual([])
      const stored = decodeConversationMessage(encodeConversationMessage(result.message))
      await model.invoke({ ...request(), messages: [...request().messages, stored, { kind: 'tool', content: 'file body', resultFor: 'call' }] })
      if (protocol === 'openai_responses') {
        expect(requests[1].input).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'reasoning', encrypted_content: 'encrypted' }),
          expect.objectContaining({ type: 'function_call', id: 'item', call_id: 'call', arguments: args }),
          { type: 'function_call_output', call_id: 'call', output: 'file body' }
        ]))
      } else if (protocol === 'anthropic_messages') {
        expect(requests[1].messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', content: expect.arrayContaining([{ type: 'thinking', thinking: 'plan', signature: 'signed' }]) }),
          expect.objectContaining({ role: 'user', content: expect.arrayContaining([{ type: 'tool_result', tool_use_id: 'call', content: 'file body' }]) })
        ]))
      } else {
        const messages = requests[1].messages as Array<{ role: string; tool_calls?: Array<{ function: { arguments: string } }> }>
        expect(messages).toEqual(expect.arrayContaining([
          expect.objectContaining({ role: 'assistant', tool_calls: [expect.objectContaining({ type: 'function', id: 'call', function: expect.objectContaining({ name: 'read' }) })] }),
          { role: 'tool', tool_call_id: 'call', content: 'file body' }
        ]))
        expect(JSON.parse(messages.find(message => message.role === 'assistant')!.tool_calls![0].function.arguments)).toEqual(JSON.parse(args))
      }
      expect(tool.execute).not.toHaveBeenCalled()
    })

  it.each(protocols)('distinguishes encoded malformed JSON from a literal string input in %s', async protocol => {
    const model = createConversationModel({ ...config, protocol }, { providerFetch: async () => Response.json(response(protocol, '{broken')) })
    const result = await model.invoke(request())
    if (protocol === 'anthropic_messages') {
      expect(result.message.calls).toEqual([expect.objectContaining({ id: 'call', args: '{broken' })])
      expect(result.message.invalidCalls).toEqual([])
    } else {
      expect(result.message.calls).toEqual([])
      expect(result.message.invalidCalls).toEqual([expect.objectContaining({ id: 'call', args: '{broken' })])
    }
  })

  it.each(protocols)('does not retry HTTP failures inside %s transport', async protocol => {
    const fetch = vi.fn(async () => Response.json({ error: { message: 'unavailable' } }, { status: 503 }))
    const model = createConversationModel({ ...config, protocol }, { providerFetch: fetch })
    await expect(model.invoke(request())).rejects.toMatchObject({ status: 503 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(protocols)('rejects incomplete %s streams', async protocol => {
    const model = createConversationModel({ ...config, protocol, stream: true }, { providerFetch: async () => sse(frames(protocol).slice(0, -1)) })
    await expect(model.invoke(request())).rejects.toBeInstanceOf(IncompleteModelResponseError)
  })

  it.each(protocols)('preserves a completed %s response when display observers fail', async protocol => {
    const failure = new Error('display failed')
    const fetch = vi.fn(async () => sse(frames(protocol)))
    const model = createConversationModel({ ...config, protocol, stream: true }, { providerFetch: fetch })
    const result = await model.invoke({ ...request(), observe: () => { throw failure } })
    expect(result.message.calls?.[0].id).toBe('call')
    expect(result.observationErrors).toEqual([failure])
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it.each(protocols)('cancels %s while receiving progress without returning executable calls', async protocol => {
    const controller = new AbortController()
    const model = createConversationModel({ ...config, protocol, stream: true }, { providerFetch: async () => sse(frames(protocol)) })
    await expect(model.invoke({ ...request(), signal: controller.signal,
      observe: () => controller.abort(new Error('cancelled during response')) })).rejects.toThrow()
  })

  it('preserves native Responses custom/computer calls and server output through storage', async () => {
    const data = { ...response('openai_responses'), output: [
      { type: 'custom_tool_call', id: 'custom-item', call_id: 'patch-call', name: 'apply_patch', input: 'patch text', status: 'completed' },
      { type: 'computer_call', id: 'computer-item', call_id: 'computer-call', action: { type: 'screenshot' }, pending_safety_checks: [], status: 'completed' },
      { type: 'web_search_call', id: 'search-item', status: 'completed', action: { type: 'search', query: 'fixture' } }
    ] }
    const requests: Record<string, unknown>[] = []
    const model = createConversationModel({ ...config, protocol: 'openai_responses' }, { providerFetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json(data)
    } })
    const result = await model.invoke(request())
    const stored = decodeConversationMessage(encodeConversationMessage(result.message))
    expect(stored.calls).toEqual([
      expect.objectContaining({ id: 'patch-call', kind: 'custom', itemId: 'custom-item', name: 'apply_patch', args: { input: 'patch text' } }),
      expect.objectContaining({ id: 'computer-call', kind: 'computer', itemId: 'computer-item', name: 'computer_use', args: { action: { type: 'screenshot' } } })
    ])
    await model.invoke({ ...request(), messages: [stored,
      { kind: 'tool', resultFor: 'patch-call', resultKind: 'custom', content: 'patched' },
      { kind: 'tool', resultFor: 'computer-call', resultKind: 'computer', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }] })
    expect(requests[1].input).toEqual(expect.arrayContaining(data.output))
    expect(requests[1].input).toEqual(expect.arrayContaining([
      { type: 'custom_tool_call_output', call_id: 'patch-call', output: 'patched' },
      expect.objectContaining({ type: 'computer_call_output', call_id: 'computer-call' })
    ]))
  })

  it('cancels before transport and validates the selected model', async () => {
    const fetch = vi.fn(), model = createConversationModel(config, { providerFetch: fetch })
    const controller = new AbortController(), reason = new Error('cancelled')
    controller.abort(reason)
    await expect(model.invoke({ ...request(), signal: controller.signal })).rejects.toBe(reason)
    expect(fetch).not.toHaveBeenCalled()
    expect(() => createConversationModel({ ...config, model: ' ' })).toThrow(ModelSelectionError)
  })
})
