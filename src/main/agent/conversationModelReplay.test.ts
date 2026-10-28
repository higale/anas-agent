import { describe, expect, it, vi } from 'vitest'
import type { ResolvedModelConfig } from '@shared/types'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { encodeConversationMessage, decodeConversationMessage } from '../../runtime/conversationStorage'
import { createConversationModel } from './conversationModel'
import { countConversationTokens, assertConversationFits, assertConversationSupported } from './conversationContext'
import { conversationChatInput, conversationResponsesInput, conversationContentBlocks } from '../../providers/conversationInput'
import { presentConversationMessage } from './conversationPresentation'
import { filePatchDescription, filePatchSchema, parseFilePatch } from '../filePatch'
import { fileToolDefinitions } from '../llm/fileTools'
import codexPatchSpec from '../codexPatchSpec.json'
vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
const baseModel: ResolvedModelConfig = {
  id: 'test',
  displayName: '',
  providerId: 'provider-test',
  providerName: 'Test',
  protocol: 'openai_chat_completions',
  baseUrl: 'https://example.com/v1',
  model: 'test-model',
  apiKey: 'secret',
  parameters: {},
  parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true },
  stream: true,
  maxContextTokens: 128000,
  maxOutputTokens: 16000,
  contextCompressionThreshold: 0.8,
  contextCompressionEnabled: true
}

function responsesSse(id: string, reasoning: string, text: string): string {
  const reasoningItem = {
    id: `rs_${id}`,
    type: 'reasoning',
    status: 'completed',
    summary: [{ type: 'summary_text', text: reasoning }]
  }
  const messageItem = {
    id: `msg_${id}`,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text, annotations: [], logprobs: [] }]
  }
  const response = {
    id,
    object: 'response',
    created_at: 1,
    status: 'completed',
    model: 'qwen-compatible-model',
    output_text: text,
    output: [reasoningItem, messageItem],
    usage: {
      input_tokens: 10,
      output_tokens: 8,
      total_tokens: 18,
      input_tokens_details: { cached_tokens: 0 },
      output_tokens_details: { reasoning_tokens: 5 }
    }
  }
  const stream = [
    {
      type: 'response.created',
      sequence_number: 0,
      response: { ...response, status: 'in_progress', output: [], usage: null }
    },
    {
      type: 'response.output_item.added',
      sequence_number: 1,
      output_index: 0,
      item: { ...reasoningItem, status: 'in_progress', summary: [] }
    },
    {
      type: 'response.reasoning_text.delta',
      sequence_number: 2,
      item_id: reasoningItem.id,
      output_index: 0,
      content_index: 0,
      delta: reasoning
    },
    {
      type: 'response.reasoning_text.done',
      sequence_number: 3,
      item_id: reasoningItem.id,
      output_index: 0,
      content_index: 0,
      text: reasoning
    },
    {
      type: 'response.output_item.done',
      sequence_number: 4,
      output_index: 0,
      item: reasoningItem
    },
    {
      type: 'response.output_item.added',
      sequence_number: 5,
      output_index: 1,
      item: { ...messageItem, status: 'in_progress', content: [] }
    },
    {
      type: 'response.output_text.delta',
      sequence_number: 6,
      item_id: messageItem.id,
      output_index: 1,
      content_index: 0,
      delta: text,
      logprobs: []
    },
    { type: 'response.completed', sequence_number: 7, response }
  ]
  return stream
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('') + 'data: [DONE]\n\n'
}

describe('native model protocol replay and media', () => {
  it('counts native Anthropic stream reasoning and non-standard content replayed by its HTTP adapter', async () => {
    const thinking = 't'.repeat(32_000)
    const signature = 's'.repeat(400)
    const redacted = 'r'.repeat(8_000)
    const events = [
      { type: 'message_start', message: { id: 'msg_thinking', type: 'message', role: 'assistant', model: 'claude-fixture', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'redacted_thinking', data: redacted } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: 'Done' } },
      { type: 'content_block_stop', index: 2 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 123_456 } },
      { type: 'message_stop' }
    ]
    const bodies: Record<string, unknown>[] = []
    const create = (stream: boolean) => createConversationModel({ ...baseModel, protocol: 'anthropic_messages', model: 'claude-fixture', stream }, {
      providerFetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body))
        bodies.push(body)
        if (body.stream) return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
        return new Response(JSON.stringify({ id: 'msg_done', type: 'message', role: 'assistant', model: 'claude-fixture', content: [{ type: 'text', text: 'Done' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } }), { headers: { 'content-type': 'application/json' } })
      }
    })
    const previous = (await create(true).invoke({ messages: [{ kind: 'user', content: 'Start' }], tools: [], signal: new AbortController().signal })).message
    expect(previous.content).toEqual(expect.arrayContaining([
      { type: 'thinking', thinking, signature },
      { type: 'redacted_thinking', data: redacted }
    ]))
    const restored = decodeConversationMessage(encodeConversationMessage(previous))
    expect(restored.source?.provider).toBe('anthropic')
    const messages: ConversationMessage[] = [{ kind: 'user', content: 'Start' }, restored, { kind: 'user', content: 'Continue' }]
    await create(false).invoke({ messages, tools: [], signal: new AbortController().signal })
    expect(bodies[1].messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ role: 'assistant', content: expect.arrayContaining([
        { type: 'thinking', thinking, signature }, { type: 'redacted_thinking', data: redacted }
      ]) })
    ]))
    const estimated = countConversationTokens(messages, [], { protocol: 'anthropic_messages' })
    expect(estimated).toBeGreaterThan(10_100)
    expect(estimated).toBeLessThan(10_200)
    expect(countConversationTokens(messages, [], { protocol: 'openai_chat_completions' })).toBeLessThan(20)
    const original = encodeConversationMessage(restored)
    for (const protocol of ['openai_chat_completions', 'openai_responses'] as const) {
      const requests: string[] = []
      const switched = createConversationModel({ ...baseModel, protocol, stream: false }, { providerFetch: async (_url, init) => {
        requests.push(String(init?.body))
        return Response.json(protocol === 'openai_responses'
          ? { id: 'response', object: 'response', status: 'completed', model: 'fixture', output: [] }
          : { id: 'response', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0,
            finish_reason: 'stop', message: { role: 'assistant', content: 'done' } }] })
      } })
      await switched.invoke({ messages, tools: [], signal: new AbortController().signal })
      expect(requests).toHaveLength(1)
      expect(requests[0]).toContain('Done')
      for (const opaque of [signature, redacted, 'redacted_thinking']) expect(requests[0]).not.toContain(opaque)
      if (protocol === 'openai_responses') expect(requests[0]).toContain(thinking)
      else expect(requests[0]).not.toContain(thinking)
      expect(countConversationTokens(messages, [], { protocol })).toBe(protocol === 'openai_responses' ? 8027 : 5)
    }
    expect(encodeConversationMessage(restored)).toEqual(original)

  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'uses the Codex freeform definition on Responses and the JSON adapter on %s', async (protocol) => {
        const args = { summary: '更新中文文件并移动说明', patch: [
        '*** Begin Patch',
        '*** Update File: src/中文 文件.ts',
        '@@',
        '-before',
        '+after',
        '*** Update File: old.md',
        '*** Move to: docs/new.md',
        '@@',
        ' unchanged',
        '*** End Patch'
      ].join('\n') }
      let sent: Record<string, unknown> | undefined
      const providerFetch: typeof fetch = async (_url, init) => {
        sent = JSON.parse(String(init?.body))
        const body = protocol === 'anthropic_messages'
          ? { id: 'msg_patch', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'tool_use', stop_sequence: null,
              content: [{ type: 'tool_use', id: 'call_patch', name: 'apply_patch', input: args }], usage: { input_tokens: 10, output_tokens: 20 } }
          : protocol === 'openai_responses'
            ? { id: 'resp_patch', object: 'response', created_at: 1, status: 'completed', model: 'fixture',
                output: [{ type: 'custom_tool_call', id: 'ct_patch', call_id: 'call_patch', name: 'apply_patch', input: args.patch, status: 'completed' }],
                usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 } }
            : { id: 'chat_patch', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'tool_calls',
                message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_patch', type: 'function', function: { name: 'apply_patch', arguments: JSON.stringify(args) } }] } }],
                usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      const model = createConversationModel({ ...baseModel, protocol, stream: false }, { providerFetch })
      const patchTool = fileToolDefinitions({ maxReadBytes: 1_000_000, primaryFolder: process.cwd() }).find(item => item.name === 'apply_patch')!

      const response = (await model.invoke({ messages: [{ kind: 'user' as const, content: 'Edit both files' }], tools: [patchTool], signal: new AbortController().signal })).message
      expect(response.calls).toMatchObject([{ name: 'apply_patch', args: protocol === 'openai_responses' ? { input: args.patch } : args }])
      expect(parseFilePatch(response.calls![0].args).operations.map(operation => operation.type)).toEqual(['update', 'move'])
      const tools = sent?.tools as Array<Record<string, unknown>>
      expect(tools).toHaveLength(1)
      if (protocol === 'openai_responses') {
        expect(tools[0]).toEqual(codexPatchSpec)
        expect(filePatchSchema.parse(response.calls![0].args)).toEqual({ patch: args.patch })
        const restored = decodeConversationMessage(encodeConversationMessage(response))
        await model.invoke({ messages: [{ kind: 'user' as const, content: 'Edit both files' }, restored, { kind: 'tool' as const, resultFor: 'call_patch', content: 'Success' }], tools: [patchTool], signal: new AbortController().signal })
        expect(sent?.input).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'custom_tool_call', call_id: 'call_patch', input: args.patch }),
          { type: 'custom_tool_call_output', call_id: 'call_patch', output: 'Success' }
        ]))
        return
      }
      const definition = protocol === 'openai_chat_completions' ? tools[0].function as Record<string, unknown> : tools[0]
      expect(definition.name).toBe('apply_patch')
      expect(definition.description).toBe(filePatchDescription)
      const schema = (definition.parameters ?? definition.input_schema) as {
        additionalProperties: boolean
        properties: Record<string, unknown>
        required: string[]
      }
      expect(schema.additionalProperties).toBe(false)
      expect(Object.keys(schema.properties).sort()).toEqual(['dry_run', 'patch', 'summary'])
      expect(schema.properties.patch).toMatchObject({ type: 'string' })
      expect(schema.required).toContain('patch')
      expect(filePatchSchema.parse(response.calls![0].args)).toEqual(args)
    })

  it.each(['data', 'patch', 'function'])('continues a previous %s call with streamed freeform patch text', async (field) => {
    const patch = '*** Begin Patch\n*** Update File: src/main.ts\n@@\n-before\n+const text = `你好中国 "quoted" C:\\temp`;\n*** End Patch'
    const wrapped = JSON.stringify({ [field]: patch })
    const oldCall = field === 'function'
      ? { type: 'function_call', id: 'fc_old', call_id: 'call_old', name: 'apply_patch', arguments: JSON.stringify({ patch }) }
      : { type: 'custom_tool_call', id: 'ct_old', call_id: 'call_old', name: 'apply_patch', input: wrapped }
    const historical = decodeConversationMessage(encodeConversationMessage({ kind: 'assistant' as const, content: '', calls: [{ id: 'call_old', name: 'apply_patch', args: field === 'function' ? { patch } : { input: wrapped } }], source: { provider: 'openai' as const, contentFormat: 'portable' as const, metadata: { output: [oldCall] }, extras: {} } }))
    const output = { type: 'custom_tool_call', id: 'ct_new', call_id: 'call_new', name: 'apply_patch', input: patch, status: 'completed' }
    const response = { id: 'resp_patch', object: 'response', created_at: 1, model: 'test-model', status: 'completed', output: [output],
      usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    let sent: Record<string, unknown> | undefined
    const model = createConversationModel({ ...baseModel, protocol: 'openai_responses', stream: true }, { providerFetch: async (_url, init) => {
      sent = JSON.parse(String(init?.body))
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...output, status: 'in_progress', input: '' } },
        { type: 'response.custom_tool_call_input.delta', item_id: output.id, output_index: 0, delta: output.input.slice(0, 20) },
        { type: 'response.custom_tool_call_input.delta', item_id: output.id, output_index: 0, delta: output.input.slice(20) },
        { type: 'response.custom_tool_call_input.done', item_id: output.id, output_index: 0, input: output.input },
        { type: 'response.output_item.done', output_index: 0, item: output },
        { type: 'response.completed', response }
      ]
      return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } })
    } })

    const patchTool = fileToolDefinitions({ maxReadBytes: 1_000_000, primaryFolder: process.cwd() }).find(item => item.name === 'apply_patch')!

    const result = (await model.invoke({ messages: [
      { kind: 'user' as const, content: 'Update the file' }, historical,
      { kind: 'tool' as const, resultFor: 'call_old', resultStatus: 'error' as const, content: "NOT EXECUTED: invalid patch: The first line of the patch must be '*** Begin Patch'" }
    ], tools: [patchTool], signal: new AbortController().signal })).message
    expect(sent?.tools).toEqual([codexPatchSpec])
    expect(sent?.input).toEqual(expect.arrayContaining([
      expect.objectContaining(oldCall),
      expect.objectContaining({ type: field === 'function' ? 'function_call_output' : 'custom_tool_call_output', call_id: 'call_old' })
    ]))
    expect(result.calls).toMatchObject([{ name: 'apply_patch', args: { input: patch } }])
    expect(parseFilePatch(result.calls![0].args).operations).toMatchObject([{ type: 'update', path: 'src/main.ts' }])
  })

  it('keeps request image encoding stable when called again', () => {
    const original = { kind: 'tool' as const, resultFor: 'image', content: [
      { type: 'input_text', text: 'picture.png' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'high' }
    ] }
    for (const protocol of ['openai_responses', 'openai_chat_completions'] as const) {
      const project = () => protocol === 'openai_responses' ? conversationResponsesInput([original], { model: 'fixture', zeroRetention: false }) : conversationChatInput([original])
      const once = project()
      const twice = project()
      expect(twice).toEqual(once)
      expect(JSON.stringify(once)).toContain('data:image/png;base64,AAAA')
    }
    expect(original.content).toEqual(expect.arrayContaining([{ type: 'input_text', text: 'picture.png' }]))
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('sends actual tool images through %s in streaming and ordinary requests', async (protocol) => {
    for (const stream of [false, true]) {
      let sent: any
      const response = protocol === 'anthropic_messages'
        ? { id: 'msg_image', type: 'message', role: 'assistant', model: 'fixture', stop_reason: 'end_turn', stop_sequence: null,
            content: [{ type: 'text', text: 'Seen' }], usage: { input_tokens: 10, output_tokens: 2 } }
        : protocol === 'openai_responses'
          ? { id: 'resp_image', object: 'response', created_at: 1, status: 'completed', model: 'fixture',
              output: [{ id: 'msg_image', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Seen', annotations: [] }] }],
              usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }
          : { id: 'chat_image', object: 'chat.completion', created: 1, model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Seen' } }],
              usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }
      const providerFetch: typeof fetch = async (input, init) => {
        sent = input instanceof Request ? await input.clone().json() : JSON.parse(String(init?.body))
        if (!stream) return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
        const events = protocol === 'anthropic_messages' ? [
          { type: 'message_start', message: { ...response, content: [], stop_reason: null } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Seen' } },
          { type: 'content_block_stop', index: 0 },
          { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 2 } },
          { type: 'message_stop' }
        ] : [{ id: 'chat_image', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: { role: 'assistant', content: 'Seen' }, finish_reason: null }] },
          { id: 'chat_image', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }]
        const body = protocol === 'openai_responses' ? responsesSse('resp_image', '', 'Seen')
          : events.map((event) => `${'type' in event ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('') + (protocol === 'openai_chat_completions' ? 'data: [DONE]\n\n' : '')
        return new Response(body, { headers: { 'content-type': 'text/event-stream' } })
      }
      const images = { kind: 'tool' as const, resultFor: 'images', name: 'view_multiple_images', source: { provider: 'openai' as const, contentFormat: 'portable' as const, metadata: { output_version: 'v1' }, extras: {} }, content: [
        { type: 'text', text: 'first.png' }, { type: 'image', mimeType: 'image/png', data: 'AAAA' },
        { type: 'text', text: 'second.jpg' }, { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }
      ] }
      const messages = [{ kind: 'user' as const, content: 'Inspect the pictures' }, { kind: 'assistant' as const, content: '', calls: [
        { id: 'images', name: 'view_multiple_images', args: { paths: ['first.png', 'second.jpg'] } },
        { id: 'text', name: 'read_file', args: { path: 'notes.txt' } }
      ] }, images, { kind: 'tool' as const, resultFor: 'text', content: 'Notes' }]
      const original = JSON.stringify(messages)
      const model = createConversationModel({ ...baseModel, protocol, stream }, { providerFetch })
      await model.invoke({ messages, tools: [], signal: new AbortController().signal })
      expect(JSON.stringify(messages)).toBe(original)
      if (protocol === 'openai_responses') {
        expect(sent.input.find((item: any) => item.call_id === 'images' && item.type === 'function_call_output').output).toEqual([
          { type: 'input_text', text: 'first.png' }, { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' },
          { type: 'input_text', text: 'second.jpg' }, { type: 'input_image', image_url: 'data:image/jpeg;base64,BBBB', detail: 'auto' }
        ])
      } else if (protocol === 'anthropic_messages') {
        const result = sent.messages.flatMap((message: any) => Array.isArray(message.content) ? message.content : []).find((block: any) => block.type === 'tool_result' && block.tool_use_id === 'images')
        expect(result.content.filter((block: any) => block.type === 'image')).toEqual([
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'BBBB' } }
        ])
      } else {
        expect(sent.messages.slice(-3).map((message: any) => message.role)).toEqual(['tool', 'tool', 'user'])
        expect(sent.messages.at(-1).content.filter((block: any) => block.type === 'image_url')).toEqual([
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
          { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBBB' } }
        ])
      }
    }
  })

  it('uses the selected OpenAI endpoint and preserves Responses output items', async () => {
    const requestedUrls: string[] = []
    const requestBodies: Array<Record<string, unknown>> = []
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = input instanceof Request ? input.url : String(input)
      requestedUrls.push(url)
      const requestBody = input instanceof Request
        ? await input.clone().json() as Record<string, unknown>
        : JSON.parse(String(init?.body)) as Record<string, unknown>
      requestBodies.push(requestBody)
      if (url.endsWith('/responses')) {
        return new Response(JSON.stringify({
          id: 'resp_test',
          object: 'response',
          created_at: 1,
          status: 'completed',
          model: 'gpt-5',
          output_text: 'responses-ok',
          output: [
            {
              id: 'rs_test',
              type: 'reasoning',
              summary: [{ type: 'summary_text', text: 'reasoning summary' }]
            },
            {
              id: 'msg_test',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: 'responses-ok', annotations: [] }]
            }
          ],
          usage: {
            input_tokens: 1,
            output_tokens: 2,
            total_tokens: 3,
            input_tokens_details: { cached_tokens: 0 },
            output_tokens_details: { reasoning_tokens: 1 }
          }
        }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }
      return new Response(JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        created: 1,
        model: 'gpt-5',
        choices: [{
          index: 0,
          message: { role: 'assistant', content: 'chat-ok' },
          finish_reason: 'stop'
        }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })

    try {
      const responsesModel = createConversationModel({
        ...baseModel,
        protocol: 'openai_responses',
        model: 'gpt-5',
        stream: false
      })
      const chatModel = createConversationModel({
        ...baseModel,
        protocol: 'openai_chat_completions',
        model: 'gpt-5',
        stream: false
      })

      const response = (await responsesModel.invoke({ messages: [{ kind: 'user', content: 'Hello' }], tools: [], signal: new AbortController().signal })).message
      await responsesModel.invoke({ messages: [
        { kind: 'user' as const, content: 'Hello' },
        response,
        { kind: 'user' as const, content: 'Follow up' }
      ], tools: [], signal: new AbortController().signal })
      await expect(chatModel.invoke({ messages: [{ kind: 'user', content: 'Hello' }], tools: [], signal: new AbortController().signal }).then(result => result.message)).resolves.toMatchObject({ content: 'chat-ok' })

      expect(requestedUrls).toEqual([
        'https://example.com/v1/responses',
        'https://example.com/v1/responses',
        'https://example.com/v1/chat/completions'
      ])
      expect(requestBodies[1].input).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'rs_test', type: 'reasoning' }),
        expect.objectContaining({ id: 'msg_test', type: 'message' }),
        expect.objectContaining({ role: 'user', content: 'Follow up' })
      ]))
      expect(response.source!.metadata.output).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'rs_test', type: 'reasoning' }),
        expect.objectContaining({ id: 'msg_test', type: 'message' })
      ]))
      expect(conversationContentBlocks(response)).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'reasoning', reasoning: 'reasoning summary' }),
        expect.objectContaining({ type: 'text', text: 'responses-ok' })
      ]))
    } finally {
      fetchSpy.mockRestore()
    }
  })

  it.each([false, true])('replays a generated Responses image unchanged while budgeting it once (stream=%s)', async (stream) => {
    const image = { type: 'image_generation_call', id: 'ig_flower', status: 'completed', result: 'A'.repeat(100_000) }
    const response = { id: 'resp_image', object: 'response', created_at: 1, model: 'test-model',
      status: 'completed', output: [image], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    const bodies: Record<string, unknown>[] = []
    const selected = { ...baseModel, protocol: 'openai_responses' as const, stream, maxContextTokens: 4096, maxOutputTokens: 1024 }
    const model = createConversationModel(selected, { providerFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      if (!body.stream) return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...image, status: 'in_progress', result: null } },
        { type: 'response.output_item.done', output_index: 0, item: image },
        { type: 'response.completed', response }
      ]
      return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } })
    } })
    const prompt = { kind: 'user' as const, content: 'Draw a flower.' }
    const generated = (await model.invoke({ messages: [prompt], tools: [], signal: new AbortController().signal })).message
    const messages = [prompt, generated, { kind: 'user' as const, content: 'Continue.' }]
    expect(presentConversationMessage(generated, 'generated').content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'image', mimeType: 'image/png', data: image.result })
    ]))
    expect(generated.source!.metadata.output).toEqual([image])
    expect(countConversationTokens(messages, [], { protocol: selected.protocol })).toBeLessThan(1100)
    expect(() => assertConversationFits(selected, messages, [])).not.toThrow()
    await model.invoke({ messages, tools: [], signal: new AbortController().signal })
    expect(bodies[1].input).toEqual(expect.arrayContaining([image]))
  })

  it.each([false, true])('budgets native code interpreter images in the actual Responses replay (stream=%s)', async (stream) => {
    const output = { type: 'code_interpreter_call', id: 'ci_chart', status: 'completed',
      container_id: 'cntr_chart', code: 'plot()', outputs: [
        { type: 'logs', logs: 'Generated two charts.' },
        { type: 'image', url: 'https://example.test/chart.png' },
        { type: 'image', url: `data:image/png;base64,${'A'.repeat(100_000)}` }
      ] }
    const response = { id: 'resp_charts', object: 'response', created_at: 1, model: 'test-model',
      status: 'completed', output: [output], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } }
    const bodies: Record<string, unknown>[] = []
    const selected = { ...baseModel, protocol: 'openai_responses' as const, stream,
      parameters: { tools: [{ type: 'code_interpreter', container: { type: 'auto' } }], include: ['code_interpreter_call.outputs'] } }
    const model = (createConversationModel(selected, { providerFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      bodies.push(body)
      if (!body.stream) return new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } })
      const events = [
        { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
        { type: 'response.output_item.added', output_index: 0, item: { ...output, status: 'in_progress', outputs: null } },
        { type: 'response.output_item.done', output_index: 0, item: output },
        { type: 'response.completed', response }
      ]
      return new Response(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''),
        { headers: { 'content-type': 'text/event-stream' } })
    } }))
    const prompt = { kind: 'user' as const, content: 'Plot two charts.' }
    const generated = (await model.invoke({ messages: [prompt], tools: selected.parameters.tools, signal: new AbortController().signal })).message
    const restored = decodeConversationMessage(encodeConversationMessage(generated))
    const messages = [prompt, restored, { kind: 'user' as const, content: 'Interpret the charts.' }]
    expect(restored.source!.metadata).toMatchObject({ output: [output] })
    expect(() => assertConversationSupported(selected, messages, false)).not.toThrow()
    expect(() => assertConversationSupported({ ...selected, capabilities: { ...selected.capabilities, vision: false } }, messages, false))
      .toThrow('does not support the images')
    const tokens = countConversationTokens(messages, selected.parameters.tools, selected)
    expect(tokens).toBeGreaterThanOrEqual(2048)
    expect(tokens).toBeLessThan(2300)
    const exactCapacity = { ...selected, maxContextTokens: tokens + selected.maxOutputTokens }
    expect(() => assertConversationFits(exactCapacity, messages, selected.parameters.tools)).not.toThrow()
    expect(() => assertConversationFits({ ...exactCapacity, maxContextTokens: exactCapacity.maxContextTokens - 1 }, messages, selected.parameters.tools))
      .toThrow('required context does not fit')
    await model.invoke({ messages, tools: selected.parameters.tools, signal: new AbortController().signal })
    expect(bodies[1]).toMatchObject({ tools: selected.parameters.tools, include: selected.parameters.include,
      input: expect.arrayContaining([output]) })
  })

  it('streams Responses reasoning and replays the exact output on the next call', async () => {
    const requestBodies: Array<Record<string, unknown>> = []
    let requestNumber = 0
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      requestNumber += 1
      requestBodies.push(input instanceof Request
        ? await input.clone().json() as Record<string, unknown>
        : JSON.parse(String(init?.body)) as Record<string, unknown>)
      return new Response(
        responsesSse(`resp_${requestNumber}`, `REASONING_${requestNumber}`, `ANSWER_${requestNumber}`),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } }
      )
    })
    const model = createConversationModel({
      ...baseModel,
      protocol: 'openai_responses',
      model: 'qwen-compatible-model',
      stream: true
    }, { providerFetch })

    let reasoning = ''
    const message = (await model.invoke({ messages: [{ kind: 'user', content: 'FIRST' }], tools: [], signal: new AbortController().signal,
      observe: event => { if (event.kind === 'delta' && event.channel === 'reasoning') reasoning += event.text } })).message
    await model.invoke({ messages: [{ kind: 'user', content: 'FIRST' }, message, { kind: 'user', content: 'FOLLOW UP' }],
      tools: [], signal: new AbortController().signal })

    expect(reasoning).toBe('REASONING_1')
    expect(message.source!.metadata.output).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rs_resp_1', type: 'reasoning' }),
      expect.objectContaining({ id: 'msg_resp_1', type: 'message' })
    ]))
    expect(requestBodies[1].input).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'rs_resp_1', type: 'reasoning' }),
      expect.objectContaining({ id: 'msg_resp_1', type: 'message' }),
      expect.objectContaining({ role: 'user', content: 'FOLLOW UP' })
    ]))
  })
})
