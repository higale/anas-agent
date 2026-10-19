import { describe, expect, it } from 'vitest'
import type { AgentThread } from './agentTypes'
import { orderProjectThreads } from './sidebarOrder'

function thread(id: string, date: string, pinned = false): AgentThread {
  return { id, projectId: 'project', title: id, pinned, accessMode: 'full_access', status: 'idle', userTurnCount: 0,
    createdAt: date, updatedAt: date }
}

describe('sidebar conversation order', () => {
  it('keeps automatic ordering until dragged, then ignores activity and puts new conversations first within pin groups', () => {
    const a = thread('a', '2026-10-01')
    const b = thread('b', '2026-10-02')
    const pinned = thread('pinned', '2026-10-01', true)
    expect(orderProjectThreads([a, b, pinned]).map(t => t.id)).toEqual(['pinned', 'b', 'a'])
    b.updatedAt = '2026-10-30'
    const fresh = thread('fresh', '2026-10-03')
    expect(orderProjectThreads([a, b, fresh, pinned], ['a', 'b', 'pinned', 'deleted']).map(t => t.id))
      .toEqual(['pinned', 'fresh', 'a', 'b'])
    expect(orderProjectThreads([a, b], []).map(t => t.id)).toEqual(['b', 'a'])
  })
})
