import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { registerZoomShortcuts } from './zoomService'

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
describe('movable content zoom shortcuts', () => {
  it('resolves the current owner for keyboard and wheel zoom without zooming the source alone', () => {
    const source = new Contents(), main = new Contents(), detached = new Contents()
    let owner: Contents | undefined = main
    registerZoomShortcuts(source as unknown as WebContents, () => owner as unknown as WebContents | undefined)
    const preventDefault = vi.fn()
    source.emit('before-input-event', { preventDefault }, { type: 'keyDown', control: true, key: '=' })
    expect(main.getZoomFactor()).toBeGreaterThan(1)
    expect(source.getZoomFactor()).toBe(1)
    owner = detached
    source.emit('zoom-changed', { preventDefault }, 'out')
    expect(detached.getZoomFactor()).toBeLessThan(1)
    expect(main.getZoomFactor()).toBeGreaterThan(1)
    source.emit('before-input-event', { preventDefault }, { type: 'keyDown', control: true, key: '0' })
    expect(detached.getZoomFactor()).toBe(1)
    expect(preventDefault).toHaveBeenCalledTimes(3)
    source.emit('before-input-event', { preventDefault }, { type: 'keyDown', control: true, key: 'c' })
    detached.destroyed = true
    source.emit('zoom-changed', { preventDefault }, 'in')
    owner = undefined
    source.emit('zoom-changed', { preventDefault }, 'in')
    expect(preventDefault).toHaveBeenCalledTimes(3)
  })
})
