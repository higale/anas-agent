import type OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import { encodeConversationMessage, decodeConversationMessage } from '../runtime/conversationStorage'
import { OpenAiChatCompletions } from './openAiChatCompletions'
import { collectChatCompletion } from './chatCompletionStream'
import { openAiChatConversationResponses } from './conversationOutput'
import { streamChatConversation, type ConversationProgress } from './conversationStream'
import { conversationChatInput, conversationContentBlocks } from './conversationInput'

type Frame = OpenAI.Chat.ChatCompletionChunk
const header = { id: 'completion', object: 'chat.completion.chunk', model: 'fixture', created: 1 }
const usage = { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 2 },
  completion_tokens_details: { reasoning_tokens: 0 } }
const updates = [
  { role: 'assistant', reasoning_content: 'Think ', content: 'An', tool_calls: [
    { index: 0, id: 'read', type: 'function', function: { name: 'read', arguments: '{"limit":' } },
    { index: 3, id: 'custom', type: 'custom', custom: { name: 'patch', input: 'first ' } }
  ], audio: { id: 'audio', data: 'YW', transcript: 'audio ' } },
  { content: 'swer', reasoning_content: 'first', tool_calls: [
    { index: 0, id: '', function: { name: '', arguments: '0}' } }, { index: 3, custom: { input: 'line' } }
  ], audio: { data: 'Jj', transcript: 'text', expires_at: 50 } }
]
async function* frames(input: unknown[] = updates): AsyncGenerator<Frame> {
  for (const delta of input) yield { ...header, choices: [{ index: 0, delta, finish_reason: null }] } as Frame
  yield { ...header, choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage } as Frame
}


describe('native Chat Completions response persistence', () => {
  it('retains each log probability once through the SDK stream', async () => {
    const wire: Frame[] = []
    for await (const frame of frames([{ role: 'assistant', content: 'A' }, { content: 'B' }])) {
      const text = frame.choices[0]?.delta.content
      wire.push({ ...frame, choices: frame.choices.map(choice => ({ ...choice,
        logprobs: text ? { content: [{ token: text, bytes: [], logprob: -1, top_logprobs: [] }], refusal: null } : null })) })
    }
    const provider = new OpenAiChatCompletions({ apiKey: 'fixture', baseURL: 'https://fixture.invalid/v1',
      fetch: async () => new Response(wire.map(frame => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n',
        { headers: { 'content-type': 'text/event-stream' } }) })
    const response = await streamChatConversation(provider.stream({ model: 'fixture', messages: [{ role: 'user', content: 'hello' }], logprobs: true }), () => {})
    expect(response.message.source?.metadata.logprobs).toMatchObject({ content: [{ token: 'A' }, { token: 'B' }] })
    expect(response.text).toBe('AB')
  })

  it.each(['complete', 'stream'] as const)('preserves function/custom calls, audio and usage through %s, storage and replay', async mode => {
    const response = mode === 'complete' ? openAiChatConversationResponses(await collectChatCompletion(frames()))[0]
      : await streamChatConversation(frames(), () => {})
    expect(response.text).toBe('Answer')
    expect(response.message.calls).toEqual([
      expect.objectContaining({ id: 'read', name: 'read', args: { limit: 0 } }),
      expect.objectContaining({ id: 'custom', name: 'patch', args: { input: 'first line' } })
    ])
    expect(response.message.usage).toMatchObject({ input_tokens: 5, output_tokens: 0, total_tokens: 5,
      input_token_details: { cache_read: 0, cache_creation: 2 }, output_token_details: { reasoning: 0 } })
    const restored = decodeConversationMessage(encodeConversationMessage(response.message))
    expect(conversationChatInput([restored])).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'Answer' }], tool_calls: [
        { id: 'read', type: 'function', function: { name: 'read', arguments: '{"limit":0}' } },
        { id: 'custom', type: 'custom', custom: { name: 'patch', input: 'first line' } }
      ] }, { role: 'assistant', audio: { id: 'audio' } }
    ])
  })

  it('emits text and reasoning once and selects choice zero with interleaved candidates', async () => {
    async function* source(): AsyncGenerator<Frame> {
      yield { ...header, choices: [{ index: 1, delta: { content: 'other' }, finish_reason: null },
        { index: 0, delta: { content: 'A', reasoning: 'plan' }, finish_reason: null }] } as Frame
      yield { ...header, choices: [{ index: 1, delta: { content: ' candidate' }, finish_reason: 'stop' }] } as Frame
      yield { ...header, choices: [{ index: 0, delta: { content: 'B' }, finish_reason: 'stop' }], usage } as Frame
    }
    const progress: ConversationProgress[] = [], response = await streamChatConversation(source(), event => progress.push(event))
    for (const [channel, expected] of [['text', 'AB'], ['reasoning', 'plan']]) {
      expect(progress.filter(event => event.kind === 'delta' && event.channel === channel).map(event => event.kind === 'delta' ? event.text : '').join('')).toBe(expected)
    }
    expect(response.text).toBe('AB')
    expect(openAiChatConversationResponses(await collectChatCompletion(source())).map(item => item.text)).toEqual(['AB', 'other candidate'])
  })

  it.each(['{', 'null', '[]', '1'])('preserves malformed and non-object arguments without replacing them: %s', async args => {
    const source = () => frames([{ tool_calls: [{ index: 0, id: 'bad', type: 'function', function: { name: 'read', arguments: args } }] }])
    const direct = openAiChatConversationResponses(await collectChatCompletion(source()))[0]
    const stream = await streamChatConversation(source(), () => {})
    for (const response of [direct, stream]) {
      const restored = decodeConversationMessage(encodeConversationMessage(response.message))
      if (args === '{') {
        expect(restored.calls).toEqual([])
        expect(restored.invalidCalls).toContainEqual(expect.objectContaining({ id: 'bad', args }))
      } else expect(restored.calls).toEqual([expect.objectContaining({ id: 'bad', args: JSON.parse(args) })])
    }
  })

  it('retains refusal and citations without replaying presentation metadata', () => {
    const response = { ...header, object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: {
      role: 'assistant', content: 'answer', refusal: 'refusal', annotations: [
        { type: 'url_citation', url_citation: { url: 'https://fixture', title: 'source', start_index: 0, end_index: 6 } }
      ] } }] } as OpenAI.Chat.ChatCompletion
    const message = openAiChatConversationResponses(response)[0].message
    expect(conversationContentBlocks(message)).toContainEqual(expect.objectContaining({ type: 'text', annotations: [
      { type: 'citation', url: 'https://fixture', title: 'source', startIndex: 0, endIndex: 6 }
    ] }))
    expect(conversationChatInput([decodeConversationMessage(encodeConversationMessage(message))])).toEqual([
      { role: 'assistant', content: [{ type: 'text', text: 'answer' }], refusal: 'refusal' }
    ])
    expect(message.usage).toBeUndefined()
  })
})
