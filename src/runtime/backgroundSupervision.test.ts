import { describe, expect, it, vi } from 'vitest'
import { observedManagedCalls, observedSubagents, reconcileTaskObservations, type SupervisionMessage } from './backgroundSupervision'

const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
function evidence(kind: 'managed' | 'subagent'): SupervisionMessage[] {
  const name = kind === 'managed' ? 'read_call' : 'read_subagent'
  return ids.flatMap((id, index): SupervisionMessage[] => [
    { kind: 'calls', calls: [{ id: `read-${index}`, name, args: kind === 'managed' ? { call_id: id } : { subagent_id: id } }] },
    { kind: 'result', callId: `read-${index}`, name, content: JSON.stringify({ ok: true, terminal: true,
      ...(kind === 'managed' ? { call_id: id, status: 'completed', output_chars_total: 0 } : { subagent_id: id }) }) }
  ])
}

describe('native background completion acknowledgement', () => {
  it.each(['managed', 'subagent'] as const)('acknowledges durable %s results and reloads unresolved ownership', async kind => {
    const remaining = new Set(ids)
    const unresolved = vi.fn(() => [...remaining].map(id => ({ id })))
    const resolve = vi.fn(async (id: string) => { remaining.delete(id) })
    expect(await reconcileTaskObservations({ messages: evidence(kind), previous: {}, unresolved, resolve,
      observe: kind === 'managed' ? observedManagedCalls : observedSubagents })).toBeUndefined()
    expect(resolve.mock.calls).toEqual(ids.map(id => [id]))
    expect(unresolved).toHaveBeenCalledTimes(2)
    expect(remaining.size).toBe(0)
  })

  it('retains evidence until its owner acknowledges resolution and removes stale observations', async () => {
    const remaining = new Set(ids)
    const unresolved = vi.fn(() => [...remaining].map(id => ({ id })))
    const resolve = vi.fn((id: string) => { if (id === ids[0]) remaining.delete(id) })
    const retained = await reconcileTaskObservations({ messages: evidence('managed'), previous: { stale: true },
      unresolved, resolve, observe: observedManagedCalls })
    expect(retained).toEqual({ [ids[1]]: true })
    expect(await reconcileTaskObservations({ messages: evidence('managed'), previous: retained!, unresolved,
      resolve, observe: observedManagedCalls })).toBeUndefined()
  })

  it('retains completed evidence when no acknowledgement operation is provided', async () => {
    const unresolved = vi.fn(() => ids.map(id => ({ id })))
    expect(await reconcileTaskObservations({ messages: evidence('managed'), previous: {}, unresolved,
      observe: observedManagedCalls })).toEqual(Object.fromEntries(ids.map(id => [id, true])))
    expect(unresolved).toHaveBeenCalledOnce()
    const resolve = vi.fn()
    expect(await reconcileTaskObservations({ messages: evidence('managed').filter(item => item.kind === 'calls'),
      previous: {}, unresolved, resolve, observe: observedManagedCalls })).toBeUndefined()
    expect(resolve).not.toHaveBeenCalled()
  })

  it('drains entered acknowledgements on failure and keeps the original error', async () => {
    const failure = new Error('First confirmation failed')
    let finish!: () => void
    const second = new Promise<void>(resolve => { finish = resolve })
    const unresolved = vi.fn(() => ids.map(id => ({ id })))
    const resolve = vi.fn((id: string) => id === ids[0] ? Promise.reject(failure) : second)
    let finished = false
    const pending = reconcileTaskObservations({ messages: evidence('subagent'), previous: {}, unresolved, resolve,
      observe: observedSubagents }).finally(() => { finished = true })
    const rejected = expect(pending).rejects.toBe(failure)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(finished).toBe(false)
    finish()
    await rejected
    expect(unresolved).toHaveBeenCalledOnce()
  })

  it('does not start more acknowledgements after a synchronous owner failure', async () => {
    const failure = new Error('Owner unavailable')
    const resolve = vi.fn(() => { throw failure })
    await expect(reconcileTaskObservations({ messages: evidence('managed'), previous: {},
      unresolved: () => ids.map(id => ({ id })), resolve, observe: observedManagedCalls })).rejects.toBe(failure)
    expect(resolve).toHaveBeenCalledExactlyOnceWith(ids[0])
  })
})
