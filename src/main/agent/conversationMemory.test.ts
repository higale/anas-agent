import { describe, expect, it, vi } from 'vitest'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { createConversationMemoryProjector } from './conversationMemory'

describe('native memory recall', () => {
  it('reuses the same in-flight query, re-queries queued directions and leaves message bodies untouched', async () => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    const recall = vi.fn(async () => { await pending; return [{ id: 'memory', scope: 'global' as const, kind: 'fact' as const,
      content: '<value> & detail', keywords: [], importance: 0, origin: 'user' as const, createdAt: '', updatedAt: '' }] })
    const observe = vi.fn(), project = createConversationMemoryProjector({ enabled: true, projectId: 'project', limit: 2,
      store: { relevantMemories: recall }, onRecall: observe })
    const system: ConversationMessage = { kind: 'system', content: 'Instructions' }
    const messages: ConversationMessage[] = [{ kind: 'user', content: [{ type: 'text', text: 'question' }, { type: 'text', text: 'attachment' }] }]
    const first = project(system, messages), second = project(system, [...messages, { kind: 'tool', content: 'read result', resultFor: 'call' }])
    release()
    const [left, right] = await Promise.all([first, second])
    expect(left).toEqual(right)
    expect(left.content).toContain('&lt;value&gt; &amp; detail')
    expect(recall).toHaveBeenCalledOnce()
    expect(recall).toHaveBeenCalledWith('question\nattachment', 'project', 2)
    expect(observe).toHaveBeenCalledOnce()
    expect(observe).toHaveBeenCalledWith({ query: 'question\nattachment', memoryCount: 1,
      promptText: expect.stringContaining('&lt;value&gt; &amp; detail') })
    await project(system, [...messages, { kind: 'user', content: 'next question' }])
    expect(recall).toHaveBeenCalledTimes(2)
    expect(system.content).toBe('Instructions')
    expect(messages).toHaveLength(1)
  })

  it('does not query disabled or empty memory input and surfaces store failures', async () => {
    const error = new Error('memory unavailable'), recall = vi.fn(async () => { throw error })
    const system: ConversationMessage = { kind: 'system', content: '' }
    const options = { projectId: 'project', store: { relevantMemories: recall } }
    expect(await createConversationMemoryProjector({ ...options, enabled: false })(system, [{ kind: 'user', content: 'question' }])).toBe(system)
    const project = createConversationMemoryProjector({ ...options, enabled: true })
    expect(await project(system, [{ kind: 'user', content: '  ' }])).toBe(system)
    expect(recall).not.toHaveBeenCalled()
    await expect(project(system, [{ kind: 'user', content: 'question' }])).rejects.toBe(error)
  })
})
