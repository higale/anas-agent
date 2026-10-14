import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginStore } from './pluginStore'
const mocks = vi.hoisted(() => ({ fork: vi.fn() }))
vi.mock('electron', () => ({ app: { getAppPath: () => '/app' }, utilityProcess: { fork: mocks.fork } }))
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
    packageDirectory: async () => '/plugin', directory: async (group: string, id: string) => `/data/${group}/${group === 'tmp' ? `anas-plugin-${id}` : id}`
  } as unknown as PluginStore, vi.fn(), 1000, 100)
})
afterEach(() => vi.useRealTimers())

async function started() {
  const starting = backend.start('test-plugin')
  await vi.waitFor(() => expect(mocks.fork).toHaveBeenCalled())
  child.emit('message', { ready: true })
  await starting
}

describe('optional plugin backend', () => {
  it('passes persistent and temporary directories separately to the worker', async () => {
    await started()
    const [, args] = mocks.fork.mock.calls.at(-1)!
    expect(JSON.parse(args[1])).toEqual({ pluginId: 'test-plugin', packageDirectory: '/plugin',
      dataDirectory: '/data/plugins_data/test-plugin', tempDirectory: '/data/tmp/anas-plugin-test-plugin' })
    await backend.stopAll()
  })

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
    expect(child.postMessage).toHaveBeenCalledWith({ cancel: sent.id, reason: 'stopped' })
    expect(child.postMessage).toHaveBeenLastCalledWith({ stop: true })
    child.emit('message', { id: sent.id, result: 'completed' })
    expect(await active).toBe('completed')
    expect(child.postMessage.mock.calls.filter(([message]) => 'method' in message)).toHaveLength(1)
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

  it('reports explicit stop cleanup failure after an earlier request timeout', async () => {
    await started()
    vi.useFakeTimers()
    child.postMessage.mockImplementation(() => undefined)
    const request = backend.call('test-plugin', 'hang', null)
    const requestAssertion = expect(request).rejects.toMatchObject({ code: 'unknown_effect' })
    await vi.advanceTimersByTimeAsync(1050)
    const stopping = backend.stop('test-plugin')
    const stopAssertion = expect(stopping).rejects.toThrow('cleanup timed out')
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([requestAssertion, stopAssertion])
    expect(backend.status('test-plugin').backendStatus).toBe('failed')
  })

  it('reports an abnormal exit during cleanup as a stop failure', async () => {
    await started()
    child.postMessage.mockImplementation(() => undefined)
    const stopping = backend.stop('test-plugin')
    const assertion = expect(stopping).rejects.toThrow('before cleanup completed')
    child.emit('exit', 1)
    await assertion
  })

  it('keeps a timed-out RPC in order, expires queued calls without dispatch and accepts its late result', async () => {
    await started()
    vi.useFakeTimers()
    const request = backend.call('test-plugin', 'hang', null)
    const sent = child.postMessage.mock.calls.at(-1)![0] as { id: number }
    const queued = backend.call('test-plugin', 'must-not-run', null)
    const assertion = expect(queued).rejects.toMatchObject({ code: 'timeout', dispatched: false })
    await vi.advanceTimersByTimeAsync(60_000)
    await assertion
    expect(child.postMessage).toHaveBeenCalledWith({ cancel: sent.id, reason: 'timeout' })
    expect(child.postMessage.mock.calls.filter(([message]) => 'method' in message)).toHaveLength(1)
    expect(child.kill).not.toHaveBeenCalled()
    const next = backend.call('test-plugin', 'after-receipt', null)
    expect(child.postMessage.mock.calls.filter(([message]) => 'method' in message)).toHaveLength(1)
    child.emit('message', { id: sent.id, result: 'completed' })
    expect(await request).toBe('completed')
    const nextSent = child.postMessage.mock.calls.at(-1)![0] as { id: number; method: string }
    expect(nextSent.method).toBe('after-receipt')
    child.emit('message', { id: nextSent.id, result: null })
    await next
    expect(mocks.fork).toHaveBeenCalledOnce()
    expect(backend.status('test-plugin').backendStatus).toBe('running')
    await backend.stopAll()
  })
})

describe('no-page plugin tool calls', () => {
  it('returns live views from the host without exposing other plugins', async () => {
    let views = [{ panelId: 'panel', instanceId: 'main', location: 'sidebar' as const }]
    const store = { requireEnabled: async () => ({ backend: 'backend.cjs' }), packageFile: async () => '/plugin/backend.cjs',
      packageDirectory: async () => '/plugin', directory: async () => '/data' } as unknown as PluginStore
    const readViews = vi.fn(() => views)
    backend = new PluginBackends(store, vi.fn(), 1000, 100, readViews)
    await started()
    child.emit('message', { hostRequest: 1, method: 'getViews' })
    expect(readViews).toHaveBeenCalledWith('test-plugin')
    expect(child.postMessage).toHaveBeenLastCalledWith({ hostResponse: 1, result: views })
    backend.viewsChanged()
    expect(child.postMessage).toHaveBeenLastCalledWith({ viewsChanged: views })
    child.postMessage.mockClear()
    backend.viewsChanged()
    expect(child.postMessage).not.toHaveBeenCalled()
    views = []
    backend.viewsChanged()
    expect(child.postMessage).toHaveBeenLastCalledWith({ viewsChanged: [] })
    child.emit('message', { hostRequest: 2, method: 'getViews' })
    expect(child.postMessage).toHaveBeenLastCalledWith({ hostResponse: 2, result: [] })
    await backend.stopAll()
  })

  it.each(['openView', 'moveView', 'closeView'])('scopes %s to its originating backend and rechecks delayed actions after stop', async method => {
    const store = { requireEnabled: async () => ({ backend: 'backend.cjs' }), packageFile: async () => '/plugin/backend.cjs',
      packageDirectory: async () => '/plugin', directory: async () => '/data' } as unknown as PluginStore
    let resume!: () => void
    let changed = false
    const action = vi.fn(async (_id, _method, _params, check) => {
      await new Promise<void>(resolve => { resume = resolve })
      check(); changed = true; return null
    })
    backend = new PluginBackends(store, vi.fn(), 1000, 100, undefined, action)
    await started()
    child.emit('message', { hostRequest: 1, method, params: { instanceId: 'server', location: 'sidebar' } })
    expect(action).toHaveBeenCalledWith('test-plugin', method, { instanceId: 'server', location: 'sidebar' }, expect.any(Function))
    await backend.stopAll()
    resume()
    await vi.waitFor(() => expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({hostResponse:1,error:expect.stringContaining('unavailable')})))
    expect(changed).toBe(false)
  })

  it('allows a page query while a tool runs and preserves the real result after cancellation', async () => {
    await started()
    const prepared = await backend.prepare('test-plugin')
    const controller = new AbortController()
    const dispatched = vi.fn()
    const tool = backend.tool('test-plugin', 'slow', {}, prepared, { timeoutMs: 10_000, signal: controller.signal, onDispatch: dispatched })
    const page = backend.call('test-plugin', 'status', {})
    const calls = child.postMessage.mock.calls.map(([message]) => message as { id: number; method?: string })
    expect(calls.map(call => call.method)).toEqual(['slow', 'status'])
    expect(dispatched).toHaveBeenCalledOnce()
    expect(child.postMessage).toHaveBeenCalledWith(expect.objectContaining({ tool: true, context: { deadline: expect.any(Number) } }))
    child.emit('message', { id: calls[1].id, result: 'ready' })
    expect(await page).toBe('ready')
    controller.abort()
    expect(child.postMessage).toHaveBeenLastCalledWith({ cancel: calls[0].id, reason: 'cancelled' })
    child.emit('message', { id: calls[0].id, result: 'effect completed' })
    expect(await tool).toBe('effect completed')
    expect(child.kill).not.toHaveBeenCalled()
    await backend.stopAll()
  })
  it('never dispatches an already cancelled tool', async () => {
    await started()
    const prepared = await backend.prepare('test-plugin')
    await expect(backend.tool('test-plugin', 'write', {}, prepared, { timeoutMs: 1000, signal: AbortSignal.abort(), onDispatch: vi.fn() })).rejects.toMatchObject({ code: 'cancelled', dispatched: false })
    expect(child.postMessage).not.toHaveBeenCalled()
    await backend.stopAll()
  })
  it('lets cancelled accepted work finish within its original deadline without killing shared resources', async () => {
    await started()
    vi.useFakeTimers()
    const prepared = await backend.prepare('test-plugin')
    const controller = new AbortController()
    let settled = false
    const tool = backend.tool('test-plugin', 'input', {}, prepared, { timeoutMs: 30_000, signal: controller.signal, onDispatch: vi.fn() })
      .finally(() => { settled = true })
    const other = backend.tool('test-plugin', 'other', {}, prepared, { timeoutMs: 30_000, onDispatch: vi.fn() })
    const calls = child.postMessage.mock.calls.map(([message]) => message as { id: number })
    controller.abort()
    expect(child.postMessage).toHaveBeenLastCalledWith({ cancel: calls[0].id, reason: 'cancelled' })
    await vi.advanceTimersByTimeAsync(4000)
    expect(settled).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
    expect(backend.status('test-plugin').backendStatus).toBe('running')
    const page = backend.call('test-plugin', 'status', {})
    const pageCall = child.postMessage.mock.calls.at(-1)![0] as { id: number }
    child.emit('message', { id: pageCall.id, result: 'connected' })
    expect(await page).toBe('connected')
    child.emit('message', { id: calls[0].id, result: { accepted: true } })
    expect(await tool).toEqual({ accepted: true })
    child.emit('message', { id: calls[1].id, result: 'still running' })
    expect(await other).toBe('still running')
    await vi.advanceTimersByTimeAsync(30_000)
    expect(child.kill).not.toHaveBeenCalled()
    await backend.stopAll()
  })

  it.each([50, 1050])('retains late results and other resources after timeout and cancellation at %i ms', async cancelledAt => {
    await started()
    vi.useFakeTimers()
    const prepared = await backend.prepare('test-plugin')
    const controller = new AbortController()
    const tool = backend.tool('test-plugin', 'hang', {}, prepared, { timeoutMs: 1000, signal: controller.signal, onDispatch: vi.fn() })
    let settled = false
    void tool.then(() => { settled = true })
    const sent = child.postMessage.mock.calls.at(-1)![0] as { id: number }
    await vi.advanceTimersByTimeAsync(cancelledAt)
    controller.abort()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(child.postMessage).toHaveBeenCalledWith({ cancel: sent.id, reason: 'timeout' })
    expect(settled).toBe(false)
    expect(child.kill).not.toHaveBeenCalled()
    expect(backend.status('test-plugin').backendStatus).toBe('running')
    const other = backend.tool('test-plugin', 'other-session', {}, prepared, { timeoutMs: 1000, onDispatch: vi.fn() })
    const otherSent = child.postMessage.mock.calls.at(-1)![0] as { id: number }
    child.emit('message', { id: otherSent.id, result: 'connected' })
    expect(await other).toBe('connected')
    const page = backend.call('test-plugin', 'status', {})
    const pageSent = child.postMessage.mock.calls.at(-1)![0] as { id: number }
    child.emit('message', { id: pageSent.id, result: 'visible' })
    expect(await page).toBe('visible')
    child.emit('message', { id: sent.id, result: 'completed late' })
    expect(await tool).toBe('completed late')
    await backend.stopAll()
  })

  it('keeps explicit backend stopping bounded after a tool was cancelled', async () => {
    await started()
    vi.useFakeTimers()
    child.postMessage.mockImplementation(() => undefined)
    const prepared = await backend.prepare('test-plugin')
    const controller = new AbortController()
    const tool = backend.tool('test-plugin', 'hang', {}, prepared, { timeoutMs: 30_000, signal: controller.signal, onDispatch: vi.fn() })
    const assertion = expect(tool).rejects.toMatchObject({ code: 'unknown_effect', dispatched: true })
    controller.abort()
    const stopping = backend.stop('test-plugin')
    const stopAssertion = expect(stopping).rejects.toThrow('cleanup timed out')
    await vi.advanceTimersByTimeAsync(100)
    await Promise.all([assertion, stopAssertion])
    expect(child.kill).toHaveBeenCalledOnce()
  })
  it('does not send a call cancelled at the dispatch boundary', async () => {
    await started()
    const prepared = await backend.prepare('test-plugin')
    const controller = new AbortController()
    await expect(backend.tool('test-plugin', 'write', {}, prepared, { timeoutMs: 1000,
      signal: controller.signal, onDispatch: () => controller.abort() })).rejects.toMatchObject({ code: 'cancelled', dispatched: false })
    expect(child.postMessage).not.toHaveBeenCalled()
    await backend.stopAll()
  })

  it('cancels a timed-out call without terminating unrelated work after a cooperative reply', async () => {
    await started()
    vi.useFakeTimers()
    const prepared = await backend.prepare('test-plugin')
    const slow = backend.tool('test-plugin', 'slow', {}, prepared, { timeoutMs: 100, onDispatch: vi.fn() })
    const assertion = expect(slow).rejects.toMatchObject({ code: 'unknown_effect', dispatched: true })
    const other = backend.tool('test-plugin', 'other', {}, prepared, { timeoutMs: 1000, onDispatch: vi.fn() })
    const messages = child.postMessage.mock.calls.map(([message]) => message as { id: number })
    await vi.advanceTimersByTimeAsync(101)
    child.emit('message', { id: messages[0].id, error: 'aborted' })
    await assertion
    await vi.advanceTimersByTimeAsync(101)
    expect(child.kill).not.toHaveBeenCalled()
    child.emit('message', { id: messages[1].id, result: false })
    expect(await other).toBe(false)
    await backend.stopAll()
  })
})

it('opt-in concurrent RPC permits lifecycle calls without changing default RPC ordering', async () => {
  await started()
  const operation = backend.call('test-plugin', 'orchestrate', null, undefined, undefined, { concurrent: true })
  const disposal = backend.call('test-plugin', 'dispose', null)
  const next = backend.call('test-plugin', 'after', null)
  const sent = child.postMessage.mock.calls.map(([message]) => message as { id: number; method: string })
  expect(sent.map(message => message.method)).toEqual(['orchestrate', 'dispose'])
  child.emit('message', { id: sent[1].id, result: null }); await disposal
  expect(child.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ method: 'after' }))
  const last = child.postMessage.mock.calls.at(-1)![0] as { id: number }
  child.emit('message', { id: last.id, result: null }); await next
  child.emit('message', { id: sent[0].id, result: null }); await operation
  await backend.stopAll()
})
