import { describe, expect, it, vi } from 'vitest'
import type { PreferenceScope } from '../../shared/preferenceMemory'
import { createConversationMemoryProjector } from './conversationMemory'

describe('completed preference injection', () => {
  it('reads both scopes each request, observes updates, and leaves history untouched', async () => {
    let content = '<value> & detail'
    const read = vi.fn((scope: PreferenceScope) => ({ scope, content, hash: '' }))
    const observe = vi.fn(), project = createConversationMemoryProjector({ enabled: true, projectId: 'project',
      store: { preferences: { read } }, onRecall: observe })
    const system = { kind: 'system' as const, content: 'Instructions' }
    const messages = [{ kind: 'user' as const, content: 'Question' }]
    expect((await project(system, messages)).content).toContain('&lt;value&gt; &amp; detail')
    expect(read.mock.calls.map(([scope]) => scope)).toEqual([{ kind: 'global' }, { kind: 'project', projectId: 'project' }])
    content = 'Updated preference'
    expect((await project(system, messages)).content).toContain(content)
    content = ''
    expect(await project(system, messages)).toBe(system)
    expect(system.content).toBe('Instructions'); expect(messages).toEqual([{ kind: 'user', content: 'Question' }])
    expect(observe).toHaveBeenCalledTimes(2)
  })
  it('does not read disabled memory and surfaces document errors', async () => {
    const read = vi.fn(() => { throw new Error('Damaged memory') })
    const options = { projectId: 'project', store: { preferences: { read } } }
    const system = { kind: 'system' as const, content: '' }
    expect(await createConversationMemoryProjector({ ...options, enabled: false })(system, [])).toBe(system)
    expect(read).not.toHaveBeenCalled()
    await expect(createConversationMemoryProjector({ ...options, enabled: true })(system, [])).rejects.toThrow('Damaged memory')
  })
})
