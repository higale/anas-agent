import { contentText } from '../runtime/inputContent'
import { describe, expect, it } from 'vitest'
import type { ConversationMessage } from '../runtime/conversationMessage'
import { conversationAnthropicInput, conversationChatInput, conversationResponsesInput, conversationContentBlocks } from './conversationInput'

const importedContentSamples = [
  { content: '', blocks: [ { type: 'text', text: '' } ], text: '' },
  { content: 'text', blocks: [ { type: 'text', text: 'text' } ], text: 'text' },
  { content: [], blocks: [], text: '' },
  {
    content: [ { type: 'text', text: 'one' }, { type: 'text', text: 'two' } ],
    blocks: [ { type: 'text', text: 'one' }, { type: 'text', text: 'two' } ],
    text: 'onetwo'
  },
  {
    content: [ { type: 'image_url', image_url: { url: 'data:IMAGE/PNG;base64,AA==', detail: 'high' } } ],
    blocks: [ { type: 'image', mimeType: 'image/png', data: 'AA==' } ],
    text: ''
  },
  {
    content: [
      { type: 'image', source_type: 'base64', data: '', mime_type: '', metadata: { count: 0, enabled: false } }
    ],
    blocks: [ { type: 'image', mimeType: '', data: '', metadata: { count: 0, enabled: false } } ],
    text: ''
  },
  {
    content: [ { type: 'document', source: { type: 'text', data: 'document' } } ],
    blocks: [ { type: 'file', mimeType: 'text/plain', data: 'document' } ],
    text: ''
  },
  {
    content: [ { type: 'file', file: { file_id: 'id-only' } }, { type: 'file', file: { data: '', file_id: 'id' } } ],
    blocks: [ { type: 'file', file: { file_id: 'id-only' } }, { type: 'file', fileId: 'id' } ],
    text: ''
  },
  {
    content: [
      { type: 'input_audio', input_audio: { format: 'wav', data: 'AA==' } },
      { type: 'json', value: { enabled: false } }
    ],
    blocks: [ { type: 'audio', data: 'AA==', mimeType: 'audio/wav' }, { type: 'json', value: { enabled: false } } ],
    text: ''
  }
]

describe('native conversation requests', () => {
  it.each(importedContentSamples.map((sample, index) => ({ ...sample, index })))('preserves user, system and tool content sample $index', ({ content, blocks, text }) => {
    for (const kind of ['user', 'system', 'tool'] as const) {
      const message: ConversationMessage = { kind, content, ...(kind === 'tool' ? { resultFor: 'call' } : {}) }
      const before = structuredClone(message)
      expect(conversationContentBlocks(message)).toStrictEqual(blocks)
      expect(contentText(conversationContentBlocks(message))).toBe(text)
      expect(message).toEqual(before)
    }
  })


  it('keeps foreign provider blocks out of Anthropic requests while preserving calls and stored content', () => {
    const messages: ConversationMessage[] = [{ kind: 'assistant', content: [
      { type: 'reasoning', reasoning: 'private plan', encrypted_content: 'opaque' }, { type: 'text', text: 'Read the file' }
    ], calls: [{ id: 'read', name: 'read_file', args: { path: 'a.ts' } }],
    source: { provider: 'openai', metadata: {}, extras: {} } },
    { kind: 'tool', resultFor: 'read', content: 'contents' }]
    const original = structuredClone(messages)
    const output = conversationAnthropicInput(messages)
    expect(output.messages[0].content).toEqual([
      { type: 'text', text: 'Read the file' }, { type: 'tool_use', id: 'read', name: 'read_file', input: { path: 'a.ts' } }
    ])
    expect(output.messages[1].content).toEqual([{ type: 'tool_result', tool_use_id: 'read', content: 'contents' }])
    expect(messages).toEqual(original)
  })

  it.each([false, true])('replays complete Responses output and pairs custom results (zero retention: %s)', zeroRetention => {
    const messages: ConversationMessage[] = [
      { kind: 'assistant', content: 'display only', calls: [{ id: 'call', name: 'patch', args: { input: 'patch\n' } }],
        source: { provider: 'openai', contentFormat: 'portable', extras: {}, metadata: { output: [
          { type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] },
          { type: 'custom_tool_call', id: 'item', call_id: 'call', name: 'patch', input: 'patch\n' }
        ] } } },
      { kind: 'tool', resultFor: 'call', resultStatus: 'error', content: 'not executed' }
    ]
    const before = structuredClone(messages)
    expect(conversationResponsesInput(messages, { model: 'fixture', zeroRetention })).toEqual([
      { type: 'reasoning', ...(!zeroRetention ? { id: 'reason' } : {}), encrypted_content: 'opaque', summary: [] },
      { type: 'custom_tool_call', ...(!zeroRetention ? { id: 'item' } : {}), call_id: 'call', name: 'patch', input: 'patch\n' },
      { type: 'custom_tool_call_output', call_id: 'call', output: 'not executed' }
    ])
    expect(messages).toEqual(before)
  })

  it('keeps complete tool batches before their image attachment and the next user input', () => {
    const messages: ConversationMessage[] = [
      { kind: 'assistant', content: '', calls: [{ id: 'view', name: 'view', args: {} }, { id: 'read', name: 'read', args: {} }] },
      { kind: 'tool', resultFor: 'view', content: [{ type: 'image_url', image_url: { url: 'https://fixture/image.png' } }],
        source: { contentFormat: 'portable', extras: {}, metadata: {} } },
      { kind: 'tool', resultFor: 'read', content: '' }, { kind: 'user', content: 'continue' }
    ]
    const before = structuredClone(messages)
    const output = conversationChatInput(messages)
    expect(output.map(item => item.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'user'])
    expect(output[3].content).toContainEqual({ type: 'image_url', image_url: { url: 'https://fixture/image.png' } })
    expect(output[4]).toEqual({ role: 'user', content: 'continue' })
    expect(messages).toEqual(before)
  })

  it('replays Anthropic reasoning with provenance and preserves an error tool result', () => {
    const messages: ConversationMessage[] = [
      { kind: 'system', content: 'rules' }, { kind: 'user', content: 'inspect' },
      { kind: 'assistant', content: [
        { type: 'reasoning', reasoning: 'plan', signature: 'signature' },
        { type: 'tool_call', id: 'call', name: 'read', args: { offset: 0 } },
        { type: 'non_standard', value: { type: 'redacted_thinking', data: 'opaque' } }
      ], calls: [{ id: 'call', name: 'read', args: { offset: 0 } }],
      source: { provider: 'anthropic', contentFormat: 'portable', extras: {}, metadata: {} } },
      { kind: 'tool', resultFor: 'call', resultStatus: 'error', content: 'denied' }
    ]
    const before = structuredClone(messages)
    const output = conversationAnthropicInput(messages)
    expect(output.system).toBe('rules')
    expect(output.messages[1].content).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'signature' },
      { type: 'tool_use', id: 'call', name: 'read', input: { offset: 0 } },
      { type: 'redacted_thinking', data: 'opaque' }
    ])
    expect(output.messages[2].content).toEqual([{ type: 'tool_result', tool_use_id: 'call', content: 'denied', is_error: true }])
    expect(messages).toEqual(before)
  })

  it('retains protocol-specific role support', () => {
    const message: ConversationMessage = { kind: 'custom', role: 'developer', content: 'rules' }
    expect(conversationChatInput([message])).toEqual([{ role: 'developer', content: 'rules' }])
    expect(() => conversationAnthropicInput([message])).toThrow('Unsupported Anthropic message role: generic')
  })
})
