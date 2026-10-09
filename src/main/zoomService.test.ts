import { EventEmitter } from 'node:events'
import type { BrowserWindow } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerWindowZoomShortcuts } from './zoomService'

vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn() }))
class Contents extends EventEmitter {
  level = 0
  destroyed = false
  isDestroyed = () => this.destroyed
  getZoomLevel = () => this.level
  getZoomFactor = () => 1.2 ** this.level
  setZoomLevel = (level: number) => { this.level = level }
  setZoomFactor = (factor: number) => { this.level = Math.log(factor) / Math.log(1.2) }
  send = vi.fn()
}
describe('window zoom shortcuts', () => {
  it('keeps keyboard and wheel zoom local to the window receiving input', () => {
    const main = new Contents(), detached = new Contents()
    for (const contents of [main, detached]) registerWindowZoomShortcuts({ webContents: contents } as unknown as BrowserWindow)
    const preventDefault = vi.fn()
    main.emit('before-input-event', { preventDefault }, { type: 'keyDown', control: true, key: '=' })
    expect(main.getZoomFactor()).toBeGreaterThan(1)
    expect(detached.getZoomFactor()).toBe(1)
    detached.emit('zoom-changed', { preventDefault }, 'out')
    expect(detached.getZoomFactor()).toBeLessThan(1)
    expect(main.getZoomFactor()).toBeGreaterThan(1)
    detached.emit('before-input-event', { preventDefault }, { type: 'keyDown', control: true, key: '0' })
    expect(detached.getZoomFactor()).toBe(1)
    expect(preventDefault).toHaveBeenCalledTimes(3)
    expect(main.send).toHaveBeenLastCalledWith('app:zoomChanged', expect.any(Number))
    expect(detached.send).toHaveBeenLastCalledWith('app:zoomChanged', 100)
  })
  it('leaves other shortcuts and destroyed windows alone', () => {
    const detached = new Contents()
    registerWindowZoomShortcuts({ webContents: detached } as unknown as BrowserWindow)
    const preventDefault = vi.fn()
    detached.emit('before-input-event', { preventDefault }, { type: 'keyDown', control: true, key: 'c' })
    detached.emit('before-input-event', { preventDefault }, { type: 'keyDown', control: true, alt: true, key: '=' })
    detached.destroyed = true
    detached.emit('zoom-changed', { preventDefault }, 'in')
    detached.emit('before-input-event', { preventDefault }, { type: 'keyDown', control: true, key: '=' })
    expect(preventDefault).not.toHaveBeenCalled()
    expect(detached.getZoomFactor()).toBe(1)
  })
})
