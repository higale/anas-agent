import { describe, expect, it } from 'vitest'
import { historyRevisionBoundary, regenerationContent } from './historyRevision'

describe('history revision', () => {
  const messages = [
    { id: 'user-1', role: 'user' as const, runId: 'run-1' },
    { id: 'answer-1', role: 'assistant' as const, runId: 'run-1' },
    { id: 'user-2', role: 'user' as const, runId: 'run-2' },
    { id: 'direction', role: 'user' as const, runId: 'run-2' },
    { id: 'answer-2', role: 'assistant' as const, runId: 'run-2' }
  ]
  it('truncates the whole selected run but resends from the exact selected user message', () => {
    expect(historyRevisionBoundary(messages, 'answer-2', 'truncate')).toEqual({ targetIndex: 4, retainedCount: 2, fromRunId: 'run-2' })
    expect(historyRevisionBoundary(messages, 'direction', 'regenerate')).toEqual({ targetIndex: 3, retainedCount: 3, fromRunId: 'run-2' })
    expect(messages).toHaveLength(5)
  })
  it('rejects missing messages, missing run ownership and non-user resends', () => {
    expect(() => historyRevisionBoundary(messages, 'missing', 'truncate')).toThrow('was not found')
    expect(() => historyRevisionBoundary([{ id: 'orphan', role: 'user' }], 'orphan', 'truncate')).toThrow('missing its run association')
    expect(() => historyRevisionBoundary(messages, 'answer-2', 'regenerate')).toThrow('Only user messages')
  })
  it('requires freshly supplied Skill instructions only for a Skill request', () => {
    expect(() => regenerationContent('original', true)).toThrow('must be refreshed')
    expect(() => regenerationContent('original', true, '')).toThrow('must be refreshed')
    expect(() => regenerationContent('original', false, '')).toThrow('non-skill')
    expect(regenerationContent('', false)).toBe('')
    expect(regenerationContent('old', true, 'new')).toBe('new')
  })
  it('replaces the first prompt block without changing attachments, metadata or later text', () => {
    const content = [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      { type: 'text-plain', text: 'old', metadata: { enabled: false } }, { type: 'text', text: 'later' }]
    const before = structuredClone(content)
    expect(regenerationContent(content, true, 'new')).toEqual([before[0], { ...before[1], text: 'new' }, before[2]])
    expect(content).toEqual(before)
  })
  it('inserts a prompt before media when the message has no text slot', () => {
    const content = Object.freeze([Object.freeze({ type: 'image', data: 'AA==' })])
    expect(regenerationContent(content, true, 'new')).toEqual([{ type: 'text', text: 'new' }, ...content])
    expect(regenerationContent(content, false)).toEqual(content)
    const unknown = { type: ['text'], text: 'opaque' }
    expect(regenerationContent([unknown], true, 'new')).toEqual([{ type: 'text', text: 'new' }, unknown])
  })
})
