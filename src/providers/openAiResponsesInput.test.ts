import { describe, expect, it } from 'vitest'
import { openAiToolImageContent } from './openAiChatInput'
import { responseAssistantInput, responseInput, responseInputContent, responsePortableInput, responseReplay, responseToolCall, responseToolResult, responseUserInput, type ResponseHistoryEntry } from './openAiResponsesInput'

describe('native Responses input', () => {
  it.each([false, true])('assembles complete native history and pairs custom image results with zero retention %s', zeroRetention => {
    const history: ResponseHistoryEntry[] = [
      { kind: 'message', role: 'system', content: 'rules', calls: [] },
      { kind: 'message', role: 'assistant', content: 'presentation', calls: [], output: [
        { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [] },
        { type: 'custom_tool_call', id: 'ct_1', call_id: 'call', name: 'inspect', input: 'screen' }
      ] },
      { kind: 'result', callId: 'call', resultKind: 'function', content: [
        { type: 'text', text: 'screen' }, { type: 'image_url', image_url: { url: 'https://fixture/screen.png' } }
      ] },
      { kind: 'message', role: 'user', content: 'continue', calls: [], output: [
        { type: 'custom_tool_call', call_id: 'untrusted-role', name: 'ignored', input: '' }
      ] },
      { kind: 'result', callId: 'untrusted-role', resultKind: 'function', content: 'ordinary' }
    ]
    const before = structuredClone(history)
    expect(responseInput(history, { model: 'gpt-5', zeroRetention })).toEqual([
      { type: 'message', role: 'developer', content: 'rules' },
      { type: 'reasoning', ...(!zeroRetention ? { id: 'rs_1' } : {}), encrypted_content: 'opaque', summary: [] },
      { type: 'custom_tool_call', ...(!zeroRetention ? { id: 'ct_1' } : {}), call_id: 'call', name: 'inspect', input: 'screen' },
      { type: 'custom_tool_call_output', call_id: 'call', output: [
        { type: 'input_text', text: 'screen' }, { type: 'input_image', image_url: 'https://fixture/screen.png', detail: 'auto' }
      ] },
      { type: 'message', role: 'user', content: 'continue' },
      { type: 'function_call_output', call_id: 'untrusted-role', output: 'ordinary' }
    ])
    expect(history).toEqual(before)
  })

  it('keeps portable input and explicit custom or computer results in their protocol forms', () => {
    expect(responseInput([
      { kind: 'message', role: 'assistant', content: '', calls: [{ kind: 'custom', id: 'custom', name: 'edit', args: { input: 'patch' } }],
        portable: { nativeProvider: false, blocks: [{ type: 'text', text: 'answer' },
          { type: 'tool_call', id: 'custom', name: 'edit', args: { input: 'patch' } }] } },
      { kind: 'result', callId: 'custom', resultKind: 'function', content: 'done' },
      { kind: 'result', callId: 'custom', resultKind: 'computer', content: [{ type: 'image_url', image_url: { url: 'https://fixture/screen.png' } }] },
      { kind: 'result', callId: 'explicit', resultKind: 'custom', content: '' }
    ], { model: 'fixture', zeroRetention: false })).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer', annotations: [] }] },
      { type: 'custom_tool_call', call_id: 'custom', name: 'edit', input: 'patch' },
      { type: 'custom_tool_call_output', call_id: 'custom', output: 'done' },
      { type: 'computer_call_output', call_id: 'custom', output: { type: 'input_image', image_url: 'https://fixture/screen.png', detail: 'auto' } },
      { type: 'custom_tool_call_output', call_id: 'explicit', output: '' }
    ])
    for (const role of ['function', 'critic']) expect(() => responseInput([
      { kind: 'message', role, content: '', calls: [] }
    ], { model: 'fixture', zeroRetention: false })).toThrow()
  })

  it.each(['function', 'custom', 'computer'] as const)('keeps %s tool images inline and encoding stable', kind => {
    const content = [{ type: 'text', text: 'Screen' }, { type: 'image_url', image_url: { url: 'https://fixture/screen.png', detail: 'high' } }]
    const before = structuredClone(content)
    const encoded = openAiToolImageContent(content, true)!.result
    const result = responseToolResult({ kind, callId: 'call-image', id: 'fc_image', content: encoded })
    const output = kind === 'computer' ? { type: 'input_image', image_url: 'https://fixture/screen.png', detail: 'auto' }
      : [{ type: 'input_text', text: 'Screen' }, { type: 'input_image', image_url: 'https://fixture/screen.png', detail: 'auto' }]
    expect(result).toEqual({ type: `${kind}_call_output`.replace('custom_call', 'custom_tool_call'), call_id: 'call-image', output,
      ...(kind === 'function' ? { id: 'fc_image' } : {}) })
    if (Array.isArray(output)) expect(responseToolResult({ kind, callId: 'call-image', id: 'fc_image', content: output })).toEqual(result)
    expect(openAiToolImageContent(encoded, true)?.result).toEqual(encoded)
    expect(content).toEqual(before)
  })

  it('replays opaque native items exactly and does not mutate source data', () => {
    const output = [
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: 'plan' }] },
      { type: 'message', id: 'msg_1', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'result', annotations: [] }] },
      { type: 'custom_tool_call', id: 'ct_1', call_id: 'call_1', name: 'apply_patch', input: 'patch\n中文' },
      { type: 'image_generation_call', id: 'ig_1', result: 'AA==', status: 'completed', vendor_extra: false },
      { type: 'code_interpreter_call', id: 'ci_1', code: 'print(0)', outputs: [{ type: 'logs', logs: '0' }] }
    ]
    const snapshot = structuredClone(output)
    expect(responseReplay(output, false)).toEqual(output)
    expect(responseReplay(output, true)).toEqual([
      { type: 'reasoning', encrypted_content: 'opaque', summary: [{ type: 'summary_text', text: 'plan' }] },
      { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: 'result', annotations: [] }] },
      { type: 'custom_tool_call', call_id: 'call_1', name: 'apply_patch', input: 'patch\n中文' }, output[3], output[4]
    ])
    expect(output).toEqual(snapshot)
  })

  it('does not send server references or unencrypted reasoning in zero-retention requests', () => {
    const output = [{ type: 'item_reference', id: 'old' }, { type: 'reasoning', id: 'rs_1', summary: [] }]
    expect(responseReplay(output, true)).toEqual([])
    expect(responseReplay(output, false)).toEqual(output)
    expect(responseAssistantInput({ content: 'answer', calls: [], reasoning: { id: 'rs_1', summary: [] } }, true))
      .toEqual([{ type: 'message', role: 'assistant', content: 'answer' }])
  })

  it('encodes uploaded images, binary media, remote files and MCP approval responses', () => {
    expect(responseUserInput('user', [
      { type: 'mcp_approval_response', approval_request_id: 'approval', approve: false },
      { type: 'image', fileId: 'image-id', metadata: { detail: 'high' } },
      { type: 'file', url: 'https://fixture/report.pdf', metadata: { filename: 'report.pdf' } },
      { type: 'image', data: new Uint8Array([0]), mimeType: 'image/png' },
      { type: 'audio', source_type: 'base64', data: 'AA==', mime_type: 'audio/wav' },
      { type: 'input_text', text: '' }
    ])).toEqual([
      { type: 'mcp_approval_response', approval_request_id: 'approval', approve: false },
      { type: 'message', role: 'user', content: [
        { type: 'input_image', file_id: 'image-id', detail: 'high' },
        { type: 'input_file', file_url: 'https://fixture/report.pdf', filename: 'report.pdf' },
        { type: 'input_image', image_url: 'data:image/png;base64,AA==', detail: 'auto' },
        { type: 'input_audio', input_audio: { data: 'AA==', format: 'wav' } }, { type: 'input_text', text: '' }
      ] }
    ])
    expect(() => responseInputContent({ type: 'image', source_type: 'id', data: 'AA==' })).toThrow('source')
  })

  it('keeps function, custom and computer results distinct, including errors and multimodal outputs', () => {
    const parts = [{ type: 'input_text', text: 'done' }, { type: 'input_image', image_url: 'data:image/png;base64,AA==' }]
    expect(responseToolResult({ kind: 'function', callId: 'fn', id: 'fc_result', content: parts }))
      .toEqual({ type: 'function_call_output', call_id: 'fn', id: 'fc_result', output: parts })
    expect(responseToolResult({ kind: 'function', callId: 'fn', content: [{ type: 'text', text: 'error' }] }))
      .toEqual({ type: 'function_call_output', call_id: 'fn', output: '[{"type":"text","text":"error"}]' })
    expect(responseToolResult({ kind: 'custom', callId: 'patch', content: 'NOT EXECUTED' }))
      .toEqual({ type: 'custom_tool_call_output', call_id: 'patch', output: 'NOT EXECUTED' })
    expect(responseToolResult({ kind: 'computer', callId: 'computer', content: parts }))
      .toEqual({ type: 'computer_call_output', call_id: 'computer', output: parts[1] })
    expect(() => responseToolResult({ kind: 'computer', callId: 'computer', content: [] })).toThrow('screenshot')
  })

  it('preserves citations, refusal, phase and fragmented reasoning summaries', () => {
    const reasoning = { type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque', summary: [
      { type: 'summary_text', index: 0, text: 'first ' }, { type: 'summary_text', index: 0, text: 'part' },
      { type: 'summary_text', index: 1, text: 'second' }
    ] }
    const before = structuredClone(reasoning)
    const items = responseAssistantInput({ id: 'msg_1', content: [{ type: 'text', text: 'answer', phase: 'final_answer',
      annotations: [{ type: 'citation', source: 'url_citation', url: 'https://fixture', title: 'source', startIndex: 0, endIndex: 6 }] }],
    calls: [], reasoning, refusal: 'refused' }, false)
    expect(items).toEqual([
      { ...reasoning, summary: [{ type: 'summary_text', text: 'first part' }, { type: 'summary_text', text: 'second' }] },
      { type: 'message', role: 'assistant', id: 'msg_1', phase: 'final_answer', content: [
        { type: 'output_text', text: 'answer', annotations: [{ type: 'url_citation', url: 'https://fixture', title: 'source', start_index: 0, end_index: 6 }] },
        { type: 'refusal', refusal: 'refused' }
      ] }
    ])
    expect(reasoning).toEqual(before)
  })

  it('preserves portable block order and emits a completed call only once', () => {
    const items = responsePortableInput('assistant', [
      { type: 'text', text: 'before' }, { type: 'reasoning', reasoning: 'plan', id: 'rs' },
      { type: 'tool_call_chunk', id: 'call', name: 'edit', args: '{' },
      { type: 'tool_call', id: 'call', name: 'edit', args: { enabled: false } },
      { type: 'server_tool_call_result', toolCallId: 'call', output: { zero: 0 }, status: 'error' },
      { type: 'non_standard', value: { type: 'mcp_call', id: 'remote', output: 'retained' } },
      { type: 'tool_call_chunk', id: 'partial', name: 'find', args: '{"text":' },
      { type: 'tool_call_chunk', id: 'partial', args: '"query"}' }, { type: 'text', text: 'after' }
    ], { nativeProvider: true, zeroRetention: false })
    expect(items).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'before', annotations: [] }] },
      { type: 'reasoning', id: 'rs', summary: [{ type: 'summary_text', text: 'plan' }] },
      { type: 'function_call', call_id: 'call', name: 'edit', arguments: '{"enabled":false}' },
      { type: 'function_call_output', call_id: 'call', output: '{"zero":0}', status: 'incomplete' },
      { type: 'mcp_call', id: 'remote', output: 'retained' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'after', annotations: [] }] },
      { type: 'function_call', call_id: 'partial', name: 'find', arguments: '{"text":"query"}' }
    ])
  })

  it('uses explicit native call kinds and reports unserializable input rather than replacing it', () => {
    expect(responseToolCall({ kind: 'custom', name: 'patch', id: 'call', itemId: 'ct', args: { input: 'raw\npatch' } }, true))
      .toEqual({ type: 'custom_tool_call', call_id: 'call', name: 'patch', input: 'raw\npatch' })
    expect(responseToolCall({ kind: 'function', name: 'bad', id: 'call', args: {}, argumentsText: '{' }, false))
      .toEqual({ type: 'function_call', call_id: 'call', name: 'bad', arguments: '{' })
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic
    expect(() => responsePortableInput('assistant', [{ type: 'server_tool_call_result', toolCallId: 'call', output: cyclic }],
      { nativeProvider: false, zeroRetention: false })).toThrow()
  })
})
