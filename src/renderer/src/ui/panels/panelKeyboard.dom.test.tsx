import { describe, expect, it, vi } from 'vitest'
import { installPanelEscapeHandler } from './panelKeyboard'

describe('panel Escape routing', () => {
  it('lets child menus, editors and composition consume input before forwarding', () => {
    const escape = vi.fn()
    const stop = installPanelEscapeHandler(escape)
    const input = document.createElement('input')
    document.body.append(input)
    const key = (options: KeyboardEventInit = {}) => input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', bubbles: true, cancelable: true, ...options
    }))
    try {
      input.addEventListener('keydown', event => event.preventDefault(), { once: true })
      key()
      input.addEventListener('keydown', event => event.stopPropagation(), { once: true })
      key()
      key({ isComposing: true }); key({ repeat: true }); key({ ctrlKey: true }); key({ key: 'Enter' })
      expect(escape).not.toHaveBeenCalled()
      key()
      expect(escape).toHaveBeenCalledOnce()
      stop(); key()
      expect(escape).toHaveBeenCalledOnce()
    } finally { stop(); input.remove() }
  })
})
