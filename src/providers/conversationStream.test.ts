import { describe, expect, it } from 'vitest'
import type { AnthropicNativeEvent } from './anthropicStream'
import { streamAnthropicConversation, type ConversationProgress } from './conversationStream'

async function* source(events: unknown[]) { yield* events as AnthropicNativeEvent[] }
const start = { type: 'message_start', message: { id: 'response', type: 'message', role: 'assistant', model: 'fixture', content: [],
  stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } }
const finish = [{ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1 } }, { type: 'message_stop' }]

describe('native conversation stream display metadata', () => {
  it('publishes large tool argument counts without argument content while retaining executable input', async () => {
    const patch = 'HEAD' + 'x'.repeat(100000) + 'TAIL', args = JSON.stringify({ patch })
    const progress: ConversationProgress[] = []
    const result = await streamAnthropicConversation(source([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'patch', name: 'apply_patch', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(0, 20) } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: args.slice(20) } },
      { type: 'content_block_stop', index: 0 }, ...finish
    ]), event => progress.push(event))
    expect(progress).toContainEqual({ kind: 'tool_input', progress: expect.objectContaining({ characterCount: args.length, complete: false }) })
    expect(progress.at(-1)).toMatchObject({ kind: 'tool_input', progress: { callId: 'patch', name: 'apply_patch', complete: true } })
    expect(JSON.stringify(progress)).not.toContain('HEAD')
    expect(JSON.stringify(progress)).not.toContain('TAIL')
    for (const event of progress) if (event.kind === 'tool_input') expect(event.progress).not.toHaveProperty('args')
    expect(result.message.calls).toEqual([{ id: 'patch', name: 'apply_patch', args: { patch }, extensions: { type: 'tool_call' } }])
  })

  it('does not turn text or provider-owned server tools into host tool progress', async () => {
    const progress: ConversationProgress[] = []
    const result = await streamAnthropicConversation(source([start,
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Searching' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'content_block_start', index: 1, content_block: { type: 'server_tool_use', id: 'search', name: 'web_search', input: {} } },
      { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query":"fixture"}' } },
      { type: 'content_block_stop', index: 1 }, ...finish
    ]), event => progress.push(event))
    expect(progress).toEqual([{ kind: 'delta', channel: 'text', text: 'Searching' }])
    expect(result.message.calls).toEqual([])
    expect(JSON.stringify(result.message)).toContain('web_search')
  })
})
