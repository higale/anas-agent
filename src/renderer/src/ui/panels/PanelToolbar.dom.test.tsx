import { fireEvent, render, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { PanelState } from '@shared/panels'
import { PanelToolbar } from './PanelToolbar'

it('shows accessible status and action labels and disables actions during execution or transfer', () => {
  const view: PanelState = { viewId: 'one', name: 'Example', content: { kind: 'plugin', pluginId: 'example', instanceId: 'main' },
    location: 'window', locations: ['sidebar', 'window'], toolbar: { status: { label: 'Connected', tone: 'success' },
      actions: [{ id: 'stop', label: 'Disconnect', icon: 'unplug' }] } }
  const onAction = vi.fn()
  const { rerender } = render(<PanelToolbar view={view} onAction={onAction} />)
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
