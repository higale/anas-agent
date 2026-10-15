import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PluginSummary } from '@shared/plugins'
import { PluginsSettings } from './PluginsSettings'
import { notice } from '../notice'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn(), success: vi.fn() } }))
const invoke = vi.fn(), uninstall = vi.fn(), install = vi.fn(), confirmInstall = vi.fn(), cancelInstall = vi.fn(), readContribution = vi.fn(), setEnabled = vi.fn()
const startBackend = vi.fn(), stopBackend = vi.fn()
const plugin: PluginSummary = { id: 'example', enabled: true, backendStatus: 'stopped', manifest: { tools: [],
  id: 'example', name: 'Example', pluginVersion: '1.0.0', apiVersion: 2, description: '', ui: 'index.html',
  home: { defaultLocation: 'window', locations: ['window', 'sidebar'] }
} }
const renderSettings = (plugins = [plugin]) => render(<PluginsSettings plugins={plugins} onRefresh={vi.fn(async () => {})} />)
beforeEach(() => {
  vi.clearAllMocks()
  invoke.mockReset().mockImplementation(async (_id, method) => method === 'host.home' ? { location: 'window', locations: ['window', 'sidebar'] } : null)
  uninstall.mockResolvedValue(undefined)
  install.mockReset()
  confirmInstall.mockReset().mockResolvedValue(plugin)
  cancelInstall.mockReset().mockResolvedValue(undefined)
  setEnabled.mockReset().mockResolvedValue(undefined)
  startBackend.mockReset().mockResolvedValue(undefined)
  stopBackend.mockReset().mockResolvedValue(undefined)
  readContribution.mockReset().mockResolvedValue({ content: '# Guide body', resolvedPath: 'C:/plugins/guide/SKILL.md' })
  Object.defineProperty(window, 'gale', { configurable: true, value: { plugins: { invoke, uninstall, install, confirmInstall, cancelInstall, readContribution, setEnabled, startBackend, stopBackend } } })
})

describe('plugin settings', () => {
  it('shows localized multiline plugin descriptions in the overview without adding preferences', () => {
    renderSettings([{ ...plugin, manifest: { ...plugin.manifest!, ui: undefined, description: 'Fallback' }, languages: [
      { code: 'en', name: 'English', pluginDescription: 'Supported providers:\nMiniMax: Plan quota\nDeepSeek: Balance' },
      { code: 'zh-CN', name: '简体中文', pluginDescription: '已支持厂商：\nMiniMax：套餐额度\nDeepSeek：余额' }
    ] }])
    expect(screen.getByText('Supported providers:')).toBeVisible()
    expect(screen.getByText('DeepSeek: Balance')).toBeVisible()
    expect(screen.queryByText('已支持厂商：')).not.toBeInTheDocument()
    expect(screen.queryByRole('radio', { name: 'plugins.settings' })).not.toBeInTheDocument()
  })

  const previewPlugin: PluginSummary = { ...plugin, enabled: false,
    skillSummaries: [{ id: 'guide', name: 'actual-skill-name', description: 'Skill summary' }],
    manifest: { ...plugin.manifest!, ui: undefined, backend: 'backend.cjs',
      skills: [{ id: 'guide', path: 'skills/actual-skill-name/SKILL.md', tools: ['echo'] }],
      prompts: [{ id: 'tone', path: 'tone.md', description: 'Prompt summary', scope: 'all', tools: [] }],
      tools: [{ id: 'echo', description: 'Echo text', handler: 'echo', effect: 'read', timeoutSeconds: 60,
        inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }]
    }
  }
  it('previews disabled plugin declarations on demand without executing plugin code', async () => {
    const user = userEvent.setup()
    renderSettings([previewPlugin])
    expect(readContribution).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'actual-skill-name' })).toHaveAttribute('data-tooltip', 'Skill summary')
    expect(screen.getByRole('button', { name: 'tone' })).toHaveAttribute('data-tooltip', 'Prompt summary')
    await user.click(screen.getByRole('button', { name: 'actual-skill-name' }))
    expect(readContribution).toHaveBeenCalledWith('example', 'skill', 'guide')
    expect(await screen.findByRole('heading', { name: 'Guide body' })).toBeVisible()
    let dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('plugin__example__echo')).toBeVisible()
    await user.click(dialog.getByRole('button', { name: 'common.copy' }))
    expect(await navigator.clipboard.readText()).toBe('# Guide body')
    await user.click(dialog.getByRole('button', { name: 'common.close' }))
    await user.click(screen.getByRole('button', { name: 'plugin__example__echo' }))
    dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('60')).toBeVisible()
    const code = screen.getByRole('dialog').querySelector('pre')!.textContent!
    expect(JSON.parse(code)).toEqual({ name: 'plugin__example__echo', description: 'Echo text', parameters: previewPlugin.manifest!.tools[0].inputSchema })
    expect(readContribution).toHaveBeenCalledTimes(1)
    await user.click(dialog.getByRole('button', { name: 'common.close' }))
    await user.click(screen.getByRole('button', { name: 'tone' }))
    expect(await screen.findByRole('heading', { name: 'Guide body' })).toBeVisible()
    expect(readContribution).toHaveBeenLastCalledWith('example', 'prompt', 'tone')
    expect(screen.getByText('plugins.scope_all')).toBeVisible()
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reports preview read failures and permits retry while keeping copy unavailable', async () => {
    readContribution.mockRejectedValueOnce(new Error('File removed'))
    renderSettings([previewPlugin])
    await userEvent.click(screen.getByRole('button', { name: 'tone' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('File removed')
    expect(screen.getByRole('button', { name: 'common.copy' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'common.retry' }))
    expect(await screen.findByRole('heading', { name: 'Guide body' })).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a closed preview response after opening another contribution', async () => {
    let finish!: (value: unknown) => void
    readContribution.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    renderSettings([previewPlugin])
    await userEvent.click(screen.getByRole('button', { name: 'tone' }))
    expect(screen.getByRole('status')).toHaveTextContent('common.loading')
    await userEvent.click(screen.getByRole('button', { name: 'common.close' }))
    await userEvent.click(screen.getByRole('button', { name: 'actual-skill-name' }))
    expect(await screen.findByRole('heading', { name: 'Guide body' })).toBeVisible()
    await act(async () => finish({ content: '# Old prompt', resolvedPath: 'C:/plugins/tone.md' }))
    expect(screen.queryByText('Old prompt')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Guide body' })).toBeVisible()
  })
  it('keeps plugin management separate from capability selection', () => {
    renderSettings([{ ...plugin, manifest: { ...plugin.manifest!, tools: [{ id: 'echo', description: 'Echo', handler: 'echo', effect: 'read', timeoutSeconds: 30, inputSchema: { type: 'object' } }] } }])
    expect(screen.queryByRole('radio', { name: 'plugins.capabilities' })).toBeNull()
    expect(screen.queryByRole('checkbox', { name: 'plugin__example__echo' })).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'settings.enabled' })).toBeEnabled()
    expect(screen.getByText('plugins.contributions_count')).toBeVisible()
  })
  it('displays disabled plugin icons and reports decode errors without blocking controls', async () => {
    const { container } = renderSettings([{ ...plugin, enabled: false, manifest: { ...plugin.manifest!, icon: 'icon.svg' } }])
    await waitFor(() => expect(screen.getByRole('radio', { name: 'plugins.home_window' })).toBeChecked())
    expect(container.querySelector('.ui-list-pane img')).toHaveAttribute('src', 'anas-plugin://example/_anas/icon/icon.svg')
    fireEvent.error(container.querySelector('.settings-detail-heading img')!)
    expect(screen.getByRole('alert')).toHaveTextContent('plugins.icon_failed')
    expect(screen.getByRole('checkbox', { name: 'settings.enabled' })).toBeEnabled()
    expect(invoke).toHaveBeenCalledWith('example', 'host.home')
  })

  it.each([true, false])('edits home location without opening a page when enabled=%s', async enabled => {
    renderSettings([{ ...plugin, enabled }])
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

  it('saves home location without disabling unrelated controls or refreshing the catalog', async () => {
    let finish!: () => void
    const refresh = vi.fn(async () => {})
    render(<PluginsSettings plugins={[plugin]} onRefresh={refresh} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'plugins.home_window' })).toBeChecked())
    invoke.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    await userEvent.click(screen.getByRole('radio', { name: 'plugins.home_sidebar' }))
    expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'settings.enabled' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'plugins.install' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'common.refresh' })).toBeEnabled()
    await act(async () => finish())
    expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeChecked()
    expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeEnabled()
    expect(refresh).not.toHaveBeenCalled()
    expect(invoke.mock.calls.filter(([, method]) => method === 'host.home')).toHaveLength(1)
  })

  it('keeps other settings usable while changing availability and restores its control after failure', async () => {
    let fail!: (error: Error) => void
    setEnabled.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject }))
    renderSettings()
    await waitFor(() => expect(screen.getByRole('radio', { name: 'plugins.home_window' })).toBeChecked())
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.enabled' }))
    expect(setEnabled).toHaveBeenCalledWith('example', false)
    expect(screen.getByRole('checkbox', { name: 'settings.enabled' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'plugins.install' })).toBeEnabled()
    await act(async () => fail(new Error('disk failure')))
    expect(notice.error).toHaveBeenCalledWith('plugins.operation_failed', { description: 'disk failure' })
    expect(screen.getByRole('checkbox', { name: 'settings.enabled' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'settings.enabled' })).toBeChecked()
  })

  it('keeps settings usable during backend startup and allows stopping without unlocking a pending stop', async () => {
    let finishStart!: () => void, finishStop!: () => void
    startBackend.mockImplementationOnce(() => new Promise<void>(resolve => { finishStart = resolve }))
    stopBackend.mockImplementationOnce(() => new Promise<void>(resolve => { finishStop = resolve }))
    const backendPlugin = { ...plugin, manifest: { ...plugin.manifest!, backend: 'backend.cjs' } }
    const refresh = vi.fn(async () => {})
    const view = render(<PluginsSettings plugins={[backendPlugin]} onRefresh={refresh} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'plugins.home_window' })).toBeChecked())
    await userEvent.click(screen.getByRole('button', { name: 'plugins.start_backend' }))
    expect(startBackend).toHaveBeenCalledExactlyOnceWith('example')
    expect(screen.getByRole('button', { name: 'plugins.start_backend' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'settings.enabled' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'plugins.install' })).toBeEnabled()
    view.rerender(<PluginsSettings plugins={[{ ...backendPlugin, backendStatus: 'starting' }]} onRefresh={refresh} />)
    await userEvent.click(screen.getByRole('button', { name: 'plugins.stop_backend' }))
    expect(stopBackend).toHaveBeenCalledExactlyOnceWith('example')
    await act(async () => finishStart())
    expect(screen.getByRole('button', { name: 'plugins.stop_backend' })).toBeDisabled()
    expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeEnabled()
    await act(async () => finishStop())
    expect(screen.getByRole('button', { name: 'plugins.stop_backend' })).toBeEnabled()
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
    view.rerender(<PluginsSettings plugins={[{ ...plugin }]} onRefresh={vi.fn(async () => {})} />)
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

describe('plugin drag installation', () => {
  const data = (files: File[]) => ({ types: ['Files'], files, dropEffect: 'none' })
  const region = () => screen.getByRole('region', { name: 'plugins.title' })

  it.each(['package.zip', 'PLUGIN.json', 'plugin-folder'])('installs a dropped %s using the common installer', async name => {
    install.mockResolvedValue(plugin)
    renderSettings()
    const file = new File([], name)
    fireEvent.dragEnter(region(), { dataTransfer: data([file]) })
    expect(screen.getByRole('status')).toHaveTextContent('plugins.drop_hint')
    fireEvent.dragEnter(screen.getByRole('button', { name: 'Example' }), { dataTransfer: data([file]) })
    fireEvent.dragLeave(screen.getByRole('button', { name: 'Example' }), { dataTransfer: data([file]) })
    expect(screen.getByRole('status')).toBeVisible()
    fireEvent.drop(region(), { dataTransfer: data([file]) })
    await waitFor(() => expect(install).toHaveBeenCalledExactlyOnceWith(file))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('button', { name: 'plugins.install' })).toBeEnabled())
  })

  it('clears the highlight on exit and rejects multiple files without installing any', () => {
    renderSettings([])
    const files = [new File([], 'a.zip'), new File([], 'b.zip')]
    fireEvent.dragEnter(region(), { dataTransfer: data(files) })
    fireEvent.dragLeave(region(), { dataTransfer: data(files) })
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    fireEvent.drop(region(), { dataTransfer: data(files) })
    expect(install).not.toHaveBeenCalled()
    expect(notice.error).toHaveBeenCalledWith('plugins.operation_failed', { description: 'plugins.drop_one' })
    expect(fireEvent.drop(region(), { dataTransfer: { types: ['text/plain'], files: [] } })).toBe(true)
  })

  it('blocks repeat drops while installing and waiting for replacement confirmation', async () => {
    let finish!: (value: unknown) => void
    install.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    renderSettings()
    const file = new File([], 'package.zip')
    const event = { dataTransfer: data([file]) }
    fireEvent.drop(region(), event)
    fireEvent.drop(region(), event)
    expect(install).toHaveBeenCalledTimes(1)
    const transfer = data([file])
    fireEvent.dragOver(region(), { dataTransfer: transfer })
    expect(transfer.dropEffect).toBe('none')
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    await act(async () => finish({ replacement: { token: 'dropped-token', installed: plugin, incoming: plugin.manifest } }))
    const dialog = within(await screen.findByRole('alertdialog'))
    // Modal content is portalled but its drag events still bubble through the React tree.
    fireEvent.drop(screen.getByRole('alertdialog'), event)
    expect(install).toHaveBeenCalledTimes(1)
    expect(confirmInstall).not.toHaveBeenCalled()
    await userEvent.click(dialog.getByRole('button', { name: 'plugins.replace' }))
    await waitFor(() => expect(confirmInstall).toHaveBeenCalledExactlyOnceWith('dropped-token', false))
  })

  it('reports a rejected source without leaving the drop area busy', async () => {
    install.mockRejectedValueOnce(new Error('No root manifest')).mockResolvedValueOnce(plugin)
    renderSettings()
    fireEvent.drop(region(), { dataTransfer: data([new File([], 'invalid-folder')]) })
    await waitFor(() => expect(notice.error).toHaveBeenCalledWith('plugins.operation_failed', { description: 'No root manifest' }))
    const file = new File([], 'valid-folder')
    fireEvent.drop(region(), { dataTransfer: data([file]) })
    await waitFor(() => expect(install).toHaveBeenLastCalledWith(file))
  })
})
