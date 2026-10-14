import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('electron', async () => ({ screen: new (await import('node:events')).EventEmitter() }))
vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))
import { screen } from 'electron'
import { runtimeLog } from './runtimeLogger'
import { registerMacWindowMoveSizeGuard } from './macWindowMoveSize'

class Window extends EventEmitter {
  destroyed = false
  maximized = false
  fullscreen = false
  bounds = { x: 20, y: 50, width: 1200, height: 800 }
  getBounds = () => ({ ...this.bounds })
  isDestroyed = () => this.destroyed
  isMaximized = () => this.maximized
  isFullScreen = () => this.fullscreen
}
let window: Window
let state: { eventType: number; eventTimestamp: number; eventWindow: number; window: number; liveResize: boolean; leftMouseDown: boolean; inputSequence: string }
let observe = vi.fn(() => state)
const install = (platform: NodeJS.Platform = 'darwin') => registerMacWindowMoveSizeGuard(window as unknown as BrowserWindow, { platform, observe })
const move = () => { window.emit('will-move'); state = { ...state, eventType: 13 } }
const resize = () => { const event = { preventDefault: vi.fn() }; window.emit('will-resize', event); return event.preventDefault }
beforeEach(() => {
  window = new Window()
  state = { eventType: 6, eventTimestamp: 100, eventWindow: 42, window: 42, liveResize: false, leftMouseDown: true, inputSequence: '10:1:0:30:4' }
  observe = vi.fn(() => state)
})
afterEach(() => { window.emit('closed'); vi.clearAllMocks() })

describe('macOS native move size preservation', () => {
  it('cancels repeated stale resize requests in the same move-end event, allowing a later event', () => {
    install(); move()
    window.bounds.x = -1500; window.bounds.y = -900
    expect(resize()).toHaveBeenCalledOnce()
    expect(resize()).toHaveBeenCalledOnce()
    state.eventTimestamp++
    expect(resize()).not.toHaveBeenCalled()
  })
  it.each([
    { liveResize: true }, // Edge dragging and AppKit's live window resizing.
    { eventType: 6 }, // Actual mouse input, not an AppKit adjustment.
    { eventWindow: 99 }, // An event dispatched for a different native window.
    { inputSequence: '11:1:0:30:4' }, // A new mouse gesture after moving.
    { inputSequence: '10:1:0:31:4' }, // A keyboard command after moving.
    { inputSequence: '10:1:0:30:5' } // Modifier-driven window commands.
  ])('preserves an intentional resize: %j', change => {
    install(); move(); state = { ...state, ...change }
    expect(resize()).not.toHaveBeenCalled()
  })
  it('does not treat a move without a mouse press as a drag', () => {
    install(); state.leftMouseDown = false; move()
    expect(resize()).not.toHaveBeenCalled()
  })
  it('recognizes native dragging even when currentEvent still belongs to a tooltip', () => {
    install(); state.eventType = 13; state.eventWindow = 99; move(); state.eventWindow = 42
    expect(resize()).toHaveBeenCalledOnce()
  })
  it('does not undo a size explicitly changed since the move', () => {
    install(); move(); window.bounds.width = 1600
    expect(resize()).not.toHaveBeenCalled()
  })
  it.each(['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'hide', 'blur', 'minimize'])('discards the gesture on %s', event => {
    install(); move(); window.emit(event)
    expect(resize()).not.toHaveBeenCalled()
  })
  it.each(['display-added', 'display-removed', 'display-metrics-changed'])('allows repositioning after %s', event => {
    install(); move(); screen.emit(event)
    expect(resize()).not.toHaveBeenCalled()
  })
  it.each(['maximized', 'fullscreen'] as const)('does not constrain a %s window', mode => {
    install(); move(); window[mode] = true
    expect(resize()).not.toHaveBeenCalled()
  })
  it('releases window and display listeners when closed', () => {
    install(); move(); window.destroyed = true; window.emit('closed')
    expect(window.eventNames()).toEqual([])
    expect(screen.eventNames()).toEqual([])
    expect(resize()).not.toHaveBeenCalled()
  })
  it('shares display observation and retains it until the last window closes', () => {
    const other = new Window()
    install(); registerMacWindowMoveSizeGuard(other as unknown as BrowserWindow, { platform: 'darwin', observe })
    expect(screen.listenerCount('display-removed')).toBe(1)
    window.emit('closed')
    other.emit('will-move'); state.eventType = 13; screen.emit('display-removed')
    const event = { preventDefault: vi.fn() }; other.emit('will-resize', event)
    expect(event.preventDefault).not.toHaveBeenCalled()
    other.emit('closed'); expect(screen.eventNames()).toEqual([])
  })
  it('reports a native observation failure and stops using it', () => {
    install(); observe.mockImplementation(() => { throw new Error('native observation failed') })
    move(); resize()
    expect(runtimeLog).toHaveBeenCalledWith('error', 'window', expect.stringContaining('protection stopped'), expect.objectContaining({ error: expect.any(Error) }))
    expect(observe).toHaveBeenCalledOnce()
    expect(screen.eventNames()).toEqual([])
  })
  it.each(['win32', 'linux'] as const)('leaves %s unchanged without native bindings', platform => {
    install(platform); move(); resize()
    expect(observe).not.toHaveBeenCalled()
    expect(window.eventNames()).toEqual([])
    expect(screen.eventNames()).toEqual([])
  })
})
