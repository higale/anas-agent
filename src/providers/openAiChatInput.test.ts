import { describe, expect, it } from 'vitest'
import { chatContentPart, chatInput, openAiToolImageContent, type ChatInputMessage } from './openAiChatInput'

describe('native Chat Completions input', () => {
  it('places images after every result in their own batch without moving later user input', () => {
    const image = { type: 'image_url', image_url: { url: 'https://fixture/first.png', detail: 'high' } }
    const messages: ChatInputMessage[] = [
      { role: 'assistant', content: '', toolCalls: [{ id: 'first', name: 'view', args: {} }, { id: 'second', name: 'read', args: {} }] },
      { role: 'tool', toolCallId: 'first', name: 'view', content: [{ type: 'text', text: 'First' }, image] },
      { role: 'tool', toolCallId: 'second', content: 'Second' },
      { role: 'user', content: 'Continue' },
      { role: 'tool', toolCallId: 'third', content: [{ type: 'input_text', text: '' }, { type: 'input_image', image_url: 'https://fixture/third.png' }] }
    ]
    const before = structuredClone(messages)
    const output = chatInput(messages)
    expect(output.map(item => item.role)).toEqual(['assistant', 'tool', 'tool', 'user', 'user', 'tool', 'user'])
    expect(output[1]).toEqual({ role: 'tool', tool_call_id: 'first', name: 'view', content: [
      { type: 'text', text: 'First' }, { type: 'text', text: 'Tool images are attached after this tool result batch.' }
    ] })
    expect(output[2]).toEqual({ role: 'tool', tool_call_id: 'second', content: 'Second' })
    expect(output[3]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'Images returned by tool call first (view):' }, { type: 'text', text: 'First' },
      { type: 'image_url', image_url: { url: 'https://fixture/first.png' } }
    ] })
    expect(output[4]).toEqual({ role: 'user', content: 'Continue' })
    expect(output[6]).toEqual({ role: 'user', content: [
      { type: 'text', text: 'Images returned by tool call third (tool):' }, { type: 'text', text: '' },
      { type: 'image_url', image_url: { url: 'https://fixture/third.png' } }
    ] })
    expect(chatInput(messages)).toEqual(output)
    expect(messages).toEqual(before)
  })

  it('normalizes tool media without changing ordinary results or accepting invalid images', () => {
    expect(openAiToolImageContent([{ type: 'text', text: 'ordinary' }], false)).toBeUndefined()
    const source = [{ type: 'image', source_type: 'base64', mime_type: 'image/png', data: 'AA==' },
      { type: 'vendor_info', enabled: false, count: 0 }]
    const before = structuredClone(source)
    expect(openAiToolImageContent(source, true)).toEqual({ result: [
      { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'auto' },
      { type: 'input_text', text: JSON.stringify(source[1]) }
    ], attachments: [] })
    expect(source).toEqual(before)
    expect(() => chatInput([{ role: 'tool', toolCallId: 'bad', content: [{ type: 'image', source_type: 'url' }] }])).toThrow()
  })

  it('preserves call identity, argument values, names and raw invalid calls without changing history', () => {
    const messages: ChatInputMessage[] = [
      { role: 'user', name: 'author', content: '' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'call', name: 'edit', args: { zero: 0, disabled: false, list: [], text: '' } }] },
      { role: 'tool', toolCallId: 'call', content: 'done' },
      { role: 'assistant', content: '', rawToolCalls: [{ id: 'invalid', type: 'function', function: { name: 'edit', arguments: '{' } }] }
    ]
    const before = structuredClone(messages)
    expect(chatInput(messages)).toEqual([
      { role: 'user', name: 'author', content: '' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call', type: 'function', function: { name: 'edit', arguments: '{"zero":0,"disabled":false,"list":[],"text":""}' } }] },
      { role: 'tool', tool_call_id: 'call', content: 'done' },
      { role: 'assistant', content: '', tool_calls: messages[3].rawToolCalls }
    ])
    expect(messages).toEqual(before)
    expect(() => chatInput([{ role: 'assistant', content: '', toolCalls: [{ name: 'edit', args: {} }] }])).toThrow('require an ID')
  })

  it.each(['o1', 'o3-mini', 'gpt-5', 'gpt-5.2'])('uses the developer role for %s without rewriting explicit roles', model => {
    expect(chatInput([{ role: 'system', content: 'rules' }, { role: 'developer', content: 'explicit' }], model))
      .toEqual([{ role: 'developer', content: 'rules' }, { role: 'developer', content: 'explicit' }])
    expect(chatInput([{ role: 'system', content: 'rules' }], 'gpt-5-chat-latest')[0].role).toBe('system')
  })

  it('keeps native blocks and text metadata while excluding non-chat reasoning and tool-use blocks', () => {
    const native = { type: 'image_url', image_url: { url: 'https://fixture/image', detail: 'high' } }
    const text = { type: 'text', text: 'retained', cache_control: { type: 'ephemeral' } }
    expect(chatInput([{ role: 'user', content: [text, native, { type: 'thinking', thinking: 'hidden' }, { type: 'tool_use', input: {} }] }]))
      .toEqual([{ role: 'user', content: [text, native] }])
  })

  it('encodes media, including base64 data URLs, uploaded files and image detail', () => {
    const parts = [
      { type: 'image', source_type: 'base64', data: 'AA==', mime_type: 'image/png', metadata: { detail: 'high' } },
      { type: 'audio', source_type: 'url', url: 'data:audio/mp3;base64,BB==' },
      { type: 'file', source_type: 'base64', data: 'CC==', mime_type: 'application/pdf', metadata: { filename: '合同.pdf' } },
      { type: 'file', fileId: 'file-1' }
    ]
    expect(parts.map(chatContentPart)).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==', detail: 'high' } },
      { type: 'input_audio', input_audio: { data: 'BB==', format: 'mp3' } },
      { type: 'file', file: { file_data: 'data:application/pdf;base64,CC==', filename: '合同.pdf' } },
      { type: 'file', file: { file_id: 'file-1' } }
    ])
    expect(() => chatContentPart({ type: 'audio', source_type: 'url', url: 'https://fixture/sound.mp3' })).toThrow('base64')
    expect(() => chatContentPart({ type: 'file', source_type: 'url', url: 'https://fixture/file.pdf' })).toThrow('base64')
    expect(() => chatContentPart({ type: 'image', source_type: 'id', id: 'unsupported' })).toThrow('URL or base64')
  })

  it('retains assistant audio references and the original function protocol', () => {
    expect(chatInput([{ role: 'assistant', content: 'spoken', audio: { id: 'audio-1', expires_at: 42 },
      functionCall: { name: 'legacy', arguments: '{}' } }, { role: 'function', name: 'legacy', content: 'result' }]))
      .toEqual([
        { role: 'assistant', content: 'spoken', function_call: { name: 'legacy', arguments: '{}' } },
        { role: 'assistant', audio: { id: 'audio-1' } }, { role: 'function', name: 'legacy', content: 'result' }
      ])
  })

  it('honors an explicit media source instead of falling back to conflicting fields', () => {
    expect(chatContentPart({ type: 'image', source_type: 'base64', data: 'AA==', mime_type: 'image/png', url: 'https://unused/image' }))
      .toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } })
    expect(chatContentPart({ type: 'audio', source_type: 'base64', data: 'AA==', mime_type: 'audio/wav', url: 'data:audio/mp3;base64,BB==' }))
      .toEqual({ type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } })
    expect(() => chatContentPart({ type: 'file', source_type: 'url', url: 'https://fixture/file', data: 'AA==' })).toThrow('base64')
    expect(() => chatContentPart({ type: 'audio', source_type: 'url', url: 'https://fixture/audio', data: 'AA==', mime_type: 'audio/wav' })).toThrow('base64')
  })
})
