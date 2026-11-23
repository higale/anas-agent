import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SkillSnapshot } from '@shared/types'
import type { PluginSummary } from '@shared/plugins'
import { PluginsSettings } from './PluginsSettings'
import { notice } from '../notice'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn(), success: vi.fn() } }))
const invoke = vi.fn(), uninstall = vi.fn(), install = vi.fn(), confirmInstall = vi.fn(), cancelInstall = vi.fn(), readPrompt = vi.fn(), setEnabled = vi.fn()
const startBackend = vi.fn(), stopBackend = vi.fn(), setShowInTitlebar = vi.fn(), setCapabilityEnabled = vi.fn()
const plugin: PluginSummary = { id: 'example', enabled: true, backendStatus: 'stopped', manifest: { tools: [],
  id: 'example', name: 'Example', pluginVersion: '1.0.0', apiVersion: 2, description: '', ui: 'index.html',
  home: { defaultLocation: 'window', locations: ['window', 'sidebar'] }
} }
const updateSkillAvailability = vi.fn()
const skillSnapshot: SkillSnapshot = { roots: [], skills: [{ id: 'example:skill:guide', rootId: 'plugin:example', name: 'actual-skill-name', description: 'Skill summary',
  modelAvailable: false, userAvailable: false, configuredAvailability: { modelAvailable: true, userAvailable: true }, source: 'plugin',
  rootName: 'Example', shortcutAlias: 'plugin:example', linked: false, dirPath: '/plugins/example/skills/guide', relativePath: 'guide' }] }
const renderSettings = (plugins = [plugin]) => render(<PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={plugins} onRefresh={vi.fn(async () => {})} />)
beforeEach(() => {
  vi.clearAllMocks()
  invoke.mockReset().mockImplementation(async (_id, method) => method === 'host.home' ? { location: 'window', locations: ['window', 'sidebar'] } : null)
  uninstall.mockResolvedValue(undefined)
  install.mockReset()
  confirmInstall.mockReset().mockResolvedValue(plugin)
  cancelInstall.mockReset().mockResolvedValue(undefined)
  setEnabled.mockReset().mockResolvedValue(undefined)
  setCapabilityEnabled.mockReset().mockResolvedValue(undefined)
  setShowInTitlebar.mockReset().mockResolvedValue(undefined)
  startBackend.mockReset().mockResolvedValue(undefined)
  stopBackend.mockReset().mockResolvedValue(undefined)
  readPrompt.mockReset().mockResolvedValue({ content: '# Guide body', resolvedPath: 'C:/plugins/guide/SKILL.md' })
  Object.defineProperty(window, 'gale', { configurable: true, value: { plugins: { invoke, uninstall, install, confirmInstall, cancelInstall, readPrompt, setEnabled, setShowInTitlebar, setCapabilityEnabled, startBackend, stopBackend } } })
})

describe('plugin settings', () => {
  it.each([true, false])('saves a titlebar shortcut without launching the plugin when enabled=%s', async enabled => {
    const refresh = vi.fn(async () => {})
    const view = render(<PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={[{ ...plugin, enabled }]} onRefresh={refresh} />)
    const checkbox = screen.getByRole('checkbox', { name: 'plugins.show_in_titlebar' })
    expect(checkbox).not.toBeChecked()
    expect(checkbox).toBeEnabled()
    await userEvent.click(checkbox)
    expect(setShowInTitlebar).toHaveBeenCalledExactlyOnceWith('example', true)
    expect(refresh).toHaveBeenCalledOnce()
    view.rerender(<PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={[{ ...plugin, enabled, showInTitlebar: true }]} onRefresh={refresh} />)
    expect(checkbox).toBeChecked()
    expect(invoke.mock.calls.every(([, method]) => method === 'host.home')).toBe(true)
  })

  it('retains the saved shortcut choice after failure and hides the setting for a plugin without a home', async () => {
    setShowInTitlebar.mockRejectedValueOnce(new Error('disk failure'))
    const view = renderSettings([{ ...plugin, showInTitlebar: true }])
    const checkbox = screen.getByRole('checkbox', { name: 'plugins.show_in_titlebar' })
    await userEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(checkbox).toBeEnabled()
    expect(notice.error).toHaveBeenCalledWith('plugins.operation_failed', { description: 'disk failure' })
    view.rerender(<PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={[{ ...plugin, manifest: { ...plugin.manifest!, ui: undefined } }]} onRefresh={vi.fn()} />)
    expect(screen.queryByRole('checkbox', { name: 'plugins.show_in_titlebar' })).toBeNull()
  })

  it.each(['enabled', 'showInTitlebar'] as const)('keeps %s selected during saving and stale refreshes without dimming or duplicate writes', async setting => {
    let finish!: () => void
    const write = setting === 'enabled' ? setEnabled : setShowInTitlebar
    write.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    const refresh = vi.fn(async () => { throw new Error('refresh failed') })
    const view = render(<PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={[plugin]} onRefresh={refresh} />)
    const enabled = screen.getByRole('checkbox', { name: 'settings.enabled' })
    const titlebar = screen.getByRole('checkbox', { name: 'plugins.show_in_titlebar' })
    const checkbox = setting === 'enabled' ? enabled : titlebar
    await userEvent.click(checkbox)
    expect(checkbox).toHaveAttribute('aria-checked', String(setting !== 'enabled'))
    expect(enabled).toBeEnabled()
    expect(titlebar).toBeEnabled()
    await userEvent.click(setting === 'enabled' ? titlebar : enabled)
    checkbox.focus()
    await userEvent.keyboard(' ')
    expect(write).toHaveBeenCalledTimes(1)
    expect(setting === 'enabled' ? setShowInTitlebar : setEnabled).not.toHaveBeenCalled()
    expect(checkbox).toHaveAttribute('aria-checked', String(setting !== 'enabled'))
    view.rerender(<PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={[{ ...plugin }]} onRefresh={refresh} />)
    expect(checkbox).toHaveAttribute('aria-checked', String(setting !== 'enabled'))
    await act(async () => finish())
    expect(checkbox).toHaveAttribute('aria-checked', String(setting !== 'enabled'))
    expect(screen.getByRole('group', { name: 'plugins.settings' })).not.toHaveAttribute('aria-busy')
    expect(notice.error).toHaveBeenCalledWith('plugins.operation_failed', { description: 'refresh failed' })
  })

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
  it('saves individual and bulk capability choices without collapsing groups or changing other choices', async () => {
    let stored: PluginSummary = structuredClone(previewPlugin)
    setCapabilityEnabled.mockImplementation(async (_pluginId, kind, ids, checked) => {
      stored = { ...stored, capabilityChoices: { ...stored.capabilityChoices,
        [kind]: { ...stored.capabilityChoices?.[kind as 'tool'], ...Object.fromEntries(ids.map((id: string) => [id, checked])) } } }
      return stored.capabilityChoices
    })
    function Editor() {
      const [value, setValue] = useState(stored)
      return <PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={[value]} onRefresh={async () => setValue(structuredClone(stored))} />
    }
    render(<Editor />)
    const tool = screen.getByRole('checkbox', { name: 'echo' })
    const skill = within(screen.getByRole('group', { name: 'actual-skill-name' })).getByRole('checkbox', { name: 'settings.skill_model_available' })
    expect(tool).toBeChecked()
    expect(skill).toBeChecked()
    await userEvent.click(tool)
    expect(setCapabilityEnabled).toHaveBeenCalledExactlyOnceWith('example', 'tool', ['echo'], false)
    expect(tool).not.toBeChecked()
    expect(skill).toBeChecked()
    expect(screen.getByText('actual-skill-name', { selector: 'code' })).toHaveAttribute('data-tooltip', expect.stringContaining('plugins.disabled'))
    expect(screen.getByText('actual-skill-name', { selector: 'code' })).toHaveClass('ui-resource-unavailable')
    const group = screen.getByRole('group', { name: 'plugins.tools' })
    await userEvent.click(within(group).getByRole('button', { name: 'capabilities.select_group_all' }))
    expect(group).toHaveAttribute('open')
    expect(tool).toBeChecked()
    expect(skill).not.toHaveAttribute('aria-describedby')
    await userEvent.click(within(screen.getByRole('group', { name: 'plugins.prompts' })).getByRole('button', { name: 'capabilities.clear_group_all' }))
    expect(screen.getByRole('checkbox', { name: 'tone' })).not.toBeChecked()
    expect(tool).toBeChecked()
    expect(skill).toBeChecked()
    expect(startBackend).not.toHaveBeenCalled()
  })
  it('edits and bulk-selects both uses only for the current plugin while disabled', async () => {
    const second = { ...skillSnapshot.skills[0], id: 'example:skill:second', name: 'second' }
    const unrelated = { ...second, id: 'other:skill:second' }
    let stored = { ...skillSnapshot, skills: [...skillSnapshot.skills, second, unrelated] }
    const twoSkills = { ...previewPlugin, manifest: { ...previewPlugin.manifest!, skills: [
      ...previewPlugin.manifest!.skills!, { id: 'second', path: 'skills/second/SKILL.md', tools: [] }
    ] } }
    function Editor() {
      const [snapshot, setSnapshot] = useState(stored)
      return <PluginsSettings plugins={[twoSkills]} skills={snapshot} onRefresh={vi.fn(async () => {})}
        onUpdateSkillAvailability={(ids, update) => {
          updateSkillAvailability(ids, update)
          const selected = Array.isArray(ids) ? ids : [ids]
          stored = { ...stored, skills: stored.skills.map(skill => selected.includes(skill.id)
            ? { ...skill, configuredAvailability: { ...skill.configuredAvailability!, ...update } } : skill) }
          setSnapshot(stored)
        }} />
    }
    render(<Editor />)
    const uses = within(screen.getByRole('group', { name: 'actual-skill-name' }))
    expect(uses.getAllByRole('checkbox')).toHaveLength(2)
    await userEvent.click(uses.getByRole('checkbox', { name: 'settings.skill_user_available' }))
    expect(updateSkillAvailability).toHaveBeenLastCalledWith('example:skill:guide', { userAvailable: false })
    const group = screen.getByRole('group', { name: 'settings.skills' })
    await userEvent.click(within(group).getByRole('button', { name: 'capabilities.select_group_all' }))
    expect(updateSkillAvailability).toHaveBeenLastCalledWith(['example:skill:guide', 'example:skill:second'], { userAvailable: true, modelAvailable: true })
    for (const checkbox of within(group).getAllByRole('checkbox')) expect(checkbox).toBeChecked()
    await userEvent.click(within(group).getByRole('button', { name: 'capabilities.clear_group_all' }))
    expect(updateSkillAvailability).toHaveBeenLastCalledWith(['example:skill:guide', 'example:skill:second'], { userAvailable: false, modelAvailable: false })
    for (const checkbox of within(group).getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
    expect(group).toHaveAttribute('open')
    expect(stored.skills[2]).toEqual(unrelated)
    expect(setCapabilityEnabled).not.toHaveBeenCalled()
    expect(startBackend).not.toHaveBeenCalled()
  })
  it('shows the clicked choice while saving and ignores stale refreshes, then rolls back a failed write', async () => {
    let reject!: (reason: Error) => void
    setCapabilityEnabled.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
    const view = renderSettings([previewPlugin])
    const checkbox = screen.getByRole('checkbox', { name: 'tone' })
    await userEvent.click(checkbox)
    expect(checkbox).not.toBeChecked()
    expect(checkbox).not.toBeDisabled()
    expect(checkbox).toHaveAttribute('aria-busy', 'true')
    const tool = screen.getByRole('checkbox', { name: 'echo' })
    expect(tool).not.toBeDisabled()
    await userEvent.click(tool)
    expect(tool).toBeChecked()
    const action = within(screen.getByRole('group', { name: 'plugins.tools' })).getByRole('button', { name: 'capabilities.clear_group_all' })
    expect(action).not.toBeDisabled()
    await userEvent.click(action)
    expect(setCapabilityEnabled).toHaveBeenCalledTimes(1)
    view.rerender(<PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={[{ ...previewPlugin, capabilityChoices: {} }]} onRefresh={vi.fn(async () => {})} />)
    expect(checkbox).not.toBeChecked()
    await act(async () => reject(new Error('write failed')))
    expect(checkbox).toBeChecked()
    expect(checkbox).toBeEnabled()
  })
  it('keeps saved capability choices after a failed write and supports editing while the plugin is disabled', async () => {
    setCapabilityEnabled.mockRejectedValueOnce(new Error('disk full'))
    renderSettings([previewPlugin])
    const checkbox = screen.getByRole('checkbox', { name: 'tone' })
    expect(checkbox).toBeEnabled()
    await userEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    expect(checkbox).toBeEnabled()
    expect(notice.error).toHaveBeenCalledWith('plugins.operation_failed', { description: 'disk full' })
  })
  it('keeps only prompt previews in plugin settings while skill and tool controls remain usable', async () => {
    const user = userEvent.setup()
    renderSettings([previewPlugin])
    expect(screen.queryByRole('button', { name: 'actual-skill-name' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'echo' })).not.toBeInTheDocument()
    expect(screen.getByText('actual-skill-name', { selector: 'code' })).toHaveAttribute('data-tooltip', 'plugins.disabled\nSkill summary')
    await user.click(screen.getByText('actual-skill-name', { selector: 'code' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await user.click(screen.getByText('echo', { selector: 'code' }))
    expect(setCapabilityEnabled).toHaveBeenCalledExactlyOnceWith('example', 'tool', ['echo'], false)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(readPrompt).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'tone' })).toHaveAttribute('data-tooltip', 'Prompt summary')
    await user.click(screen.getByRole('button', { name: 'tone' }))
    expect(await screen.findByRole('heading', { name: 'Guide body' })).toBeVisible()
    expect(readPrompt).toHaveBeenCalledExactlyOnceWith('example', 'tone')
    const dialog = within(screen.getByRole('dialog'))
    expect(dialog.getByText('plugins.scope_all')).toBeVisible()
    await user.click(dialog.getByRole('button', { name: 'common.copy' }))
    expect(await navigator.clipboard.readText()).toBe('# Guide body')
    expect(invoke).not.toHaveBeenCalled()
    expect(startBackend).not.toHaveBeenCalled()
  })

  it('reports preview read failures and permits retry while keeping copy unavailable', async () => {
    readPrompt.mockRejectedValueOnce(new Error('File removed'))
    renderSettings([previewPlugin])
    await userEvent.click(screen.getByRole('button', { name: 'tone' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('File removed')
    expect(screen.getByRole('button', { name: 'common.copy' })).toBeDisabled()
    await userEvent.click(screen.getByRole('button', { name: 'common.retry' }))
    expect(await screen.findByRole('heading', { name: 'Guide body' })).toBeVisible()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('ignores a closed preview response after reopening the prompt', async () => {
    let finish!: (value: unknown) => void
    readPrompt.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    renderSettings([previewPlugin])
    await userEvent.click(screen.getByRole('button', { name: 'tone' }))
    expect(screen.getByRole('status')).toHaveTextContent('common.loading')
    await userEvent.click(screen.getByRole('button', { name: 'common.close' }))
    await userEvent.click(screen.getByRole('button', { name: 'tone' }))
    expect(await screen.findByRole('heading', { name: 'Guide body' })).toBeVisible()
    await act(async () => finish({ content: '# Old prompt', resolvedPath: 'C:/plugins/tone.md' }))
    expect(screen.queryByText('Old prompt')).toBeNull()
    expect(screen.getByRole('heading', { name: 'Guide body' })).toBeVisible()
  })
  it('shows global capability switches directly in plugin management', () => {
    renderSettings([{ ...plugin, manifest: { ...plugin.manifest!, tools: [{ id: 'echo', description: 'Echo', handler: 'echo', effect: 'read', timeoutSeconds: 30, inputSchema: { type: 'object' } }] } }])
    expect(screen.queryByRole('radio', { name: 'plugins.capabilities' })).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'echo' })).toBeChecked()
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

  it('does not let an old home read overwrite a newer saved location', async () => {
    const view = renderSettings()
    await waitFor(() => expect(screen.getByRole('radio', { name: 'plugins.home_window' })).toBeChecked())
    let finishRead!: (value: unknown) => void
    invoke.mockImplementation((_id, method) => method === 'host.home'
      ? new Promise(resolve => { finishRead = resolve }) : Promise.resolve())
    view.rerender(<PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={[{ ...plugin }]} onRefresh={vi.fn(async () => {})} />)
    await userEvent.click(screen.getByRole('radio', { name: 'plugins.home_sidebar' }))
    await act(async () => finishRead({ location: 'window' }))
    expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeChecked()
  })

  it('saves home location without disabling unrelated controls or refreshing the catalog', async () => {
    let finish!: () => void
    const refresh = vi.fn(async () => {})
    render(<PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={[plugin]} onRefresh={refresh} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'plugins.home_window' })).toBeChecked())
    invoke.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve }))
    await userEvent.click(screen.getByRole('radio', { name: 'plugins.home_sidebar' }))
    expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeEnabled()
    expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeChecked()
    await userEvent.click(screen.getByRole('radio', { name: 'plugins.home_window' }))
    expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeChecked()
    expect(invoke.mock.calls.filter(([, method]) => method === 'data.set')).toHaveLength(1)
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
    expect(screen.getByRole('checkbox', { name: 'settings.enabled' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'settings.enabled' })).not.toBeChecked()
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
    const view = render(<PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={[backendPlugin]} onRefresh={refresh} />)
    await waitFor(() => expect(screen.getByRole('radio', { name: 'plugins.home_window' })).toBeChecked())
    await userEvent.click(screen.getByRole('button', { name: 'plugins.start_backend' }))
    expect(startBackend).toHaveBeenCalledExactlyOnceWith('example')
    expect(screen.getByRole('button', { name: 'plugins.start_backend' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'plugins.start_backend' }))
    expect(startBackend).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('radio', { name: 'plugins.home_sidebar' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'settings.enabled' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'plugins.install' })).toBeEnabled()
    view.rerender(<PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={[{ ...backendPlugin, backendStatus: 'starting' }]} onRefresh={refresh} />)
    await userEvent.click(screen.getByRole('button', { name: 'plugins.stop_backend' }))
    expect(stopBackend).toHaveBeenCalledExactlyOnceWith('example')
    await act(async () => finishStart())
    expect(screen.getByRole('button', { name: 'plugins.stop_backend' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'plugins.stop_backend' })).toHaveAttribute('aria-disabled', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'plugins.stop_backend' }))
    expect(stopBackend).toHaveBeenCalledTimes(1)
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
    view.rerender(<PluginsSettings skills={skillSnapshot} onUpdateSkillAvailability={updateSkillAvailability} plugins={[{ ...plugin }]} onRefresh={vi.fn(async () => {})} />)
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
