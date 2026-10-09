import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginStore } from './pluginStore'
const mocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ utilityProcess: { fork: mocks.fork } }))
import { PluginBackends } from './pluginBackend'

class FakeProcess extends EventEmitter {
  postMessage = vi.fn((message: { stop?: boolean }) => { if (message.stop) queueMicrotask(() => this.emit('exit', 0)) })
  kill = vi.fn(() => { this.emit('exit', 1); return true })
}
let child: FakeProcess
let backend: PluginBackends
beforeEach(() => {
  child = new FakeProcess()
  mocks.fork.mockReturnValue(child)
  backend = new PluginBackends({
    requireEnabled: async () => ({ backend: 'backend.cjs' }), packageFile: async () => '/plugin/backend.cjs',
    packageDirectory: async () => '/plugin', directory: async () => '/data'
  } as unknown as PluginStore, vi.fn(), 1000)
})
afterEach(() => vi.useRealTimers())

async function started() {
  const starting = backend.start('test-plugin')
  await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalled())
  child.emit('message', { ready: true })
  await starting
}

describe('optional plugin backend', () => {
  it('captures host context when a queued call is dispatched, not when enqueued', async () => {
    await started()
    let views = [{ panelId: 'home', instanceId: 'main', location: 'sidebar' as const }]
    const context = () => ({ caller: null, views })
    const first = backend.call('test-plugin', 'first', null, undefined, context)
    const second = backend.call('test-plugin', 'second', null, undefined, context)
    views = []
    const sent = child.postMessage.mock.calls[0][0] as { id: number }
    child.emit('message', { id: sent.id, result: null })
    await first
    expect(child.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'second', context: { caller: null, views: [] } }))
    const next = child.postMessage.mock.calls[1][0] as { id: number }
    child.emit('message', { id: next.id, result: null })
    await second
    await backend.stopAll()
  })

  it('starts once for concurrent callers and shares the same process', async () => {
    expect(mocks.fork).not.toHaveBeenCalled()
    const first = backend.start('test-plugin')
    const second = backend.start('test-plugin')
    await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalledTimes(1))
    child.emit('message', { ready: true })
    await Promise.all([first, second])
    const request = backend.call('test-plugin', 'echo', false)
    const sent = child.postMessage.mock.calls.at(-1)![0] as { id: number }
    child.emit('message', { id: sent.id, result: false })
    expect(await request).toBe(false)
    await backend.stopAll()
    expect(backend.status('test-plugin').backendStatus).toBe('stopped')
  })

  it('reports individual RPC errors without crashing and rejects pending calls on exit', async () => {
    await started()
    const first = backend.call('test-plugin', 'fail', null)
    const firstAssertion = expect(first).rejects.toThrow('failure')
    const sent = child.postMessage.mock.calls.at(-1)![0] as { id: number }
    child.emit('message', { id: sent.id, error: 'failure' })
    await firstAssertion
    expect(backend.status('test-plugin').backendStatus).toBe('running')
    const second = backend.call('test-plugin', 'pending', null)
    const secondAssertion = expect(second).rejects.toThrow('exited')
    child.emit('exit', 1)
    await secondAssertion
    expect(backend.status('test-plugin').backendStatus).toBe('failed')
  })

  it('can stop a backend while its activation is still pending', async () => {
    const instance = await backend.prepare('test-plugin')
    const assertion = expect(instance.ready).rejects.toThrow('stopped')
    await backend.stop('test-plugin')
    await assertion
    expect(backend.status('test-plugin').backendStatus).toBe('stopped')
  })

  it('dispatches one call at a time and cancels queued work while retaining the active result on stop', async () => {
    await started()
    child.postMessage.mockImplementation(() => undefined)
    const active = backend.call('test-plugin', 'work', 1)
    const queued = backend.call('test-plugin', 'work', 2)
    const queuedAssertion = expect(queued).rejects.toThrow('before this request started')
    expect(child.postMessage).toHaveBeenCalledTimes(1)
    const sent = child.postMessage.mock.calls[0][0] as { id: number }
    const stopping = backend.stop('test-plugin')
    await queuedAssertion
    expect(child.postMessage).toHaveBeenCalledTimes(2)
    expect(child.postMessage).toHaveBeenLastCalledWith({ stop: true })
    child.emit('message', { id: sent.id, result: 'completed' })
    expect(await active).toBe('completed')
    expect(child.postMessage).toHaveBeenCalledTimes(2)
    child.emit('exit', 0)
    await stopping
    expect(backend.status('test-plugin').backendStatus).toBe('stopped')
  })

  it('dispatches the next queued call after the active call settles', async () => {
    await started()
    const first = backend.call('test-plugin', 'work', 1)
    const second = backend.call('test-plugin', 'work', 2)
    expect(child.postMessage).toHaveBeenCalledTimes(1)
    const firstSent = child.postMessage.mock.calls[0][0] as { id: number }
    child.emit('message', { id: firstSent.id, result: 1 })
    expect(await first).toBe(1)
    expect(child.postMessage).toHaveBeenCalledTimes(2)
    const secondSent = child.postMessage.mock.calls[1][0] as { id: number }
    child.emit('message', { id: secondSent.id, result: 2 })
    expect(await second).toBe(2)
    await backend.stopAll()
  })

  it('does not dispatch an old prepared request into a restarted backend', async () => {
    await started()
    const previous = await backend.prepare('test-plugin')
    await backend.stopAll()
    child = new FakeProcess()
    mocks.fork.mockReturnValue(child)
    const next = await backend.prepare('test-plugin')
    child.emit('message', { ready: true })
    await next.ready
    await expect(backend.call('test-plugin', 'work', 1, previous)).rejects.toThrow('unavailable')
    expect(child.postMessage).not.toHaveBeenCalled()
    await backend.stopAll()
  })

  it('reports a cleanup failure instead of reporting a successful stop', async () => {
    await started()
    child.postMessage.mockImplementation(() => undefined)
    const stopping = backend.stop('test-plugin')
    const assertion = expect(stopping).rejects.toThrow('cleanup failed: cleanup unavailable')
    child.emit('message', { stopError: 'cleanup unavailable' })
    child.emit('exit', 0)
    await assertion
    expect(backend.status('test-plugin')).toEqual({ backendStatus: 'failed', backendError: 'Plugin backend cleanup failed: cleanup unavailable' })
  })

  it('waits for every backend to exit before reporting a cleanup failure', async () => {
    await started()
    const first = child
    const second = new FakeProcess()
    first.postMessage.mockImplementation(() => undefined)
    second.postMessage.mockImplementation(() => undefined)
    mocks.fork.mockReturnValue(second)
    const prepared = await backend.prepare('second-plugin')
    second.emit('message', { ready: true })
    await prepared.ready
    let settled = false
    const stopping = backend.stopAll().finally(() => { settled = true })
    const assertion = expect(stopping).rejects.toThrow('Could not cleanly stop all plugin backends')
    first.emit('message', { stopError: 'cleanup unavailable' })
    first.emit('exit', 0)
    await vi.waitFor(() => expect(backend.status('test-plugin').backendStatus).toBe('failed'))
    expect(settled).toBe(false)
    second.emit('exit', 0)
    await assertion
    expect(backend.status('second-plugin').backendStatus).toBe('stopped')
  })

  it('terminates an unresponsive backend without replaying requests', async () => {
    await started()
    vi.useFakeTimers()
    const request = backend.call('test-plugin', 'hang', null)
    const assertion = expect(request).rejects.toThrow('timed out')
    await vi.advanceTimersByTimeAsync(1001)
    await assertion
    expect(child.kill).toHaveBeenCalledOnce()
    expect(mocks.fork).toHaveBeenCalledOnce()
    expect(backend.status('test-plugin').backendStatus).toBe('failed')
  })
})
