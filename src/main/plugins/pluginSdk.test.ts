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

it('toolbar actions can await their own close while lifecycle disposal runs', async () => {
  vi.useFakeTimers()
  const listeners = new Map<string, (value: unknown) => unknown>()
  let disposeCount = 0, actionDone = false, closeRequested = false, closeId = ''
  const port = { onmessage: (_: any) => {}, start() {}, close() {}, postMessage(m: any) {
    if (m.method === 'invoke' && m.params.method === 'host.closeView') {
      closeRequested = true; closeId = m.id
      queueMicrotask(() => port.onmessage({ data: { type:'command', command: { kind:'dispose', requestId:'dispose', payload:{ reason:'closed' } } } }))
      // The real close waits for dispose before replying to this invoke request.
      return
    }
    if (m.method === 'complete' && m.params.requestId === 'dispose') queueMicrotask(() => port.onmessage({ data: { type:'reply', id:closeId, result:null } }))
    queueMicrotask(() => port.onmessage({ data: { type:'reply', id:m.id, result:null } }))
  } }
  const window: any = { parent: { postMessage() {} }, addEventListener: (key: string, handler: any) => listeners.set(key,handler) }
  runInNewContext(pluginSdk, { window, document:{body:{inert:false}}, AbortController, setTimeout, clearTimeout })
  listeners.get('message')!({ source:window.parent, data:{type:'anas:connect'}, ports:[port] })
  window.anas.registerLifecycle({ dispose: async () => { disposeCount++ } })
  window.anas.onToolbarAction(async () => { await window.anas.closeView({ instanceId:'server' }); actionDone = true })
  port.onmessage({ data: {type:'command', command:{kind:'action',requestId:'action',payload:{actionId:'close'}}} })
  for(let n=0;n<25;n++) await Promise.resolve()
  expect(closeRequested).toBe(true)
  expect(disposeCount).toBe(1)
  expect(actionDone).toBe(true)
  vi.clearAllTimers(); vi.useRealTimers()
})

it('notifies visibility changes without recreating the page or repeating unchanged activity', () => {
  const f = fixture(), changes: unknown[] = []
  ;(f.window.anas as unknown as { onViewChanged(listener: (view: unknown) => void): void }).onViewChanged(view => changes.push(view))
  const update = (visible: boolean, active = visible) => f.port.onmessage({ data: { type: 'context', context: {
    phase: 'active', location: 'sidebar', view: { content: { instanceId: 'desktop' }, activity: { visible, active } }
  } } })
  update(true); update(true); update(false); update(false); update(true, false)
  expect(changes).toEqual([
    { instanceId: 'desktop', location: 'sidebar', activity: { visible: true, active: true } },
    { instanceId: 'desktop', location: 'sidebar', activity: { visible: false, active: false } },
    { instanceId: 'desktop', location: 'sidebar', activity: { visible: true, active: false } }
  ])
})


it('notifies native window mode changes while preserving the same page', () => {
  const f = fixture(), changes: any[] = []
  ;(f.window.anas as any).onViewChanged((view: unknown) => changes.push(view))
  const update = (windowMode: string) => f.port.onmessage({ data: { type: 'context', context: {
    phase: 'active', location: 'window', windowMode, view: { content: { instanceId: 'desktop' } }
  } } })
  update('normal'); update('normal'); update('maximized'); update('fullscreen'); update('normal')
  expect(changes.map(view => view.windowMode)).toEqual(['normal', 'maximized', 'fullscreen', 'normal'])
})

it('reports placement changes once even when the native window size is unchanged', () => {
  const f = fixture(), placements: unknown[] = []
  ;(f.window.anas as any).onViewChanged((view: any) => placements.push(view.windowPlacement))
  const update = (x: number, displayId = 1) => f.port.onmessage({ data: { type: 'context', context: {
    phase: 'active', location: 'window', windowMode: 'normal', windowPlacement: { displayId, x, y: 50 }, view: { content: { instanceId: 'desktop' } }
  } } })
  update(100); update(100); update(120); update(120, 9)
  expect(placements).toEqual([{ displayId: 1, x: 100, y: 50 }, { displayId: 1, x: 120, y: 50 }, { displayId: 9, x: 120, y: 50 }])
})

it('notifies a completed user resize even when the final viewport returns to the same size', () => {
  const f = fixture(), revisions: unknown[] = []
  ;(f.window.anas as any).onViewChanged((view: any) => revisions.push(view.windowResizeRevision))
  const update = (windowResizeRevision: number) => f.port.onmessage({ data: { type: 'context', context: {
    phase: 'active', location: 'window', windowResizeRevision, viewport: { width: 1600, height: 900 }, view: { content: { instanceId: 'desktop' } }
  } } })
  update(0); update(0); update(1)
  expect(revisions).toEqual([0, 1])
})

it('reports assigned viewport changes without repeating unchanged dimensions', () => {
  const f = fixture(), sizes: unknown[] = []
  ;(f.window.anas as any).onViewChanged((view: any) => sizes.push(view.viewport))
  const update = (width: number) => f.port.onmessage({ data: { type: 'context', context: {
    phase: 'active', location: 'window', viewport: { width, height: 800 }, view: { content: { instanceId: 'desktop' } }
  } } })
  update(1200); update(1200); update(1400)
  expect(sizes).toEqual([{ width: 1200, height: 800 }, { width: 1400, height: 800 }])
})

it('routes directory selection and file reveal through the plugin host port', async () => {
  const f = fixture()
  const api = f.window.anas as unknown as { selectDirectory(options?: { title?: string }): Promise<string | null>; showItemInFolder(path: string): Promise<void> }
  expect(await api.selectDirectory({ title: 'Save files' })).toBeNull()
  await api.showItemInFolder('/chosen/file.txt')
  expect(f.calls).toEqual([
    expect.objectContaining({ method: 'invoke', params: { method: 'host.selectDirectory', params: { title: 'Save files' } } }),
    expect.objectContaining({ method: 'invoke', params: { method: 'host.showItemInFolder', params: { path: '/chosen/file.txt' } } })
  ])
})
