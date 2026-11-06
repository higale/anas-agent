import { afterEach, describe, expect, it, vi } from 'vitest'
import { ActivityDirectoryStore } from './activityDirectoryStore'
import type { ActivityDirectoryInput, ActivityDirectoryResult } from '@shared/activityDirectory'
import type { ActivityViewItem } from '@shared/activityView'

const scope = { runId: 'run' }
const reply = (key: string, sequence = 0): ActivityViewItem => ({ type: 'reply', key,
  position: { key, sequence, part: 2 }, start: { key, sequence, part: 2 }, end: { key, sequence, part: 2 },
  model: { id: key, sequence, text: '', reasoning: '', status: 'completed', toolCallIds: [], hasText: true } })
function harness() {
  const requests: { input: ActivityDirectoryInput; resolve(update: ActivityDirectoryResult): void; reject(error: Error): void }[] = []
  const cancel = vi.fn(async () => {})
  const store = new ActivityDirectoryStore('thread', { cancel,
    directory: input => new Promise((resolve, reject) => requests.push({ input, resolve, reject })) })
  return { store, requests, cancel }
}
const drain = async () => { await Promise.resolve(); await Promise.resolve() }
afterEach(() => vi.useRealTimers())

describe('activity directory ownership', () => {
  it('distinguishes an empty loaded directory from initial loading during subsequent refreshes', async () => {
    const { store, requests } = harness()
    store.sync([scope])
    expect(store.view(scope).initialized).toBe(false)
    requests[0].resolve({ version: 'empty', items: [], removed: [] }); await drain()
    store.retry(scope)
    expect(store.view(scope)).toMatchObject({ initialized: true, loading: false, items: [] })
    store.dispose()
  })
  it('keeps a 10000-item directory stable through unchanged refreshes, then publishes real changes', async () => {
    vi.useFakeTimers()
    const { store, requests } = harness(), child = { ...scope, parentId: 'group' }, changed = vi.fn()
    store.subscribe(changed); store.sync([child])
    requests[0].resolve({ version: 'v1', items: Array.from({ length: 10000 }, (_, index) => reply(`member-${index}`, index)), removed: [] }); await drain()
    const members = store.view(child).items
    changed.mockClear()
    for (let index = 0; index < 20; index++) {
      store.invalidate('run'); await vi.advanceTimersByTimeAsync(100)
      const request = requests.at(-1)!
      request.resolve({ version: `v${index + 2}`, baseVersion: request.input.version, items: [], removed: [] }); await drain()
      expect(store.view(child).items).toBe(members)
    }
    expect(changed).not.toHaveBeenCalled()
    store.invalidate('run'); await vi.advanceTimersByTimeAsync(100)
    requests.at(-1)!.resolve({ version: 'updated', baseVersion: 'v21',
      items: [reply('member-10000', 10000)], removed: ['member-0'] }); await drain()
    expect(changed).toHaveBeenCalledTimes(1)
    expect(store.view(child).items).toHaveLength(10000)
    expect(store.view(child).items[0].key).toBe('member-1')
    expect(store.view(child).items.at(-1)?.key).toBe('member-10000')
    store.dispose()
  })
  it('publishes recovery after an unchanged refresh and treats a full empty response as a reset', async () => {
    const { store, requests } = harness()
    store.sync([scope]); requests[0].resolve({ version: 'v1', items: [reply('saved')], removed: [] }); await drain()
    store.retry(scope); requests[1].reject(new Error('offline')); await drain()
    store.retry(scope); requests[2].resolve({ version: 'v1', baseVersion: 'v1', items: [], removed: [] }); await drain()
    expect(store.view(scope)).toMatchObject({ initialized: true, loading: false, items: [{ key: 'saved' }] })
    expect(store.view(scope).error).toBeUndefined()
    store.retry(scope); requests[3].resolve({ version: 'empty', items: [], removed: [] }); await drain()
    expect(store.view(scope).items).toEqual([])
    store.dispose()
  })
  it('notifies removal of a connection error even when a manual retry returns no directory changes', async () => {
    const { store, requests } = harness(), visibleErrors: unknown[] = []
    store.subscribe(() => visibleErrors.push(store.view(scope).error))
    store.sync([scope]); requests[0].resolve({ version: 'v1', items: [reply('saved')], removed: [] }); await drain()
    const error = new Error('connection failed')
    store.connectionFailed(error)
    expect(visibleErrors.at(-1)).toBe(error)
    store.retry(scope); requests[1].resolve({ version: 'v1', baseVersion: 'v1', items: [], removed: [] }); await drain()
    expect(visibleErrors.at(-1)).toBeUndefined()
    expect(store.view(scope).items[0].key).toBe('saved')
    store.dispose()
  })
  it('serializes refresh demand arriving during a read and atomically applies deltas', async () => {
    vi.useFakeTimers()
    const { store, requests } = harness()
    store.sync([scope]); store.invalidate('run'); store.invalidate('run')
    await vi.advanceTimersByTimeAsync(100)
    expect(requests).toHaveLength(1)
    requests[0].resolve({ version: 'v1', items: [reply('old')], removed: [] }); await drain()
    expect(requests).toHaveLength(2)
    expect(requests[1].input.version).toBe('v1')
    expect(store.view(scope).items.map(item => item.key)).toEqual(['old'])
    requests[1].resolve({ version: 'v2', baseVersion: 'v1', items: [reply('new')], removed: ['old'] }); await drain()
    expect(store.view(scope)).toMatchObject({ items: [{ key: 'new' }], loading: false })
    expect(requests).toHaveLength(2)
    store.dispose()
  })
  it('cancels closed directories and ignores late results after reopening or changing conversations', async () => {
    const { store, requests, cancel } = harness()
    store.sync([scope]); store.sync([]); store.sync([scope])
    expect(cancel).toHaveBeenCalledWith(requests[0].input.requestId)
    requests[0].resolve({ version: 'stale', items: [reply('stale')], removed: [] }); await drain()
    expect(store.view(scope).items).toEqual([])
    store.dispose(); store.start(); store.sync([scope])
    requests[1].resolve({ version: 'disposed', items: [reply('disposed')], removed: [] }); await drain()
    requests[2].resolve({ version: 'current', items: [reply('current')], removed: [] }); await drain()
    expect(store.view(scope).items.map(item => item.key)).toEqual(['current'])
    store.dispose()
  })
  it('ignores local cancellation acknowledgements and makes unexpected cancellation retryable', async () => {
    const { store, requests } = harness()
    store.sync([scope]); store.sync([]); store.sync([scope])
    requests[0].resolve({ cancelled: true }); await drain()
    expect(store.view(scope).error).toBeUndefined()
    requests[1].resolve({ version: 'v1', items: [reply('saved')], removed: [] }); await drain()
    store.retry(scope); requests[2].resolve({ cancelled: true }); await drain()
    expect(store.view(scope)).toMatchObject({ items: [{ key: 'saved' }], error: expect.any(Error), loading: false })
    store.retry(scope); requests[3].resolve({ version: 'v1', baseVersion: 'v1', items: [], removed: [] }); await drain()
    expect(store.view(scope).error).toBeUndefined()
    store.dispose()
  })
  it('keeps the readable directory on failure and retries it on reconnection', async () => {
    const { store, requests } = harness()
    store.sync([scope]); requests[0].resolve({ version: 'v1', items: [reply('saved')], removed: [] }); await drain()
    store.retry(scope); requests[1].reject(new Error('offline')); await drain()
    expect(store.view(scope)).toMatchObject({ items: [{ key: 'saved' }], error: expect.any(Error), loading: false })
    await store.synchronize()
    expect(requests).toHaveLength(3)
    requests[2].resolve({ version: 'v2', items: [reply('restored')], removed: [] }); await drain()
    expect(store.view(scope)).toMatchObject({ items: [{ key: 'restored' }], loading: false })
    expect(store.view(scope).error).toBeUndefined()
    store.dispose()
  })
  it.each(['retry', 'reconnect'] as const)('supersedes an outstanding read on %s and ignores its late failure', async action => {
    const { store, requests, cancel } = harness()
    store.sync([scope]); requests[0].resolve({ version: 'v1', items: [reply('saved')], removed: [] }); await drain()
    store.retry(scope)
    store.connectionFailed(new Error('disconnected'))
    if (action === 'retry') store.retry(scope)
    else await store.synchronize()
    expect(requests).toHaveLength(3)
    expect(cancel).toHaveBeenCalledWith(requests[1].input.requestId)
    requests[2].resolve({ version: 'v2', items: [reply('fresh')], removed: [] }); await drain()
    requests[1].reject(new Error('old connection failed')); await drain()
    expect(store.view(scope)).toMatchObject({ items: [{ key: 'fresh' }], initialized: true, loading: false })
    expect(store.view(scope).error).toBeUndefined()
    store.dispose()
  })
  it('rejects an invalid delta without partially changing the last complete directory', async () => {
    const { store, requests } = harness()
    store.sync([scope]); requests[0].resolve({ version: 'v1', items: [reply('saved')], removed: [] }); await drain()
    store.retry(scope); requests[1].resolve({ version: 'v3', baseVersion: 'v2', items: [reply('wrong')], removed: ['saved'] }); await drain()
    expect(store.view(scope).items.map(item => item.key)).toEqual(['saved'])
    expect(store.view(scope).error).toBeInstanceOf(Error)
    store.dispose()
  })
  it('reads opened members independently and closes their owner without discarding the outline', async () => {
    const { store, requests, cancel } = harness(), child = { ...scope, parentId: 'group' }
    store.sync([scope])
    requests[0].resolve({ version: 'v1', items: [reply('parent')], removed: [] }); await drain()
    expect(store.view(child).initialized).toBe(false)
    store.sync([scope, child])
    expect(requests).toHaveLength(2)
    expect(requests[1].input.parentId).toBe('group')
    requests[1].resolve({ version: 'member-v1', items: [reply('member')], removed: [] }); await drain()
    expect(store.view(child).items[0].key).toBe('member')
    expect(store.view(scope).items[0].key).toBe('parent')
    store.retry(child); store.sync([scope])
    expect(cancel).toHaveBeenCalledWith(requests[2].input.requestId)
    requests[2].resolve({ version: 'late', items: [reply('late')], removed: [] }); await drain()
    expect(store.view(child).items).toEqual([])
    expect(store.view(scope).items[0].key).toBe('parent')
    store.dispose()
  })
})
