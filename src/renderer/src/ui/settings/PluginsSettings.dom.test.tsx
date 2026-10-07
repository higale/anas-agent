import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginSummary } from '@shared/plugins'
import { PluginsSettings } from './PluginsSettings'
import { notice } from '../notice'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))
const invoke = vi.fn(), uninstall = vi.fn()
const plugin: PluginSummary = { id: 'example', enabled: true, backendStatus: 'stopped', manifest: {
  id: 'example', name: 'Example', pluginVersion: '1.0.0', apiVersion: 1, description: '', ui: 'index.html',
  home: { defaultLocation: 'window', locations: ['window', 'sidebar'] }
} }
const renderSettings = (plugins = [plugin]) => render(<PluginsSettings plugins={plugins} onRefresh={vi.fn(async () => {})} onOpen={vi.fn()} />)
beforeEach(() => {
  vi.clearAllMocks()
  invoke.mockReset().mockImplementation(async (_id, method) => method === 'host.home' ? { location: 'window', locations: ['window', 'sidebar'] } : null)
  uninstall.mockResolvedValue(undefined)
  Object.defineProperty(window, 'gale', { configurable: true, value: { plugins: { invoke, uninstall } } })
})

describe('plugin settings', () => {
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
