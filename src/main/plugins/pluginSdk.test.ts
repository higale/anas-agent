import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { pluginSdk } from './pluginSdk'

function fixture() {
  const listeners = new Map<string, (event: unknown) => void>()
  const calls: { method: string; params?: { requestId?: string } }[] = []
  const port = { onmessage: (_event: { data: unknown }) => {}, start() {}, close() {}, postMessage(message: { id: string; method: string; params?: { requestId?: string } }) {
    calls.push(message)
    queueMicrotask(() => port.onmessage({ data: { type: 'reply', id: message.id, result: message.method === 'context' ? { phase: 'suspended' } : null } }))
  } }
  const window = { parent: { postMessage() {} }, addEventListener(type: string, listener: (event: unknown) => void) { listeners.set(type, listener) }, anas: undefined as unknown as { registerLifecycle(handlers: Record<string, (input: { signal: AbortSignal }) => Promise<unknown>>): void } }
  const document = { body: { inert: false } }
  runInNewContext(pluginSdk, { window, document, AbortController, setTimeout, clearTimeout })
  listeners.get('message')!({ source: window.parent, data: { type: 'anas:connect' }, ports: [port] })
  const command = (kind: string, requestId: string) => port.onmessage({ data: { type: 'command', command: { kind, requestId, payload: null } } })
  return { window, document, port, calls, command }
}
describe('plugin lifecycle scheduling', () => {
  it('waits for cancelled preparation to finish before resuming and drops stale replies', async () => {
    const f = fixture(), order: string[] = []
    let release!: () => void
    f.window.anas.registerLifecycle({
      prepare: async ({ signal }) => { order.push('prepare'); await new Promise<void>(resolve => { release = resolve }); expect(signal.aborted).toBe(true); order.push('saved'); return { draft: 'latest' } },
      resume: async () => { order.push('resume') }
    })
    f.command('prepare', 'old')
    await vi.waitFor(() => expect(order).toEqual(['prepare']))
    f.port.onmessage({ data: { type: 'cancel', requestId: 'old' } })
    f.command('resume', 'current')
    await Promise.resolve()
    expect(order).toEqual(['prepare'])
    release()
    await vi.waitFor(() => expect(order).toEqual(['prepare', 'saved', 'resume']))
    expect(f.calls.filter(call => call.method === 'complete').map(call => call.params?.requestId)).toEqual(['current'])
    expect(f.document.body.inert).toBe(false)
  })
})
