import { describe, expect, it } from 'vitest'
import { conversationResponsesInput } from './conversationInput'
import { encodeConversationMessage, decodeConversationMessage } from '../runtime/conversationStorage'

describe('Responses conversation input', () => {
  it('replays saved provider output without interpreting presentation blocks', () => {
    const output = [{ type: 'message', id: 'msg', role: 'assistant', content: [{ type: 'output_text', text: 'saved', annotations: [] }] }]
    const message = { kind: 'assistant' as const, content: '', source: { contentFormat: 'portable' as const, metadata: { output }, extras: {} } }
    expect(conversationResponsesInput([message], { model: 'fixture', zeroRetention: false })).toEqual(output)
  })
  it.each([false, true])('retains raw replay and custom result identity after serialization (zero retention: %s)', zdrEnabled => {
    const output = [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: 'plan' }] },
      { type: 'custom_tool_call', id: 'ct_1', call_id: 'call_1', name: 'apply_patch', input: 'raw patch\n' }
    ]
    const message = decodeConversationMessage(encodeConversationMessage({ kind: 'assistant' as const, content: [{ type: 'text', text: 'presentation only' }], calls: [{ id: 'call_1', name: 'apply_patch', args: { input: 'raw patch\n' } }], source: { contentFormat: 'portable' as const, provider: 'openai', metadata: { output }, extras: {} } }))
    const result = { kind: 'tool' as const, content: 'NOT EXECUTED', resultFor: 'call_1', resultStatus: 'error' as const, source: { contentFormat: 'portable' as const, metadata: {}, extras: {} } }
    const snapshot = [structuredClone(message), structuredClone(result)]
    const projected = conversationResponsesInput([message, result], { model: 'fixture', zeroRetention: zdrEnabled })
    expect(projected).toEqual([
      { type: 'reasoning', ...(!zdrEnabled ? { id: 'rs_1' } : {}), encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: 'plan' }] },
      { type: 'custom_tool_call', ...(!zdrEnabled ? { id: 'ct_1' } : {}), call_id: 'call_1', name: 'apply_patch', input: 'raw patch\n' },
      { type: 'custom_tool_call_output', call_id: 'call_1', output: 'NOT EXECUTED' }
    ])
    expect([structuredClone(message), structuredClone(result)]).toEqual(snapshot)
  })

  it('keeps a standard tool result paired with its call instead of treating it as assistant text', () => {
    const call = { kind: 'assistant' as const, content: [{ type: 'tool_call', id: 'fn', name: 'find', args: { query: 'test' } }], calls: [{ id: 'fn', name: 'find', args: { query: 'test' } }], source: { contentFormat: 'portable' as const, metadata: {}, extras: {} } }
    const result = { kind: 'tool' as const, content: 'found', resultFor: 'fn', source: { contentFormat: 'portable' as const, metadata: {}, extras: {} } }
    expect(conversationResponsesInput([call, result], { model: 'fixture', zeroRetention: false }))
      .toEqual([{ type: 'function_call', call_id: 'fn', name: 'find', arguments: '{"query":"test"}' },
        { type: 'function_call_output', call_id: 'fn', output: 'found' }])
  })

  it('does not replay foreign opaque blocks or provider output attached to a user message', () => {
    const message = { kind: 'assistant' as const, content: [{ type: 'text', text: 'answer' }, { type: 'non_standard', value: { type: 'foreign', signature: 'not OpenAI' } }], source: { contentFormat: 'portable' as const, provider: 'anthropic', metadata: {}, extras: {} } }
    const user = { kind: 'user' as const, content: 'continue', source: { metadata: { output: [{ type: 'custom_tool_call', call_id: 'fake' }]}, extras: {} } }
    expect(conversationResponsesInput([message, user], { model: 'fixture', zeroRetention: false })).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
      { type: 'message', role: 'user', content: 'continue' }
    ])
  })

  it('preserves raw invalid arguments and the existing call item ID map', () => {
    const message = { kind: 'assistant' as const, content: '', source: { functionItemIds: { broken: 'fc_1' }, metadata: {}, extras: { tool_calls: [{ id: 'broken', type: 'function', function: { name: 'edit', arguments: '{' } }]}}}
    expect(conversationResponsesInput([message], { model: 'fixture', zeroRetention: false }))
      .toContainEqual({ type: 'function_call', call_id: 'broken', id: 'fc_1', name: 'edit', arguments: '{' })
  })

  it('maps portable system instructions consistently for reasoning models', () => {
    const system = { kind: 'system' as const, content: 'rules', source: { contentFormat: 'portable' as const, metadata: {}, extras: {} } }
    expect(conversationResponsesInput([system], { model: 'gpt-5', zeroRetention: false }))
      .toEqual([{ type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'rules' }] }])
  })
})
