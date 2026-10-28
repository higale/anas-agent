import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolArgumentProgress } from './toolArgumentProgress'

describe('application tool argument reception progress', () => {
  afterEach(() => vi.useRealTimers())

  it('publishes the first tool immediately, batches snapshots, and binds late IDs by block index', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const progress = new ToolArgumentProgress(publish)
    progress.accept({ index: 2, name: 'apply_patch', characterCount: 0, streamed: true, complete: false })
    expect(publish).toHaveBeenCalledTimes(1)
    progress.accept({ index: 2, characterCount: 9, streamed: true, complete: false })
    progress.accept({ index: 2, callId: 'patch-id', characterCount: 17, streamed: true, complete: false })
    vi.advanceTimersByTime(249)
    expect(publish).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    expect(publish).toHaveBeenCalledTimes(2)
    expect(publish.mock.lastCall?.[0]).toMatchObject([
      { index: 2, callId: 'patch-id', name: 'apply_patch', characterCount: 17, complete: false }
    ])
    progress.accept({ index: 3, callId: 'read-id', name: 'read_file', characterCount: 0, streamed: true, complete: false })
    expect(publish.mock.lastCall?.[0][1]).toMatchObject({ index: 3, callId: 'read-id', name: 'read_file', characterCount: 0 })
    progress.accept({ index: 2, callId: 'patch-id', name: 'apply_patch', streamed: false, complete: true })
    expect(publish.mock.lastCall?.[0][0]).toEqual({ index: 2, callId: 'patch-id', name: 'apply_patch', characterCount: 17, complete: true })
    progress.dispose()
    vi.runAllTimers()
    expect(publish).toHaveBeenCalledTimes(4)
  })

  it('reports large character counts as metadata without allocating argument content', () => {
    const publish = vi.fn()
    const progress = new ToolArgumentProgress(publish)
    progress.accept({ index: 0, name: 'apply_patch', characterCount: 100008, streamed: true, complete: false })
    expect(publish.mock.lastCall?.[0][0]).toEqual({ index: 0, callId: undefined, name: 'apply_patch', characterCount: 100008, complete: false })
    expect(publish.mock.lastCall?.[0][0]).not.toHaveProperty('args')
    progress.dispose()
  })

  it('drops pending snapshots and ignores late events after cancellation', () => {
    vi.useFakeTimers()
    const publish = vi.fn()
    const progress = new ToolArgumentProgress(publish)
    progress.accept({ index: 0, name: 'read_file', characterCount: 0, streamed: true, complete: false })
    progress.accept({ index: 0, characterCount: 10, streamed: true, complete: false })
    progress.dispose()
    progress.accept({ index: 1, name: 'apply_patch', characterCount: 0, streamed: true, complete: false })
    vi.runAllTimers()
    expect(publish).toHaveBeenCalledOnce()
  })

  it('preserves an explicit zero snapshot and ignores atomic calls without stream progress', () => {
    const publish = vi.fn()
    const progress = new ToolArgumentProgress(publish)
    progress.accept({ index: 1, name: 'read_file', characterCount: 100, streamed: true, complete: false })
    progress.accept({ index: 1, callId: 'read', characterCount: 0, streamed: true, complete: true })
    expect(publish.mock.lastCall?.[0]).toEqual([{ index: 1, callId: 'read', name: 'read_file', characterCount: 0, complete: true }])
    progress.accept({ index: 2, callId: 'atomic', name: 'read_file', streamed: false, complete: true })
    expect(publish).toHaveBeenCalledTimes(2)
    progress.dispose()
  })
})
