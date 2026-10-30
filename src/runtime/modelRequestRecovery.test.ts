import { expect, it } from 'vitest'
import type { ConversationMessage } from './conversationMessage'
import { canRetryModelRequest, isCompleteModelInput, lastToolResultBatch, modelRetryTodos, withholdToolResult, withheldToolResultText } from './modelRequestRecovery'
import { conversationAnthropicInput, conversationChatInput, conversationResponsesInput } from '../providers/conversationInput'

const messages: ConversationMessage[] = [
  { id: 'input', kind: 'user', content: 'Task' },
  { id: 'assistant', kind: 'assistant', content: [
    { type: 'thinking', thinking: 'Saved reasoning', signature: 'signature' },
    { type: 'tool_use', id: 'call', name: 'view_image', input: { path: '/image.png' } }
  ], calls: [{ id: 'call', name: 'view_image', args: { path: '/image.png' } }],
  source: { provider: 'anthropic', metadata: {}, extras: {} } },
  { id: 'result', kind: 'tool', name: 'view_image', resultFor: 'call', resultStatus: 'success', content: [
    { type: 'text', text: 'PRIVATE_TOOL_OUTPUT' }, { type: 'image', mimeType: 'image/png', data: 'original-bytes' }
  ] }
]

it('selects only a complete last batch only before another user input or assistant response', () => {
  expect(lastToolResultBatch(messages)).toEqual(['result'])
  expect(lastToolResultBatch(messages.slice(0, -1))).toEqual([])
  expect(lastToolResultBatch([...messages, { kind: 'assistant', content: 'Read it' }])).toEqual([])
  expect(lastToolResultBatch([...messages, { kind: 'user', content: 'Continue' }])).toEqual([])
  expect(lastToolResultBatch([...messages, { kind: 'user', content: 'Direction', context: { directionAfterCallIds: ['call'] } }])).toEqual([])
})

it('serializes the replacement result in every protocol while preserving call identity and thinking', () => {
  const copy = structuredClone(messages)
  const projected = messages.map(message => message.kind === 'tool' ? withholdToolResult(message) : message)
  expect(projected[1]).toBe(messages[1])
  for (const request of [conversationAnthropicInput(projected), conversationChatInput(projected),
    conversationResponsesInput(projected, { model: 'model', zeroRetention: false })]) {
    const encoded = JSON.stringify(request)
    expect(encoded).toContain(withheldToolResultText)
    expect(encoded).toContain('call')
    expect(encoded).not.toContain('PRIVATE_TOOL_OUTPUT')
    expect(encoded).not.toContain('original-bytes')
  }
  expect(JSON.stringify(conversationAnthropicInput(projected))).toContain('signature')
  expect(messages).toEqual(copy)
})

it('offers old saved failures only at a model boundary, and respects explicit non-model failures', () => {
  const state = { phase: 'failed' as const, context: { modelCalls: 1, todos: [] } }
  expect(canRetryModelRequest(state)).toBe(true)
  expect(canRetryModelRequest({ ...state, response: { id: 'response', recordId: 'record', value: messages[1] } })).toBe(false)
  expect(canRetryModelRequest({ ...state, context: { ...state.context, modelRequestFailed: false } })).toBe(false)
  expect(canRetryModelRequest({ ...state, phase: 'cancelled' })).toBe(false)
})

it('recovers legacy historical errors only after complete model input', () => {
  expect(isCompleteModelInput(messages)).toBe(true)
  expect(isCompleteModelInput(messages.slice(0, 1))).toBe(true)
  expect(isCompleteModelInput(messages.slice(0, -1))).toBe(false)
  expect(isCompleteModelInput([...messages.slice(0, -1), { kind: 'user', content: 'Continue' }])).toBe(false)
  expect(isCompleteModelInput([...messages, { kind: 'assistant', content: 'Done' }])).toBe(false)
  expect(isCompleteModelInput([...messages, { kind: 'assistant', content: 'Partial', partial: true }])).toBe(false)
  expect(isCompleteModelInput([...messages, ...messages.slice(1)])).toBe(true)
})

it('restores the last successful plan, including an explicit empty plan, without reading result text', () => {
  const todos = [{ content: 'Retained work', status: 'in_progress' as const }]
  const batch = (args: unknown, status: 'success' | 'error', withheld = false): ConversationMessage[] => {
    const result: ConversationMessage = { kind: 'tool', resultFor: 'reused-id', resultStatus: status, content: 'Not a serialized plan' }
    return [{ kind: 'assistant', content: '', calls: [{ id: 'reused-id', name: 'write_todos', args }] },
      withheld ? withholdToolResult(result) : result]
  }
  const saved = batch({ todos }, 'success', true)
  expect(modelRetryTodos([...saved, { kind: 'user', content: 'Keep going', context: { directionAfterCallIds: ['reused-id'] } }])).toEqual(todos)
  expect(modelRetryTodos([...saved, ...batch({ todos: 'invalid' }, 'error', true)])).toEqual(todos)
  expect(modelRetryTodos([...saved, ...batch({ todos: [] }, 'success', true)])).toEqual([])
  expect(modelRetryTodos(batch({ todos }, 'error'))).toEqual([])
  expect(modelRetryTodos(saved.slice(0, -1))).toEqual([])
  expect(modelRetryTodos([{ kind: 'user', content: 'No plan in this run' }])).toEqual([])
  expect(() => modelRetryTodos(batch({ todos: 'invalid' }, 'success'))).toThrow()
})
