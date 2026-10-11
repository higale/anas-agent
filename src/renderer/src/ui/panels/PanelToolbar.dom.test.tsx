import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { PanelState } from '@shared/panels'
import { requirePanelToolbar } from '@shared/panelToolbar'
import { PanelToolbar } from './PanelToolbar'

it('shows accessible status and action labels and disables actions during execution or transfer', () => {
  const view: PanelState = { viewId: 'one', name: 'Example', content: { kind: 'plugin', pluginId: 'example', instanceId: 'main' },
    location: 'window', locations: ['sidebar', 'window'], toolbar: requirePanelToolbar({ status: { label: 'Connected', tone: 'success' },
      actions: [{ id: 'stop', label: 'Disconnect', icon: 'unplug' }, { id: 'servers', label: 'Server list', icon: 'list' }] }) }
  const onAction = vi.fn()
  const { rerender } = render(<PanelToolbar view={view} onAction={onAction} />)
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
    { id: 'lock', icon: pressed ? 'lock' : 'lock-open', label: 'Local input', pressed },
    { id: 'stop', icon: 'unplug', label: 'Disconnect' }
  ] })
  const { rerender } = render(<PanelToolbar view={{ ...view, toolbar: toolbar(false) }} onAction={onAction} />)
  const button = screen.getByRole('button', { name: 'Local input', pressed: false })
  fireEvent.click(button)
  expect(onAction).toHaveBeenCalledWith('lock')
  rerender(<PanelToolbar view={{ ...view, toolbar: toolbar(true) }} onAction={onAction} />)
  expect(screen.getByRole('button', { name: 'Local input', pressed: true })).toBeEnabled()
  expect(screen.getByRole('button', { name: 'Disconnect' })).not.toHaveAttribute('aria-pressed')
  expect(() => requirePanelToolbar({ actions: [{ id: 'lock', icon: 'lock', label: 'Lock', pressed: 'false' }] })).toThrow()
})
