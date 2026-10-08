import { EventEmitter } from 'node:events'
import { beforeEach, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { tooltipStyleProperties, type NativeTooltip } from '@shared/nativeTooltip'

const create = vi.hoisted(() => vi.fn())
vi.mock('electron', () => ({ BrowserWindow: create, nativeTheme: { shouldUseDarkColors: true } }))
import { NativeTooltips } from './nativeTooltip'
import { applyWindowTheme } from '../windowAppearance'

class Window extends EventEmitter {
  destroyed = false
  webContents = Object.assign(new EventEmitter(), { getZoomFactor: () => 1.25,
    setZoomFactor: vi.fn(), setWindowOpenHandler: vi.fn() })
  getContentBounds = () => ({ x: 100, y: 200, width: 1000, height: 700 })
  isDestroyed = () => this.destroyed
  isVisible = () => true
  setIgnoreMouseEvents = vi.fn()
  setBackgroundColor = vi.fn()
  setTitleBarOverlay = vi.fn()
  showInactive = vi.fn()
  loadURL = vi.fn(async (_url: string) => {})
  destroy = vi.fn(() => { this.destroyed = true; this.emit('closed') })
}
const value: NativeTooltip = { label: 'Disconnect', bounds: { x: 700, y: 44, width: 100, height: 30 },
  styles: Object.fromEntries(tooltipStyleProperties.map(key => [key, ''])) as NativeTooltip['styles'] }
let tooltips: NativeTooltips, owner: Window, windows: Window[]
beforeEach(() => {
  tooltips = new NativeTooltips(); owner = new Window(); windows = []
  create.mockImplementation(function () { const window = new Window(); windows.push(window); return window })
})
const set = (input: unknown) => tooltips.set(owner as unknown as BrowserWindow, input)

it('opens a mouse-transparent, unfocused tooltip at the owner zoom and removes it on dismissal', async () => {
  await set(value)
  expect(windows[0].showInactive).toHaveBeenCalledOnce()
  expect(windows[0].setIgnoreMouseEvents).toHaveBeenCalledWith(true, { forward: true })
  expect(windows[0].webContents.setZoomFactor).toHaveBeenCalledWith(1.25)
  expect(create).toHaveBeenLastCalledWith(expect.objectContaining({ parent: owner, focusable: false, transparent: true,
    x: 935, y: 215, width: 205, height: 118 }))
  await set(value)
  expect(windows).toHaveLength(1)
  await set(null)
  expect(windows[0].destroyed).toBe(true)
  expect(owner.listenerCount('blur')).toBe(0)
})

it.each(['blur', 'hide', 'move', 'resize', 'closed'])('cleans up when the owner emits %s', async event => {
  await set(value)
  owner.emit(event)
  expect(windows[0].destroyed).toBe(true)
  expect(owner.listenerCount('closed')).toBe(0)
})

it('never shows a dismissed or superseded tooltip after a late load', async () => {
  let loaded!: () => void
  create.mockImplementationOnce(function () {
    const window = new Window(); windows.push(window)
    window.loadURL.mockImplementation(() => new Promise<void>(resolve => { loaded = resolve }))
    return window
  })
  const pending = set(value)
  await set(null)
  await set({ ...value, label: 'Cancel' })
  loaded(); await pending
  expect(windows[0].showInactive).not.toHaveBeenCalled()
  expect(windows[1].showInactive).toHaveBeenCalledOnce()
  await set(null)
})

it('rejects invalid tooltip data before creating a native surface', async () => {
  await expect(set({ ...value, bounds: { ...value.bounds, width: NaN } })).rejects.toThrow()
  await expect(set({ ...value, label: 'x'.repeat(8193) })).rejects.toThrow()
  expect(windows).toHaveLength(0)
})

it('preserves tooltip transparency while application windows follow theme changes', async () => {
  await set(value)
  applyWindowTheme(owner as unknown as BrowserWindow)
  applyWindowTheme(windows[0] as unknown as BrowserWindow)
  expect(owner.setBackgroundColor).toHaveBeenCalledWith('#202020')
  expect(windows[0].setBackgroundColor).not.toHaveBeenCalled()
  expect(windows[0].setTitleBarOverlay).not.toHaveBeenCalled()
  await set(null)
})
