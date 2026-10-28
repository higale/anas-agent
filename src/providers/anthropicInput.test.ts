import { describe, expect, it } from 'vitest'
import { anthropicContent, anthropicInput, anthropicPortableContent, type AnthropicInputMessage } from './anthropicInput'

describe('native Anthropic input', () => {
  it('keeps the system prefix, groups tool results and retains error outcomes without mutating history', () => {
    const input: AnthropicInputMessage[] = [
      { role: 'system', content: [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }] },
      { role: 'user', content: 'inspect' }, { role: 'assistant', content: '', calls: [{ id: 'a', name: 'read', args: { offset: 0 } }, { id: 'b', name: 'edit', args: { dry: false } }] },
      { role: 'tool', toolCallId: 'a', content: 'result' }, { role: 'tool', toolCallId: 'b', content: 'denied', toolError: true },
      { role: 'user', content: 'continue' }
    ]
    const before = structuredClone(input)
    expect(anthropicInput(input)).toEqual({ system: input[0].content, messages: [
      { role: 'user', content: 'inspect' }, { role: 'assistant', content: [
        { type: 'tool_use', id: 'a', name: 'read', input: { offset: 0 } }, { type: 'tool_use', id: 'b', name: 'edit', input: { dry: false } }
      ] }, { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: 'result' }, { type: 'tool_result', tool_use_id: 'b', content: 'denied', is_error: true }
      ] }, { role: 'user', content: 'continue' }
    ] })
    expect(input).toEqual(before)
    expect(() => anthropicInput([{ role: 'user', content: 'hello' }, { role: 'system', content: 'late' }])).toThrow('beginning')
  })

  it('encodes each media block once and preserves document controls and explicit source choices', () => {
    expect(anthropicContent([
      { type: 'image', source_type: 'base64', data: 'AA==', mime_type: 'image/png', url: 'https://unused' },
      { type: 'image_url', image_url: { url: 'https://fixture/image.png' } },
      { type: 'file', source_type: 'text', text: 'plain', metadata: { title: '', citations: { enabled: false }, context: 'context' } },
      { type: 'file', fileId: 'file-1' }
    ])).toEqual([
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } },
      { type: 'image', source: { type: 'url', url: 'https://fixture/image.png' } },
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: 'plain' }, title: '', citations: { enabled: false }, context: 'context' },
      { type: 'document', source: { type: 'file', file_id: 'file-1' } }
    ])
    expect(() => anthropicContent([{ type: 'image', source_type: 'id', data: 'AA==' }])).toThrow('file ID')
    expect(() => anthropicContent([{ type: 'image_url', image_url: 'file:///private/image.png' }])).toThrow('HTTP')
    expect(() => anthropicContent([{ type: 'audio', data: 'AA==' }])).toThrow('audio')
  })

  it('keeps native tool fields, assembles old chunks once and rejects malformed arguments', () => {
    const content = [{ type: 'server_tool_use', id: 'server', name: 'code_execution', input: '', index: 0, caller: { type: 'direct' } },
      { type: 'input_json_delta', index: 0, input: '{"code":"print(0)"}' }]
    expect(anthropicContent(content)).toEqual([{ type: 'server_tool_use', id: 'server', name: 'code_execution', input: { code: 'print(0)' }, caller: { type: 'direct' } }])
    expect(() => anthropicContent([{ type: 'tool_use', id: 'bad', name: 'edit', input: '{' }])).toThrow()
    expect(anthropicInput([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'edit', input: '{}' }], calls: [{ id: 'call', name: 'edit', args: { corrected: true } }] }]).messages)
      .toEqual([{ role: 'assistant', content: [{ type: 'tool_use', id: 'call', name: 'edit', input: { corrected: true } }] }])
  })

  it('replays signatures and native fields only for matching provider provenance', () => {
    const blocks = [
      { type: 'reasoning', reasoning: 'plan', signature: 'signature' },
      { type: 'tool_call', id: 'call', name: 'edit', args: { enabled: false }, extras: { anthropic: { caller: { type: 'direct' } } } },
      { type: 'non_standard', value: { type: 'redacted_thinking', data: 'opaque' } }
    ]
    expect(anthropicPortableContent(blocks, true)).toEqual([
      { type: 'thinking', thinking: 'plan', signature: 'signature' },
      { type: 'tool_use', id: 'call', name: 'edit', input: { enabled: false }, caller: { type: 'direct' } },
      { type: 'redacted_thinking', data: 'opaque' }
    ])
    expect(anthropicPortableContent(blocks, false)).toEqual([{ type: 'tool_use', id: 'call', name: 'edit', input: { enabled: false } }])
  })
})
