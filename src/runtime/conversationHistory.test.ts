import { describe, expect, it, vi } from 'vitest'
import { compactLatestToolResults, compactedToolContent, compressionRetention, consumedToolImageIndices,
  pendingToolImageStart, simpleChatAssistantContent, simpleChatUserContent, toolHistoryPlan, type HistoryEntry } from './conversationHistory'

const user = (text = 'Continue'): HistoryEntry => ({ role: 'user', userText: text })
const call = (id = 'a'): HistoryEntry => ({ role: 'assistant', calls: [{ id, name: 'read_file' }] })
const result = (id = 'a', images = false): HistoryEntry => ({ role: 'tool', resultFor: id, images })
const count = (costs: number[]) => (start: number, end: number) => costs.slice(start, end).reduce((sum, n) => sum + n, 0)

describe('native conversation history policies', () => {
  it('restores display text while keeping attachments, summaries and fixed review scopes', () => {
    const image = { type: 'image', url: 'https://fixture/image' }
    const source = [image, { type: 'text', text: 'Expanded skill', language: 'zh' }, { type: 'text', text: 'Attachment caption' }]
    const before = structuredClone(source)
    const input = { content: source, displayText: '/skill user request', summary: false, review: false }
    expect(simpleChatUserContent(input)).toEqual([image, { type: 'text', text: '/skill user request', language: 'zh' }, source[2]])
    expect(simpleChatUserContent({ ...input, content: [image] })).toEqual([{ type: 'text', text: '/skill user request' }, image])
    expect(simpleChatUserContent({ ...input, content: 'Expanded skill' })).toBe('/skill user request')
    expect(simpleChatUserContent({ ...input, summary: true })).toBeUndefined()
    expect(simpleChatUserContent({ ...input, review: true })).toBeUndefined()
    expect(simpleChatUserContent({ ...input, displayText: '' })).toBeUndefined()
    expect(source).toEqual(before)
  })

  it('removes calls from wrapped and raw output while retaining valid reasoning and server tools', () => {
    const reasoning = (id: string) => ({ type: 'reasoning', id, encrypted_content: `opaque-${id}`, summary: [] })
    const server = { type: 'web_search_call', id: 'search', status: 'completed' }
    const call = { type: 'non_standard', value: { type: 'custom_tool_call', call_id: 'edit', input: 'patch' } }
    const clientReasoning = reasoning('client'), serverReasoning = reasoning('server')
    const input = { content: [serverReasoning, clientReasoning, call], providerOutput: [serverReasoning, server, clientReasoning, call],
      reasoning: clientReasoning, hasClientCalls: false }
    const before = structuredClone(input)
    const detached = { type: 'reasoning', encrypted_content: 'opaque-client', summary: [] }
    expect(simpleChatAssistantContent(input)).toEqual({ content: [serverReasoning, detached],
      providerOutput: [serverReasoning, server, detached], reasoning: detached })
    expect(input).toEqual(before)
  })

  it('omits call-only responses, but retains refusals and unmodified reasoning references', () => {
    expect(simpleChatAssistantContent({ content: [{ type: 'tool_use', id: 'call', input: {} }], hasClientCalls: true })).toBeUndefined()
    expect(simpleChatAssistantContent({ content: '', refusal: 'Unavailable', hasClientCalls: false }))
      .toEqual({ content: '', providerOutput: undefined, reasoning: undefined })
    const reasoning = { type: 'reasoning', id: 'valid', encrypted_content: 'opaque' }
    expect(simpleChatAssistantContent({ content: '', reasoning, hasClientCalls: false })?.reasoning).toBe(reasoning)
    expect(simpleChatAssistantContent({ content: '', reasoning, hasClientCalls: true })?.reasoning)
      .toEqual({ type: 'reasoning', encrypted_content: 'opaque' })
  })

  it('retains an oversized newest call and all its results together with the active request', () => {
    const messages = [user('  Keep all constraints  '), { role: 'assistant' } as HistoryEntry, call(), result()]
    expect(compressionRetention(messages, messages, 40, count([1, 50, 2, 200])))
      .toEqual({ cutoffIndex: 2, retainedTokens: 202, activeUserRequest: 'Keep all constraints' })
    expect(messages).toHaveLength(4)
  })

  it('keeps a pending image transaction even when new user input would otherwise cut it off', () => {
    const messages = [user(), call(), result('a', true), user('Compare with the first image')]
    expect(compressionRetention(messages, messages, 40, count([1, 2, 100, 2])))
      .toEqual({ cutoffIndex: 1, retainedTokens: 104, activeUserRequest: undefined })
    expect(pendingToolImageStart(messages)).toBe(1)
    expect(consumedToolImageIndices(messages)).toEqual([])
    const summary = { role: 'assistant', summary: true } as const
    expect(consumedToolImageIndices([...messages, summary])).toEqual([])
    expect(consumedToolImageIndices([...messages, { role: 'assistant' }])).toEqual([2])
  })

  it('does not summarize only an existing summary again or lose the raw active request', () => {
    const effective: HistoryEntry[] = [{ role: 'user', summary: true }, call(), result()]
    expect(compressionRetention(effective, [user('original request'), ...effective.slice(1)], 40, count([100, 2, 3])))
      .toEqual({ cutoffIndex: 0, retainedTokens: 105, activeUserRequest: 'original request' })
  })

  it('recognizes both retained identity without IDs and separately projected durable IDs', () => {
    const original = user('do not repeat me')
    expect(compressionRetention([original], [original], 40, count([2])).activeUserRequest).toBeUndefined()
    const stored = { ...original, id: 'user-1' }
    expect(compressionRetention([{ ...stored }], [stored], 40, count([2])).activeUserRequest).toBeUndefined()
    expect(compressionRetention([{ ...original }], [original], 40, count([2])).activeUserRequest).toBe('do not repeat me')
  })

  it('pairs parallel results before queued input without borrowing from a later response', () => {
    const batch: HistoryEntry = { role: 'assistant', calls: [{ id: 'a', name: 'one' }, { id: 'b', name: 'two' }] }
    const messages = [result('orphan'), batch, user(), result('b'), call('a'), result('a')]
    const before = structuredClone(messages)
    expect(toolHistoryPlan(messages)).toEqual([
      { index: 1 }, { index: 3 }, { missingResult: { callId: 'a', name: 'one' } },
      { index: 2 }, { index: 4 }, { index: 5 }
    ])
    expect(messages).toEqual(before)
  })

  it('waits for the full result to be saved before returning a shortened projection', async () => {
    const source = '😀'.repeat(1000)
    let saved!: (path: string) => void
    const save = vi.fn(() => new Promise<string>(resolve => { saved = resolve }))
    let returned = false
    const pending = compactedToolContent(source, 300, save).then(value => { returned = true; return value })
    await Promise.resolve()
    expect(returned).toBe(false)
    expect(save).toHaveBeenCalledExactlyOnceWith(source)
    saved('results/"quoted".txt')
    const projected = await pending
    expect(projected).toContain(JSON.stringify('results/"quoted".txt'))
    expect(projected).toContain('do not rerun the operation')
    expect(projected.length).toBeLessThanOrEqual(300)
    expect([...projected].some(char => /^[\uD800-\uDFFF]$/.test(char))).toBe(false)
  })

  it('propagates result storage failure and leaves small structured results intact', async () => {
    const failure = new Error('disk full')
    await expect(compactedToolContent('x'.repeat(1000), 200, async () => { throw failure })).rejects.toBe(failure)
    const save = vi.fn(async () => 'unused')
    const content = [{ type: 'text', text: 'small' }]
    await expect(compactedToolContent(content, 200, save)).resolves.toBe(JSON.stringify(content))
    expect(save).not.toHaveBeenCalled()
  })

  it('compacts only text results from the latest complete batch without touching fresh images or history', async () => {
    const batch: HistoryEntry = { role: 'assistant', calls: ['a', 'b', 'image'].map(id => ({ id, name: 'read_file' })) }
    const history = [call('old'), result('old'), user(), batch, result('a'), result('b'), result('image', true)]
      .map((entry, index) => ({ ...entry, content: index === 6 ? [{ type: 'image', data: 'fresh bytes' }] : String(index).repeat(2000) }))
    const before = structuredClone(history)
    const count = vi.fn(() => 1000)
    const save = vi.fn(async (text: string) => `results/${text[0]}.txt`)
    const replacements = await compactLatestToolResults(history, 1000, count, save)
    expect(count).toHaveBeenCalledExactlyOnceWith([4, 5])
    expect(save.mock.calls.map(([text]) => text)).toEqual([history[4].content, history[5].content])
    expect(replacements.map(item => item.index)).toEqual([4, 5])
    for (const replacement of replacements) {
      expect(replacement.content.length).toBeLessThanOrEqual(256)
      expect(replacement.content).toContain(`results/${replacement.index}.txt`)
    }
    expect(history).toEqual(before)
  })

  it('keeps small structured results intact and skips a batch superseded by new input', async () => {
    const history = [call(), result()].map(entry => ({ ...entry, content: [{ type: 'text', text: 'small' }] }))
    const save = vi.fn(async () => 'unused')
    expect(await compactLatestToolResults(history, 1000, () => 0, save)).toEqual([])
    const count = vi.fn(() => 0)
    expect(await compactLatestToolResults([...history, { ...user(), content: 'new request' }], 1000, count, save)).toEqual([])
    expect(await compactLatestToolResults([], 1000, count, save)).toEqual([])
    expect(count).not.toHaveBeenCalled()
    expect(save).not.toHaveBeenCalled()
  })

  it('waits for every entered archive write after a failure without returning a partial projection', async () => {
    const failure = new Error('first archive failed')
    let finishSecond!: () => void
    const second = new Promise<string>(resolve => { finishSecond = () => resolve('results/second.txt') })
    const save = vi.fn((text: string) => text.startsWith('a') ? Promise.reject(failure) : second)
    const history = [{ ...result('a'), content: 'a'.repeat(2000) }, { ...result('b'), content: 'b'.repeat(2000) }]
    const before = structuredClone(history)
    let finished = false
    const pending = compactLatestToolResults(history, 100, () => 0, save).finally(() => { finished = true })
    const rejected = expect(pending).rejects.toBe(failure)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(save).toHaveBeenCalledTimes(2)
    expect(finished).toBe(false)
    finishSecond()
    await rejected
    expect(history).toEqual(before)
  })
})
