import { describe, expect, it, vi } from 'vitest'
import { modelRequestKey } from './modelInputBudget'
import { latestModelUsageSnapshot, type ModelUsageEvidence } from './modelUsage'

describe('native request identity and usage calibration', () => {
  it('retains the request key already stored in current sessions', () => {
    expect(modelRequestKey({ system: 'instructions', messages: [{ role: 'user', content: 'question' }] }, [
      { type: 'function', name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
      { type: 'web_search' }
    ])).toBe('d8c847f493fe6ddc081dafbde87d1754208086a204a0e45fd228e31c1140817d')
  })

  it('ignores cache placement and tool order while retaining actual input and schema changes', () => {
    const input = { system: 'instructions', messages: [{ role: 'user', content: 'question' }] }
    const tools = [{ name: 'read', parameters: { type: 'object', properties: { path: { type: 'string' } } } }, { type: 'web_search' }]
    const before = structuredClone(input), key = modelRequestKey(input, tools)
    expect(modelRequestKey({ system: [{ type: 'text', text: 'instructions', cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'question', cache_control: { type: 'ephemeral' } }] }]
    }, [...tools].reverse())).toBe(key)
    expect(modelRequestKey({ ...input, system: 'different' }, tools)).not.toBe(key)
    expect(modelRequestKey({ ...input, messages: [{ role: 'user', content: 'different' }] }, tools)).not.toBe(key)
    expect(modelRequestKey(input, [{ ...tools[0], description: 'changed' }, tools[1]])).not.toBe(key)
    expect(input).toEqual(before)
  })

  it('retains opaque replay items, media identities and ordinary JSON fields named cache_control', () => {
    const messages = [
      { type: 'reasoning', encrypted_content: 'opaque' },
      { type: 'function_call', call_id: 'call', arguments: '{"cache_control":false}' },
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }
    ]
    const key = modelRequestKey({ messages }, [])
    for (const index of [0, 1, 2]) {
      const changed = structuredClone(messages)
      if (index === 0) changed[0].encrypted_content = 'different'
      if (index === 1) changed[1].arguments = '{"cache_control":true}'
      if (index === 2) changed[2].content![0].image_url.url = 'data:image/png;base64,AQ=='
      expect(modelRequestKey({ messages: changed }, [])).not.toBe(key)
    }
  })

  it('selects the latest real response without copying or inspecting earlier history', () => {
    const evidence: ModelUsageEvidence[] = [
      { isResponse: true, modelContextKey: 'older', usage: { input_tokens: 9000, output_tokens: 10, total_tokens: 9010 } },
      { isResponse: true, modelContextKey: 'current', usage: { input_tokens: 0, output_tokens: 1, total_tokens: 1,
        input_token_details: { cache_read: 0 }, output_token_details: { reasoning: 0 } } },
      { isResponse: false },
      { isResponse: true, renderedReport: true }
    ]
    const read = vi.fn((index: number) => evidence[index])
    expect(latestModelUsageSnapshot(evidence.length, read, 'current')).toMatchObject({ messageIndex: 1,
      usage: { inputTokens: 0, outputTokens: 1, inputTokenDetails: { cacheReadTokens: 0 }, outputTokenDetails: { reasoningTokens: 0 } } })
    expect(read.mock.calls.flat()).toEqual([3, 2, 1])
  })

  it.each([
    { isResponse: true },
    { isResponse: true, modelContextKey: 'changed', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } },
    { isResponse: true, modelContextKey: 'current', usage: { input_tokens: NaN, output_tokens: 1, total_tokens: 2 } },
    { isResponse: true, modelContextKey: 'current', usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } }
  ])('does not borrow earlier usage when the latest response is unavailable or inapplicable', latest => {
    const read = vi.fn((index: number): ModelUsageEvidence => index === 1 ? latest
      : { isResponse: true, modelContextKey: 'current', usage: { input_tokens: 9000, output_tokens: 1, total_tokens: 9001 } })
    expect(latestModelUsageSnapshot(2, read, 'current')).toBeUndefined()
    expect(read.mock.calls.flat()).toEqual([1])
  })
})
