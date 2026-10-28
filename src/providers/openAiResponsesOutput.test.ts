import { describe, expect, it } from 'vitest'
import { ResponsesAccumulator, responseItemBlocks, responseUsage, type NativeResponse, type NativeResponseEvent } from './openAiResponsesOutput'

function response(output: unknown[], status = 'completed'): NativeResponse {
  return { id: 'resp_1', model: 'fixture', object: 'response', status, output } as NativeResponse
}
function accept(accumulator: ResponsesAccumulator, event: unknown) { accumulator.accept(event as NativeResponseEvent) }

describe('native Responses output', () => {
  it('requires a terminal response and retains exact native fields without mutating frames', () => {
    const accumulator = new ResponsesAccumulator()
    const item = { type: 'function_call', id: 'fc', call_id: 'call', name: 'read', arguments: '' }
    accept(accumulator, { type: 'response.output_item.added', output_index: 2, item })
    accept(accumulator, { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":' })
    expect([...accumulator.blocks().values()]).toMatchObject([{ type: 'tool_call_chunk', args: '{"path":' }])
    expect(item.arguments).toBe('')
    expect(() => accumulator.result()).toThrow('complete')
    const final = response([{ ...item, arguments: '{"path":"a"}', status: 'completed', vendor_extension: { value: 0 } }])
    accept(accumulator, { type: 'response.completed', response: final })
    expect(accumulator.result()).toBe(final)
    expect([...accumulator.blocks().values()]).toMatchObject([{ type: 'tool_call', id: 'call', args: { path: 'a' } }])
    expect(() => accept(accumulator, { type: 'response.completed', response: final })).toThrow('after a terminal')
  })

  it.each(['null', '[]', '5', '{bad'])('preserves raw arguments %s for protocol or preflight validation', argumentsText => {
    expect(responseItemBlocks({ type: 'function_call', call_id: 'bad', name: 'read', arguments: argumentsText })).toMatchObject([
      argumentsText === '{bad' ? { type: 'invalid_tool_call', id: 'bad', args: argumentsText }
        : { type: 'tool_call', id: 'bad', args: JSON.parse(argumentsText) }
    ])
  })

  it('preserves unknown usage and explicit zero cache and reasoning counts', () => {
    expect(responseUsage(response([]))).toBeUndefined()
    expect(responseUsage({ ...response([]), usage: { input_tokens: 2, output_tokens: 0, total_tokens: 2,
      input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } })).toEqual({
      input_tokens: 2, output_tokens: 0, total_tokens: 2, input_token_details: { cache_read: 0, cache_creation: 0 }, output_token_details: { reasoning: 0 }
    })
  })

  it('accepts explicit incomplete output but propagates provider failures and error codes', () => {
    const accumulator = new ResponsesAccumulator(), incomplete = response([], 'incomplete')
    accept(accumulator, { type: 'response.incomplete', response: incomplete })
    expect(accumulator.result()).toBe(incomplete)
    for (const event of [
      { type: 'error', code: 'rate_limit_exceeded', message: 'Slow down' },
      { type: 'response.failed', response: { ...response([], 'failed'), error: { code: 'rate_limit_exceeded', message: 'Slow down' } } }
    ]) expect(() => accept(new ResponsesAccumulator(), event)).toThrow(expect.objectContaining({ name: 'rate_limit_exceeded', message: 'Slow down' }))
  })

  it('finishes missing text deltas and preserves refusal and citation fields', () => {
    const accumulator = new ResponsesAccumulator()
    accept(accumulator, { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: 'Hel' })
    const final = response([{ type: 'message', id: 'm', role: 'assistant', phase: 'final_answer', content: [
      { type: 'output_text', text: 'Hello', annotations: [{ type: 'file_citation', file_id: 'f', filename: 'note', index: 0 }] },
      { type: 'refusal', refusal: 'Unavailable' }
    ] }])
    accept(accumulator, { type: 'response.completed', response: final })
    expect([...accumulator.blocks().values()]).toMatchObject([
      { type: 'text', text: 'Hello', phase: 'final_answer', annotations: [{ type: 'citation', file_id: 'f', title: 'note', startIndex: 0 }] },
      { type: 'non_standard', value: { type: 'refusal', refusal: 'Unavailable' } }
    ])
  })

  it('retains buffered summaries when compatible endpoints omit them from the final item', () => {
    const accumulator = new ResponsesAccumulator()
    accept(accumulator, { type: 'response.reasoning_summary_text.delta', output_index: 0, item_id: 'rs', summary_index: 0, delta: 'Plan' })
    expect([...accumulator.blocks().values()]).toEqual([])
    const final = response([{ type: 'reasoning', id: 'rs', summary: [], encrypted_content: 'opaque' }])
    accept(accumulator, { type: 'response.completed', response: final })
    expect([...accumulator.blocks().values()]).toMatchObject([{ type: 'reasoning', reasoning: 'Plan', encrypted_content: 'opaque' }])
    expect(accumulator.result().output).toEqual(final.output)
  })
})
