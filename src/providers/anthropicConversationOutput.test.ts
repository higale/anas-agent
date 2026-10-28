import { describe, expect, it } from 'vitest'
import { encodeConversationMessage, decodeConversationMessage } from '../runtime/conversationStorage'
import { anthropicConversationResponse } from './conversationOutput'
import { streamAnthropicConversation, type ConversationProgress } from './conversationStream'
import { conversationAnthropicInput } from './conversationInput'
import { collectAnthropicMessage, type AnthropicNativeEvent } from './anthropicStream'

const events = [
  { type: 'message_start', message: { type: 'message', id: 'message', role: 'assistant', model: 'fixture', content: [],
    stop_reason: null, stop_sequence: null, usage: { input_tokens: 4, output_tokens: 0, cache_read_input_tokens: 2 } } },
  { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: 'initial' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'obsolete' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'final-signature' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call', name: 'read', input: {}, caller: { type: 'direct' } } },
  { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"a.txt"}' } },
  { type: 'content_block_stop', index: 1 },
  { type: 'content_block_start', index: 2, content_block: { type: 'compaction', content: '' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'compaction_delta', content: 'compressed ' } },
  { type: 'content_block_delta', index: 2, delta: { type: 'compaction_delta', content: 'context' } },
  { type: 'content_block_stop', index: 2 },
  { type: 'content_block_start', index: 3, content_block: { type: 'text', text: '', citations: [] } },
  { type: 'content_block_delta', index: 3, delta: { type: 'text_delta', text: 'answer' } },
  { type: 'content_block_delta', index: 3, delta: { type: 'citations_delta', citation: { type: 'web_search_result_location', url: 'https://fixture', title: 'source', encrypted_index: 'opaque', cited_text: 'answer' } } },
  { type: 'content_block_stop', index: 3 },
  { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 6 } },
  { type: 'message_stop' }
]
async function* source(input: unknown[] = events) { yield* structuredClone(input) as AnthropicNativeEvent[] }


describe('native Anthropic response persistence', () => {
  it('keeps absent usage unknown in complete and streaming results', async () => {
    const input = events.map(event => event.type === 'message_start'
      ? { ...event, message: { ...event.message, usage: undefined } } : { ...event, usage: undefined })
    const direct = anthropicConversationResponse(await collectAnthropicMessage(source(input)))
    const streamed = await streamAnthropicConversation(source(input), () => {})
    expect(direct.message.usage).toBeUndefined(); expect(streamed.message.usage).toBeUndefined()
  })

  it.each(['complete', 'stream'] as const)('keeps complete content through %s, storage and the next request', async mode => {
    const response = mode === 'complete' ? anthropicConversationResponse(await collectAnthropicMessage(source()))
      : await streamAnthropicConversation(source(), () => {})
    expect(response.message).toMatchObject({ calls: [{ id: 'call', name: 'read', args: { path: 'a.txt' } }],
      usage: { input_tokens: 6, output_tokens: 6, total_tokens: 12 } })
    const restored = decodeConversationMessage(encodeConversationMessage(response.message))
    expect(conversationAnthropicInput([restored]).messages).toEqual([{ role: 'assistant', content: [
      { type: 'thinking', thinking: 'plan', signature: 'final-signature' },
      { type: 'tool_use', id: 'call', name: 'read', input: { path: 'a.txt' }, caller: { type: 'direct' } },
      { type: 'compaction', content: 'compressed context' },
      { type: 'text', text: 'answer', citations: [{ type: 'web_search_result_location', url: 'https://fixture', title: 'source', encrypted_index: 'opaque', cited_text: 'answer' }] }
    ] }])
  })

  it('rejects malformed encoded JSON without converting it to a literal string or empty arguments', async () => {
    const input = structuredClone(events)
    input.find(event => event.type === 'content_block_delta' && event.index === 1)!.delta = { type: 'input_json_delta', partial_json: '{' }
    await expect(collectAnthropicMessage(source(input))).rejects.toThrow('Anthropic returned malformed tool input JSON')
    const progress: ConversationProgress[] = []
    await expect(streamAnthropicConversation(source(input), event => progress.push(event))).rejects.toThrow('Anthropic returned malformed tool input JSON')
    expect(progress.filter(event => event.kind === 'tool_input' && event.progress.complete)).toEqual([])
  })

  it('emits text once while retaining final provider metadata', async () => {
    const progress: ConversationProgress[] = []
    const response = await streamAnthropicConversation(source(), event => progress.push(event))
    expect(progress.filter(event => event.kind === 'delta' && event.channel === 'text')).toEqual([{ kind: 'delta', channel: 'text', text: 'answer' }])
    expect(response.message.source).toMatchObject({ provider: 'anthropic', metadata: { stop_reason: 'tool_use' } })
  })
})
