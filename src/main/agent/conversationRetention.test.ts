import { describe, expect, it } from 'vitest'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { countConversationTokens } from './conversationContext'
import { selectConversationRetention } from './conversationHistoryProjection'

const tokens = (messages: ConversationMessage[]) => countConversationTokens(messages, [], { protocol: 'openai_chat_completions' })
function toolTransaction(id: string, content: string): ConversationMessage[] {
  return [{ id: `${id}:request`, kind: 'assistant', content: '', calls: [{ id, name: 'search', args: { query: id } }] },
    { id: `${id}:result`, kind: 'tool', content, resultFor: id }]
}

describe('native compression retention with product token counting', () => {
  it('cuts a large active turn only between complete tool transactions', () => {
    const activeUser: ConversationMessage = { id: 'active-user', kind: 'user', content: 'Complete the active research task.' }
    const first = toolTransaction('call-1', 'old result '.repeat(200)), newest = toolTransaction('call-2', 'latest result '.repeat(40))
    const messages: ConversationMessage[] = [{ kind: 'user', content: 'Earlier question' }, { kind: 'assistant', content: 'Earlier answer' },
      activeUser, ...first, ...newest]
    const selection = selectConversationRetention(messages, messages, (tokens(newest) + 1) * 4, tokens)
    expect(selection.cutoffIndex).toBe(messages.indexOf(newest[0]))
    expect(messages.slice(selection.cutoffIndex)).toEqual(newest)
    expect(selection.activeUserRequest).toBe('Complete the active research task.')
  })

  it('preserves the newest causal unit even when it exceeds the retention limit', () => {
    const activeUser: ConversationMessage = { id: 'active-user', kind: 'user', content: 'Continue the active task.' }
    const older = toolTransaction('call-old', 'Older result'), newest = toolTransaction('call-oversized', 'Oversized newest result '.repeat(500))
    const messages: ConversationMessage[] = [{ kind: 'user', content: 'Earlier question' }, { kind: 'assistant', content: 'Earlier answer' },
      activeUser, ...older, ...newest]
    const threshold = Math.max(400, tokens(older) * 4)
    expect(tokens(newest)).toBeGreaterThan(Math.floor(threshold / 4))
    const selection = selectConversationRetention(messages, messages, threshold, tokens)
    expect(selection.cutoffIndex).toBe(messages.indexOf(newest[0]))
    expect(messages.slice(selection.cutoffIndex)).toEqual(newest)
    expect(selection.retainedTokens).toBe(tokens(newest))
    expect(selection.activeUserRequest).toBe('Continue the active task.')
  })

  it('retains only complete older turns within its remaining budget', () => {
    const oldest: ConversationMessage[] = [{ id: 'oldest-user', kind: 'user', content: 'Old large question' },
      { kind: 'assistant', content: 'large old answer '.repeat(500) }]
    const recent: ConversationMessage[] = [{ id: 'recent-user', kind: 'user', content: 'Recent compact question' },
      { kind: 'assistant', content: 'Recent compact answer' }]
    const current: ConversationMessage[] = [{ id: 'current-user', kind: 'user', content: 'Current question' },
      { kind: 'assistant', content: 'Current answer' }]
    const threshold = (tokens(recent) + 10) * 8, messages = [...oldest, ...recent, ...current]
    const selection = selectConversationRetention(messages, messages, threshold, tokens)
    expect(selection.cutoffIndex).toBe(oldest.length)
    expect(messages.slice(selection.cutoffIndex)).toEqual([...recent, ...current])
    expect(selection.retainedTokens).toBe(tokens([...recent, ...current]))
    expect(selection.activeUserRequest).toBeUndefined()
  })

  it('does not partially retain an older user turn that exceeds its remaining budget', () => {
    const previous: ConversationMessage[] = [{ id: 'previous-user', kind: 'user', content: 'Previous question' },
      { kind: 'assistant', content: 'Previous answer '.repeat(300) }]
    const current: ConversationMessage[] = [{ id: 'current-user', kind: 'user', content: 'Current question' },
      { kind: 'assistant', content: 'Current answer' }]
    const threshold = Math.max(tokens(current) * 4 + 40, 400), messages = [...previous, ...current]
    const selection = selectConversationRetention(messages, messages, threshold, tokens)
    expect(selection.cutoffIndex).toBe(previous.length)
    expect(messages.slice(selection.cutoffIndex)).toEqual(current)
  })

  it('retains more than five complete older turns when they fit the budget', () => {
    const olderTurns: ConversationMessage[] = Array.from({ length: 8 }, (_, index): ConversationMessage[] => [
      { id: `older-user-${index}`, kind: 'user', content: `Question ${index}` }, { kind: 'assistant', content: `Answer ${index}` }
    ]).flat()
    const current: ConversationMessage[] = [{ id: 'current-user', kind: 'user', content: 'Current question' },
      { kind: 'assistant', content: 'Current answer' }]
    const discarded: ConversationMessage[] = [{ id: 'discarded-user', kind: 'user', content: 'Discard this question' },
      { kind: 'assistant', content: 'Discarded answer '.repeat(8000) }]
    const messages = [...discarded, ...olderTurns, ...current], threshold = 8000
    expect(tokens(messages)).toBeGreaterThan(threshold)
    expect(tokens(olderTurns)).toBeLessThanOrEqual(Math.floor(threshold / 8))
    const selection = selectConversationRetention(messages, messages, threshold, tokens)
    expect(selection.cutoffIndex).toBe(discarded.length)
    expect(messages.slice(selection.cutoffIndex)).toEqual([...olderTurns, ...current])
  })

  it('does not repeatedly summarize an unchanged previous summary', () => {
    const summary: ConversationMessage = { id: 'previous-summary', kind: 'user', content: 'Here is a summary of the conversation to date.',
      context: { summary: true } }
    const tail = toolTransaction('call-1', 'Current result')
    const effective = [summary, ...tail], raw: ConversationMessage[] = [{ id: 'active-user', kind: 'user', content: 'Active request' }, ...tail]
    const selection = selectConversationRetention(effective, raw, 10000, tokens)
    expect(selection.cutoffIndex).toBe(0)
    expect(selection.retainedTokens).toBe(tokens(effective))
  })
})
