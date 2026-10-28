import { describe, expect, it } from 'vitest'
import { projectConversationToolHistory } from './conversationHistoryProjection'

const call = (id: string) => ({ kind: 'assistant' as const, content: '', calls: [{ id, name: 'write_file', args: { path: 'a.txt' } }]})
const result = (id: string, content = 'Written') => ({ kind: 'tool' as const, content, resultFor: id })

describe('model tool history projection', () => {
  it('keeps already valid history and native results untouched', () => {
    const messages = [ ({ kind: 'user' as const, content: 'Write a file'}) , call('call-1'), result('call-1'), ({ kind: 'assistant' as const, content: 'Done'}) ]
    expect(projectConversationToolHistory(messages)).toBe(messages)
  })

  it('reports an unrecorded result as unknown without rewriting history', () => {
    const messages = [call('call-1'), ({ kind: 'user' as const, content: 'Continue'}) ]
    const original = JSON.stringify(messages)
    const projected = projectConversationToolHistory(messages)
    expect(projected).toHaveLength(3)
    expect(projected[1]).toMatchObject({ resultFor: 'call-1', resultStatus: 'error' })
    expect(projected[1].content).toContain('outcome is unknown')
    expect(projected[1].content).not.toMatch(/was cancelled|completed successfully/)
    expect(JSON.stringify(messages)).toBe(original)
    expect(projectConversationToolHistory(projected)).toBe(projected)
  })

  it('does not use a later turn result to answer an older call with the same ID', () => {
    const earlier = call('repeated'), later = call('repeated'), recorded = result('repeated')
    const projected = projectConversationToolHistory([earlier, ({ kind: 'user' as const, content: 'Continue'}) , later, recorded])
    expect(projected[1].content).toContain('outcome is unknown')
    expect(projected.slice(-2)).toEqual([later, recorded])
  })

  it('places recorded parallel results together before new user input without changing their order', () => {
    const batch = ({ kind: 'assistant' as const, content: '', calls: [
      { id: 'a', name: 'read_file', args: {} }, { id: 'b', name: 'read_file', args: {} }
    ]})
    const user = ({ kind: 'user' as const, content: 'Also inspect tests'}) , a = result('a'), b = result('b')
    const messages = [batch, user, b, a]
    expect(projectConversationToolHistory(messages)).toEqual([batch, b, a, user])
    expect(messages).toEqual([batch, user, b, a])
  })

  it('omits unpaired protocol results only from the request and does not invent call identifiers', () => {
    const orphan = result('unknown', 'Evidence remains in the original history')
    const invalid = ({ kind: 'assistant' as const, content: '', calls: [{ name: 'read_file', args: {} }]})
    const messages = [orphan, invalid]
    expect(projectConversationToolHistory(messages)).toEqual([invalid])
    expect(messages[0]).toBe(orphan)
    expect(invalid.calls?.[0]).not.toHaveProperty('id')
  })
})
