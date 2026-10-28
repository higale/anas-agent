import { describe, expect, it } from 'vitest'
import { AnthropicResponseAccumulator, collectAnthropicMessage, type AnthropicNativeEvent } from './anthropicStream'
import { IncompleteModelResponseError } from '../runtime/errors'

const start = { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [],
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 2, cache_read_input_tokens: 3 } } }
async function* source(events: unknown[]) { yield* events as AnthropicNativeEvent[] }

describe('native Anthropic response aggregation', () => {
  it('retains reasoning signatures, tool input, citations, beta compaction and cumulative usage', async () => {
    const citation = { type: 'web_search_result_location', url: 'https://fixture', title: 'source', encrypted_index: 'opaque', cited_text: 'answer' }
    const events = [start,
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: 'pre-', signature: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'plan' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'old' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signed' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'call', name: 'edit', input: {}, caller: { type: 'direct' } } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"enabled":' } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'false,"text":"中文"}' } },
      { type: 'content_block_stop', index: 1 },
      { type: 'content_block_start', index: 2, content_block: { type: 'text', text: 'answer' } },
      { type: 'content_block_delta', index: 2, delta: { type: 'citations_delta', citation } },
      { type: 'content_block_stop', index: 2 },
      { type: 'content_block_start', index: 3, content_block: { type: 'compaction', content: '' } },
      { type: 'content_block_delta', index: 3, delta: { type: 'compaction_delta', content: 'compressed ' } },
      { type: 'content_block_delta', index: 3, delta: { type: 'compaction_delta', content: 'context' } },
      { type: 'content_block_stop', index: 3 },
      { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null, context_management: { applied_edits: [] } }, usage: { output_tokens: 5 } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 0, cost: 0 } },
      { type: 'message_stop' }
    ]
    const before = structuredClone(events)
    const result = await collectAnthropicMessage(source(events))
    expect(result.content).toEqual([
      { type: 'thinking', thinking: 'pre-plan', signature: 'signed' },
      { type: 'tool_use', id: 'call', name: 'edit', input: { enabled: false, text: '中文' }, caller: { type: 'direct' } },
      { type: 'text', text: 'answer', citations: [citation] }, { type: 'compaction', content: 'compressed context' }
    ])
    expect(result.usage).toEqual({ input_tokens: 10, output_tokens: 0, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, cost: 0 })
    expect(result).toMatchObject({ context_management: { applied_edits: [] }, stop_reason: 'tool_use' })
    expect(events).toEqual(before)
  })

  it('rejects malformed JSON without treating the text as a literal string argument', async () => {
    await expect(collectAnthropicMessage(source([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'bad', name: 'edit', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{broken' } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_stop' }
    ]))).rejects.toThrow('malformed tool input JSON')
  })

  it.each(['null', '[]', 'false', '5', '"{broken"'])('preserves parsed non-object input %s for preflight correction', async input => {
    const result = await collectAnthropicMessage(source([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'call', name: 'edit', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: input } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_stop' }
    ]))
    expect(result.content[0]).toMatchObject({ input: JSON.parse(input) })
  })

  it.each([
    [start],
    [start, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'partial' } }, { type: 'message_stop' }]
  ].map(events => ({ events })))('rejects incomplete output: $events.length events', async ({ events }) => {
    await expect(collectAnthropicMessage(source(events))).rejects.toBeInstanceOf(IncompleteModelResponseError)
  })

  it.each([
    [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'orphan' } }],
    [start, start],
    [start, { type: 'content_block_stop', index: 0 }],
    [start, { type: 'message_stop' }, { type: 'message_stop' }]
  ].map(events => ({ events })))('rejects invalid event ordering without inventing blocks: $events.length events', async ({ events }) => {
    await expect(collectAnthropicMessage(source(events))).rejects.toThrow('Anthropic')
  })

  it('closes the source if a progress consumer fails', async () => {
    let closed = false
    async function* stream() { try { yield start as AnthropicNativeEvent; yield { type: 'message_stop' } as const } finally { closed = true } }
    const failure = new Error('Consumer stopped')
    await expect(collectAnthropicMessage(stream(), () => { throw failure })).rejects.toBe(failure)
    expect(closed).toBe(true)
    expect(() => new AnthropicResponseAccumulator().result()).toThrow(IncompleteModelResponseError)
  })
})
