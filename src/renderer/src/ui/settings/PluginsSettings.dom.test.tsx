import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginSummary } from '@shared/plugins'
import { PluginsSettings } from './PluginsSettings'
import { notice } from '../notice'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))
const invoke = vi.fn(), uninstall = vi.fn(), install = vi.fn(), confirmInstall = vi.fn(), cancelInstall = vi.fn()
const plugin: PluginSummary = { id: 'example', enabled: true, backendStatus: 'stopped', manifest: {
  id: 'example', name: 'Example', pluginVersion: '1.0.0', apiVersion: 2, description: '', ui: 'index.html',
  home: { defaultLocation: 'window', locations: ['window', 'sidebar'] }
} }
const renderSettings = (plugins = [plugin]) => render(<PluginsSettings plugins={plugins} onRefresh={vi.fn(async () => {})} onOpen={vi.fn()} />)
beforeEach(() => {
  vi.clearAllMocks()
  invoke.mockReset().mockImplementation(async (_id, method) => method === 'host.home' ? { location: 'window', locations: ['window', 'sidebar'] } : null)
  uninstall.mockResolvedValue(undefined)
  install.mockReset()
  confirmInstall.mockReset().mockResolvedValue(plugin)
  cancelInstall.mockReset().mockResolvedValue(undefined)
  Object.defineProperty(window, 'gale', { configurable: true, value: { plugins: { invoke, uninstall, install, confirmInstall, cancelInstall } } })
})

describe('plugin settings', () => {
  it('displays disabled plugin icons and reports decode errors without blocking controls', () => {
    const { container } = renderSettings([{ ...plugin, enabled: false, manifest: { ...plugin.manifest!, icon: 'icon.svg' } }])
    expect(container.querySelector('.ui-list-pane img')).toHaveAttribute('src', 'anas-plugin://example/_anas/icon/icon.svg')
    fireEvent.error(container.querySelector('.settings-detail-heading img')!)
    expect(screen.getByRole('alert')).toHaveTextContent('plugins.icon_failed')
    expect(screen.getByRole('checkbox', { name: 'settings.enabled' })).toBeEnabled()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('edits home location in the selected plugin configuration without opening a page', async () => {
    renderSettings()
    await waitFor(() => expect(screen.getByRole('radio', { name: 'plugins.home_window' })).toBeChecked())
    await userEvent.click(screen.getByRole('radio', { name: 'plugins.home_sidebar' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeChecked())
    expect(invoke).toHaveBeenCalledWith('example', 'data.set', { key: 'home_open_location', value: 'sidebar' })
    expect(invoke.mock.calls.every(([, method]) => ['host.home', 'data.set'].includes(method))).toBe(true)
  })

  it('retains the previous location and reports a failed save', async () => {
    invoke.mockImplementation(async (_id, method) => {
      if (method === 'data.set') throw new Error('disk failure')
      return { location: 'window', locations: ['window', 'sidebar'] }
    })
    renderSettings()
    await waitFor(() => expect(screen.getByRole('radio', { name: 'plugins.home_window' })).toBeChecked())
    await userEvent.click(screen.getByRole('radio', { name: 'plugins.home_sidebar' }))
    await waitFor(() => expect(notice.error).toHaveBeenCalled())
    expect(screen.getByRole('radio', { name: 'plugins.home_window' })).toBeChecked()
  })

  it('ignores a previous plugin read after selecting another plugin', async () => {
    let finish!: (value: unknown) => void
    invoke.mockImplementation(async id => id === 'example' ? new Promise(resolve => { finish = resolve }) : { location: 'sidebar' })
    renderSettings([plugin, { ...plugin, id: 'second', manifest: { ...plugin.manifest!, id: 'second', name: 'Second' } }])
    await userEvent.click(screen.getByRole('button', { name: 'Second' }))
    await waitFor(() => expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeChecked())
    await act(async () => finish({ location: 'window' }))
    expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeChecked()
  })

  it('defaults to retaining data, honors explicit deletion and resets a canceled choice', async () => {
    renderSettings()
    const open = async () => {
      await userEvent.click(screen.getByRole('button', { name: 'plugins.uninstall' }))
      return within(screen.getByRole('alertdialog'))
    }
    let dialog = await open()
    expect(dialog.getByRole('checkbox', { name: 'plugins.delete_data' })).not.toBeChecked()
    await userEvent.click(dialog.getByRole('button', { name: 'common.confirm' }))
    await waitFor(() => expect(uninstall).toHaveBeenLastCalledWith('example', false))
    dialog = await open()
    await userEvent.click(dialog.getByRole('checkbox', { name: 'plugins.delete_data' }))
    await userEvent.click(dialog.getByRole('button', { name: 'common.cancel' }))
    dialog = await open()
    expect(dialog.getByRole('checkbox', { name: 'plugins.delete_data' })).not.toBeChecked()
    await userEvent.click(dialog.getByRole('checkbox', { name: 'plugins.delete_data' }))
    await userEvent.click(dialog.getByRole('button', { name: 'common.confirm' }))
    await waitFor(() => expect(uninstall).toHaveBeenLastCalledWith('example', true))
  })
})


describe('plugin replacement confirmation', () => {
  const preview = { token: 'prepared-token', installed: plugin, incoming: { ...plugin.manifest!, pluginVersion: '2.0.0' } }
  async function open() {
    await userEvent.click(screen.getByRole('button', { name: 'plugins.install' }))
    return within(await screen.findByRole('alertdialog'))
  }
  beforeEach(() => { install.mockResolvedValue({ replacement: preview }) })

  it('shows both versions, retains data by default and confirms without canceling staging', async () => {
    renderSettings()
    const dialog = await open()
    expect(dialog.getByText('1.0.0')).toBeVisible()
    expect(dialog.getByText('2.0.0')).toBeVisible()
    expect(dialog.getByRole('checkbox', { name: 'plugins.delete_data' })).not.toBeChecked()
    expect(confirmInstall).not.toHaveBeenCalled()
    await userEvent.click(dialog.getByRole('button', { name: 'plugins.replace' }))
    await waitFor(() => expect(confirmInstall).toHaveBeenCalledExactlyOnceWith(preview.token, false))
    expect(cancelInstall).not.toHaveBeenCalled()
  })

  it('cancels explicitly, resets deletion on reopen and honors an explicit deletion choice', async () => {
    renderSettings()
    let dialog = await open()
    await userEvent.click(dialog.getByRole('checkbox', { name: 'plugins.delete_data' }))
    await userEvent.click(dialog.getByRole('button', { name: 'common.cancel' }))
    await waitFor(() => expect(cancelInstall).toHaveBeenCalledExactlyOnceWith(preview.token))
    expect(confirmInstall).not.toHaveBeenCalled()
    cancelInstall.mockClear()
    dialog = await open()
    expect(dialog.getByRole('checkbox', { name: 'plugins.delete_data' })).not.toBeChecked()
    await userEvent.click(dialog.getByRole('checkbox', { name: 'plugins.delete_data' }))
    await userEvent.click(dialog.getByRole('button', { name: 'plugins.replace' }))
    await waitFor(() => expect(confirmInstall).toHaveBeenCalledExactlyOnceWith(preview.token, true))
    expect(cancelInstall).not.toHaveBeenCalled()
  })

  it('keeps the preview across rerenders and discards it when leaving settings', async () => {
    const view = renderSettings()
    await open()
    view.rerender(<PluginsSettings plugins={[{ ...plugin }]} onRefresh={vi.fn(async () => {})} onOpen={vi.fn()} />)
    expect(screen.getByRole('alertdialog')).toBeVisible()
    expect(cancelInstall).not.toHaveBeenCalled()
    view.unmount()
    await waitFor(() => expect(cancelInstall).toHaveBeenCalledExactlyOnceWith(preview.token))
  })

  it('discards a preview that arrives after settings has unmounted', async () => {
    let resolve!: (result: unknown) => void
    install.mockImplementation(() => new Promise(done => { resolve = done }))
    const view = renderSettings()
    await userEvent.click(screen.getByRole('button', { name: 'plugins.install' }))
    view.unmount()
    await act(async () => resolve({ replacement: preview }))
    expect(cancelInstall).toHaveBeenCalledExactlyOnceWith(preview.token)
    expect(confirmInstall).not.toHaveBeenCalled()
  })

  it('reports replacement failure without uninstalling the existing plugin', async () => {
    confirmInstall.mockRejectedValue(new Error('Directory busy'))
    renderSettings()
    const dialog = await open()
    await userEvent.click(dialog.getByRole('button', { name: 'plugins.replace' }))
    await waitFor(() => expect(notice.error).toHaveBeenCalled())
    expect(screen.getByRole('button', { name: 'Example' })).toBeVisible()
    expect(uninstall).not.toHaveBeenCalled()
    expect(cancelInstall).not.toHaveBeenCalled()
  })

  it('does not ask for replacement when installing a new plugin', async () => {
    install.mockResolvedValue(plugin)
    renderSettings()
    await userEvent.click(screen.getByRole('button', { name: 'plugins.install' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'plugins.install' })).toBeEnabled())
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(confirmInstall).not.toHaveBeenCalled()
  })
})
