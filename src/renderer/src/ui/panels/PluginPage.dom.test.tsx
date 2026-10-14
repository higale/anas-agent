import { act, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PanelPageApi, PanelPageContext } from '@shared/panelLifecycle'
import { PluginPage } from './PluginPage'

afterEach(() => vi.unstubAllGlobals())

it.each([false, true])('fits a restored plugin viewport with titlebar space (floating: %s)', async floating => {
  const port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn(), start() {}, close() {} }
  vi.stubGlobal('MessageChannel', class { port1 = port; port2 = {} })
  const api = { resizeWindow: vi.fn(async () => {}), onCommand: () => () => {}, onCancel: () => () => {} } as unknown as PanelPageApi
  const context = { pageId: 'page', panelId: 'panel', view: { name: 'Desktop' }, pluginUrl: 'https://plugin.test/index.html' } as PanelPageContext
  const { container } = render(<div className="panel-window-shell"><div className="panel-window-titlebar" /><PluginPage context={context} api={api} /></div>)
  const frame = container.querySelector('iframe')!
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
  const rect = (width: number, height: number) => ({ width, height } as DOMRect)
  // Integer innerWidth/innerHeight lose fractional CSS pixels at scaled DPI.
  const viewport = rect(window.innerWidth + 1 / 3, window.innerHeight + 1 / 3)
  vi.spyOn(document.documentElement, 'getBoundingClientRect').mockReturnValue(viewport)
  vi.spyOn(frame, 'getBoundingClientRect').mockReturnValue(rect(viewport.width, viewport.height - (floating ? 0 : 37)))
  vi.spyOn(container.querySelector('.panel-window-titlebar')!, 'getBoundingClientRect').mockReturnValue(rect(400, 37))
  act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin: 'https://plugin.test', data: { type: 'anas:ready' } })))
  await act(async () => {
    port.onmessage!({ data: { id: 'fit', method: 'resizeWindow', params: { width: 1024, height: 768, restore: true } } })
  })
  expect(api.resizeWindow).toHaveBeenCalledWith('page', { width: 1024, height: 805, restore: true })
  await waitFor(() => expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'reply', id: 'fit', error: undefined })))
})

it('reports the parent-assigned viewport on initialization, request and resize, and releases observation', async () => {
  const port = { onmessage: null as ((event: { data: unknown }) => void) | null, postMessage: vi.fn(), start() {}, close() {} }
  vi.stubGlobal('MessageChannel', class { port1 = port; port2 = {} })
  let resized = () => {}
  const disconnected = vi.fn()
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resized = callback } observe() {} disconnect = disconnected })
  const context = { pageId: 'page', panelId: 'panel', view: { name: 'Desktop' }, pluginUrl: 'https://plugin.test/index.html' } as PanelPageContext
  const api = { context: vi.fn(async () => context), onCommand: () => () => {}, onCancel: () => () => {} } as unknown as PanelPageApi
  const { container, unmount } = render(<PluginPage context={context} api={api} />)
  const frame = container.querySelector('iframe')!
  let width = 1920
  vi.spyOn(frame, 'getBoundingClientRect').mockImplementation(() => ({ width, height: 1080.25 } as DOMRect))
  vi.spyOn(frame.contentWindow!, 'postMessage').mockImplementation(() => {})
  act(() => window.dispatchEvent(new MessageEvent('message', { source: frame.contentWindow, origin: 'https://plugin.test', data: { type: 'anas:ready' } })))
  expect(port.postMessage).toHaveBeenLastCalledWith({ type: 'context', context: { ...context, viewport: { width: 1920, height: 1080.25 } } })
  width = 1600.5
  await act(async () => { port.onmessage!({ data: { id: 'measure', method: 'context' } }) })
  expect(port.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'reply', id: 'measure', result: { ...context, viewport: { width: 1600.5, height: 1080.25 } } }))
  width = 1280
  act(resized)
  expect(port.postMessage).toHaveBeenLastCalledWith({ type: 'context', context: { ...context, viewport: { width: 1280, height: 1080.25 } } })
  unmount(); expect(disconnected).toHaveBeenCalledOnce()
})
