import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PanelState } from '@shared/panels'
import { PanelWindowTitlebar } from './PanelWindowTitlebar'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const view: PanelState = { viewId: 'desktop', name: 'Desktop', content: { kind: 'plugin', pluginId: 'rdp', instanceId: 'one' },
  location: 'window', locations: ['sidebar', 'window'], toolbar: { actions: [{ id: 'disconnect', label: 'Disconnect', icon: 'assets/unplug.svg' }] } }
beforeEach(() => {
  document.documentElement.dataset.platform = 'darwin'
  Object.defineProperty(window, 'panelWindow', { configurable: true, value: {
    moveToSidebar: vi.fn(async () => {}), setFullScreen: vi.fn(async () => {}), invokeToolbarAction: vi.fn(async () => {})
  } })
})
afterEach(() => { delete document.documentElement.dataset.platform })
function mount() {
  const result = render(<div><PanelWindowTitlebar view={view} fullScreen /></div>)
  const toolbar = result.container.querySelector<HTMLElement>('.panel-window-titlebar')!
  const rect = (left: number, width: number) => ({ left, x: left, right: left + width, width, top: 12, y: 12, height: 37, bottom: 49, toJSON() {} })
  vi.spyOn(toolbar, 'getBoundingClientRect').mockReturnValue(rect(300, 400))
  vi.spyOn(toolbar.parentElement!, 'getBoundingClientRect').mockReturnValue(rect(0, 1000))
  const handle = screen.getByRole('button', { name: 'panels.move_toolbar' })
  const move = (clientX: number, pointerId = 7) => fireEvent.pointerMove(handle, { pointerId, clientX })
  const down = () => fireEvent.pointerDown(handle, { button: 0, isPrimary: true, pointerId: 7, clientX: 312 })
  return { ...result, toolbar, handle, down, move }
}
describe('fullscreen panel toolbar', () => {
  it.each(['plugin', 'document'] as const)('offers a Windows fullscreen entry for %s windows and switches to exit after confirmation', async kind => {
    document.documentElement.dataset.platform = 'win32'
    const content: PanelState['content'] = kind === 'plugin' ? view.content : { kind: 'document', documentId: 'USER_GUIDE.en.md' }
    const panel = { ...view, content }
    const { rerender } = render(<PanelWindowTitlebar view={panel} fullScreen={false} />)
    const button = screen.getByRole('button', { name: 'panels.enter_fullscreen' })
    expect(button).toHaveAttribute('data-tooltip', 'panels.enter_fullscreen')
    await act(async () => { fireEvent.click(button) })
    expect(window.panelWindow.setFullScreen).toHaveBeenLastCalledWith(true)
    expect(screen.queryByRole('button', { name: 'panels.exit_fullscreen' })).toBeNull()
    rerender(<PanelWindowTitlebar view={panel} fullScreen />)
    expect(screen.queryByRole('button', { name: 'panels.enter_fullscreen' })).toBeNull()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'panels.exit_fullscreen' })) })
    expect(window.panelWindow.setFullScreen).toHaveBeenLastCalledWith(false)
  })
  it('keeps the native macOS entry and offers the shared exit when fullscreen', () => {
    const { rerender } = render(<PanelWindowTitlebar view={view} fullScreen={false} />)
    expect(screen.queryByRole('button', { name: 'panels.enter_fullscreen' })).toBeNull()
    rerender(<PanelWindowTitlebar view={view} fullScreen />)
    expect(screen.getByRole('button', { name: 'panels.exit_fullscreen' })).toBeVisible()
  })
  it('drags horizontally within the window and preserves position across fullscreen toggles', () => {
    const { toolbar, handle, down, move, rerender } = mount()
    down()
    move(1200)
    expect(toolbar.style.transform).toBe('translateX(-100%)')
    move(-500)
    expect(toolbar.style.transform).toBe('translateX(0%)')
    move(456)
    fireEvent.pointerUp(handle, { pointerId: 7, clientX: 456 })
    expect(toolbar.style.transform).toBe('translateX(-75%)')
    expect(toolbar).toHaveAttribute('data-dragging', 'false')
    rerender(<div><PanelWindowTitlebar view={view} fullScreen={false} /></div>)
    expect(screen.queryByRole('button', { name: 'panels.exit_fullscreen' })).toBeNull()
    expect(toolbar.style.transform).toBe('')
    rerender(<div><PanelWindowTitlebar view={view} fullScreen /></div>)
    expect(toolbar.style.transform).toBe('translateX(-75%)')
  })
  it.each(['pointercancel', 'lostpointercapture', 'blur', 'resize'])('ends dragging on %s and ignores unrelated pointers', event => {
    const { toolbar, handle, down, move } = mount()
    down()
    move(900, 8)
    expect(toolbar.style.transform).toBe('translateX(-50%)')
    move(600)
    const position = toolbar.style.transform
    if (event === 'pointercancel') fireEvent.pointerCancel(handle, { pointerId: 7 })
    else if (event === 'lostpointercapture') fireEvent.lostPointerCapture(handle, { pointerId: 7 })
    else fireEvent(window, new Event(event))
    move(900)
    expect(toolbar.style.transform).toBe(position)
    expect(toolbar).toHaveAttribute('data-dragging', 'false')
  })
  it('supports keyboard positioning and retains the existing actions and exit control', async () => {
    const { toolbar, handle } = mount()
    fireEvent.keyDown(handle, { key: 'End' })
    expect(toolbar.style.transform).toBe('translateX(-100%)')
    fireEvent.keyDown(handle, { key: 'Home' })
    expect(toolbar.style.transform).toBe('translateX(0%)')
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    expect(toolbar.style.transform).not.toBe('translateX(0%)')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
      fireEvent.click(screen.getByRole('button', { name: 'panels.move_sidebar' }))
      fireEvent.click(screen.getByRole('button', { name: 'panels.exit_fullscreen' }))
    })
    expect(window.panelWindow.invokeToolbarAction).toHaveBeenCalledWith('disconnect')
    expect(window.panelWindow.moveToSidebar).toHaveBeenCalledOnce()
    expect(window.panelWindow.setFullScreen).toHaveBeenCalledExactlyOnceWith(false)
  })
})
