import { act, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { PanelState } from '@shared/panels'
import { requirePanelToolbar } from '@shared/panelToolbar'
import { PanelToolbar } from './PanelToolbar'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => vi.unstubAllGlobals())

it('shows accessible status and action labels and disables actions during execution or transfer', () => {
  const view: PanelState = { viewId: 'one', name: 'Example', content: { kind: 'plugin', pluginId: 'example', instanceId: 'main' },
    location: 'window', locations: ['sidebar', 'window'], toolbar: requirePanelToolbar({ status: { label: 'Connected', tone: 'success' },
      actions: [{ id: 'stop', label: 'Disconnect', icon: 'assets/unplug.svg' }, { id: 'servers', label: 'Server list', icon: 'assets/list.svg' }] }) }
  const onAction = vi.fn()
  const { rerender } = render(<PanelToolbar view={view} onAction={onAction} />)
  expect(screen.getByRole('button', { name: 'Server list' }).querySelector('img')).toHaveAttribute('src', 'anas-plugin://example/_anas/icon/assets/list.svg')
  fireEvent.click(screen.getByRole('button', { name: 'Server list' }))
  expect(onAction).toHaveBeenCalledWith('servers')
  expect(screen.getByRole('status')).toHaveTextContent('Connected')
  fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }))
  expect(onAction).toHaveBeenCalledWith('stop')
  for (const update of [{ pendingActionId: 'stop' }, { pendingLocation: 'sidebar' as const }, { loading: true }]) {
    rerender(<PanelToolbar view={{ ...view, ...update }} onAction={onAction} />)
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeDisabled()
  }
  rerender(<PanelToolbar view={{ ...view, toolbar: undefined }} onAction={onAction} />)
  expect(screen.queryByRole('button')).not.toBeInTheDocument()
})

it('renders optional toggle state and keeps ordinary actions as buttons', () => {
  const view: PanelState = { viewId: 'lock', name: 'Desktop', content: { kind: 'plugin', pluginId: 'example', instanceId: 'desktop' },
    location: 'window', locations: ['sidebar', 'window'] }
  const onAction = vi.fn()
  const toolbar = (pressed: boolean) => requirePanelToolbar({ actions: [
    { id: 'lock', icon: pressed ? 'assets/lock.svg' : 'assets/lock-open.svg', label: 'Local input', pressed },
    { id: 'stop', icon: 'assets/unplug.svg', label: 'Disconnect' }
  ] })
  const { rerender } = render(<PanelToolbar view={{ ...view, toolbar: toolbar(false) }} onAction={onAction} />)
  const button = screen.getByRole('button', { name: 'Local input', pressed: false })
  fireEvent.click(button)
  expect(onAction).toHaveBeenCalledWith('lock')
  rerender(<PanelToolbar view={{ ...view, toolbar: toolbar(true) }} onAction={onAction} />)
  expect(screen.getByRole('button', { name: 'Local input', pressed: true })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Disconnect' })).not.toHaveAttribute('aria-pressed')
  expect(() => requirePanelToolbar({ actions: [{ id: 'lock', icon: 'assets/lock.svg', label: 'Lock', pressed: 'false' }] })).toThrow()
})

it('accepts more than four actions and moves only overflow into an operable menu', async () => {
  let width = 72
  let resize = () => {}
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('panel-toolbar-actions') ? width : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { x: 0, y: 0, left: 0, top: 0, right: 24, bottom: 24, width: this.classList.contains('panel-toolbar-measure') ? 24 : 0, height: 24, toJSON() {} }
  })
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe(target: Element) {
      if (target.classList.contains('panel-toolbar-actions')) resize = () => this.callback([], this as unknown as ResizeObserver)
    }
    unobserve() {}
    disconnect() {}
  })
  const actions = Array.from({ length: 7 }, (_, index) => ({ id: `action-${index}`, icon: 'assets/scan.svg', label: `Action ${index}`,
    ...(index === 5 ? { pressed: true } : {}), disabled: index === 6 }))
  const view: PanelState = { viewId: 'many', name: 'Desktop', content: { kind: 'plugin', pluginId: 'example', instanceId: 'desktop' },
    location: 'window', locations: ['window'], toolbar: requirePanelToolbar({ actions }) }
  const onAction = vi.fn(), user = userEvent.setup()
  const { rerender } = render(<PanelToolbar view={view} onAction={onAction} />)
  expect(screen.getByRole('button', { name: 'Action 0' })).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Action 2' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'common.more' }))
  expect(screen.getByRole('menuitemcheckbox', { name: 'Action 5', checked: true })).toBeEnabled()
  expect(screen.getByRole('menuitemcheckbox', { name: 'Action 5' }).querySelector('img')).toHaveAttribute('src', 'anas-plugin://example/_anas/icon/assets/scan.svg')
  expect(screen.getByRole('menuitem', { name: 'Action 6' })).toHaveAttribute('aria-disabled', 'true')
  await user.click(screen.getByRole('menuitem', { name: 'Action 4' }))
  expect(onAction).toHaveBeenCalledWith('action-4')
  rerender(<PanelToolbar view={{ ...view, pendingActionId: 'action-4' }} onAction={onAction} />)
  await user.click(screen.getByRole('button', { name: 'common.more' }))
  expect(screen.getByRole('menuitemcheckbox', { name: 'Action 5' })).toHaveAttribute('aria-disabled', 'true')
  await user.keyboard('{Escape}')
  rerender(<PanelToolbar view={view} onAction={onAction} />)
  width = 400
  act(resize)
  expect(screen.queryByRole('button', { name: 'common.more' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Action 5', pressed: true })).toBeEnabled()
})
