import { describe, expect, it } from 'vitest'
import type OpenAI from 'openai'
import { chatResponseBlocks, readChatCompletion } from './openAiChatOutput'
import { anthropicResponseBlock, readAnthropicResponse } from './anthropicOutput'
import { readOpenAiResponse, type NativeResponse } from './openAiResponsesOutput'
import type { AnthropicNativeMessage } from './anthropicStream'

describe('native provider response decoding', () => {
  it('preserves text from compatible non-assistant Chat roles without interpreting assistant-only fields', () => {
    const decoded = readChatCompletion({ choices: [{ message: { role: 'critic', content: 'feedback', annotations: [null] } }] } as unknown as OpenAI.Chat.ChatCompletion)
    expect(decoded.candidates[0]).toMatchObject({ role: 'critic', text: 'feedback', content: 'feedback', calls: [], invalidCalls: [] })
  })

  it('retains Chat candidates, custom input, citations, refusal and unknown usage without mutating replay data', () => {
    const response = { id: 'reply', choices: [
      { index: 1, message: { role: 'assistant', content: 'other' } },
      { index: 0, message: { role: 'assistant', content: 'answer', reasoning_content: 'plan', refusal: 'refusal',
        annotations: [{ type: 'url_citation', url_citation: { url: 'https://example.invalid', title: 'source', start_index: 0, end_index: 6 } }],
        tool_calls: [{ type: 'custom', id: 'patch', custom: { name: 'apply_patch', input: 'raw\npatch' } }],
        audio: { id: 'audio', data: 'AA==', expires_at: 0 }, images: [{ image_url: { url: 'data:image/png;base64,AA==' } }]
      } }
    ] } as unknown as OpenAI.Chat.ChatCompletion
    const before = structuredClone(response)
    const decoded = readChatCompletion(response)
    expect(decoded.candidates.map(candidate => candidate.text)).toEqual(['other', 'answer'])
    expect(decoded.candidates[1].calls).toEqual([
      { type: 'tool_call', id: 'patch', name: 'apply_patch', args: { input: 'raw\npatch' }, extras: { openai: { type: 'custom' } } }
    ])
    expect(decoded.candidates[1].blocks).toEqual(expect.arrayContaining([
      { type: 'reasoning', reasoning: 'plan' },
      expect.objectContaining({ type: 'text', annotations: [expect.objectContaining({ startIndex: 0, endIndex: 6 })] }),
      { type: 'non_standard', value: { type: 'refusal', refusal: 'refusal' } },
      expect.objectContaining({ type: 'audio', id: 'audio', expires_at: 0 }),
      { type: 'image', url: 'data:image/png;base64,AA==' }
    ]))
    expect(decoded.usage).toBeUndefined()
    expect(response).toEqual(before)
  })

  it.each(['{', 'null', '[]', 'false'])('separates malformed JSON from complete arguments awaiting validation: %s', args => {
    const message = { role: 'assistant', tool_calls: [{ type: 'function', id: 'call', function: { name: 'read', arguments: args } }] }
    const decoded = readChatCompletion({ choices: [{ message }] } as unknown as OpenAI.Chat.ChatCompletion).candidates[0]
    if (args === '{') {
      expect(decoded.calls).toEqual([])
      expect(decoded.invalidCalls).toEqual([expect.objectContaining({ id: 'call', args })])
    } else {
      expect(decoded.calls).toEqual([expect.objectContaining({ id: 'call', args: JSON.parse(args) })])
      expect(decoded.invalidCalls).toEqual([])
    }
    const partial = chatResponseBlocks(message as OpenAI.Chat.ChatCompletionMessage, false)
    expect(partial.get('tool:0')).toMatchObject({ type: 'tool_call_chunk', args })
  })

  it('does not manufacture a Chat call identity and retains explicit zero usage', () => {
    const decoded = readChatCompletion({ id: 'reply', choices: [{ message: { role: 'assistant', content: '', tool_calls: [
      { type: 'function', function: { name: 'read', arguments: '{}' } }
    ] } }], usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } } as unknown as OpenAI.Chat.ChatCompletion)
    expect(decoded.candidates[0].calls).toEqual([])
    expect(decoded.candidates[0].invalidCalls[0]).toMatchObject({ error: 'Tool calls require a provider ID and name.' })
    expect(decoded.candidates[0].invalidCalls[0].id).toBeUndefined()
    expect(decoded.usage).toMatchObject({ input_tokens: 0, output_tokens: 0, total_tokens: 0 })
  })

  it('preserves Anthropic opaque blocks and signatures, and keeps server tools out of host dispatch', () => {
    const response = { id: 'reply', role: 'assistant', content: [
      { type: 'thinking', thinking: 'plan', signature: 'signed' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'server_tool_use', id: 'server', name: 'search', input: { query: 'q' } },
      { type: 'tool_use', id: 'call', name: 'read', input: { zero: 0, enabled: false } },
      { type: 'tool_use', id: 'bad', name: 'read', input: 'null' },
      { type: 'text', text: 'answer', citations: [{ type: 'future_citation', opaque: true }] }
    ], usage: { input_tokens: 0, output_tokens: 0 } } as unknown as AnthropicNativeMessage
    const before = structuredClone(response)
    const decoded = readAnthropicResponse(response)
    expect(decoded.text).toBe('answer')
    expect(decoded.content).toEqual(response.content)
    expect(decoded.content).not.toBe(response.content)
    expect(decoded.calls).toEqual([{ type: 'tool_call', id: 'call', name: 'read', args: { zero: 0, enabled: false } },
      { type: 'tool_call', id: 'bad', name: 'read', args: 'null' }])
    expect(decoded.invalidCalls).toEqual([])
    expect(anthropicResponseBlock({ type: 'thinking', thinking: 'plan', signature: 'signed' }, 0, true))
      .toMatchObject({ type: 'reasoning', reasoning: 'plan', signature: 'signed' })
    expect(response).toEqual(before)
  })

  it('preserves Responses item IDs, custom and computer calls, opaque reasoning and structured false values', () => {
    const response = { id: 'reply', status: 'completed', output: [
      { type: 'reasoning', id: 'reason', encrypted_content: 'opaque', summary: [] },
      { type: 'function_call', id: 'item', call_id: 'fn', name: 'read', arguments: '{"zero":0}' },
      { type: 'custom_tool_call', id: 'custom-item', call_id: 'custom', name: 'patch', input: 'literal\npatch' },
      { type: 'computer_call', id: 'computer-item', call_id: 'computer', action: { type: 'click', x: 0, y: 0 }, pending_safety_checks: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'false', annotations: [] }, { type: 'refusal', refusal: '' }] },
      { type: 'future_output', id: 'opaque-output', value: false }
    ], text: { format: { type: 'json_schema' } }, usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1 } } as unknown as NativeResponse
    const before = structuredClone(response), decoded = readOpenAiResponse(response)
    expect(decoded).toMatchObject({ text: 'false', parsed: false, refusal: '', functionCallIds: { fn: 'item' }, customCallIds: { custom: 'custom-item' },
      reasoning: response.output[0], usage: { input_tokens: 0, output_tokens: 1 } })
    expect(decoded.calls).toEqual([
      expect.objectContaining({ id: 'fn', args: { zero: 0 }, call_id: 'item' }),
      expect.objectContaining({ id: 'custom', args: { input: 'literal\npatch' }, isCustomTool: true }),
      expect.objectContaining({ id: 'computer', args: { action: { type: 'click', x: 0, y: 0 } }, isComputerTool: true })
    ])
    expect(decoded.toolOutputs).toEqual([response.output[3], response.output[5]])
    expect(response).toEqual(before)
  })

  it('rejects failed Responses and retains malformed structured text without inventing parsed data', () => {
    expect(() => readOpenAiResponse({ output: [], status: 'failed', error: { message: 'failed request' } } as unknown as NativeResponse)).toThrow('failed request')
    expect(readOpenAiResponse({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{', annotations: [] }] }],
      text: { format: { type: 'json_schema' } } } as unknown as NativeResponse)).toMatchObject({ text: '{', parsed: undefined })
  })
})
