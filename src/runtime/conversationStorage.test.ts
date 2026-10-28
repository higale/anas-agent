import { describe, expect, it } from 'vitest'
import type { ConversationMessage } from './conversationMessage'
import { decodeConversationMessage, encodeConversationMessage } from './conversationStorage'
import { decodeExecutionValue, encodeExecutionValue } from './executionValue'
import { conversationAnthropicInput, conversationChatInput, conversationResponsesInput } from '../providers/conversationInput'

describe('native conversation storage', () => {
  it('retains complete messages and request behavior across encoding without a message class', () => {
    const messages: ConversationMessage[] = [
      { id: 'input', kind: 'user', content: [{ type: 'text', text: 'inspect' }], context: { runId: 'run', displayText: '', attachmentBlockCount: 0 } },
      { id: 'response', kind: 'assistant', content: '', calls: [{ id: 'call', name: 'read', args: { enabled: false, limit: 0, list: [] }, itemId: 'item' }],
        invalidCalls: [{ id: 'bad', args: '{' }], usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        source: { provider: 'openai', extras: {}, metadata: { output: [
          { type: 'function_call', id: 'item', call_id: 'call', name: 'read', arguments: '{"enabled":false,"limit":0,"list":[]}' }
        ] }, functionItemIds: { call: 'item' } } },
      { id: 'result', kind: 'tool', content: 'visible', resultFor: 'call', resultStatus: 'success',
        artifact: { full: 'complete result', bytes: new Uint8Array([0, 255]), values: new Map([['x', new Set([false, 0])]]),
          marker: { lc: 2, type: 'constructor', id: ['Uint8Array'], args: [[255]] }, missing: undefined } }
    ]
    const before = structuredClone(messages)
    const restored = messages.map(message => decodeConversationMessage(encodeConversationMessage(message)))
    expect(restored).toEqual(messages)
    expect(conversationChatInput(restored)).toEqual(conversationChatInput(messages))
    expect(conversationResponsesInput(restored, { model: 'fixture', zeroRetention: false }))
      .toEqual(conversationResponsesInput(messages, { model: 'fixture', zeroRetention: false }))
    expect(conversationAnthropicInput(restored)).toEqual(conversationAnthropicInput(messages))
    expect(messages).toEqual(before)
    expect(decodeExecutionValue(encodeConversationMessage(messages[0]))).toEqual({ id: 'input', kind: 'user', content: messages[0].content,
      context: { run_id: 'run', display_text: '', attachment_block_count: 0 } })
    expect(decodeExecutionValue(encodeConversationMessage(messages[1]))).toMatchObject({ invalid_calls: [{ id: 'bad', args: '{' }],
      calls: [{ item_id: 'item' }], source: { function_item_ids: { call: 'item' } } })
  })

  it('preserves absence, explicit undefined and independently owned metadata and artifacts', () => {
    const original: ConversationMessage = { kind: 'tool', resultFor: 'call', content: '', artifact: new Uint8Array([1]),
      context: { unrecordedResult: false, summaryId: undefined }, source: { metadata: {}, extras: { customField: false } } }
    const bytes = encodeConversationMessage(original)
    ;(original.artifact as Uint8Array)[0] = 9
    original.source!.extras.customField = true
    const restored = decodeConversationMessage(bytes)
    expect(restored.artifact).toEqual(new Uint8Array([1]))
    expect(restored.source!.extras).toEqual({ customField: false })
    expect(Object.hasOwn(restored.context!, 'summaryId')).toBe(true)
    expect(Object.hasOwn(restored, 'id')).toBe(false)
  })

  it.each([
    { kind: 'user' }, { kind: 'tool', content: '' }, { kind: 'future', content: '' },
    { kind: 'assistant', content: '', calls: [{ name: 'read' }] },
    { kind: 'user', content: '', unknown_field: true },
    { kind: 'user', content: '', context: { displayText: '' } },
    { kind: 'user', content: '', source: { metadata: {}, extras: {}, content_format: 'future' } }
  ])('reports malformed stored message %j instead of resetting it', value => {
    expect(() => decodeConversationMessage(encodeExecutionValue(value))).toThrow('Invalid conversation message')
  })

  it.each([null, [], false, 0, 'wrong'].map(args => ({ args })))('retains raw tool input $args across storage and provider replay', ({ args }) => {
    const message: ConversationMessage = { kind: 'assistant', content: '', calls: [{ id: 'call', name: 'read', args }] }
    const restored = decodeConversationMessage(encodeConversationMessage(message))
    expect(restored).toEqual(message)
    expect(conversationChatInput([restored])).toMatchObject([{ tool_calls: [{ function: { arguments: JSON.stringify(args) } }] }])
    expect(conversationResponsesInput([restored], { model: 'fixture', zeroRetention: false })).toEqual(expect.arrayContaining([expect.objectContaining({ arguments: JSON.stringify(args) })]))
    expect(conversationAnthropicInput([restored])).toMatchObject({ messages: [{ content: [{ input: args }] }] })
  })

  it('does not accept a framework-shaped object as a native message', () => {
    class ExternalMessage { kind = 'user'; content = '' }
    expect(() => encodeConversationMessage(new ExternalMessage() as ConversationMessage)).toThrow('expected a data object')
  })
})
