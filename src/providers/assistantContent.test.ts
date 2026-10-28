import { contentText } from '../runtime/inputContent'
import { assistantContentSamples } from './fixtures/assistantContentBaseline'
import { describe, expect, it } from 'vitest'
import { assistantContentBlocks } from './assistantContent'

describe('assistant content interpretation', () => {
  it.each(assistantContentSamples)('preserves imported $name presentation (partial=$source.partial)', ({ source, blocks, text }) => {
    const before = structuredClone(source)
    expect(assistantContentBlocks(source)).toStrictEqual(blocks)
    expect(contentText(assistantContentBlocks(source))).toBe(text)
    expect(source).toEqual(before)
  })

  it('presents an assistant reply without requiring provider metadata', () => {
    expect(assistantContentBlocks({ format: 'generic', content: 'answer' })).toEqual([{ type: 'text', text: 'answer' }])
  })

  it('keeps portable blocks and opaque provider data intact', () => {
    const content = [{ type: 'reasoning', reasoning: '', signature: 'signed' },
      { type: 'non_standard', value: { type: 'future', enabled: false } }]
    const before = structuredClone(content)
    expect(assistantContentBlocks({ format: 'portable', content })).toEqual(before)
    expect(content).toEqual(before)
    expect(() => assistantContentBlocks({ format: 'portable', content: 'invalid' })).toThrow('must contain blocks')
  })

  it('keeps reasoning, signatures and redacted content separate', () => {
    expect(assistantContentBlocks({ format: 'anthropic', content: [
      { type: 'thinking', thinking: 'plan', signature: 'opaque', index: 0 },
      { type: 'redacted_thinking', data: 'encrypted' }, { type: 'text', text: 'answer' }
    ] })).toEqual([
      { type: 'reasoning', reasoning: 'plan', signature: 'opaque', index: 0 },
      { type: 'non_standard', value: { type: 'redacted_thinking', data: 'encrypted' } }, { type: 'text', text: 'answer' }
    ])
  })

  it('retains citation coordinates and phase without altering native blocks', () => {
    const content = [{ type: 'text', text: 'answer', phase: 'final_answer', extras: { enabled: false }, annotations: [
      { type: 'url_citation', url: 'https://example.invalid', title: '', start_index: 0, end_index: 2 },
      { type: 'future', value: 0 }
    ] }]
    const before = structuredClone(content)
    expect(assistantContentBlocks({ format: 'openai', content })).toEqual([{ type: 'text', text: 'answer',
      extras: { enabled: false, phase: 'final_answer' }, annotations: [
        { type: 'citation', url: 'https://example.invalid', title: '', startIndex: 0, endIndex: 2 }, { type: 'future', value: 0 }
      ] }])
    expect(content).toEqual(before)
  })

  it('does not report a pending provider search as a completed result', () => {
    expect(assistantContentBlocks({ format: 'openai', content: [], toolOutputs: [
      { type: 'web_search_call', id: 'pending', status: 'in_progress', action: { query: 'q' } },
      { type: 'file_search_call', id: 'failed', status: 'failed', queries: [], results: [] }
    ] })).toEqual([
      { type: 'server_tool_call', id: 'pending', name: 'web_search', args: { query: 'q' } },
      { type: 'server_tool_call', id: 'failed', name: 'file_search', args: { queries: [] } },
      { type: 'server_tool_call_result', toolCallId: 'failed', status: 'error', output: { results: [] } }
    ])
  })

  it('preserves generated image bytes and the full provider result', () => {
    const result = { type: 'image_generation_call', result: 'AA==', id: 'image', status: 'completed', extra: false }
    expect(assistantContentBlocks({ format: 'openai', content: [], toolOutputs: [result] })).toEqual([
      { type: 'image', mimeType: 'image/png', data: 'AA==', id: 'image', metadata: { status: 'completed' } },
      { type: 'non_standard', value: result }
    ])
  })

  it('retains code failure output and existing provider result presentation', () => {
    expect(assistantContentBlocks({ format: 'openai', content: [], toolOutputs: [
      { type: 'code_interpreter_call', id: 'code', code: '', status: 'failed', outputs: [{ type: 'logs', logs: 'error' }] }
    ] })).toEqual([
      { id: 'code', type: 'server_tool_call', name: 'code_interpreter', args: { code: '' } },
      { type: 'server_tool_call_result', toolCallId: 'code', status: 'success',
        output: { type: 'code_interpreter_output', returnCode: 1, stderr: 'error', stdout: undefined } }
    ])
  })

  it('preserves incomplete Anthropic arguments without inventing a completed call', () => {
    expect(assistantContentBlocks({ format: 'anthropic', content: [{ type: 'input_json_delta', input: '{' }], partial: true,
      callFragments: [{ id: 'call', name: 'read', args: '{', index: 2 }] })).toEqual([
      { type: 'tool_call_chunk', id: 'call', name: 'read', args: '{', index: 2 }
    ])
    expect(assistantContentBlocks({ format: 'anthropic', content: [{ type: 'server_tool_use', id: 'search', name: 'web_search', partial_json: '{' }] }))
      .toEqual([{ id: 'search', type: 'server_tool_call', name: 'web_search', args: { query: '' } }])
  })

  it('deduplicates only recorded call identities, without modifying input', () => {
    const content = [{ type: 'tool_call', id: 'call', name: 'read', args: { path: 'original' } }]
    const before = structuredClone(content)
    expect(assistantContentBlocks({ format: 'generic', content, calls: [
      { id: 'call', name: 'read', args: { path: 'duplicate' } }, { id: 'other', name: 'read', args: { path: 'new' } }
    ] })).toEqual([...before, { type: 'tool_call', id: 'other', name: 'read', args: { path: 'new' } }])
    expect(content).toEqual(before)
  })
})
