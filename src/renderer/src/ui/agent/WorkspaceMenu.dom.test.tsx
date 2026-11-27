import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { PluginSummary } from '@shared/plugins'
import { WorkspaceMenu } from './WorkspaceMenu'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }))
afterEach(() => vi.unstubAllGlobals())
const plugin: PluginSummary = { id: 'notepad', enabled: true, showInTitlebar: true, backendStatus: 'stopped',
  manifest: { id: 'notepad', name: 'Notepad', pluginVersion: '1.0.0', apiVersion: 2, description: '', tools: [], ui: 'index.html' } }

it('groups file changes and plugins, opens the existing actions and makes the heading gear keyboard accessible', async () => {
  const user = userEvent.setup(), onOpenFiles = vi.fn(), onOpenPlugin = vi.fn(), onOpenPluginSettings = vi.fn()
  render(<WorkspaceMenu onOpenMemoryActivity={vi.fn()} project={{ name: 'My project', onOpenFiles }} plugins={[plugin]}
    onOpenPlugin={onOpenPlugin} onOpenPluginSettings={onOpenPluginSettings} />)
  await user.click(screen.getByRole('button', { name: 'Notepad' }))
  expect(onOpenPlugin).toHaveBeenCalledExactlyOnceWith(plugin)
  await user.click(screen.getByRole('button', { name: 'agent.workspace_menu' }))
  expect(within(screen.getByRole('group', { name: 'My project' })).getByRole('menuitem', { name: 'agent.file_changes' })).toBeVisible()
  expect(within(screen.getByRole('group', { name: 'plugins.title' })).getByRole('menuitem', { name: 'Notepad' })).toBeVisible()
  await user.click(screen.getByRole('menuitem', { name: 'agent.file_changes' }))
  expect(onOpenFiles).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).toBeNull()
  await user.click(screen.getByRole('button', { name: 'agent.workspace_menu' }))
  await user.keyboard('{ArrowDown}{ArrowDown}')
  expect(screen.getByRole('menuitem', { name: 'plugins.manage' })).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(onOpenPluginSettings).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).toBeNull()
})

it('retains plugin settings without launchable plugins and hides disabled, invalid and headless shortcuts', async () => {
  const items = [{ ...plugin, enabled: false }, { ...plugin, id: 'broken', error: 'Missing file' },
    { ...plugin, id: 'tools', manifest: { ...plugin.manifest!, ui: undefined } }]
  const openActivity = vi.fn()
  render(<WorkspaceMenu plugins={items} onOpenPlugin={vi.fn()} onOpenPluginSettings={vi.fn()} onOpenMemoryActivity={openActivity} />)
  expect(screen.getAllByRole('button')).toHaveLength(1)
  await userEvent.click(screen.getByRole('button', { name: 'agent.workspace_menu' }))
  expect(screen.getAllByRole('menuitem')).toHaveLength(2)
  expect(screen.getByRole('menuitem', { name: 'plugins.manage' })).toBeVisible()
  const activity = screen.getByRole('menuitem', { name: 'agent.memory_activity' })
  expect(screen.getByRole('separator').nextElementSibling).toBe(activity)
  await userEvent.click(activity)
  expect(openActivity).toHaveBeenCalledOnce()
})

it.each([
  ['light', 'light', 'dark'], ['dark', 'dark', 'light'],
  ['system', 'light', 'dark'], ['system', 'dark', 'light']
] as const)('places the theme shortcut before the menu and toggles %s with actual %s to %s', async (value, resolvedTheme, next) => {
  const user = userEvent.setup(), onChange = vi.fn()
  const props = { plugins: [plugin], onOpenPlugin: vi.fn(), onOpenMemoryActivity: vi.fn() }
  render(<WorkspaceMenu {...props} theme={{ value, resolvedTheme, onChange }} />)
  const button = screen.getByRole('button', { name: `settings.theme: settings.theme_${value}` })
  expect(button.previousElementSibling).toBe(screen.getByRole('button', { name: 'Notepad' }))
  expect(button.nextElementSibling).toBe(screen.getByRole('button', { name: 'agent.workspace_menu' }))
  await user.click(button)
  expect(onChange).toHaveBeenCalledExactlyOnceWith(next)
  expect(screen.queryByRole('menu')).toBeNull()
})

it('opens three checked theme choices on right-click without toggling the appearance', async () => {
  const user = userEvent.setup(), onChange = vi.fn()
  const props = { plugins: [], onOpenMemoryActivity: vi.fn() }
  const { rerender } = render(<WorkspaceMenu {...props} theme={{ value: 'system', resolvedTheme: 'dark', onChange }} />)
  let current = 'system'
  for (const next of ['dark', 'light', 'system'] as const) {
    const button = screen.getByRole('button', { name: `settings.theme: settings.theme_${current}` })
    const calls = onChange.mock.calls.length
    fireEvent.contextMenu(button)
    expect(onChange).toHaveBeenCalledTimes(calls)
    expect(screen.getAllByRole('menuitemradio')).toHaveLength(3)
    expect(screen.getByRole('menuitemradio', { name: `settings.theme_${current}` })).toBeChecked()
    await user.click(screen.getByRole('menuitemradio', { name: `settings.theme_${next}` }))
    expect(onChange).toHaveBeenLastCalledWith(next)
    expect(screen.queryByRole('menu')).toBeNull()
    rerender(<WorkspaceMenu {...props} theme={{ value: next, resolvedTheme: next === 'system' ? 'dark' : next, onChange }} />)
    expect(button).toHaveAccessibleName(`settings.theme: settings.theme_${next}`)
    current = next
  }
})

it('keeps left-click and keyboard activation separate from the theme menu', async () => {
  const onChange = vi.fn()
  render(<WorkspaceMenu plugins={[]} onOpenMemoryActivity={vi.fn()}
    theme={{ value: 'system', resolvedTheme: 'dark', onChange }} />)
  const button = screen.getByRole('button', { name: 'settings.theme: settings.theme_system' })
  fireEvent.contextMenu(button)
  await userEvent.click(button)
  expect(screen.queryByRole('menu')).toBeNull()
  expect(onChange).toHaveBeenCalledExactlyOnceWith('light')
  onChange.mockClear()
  fireEvent.keyDown(button, { key: 'F10', shiftKey: true })
  expect(screen.getByRole('menu')).toBeVisible()
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.keyDown(button, { key: 'Enter' })
  expect(screen.queryByRole('menu')).toBeNull()
  expect(onChange).toHaveBeenCalledExactlyOnceWith('light')
})

it.each([false, true])('keeps every plugin in the menu while shortcuts shrink and return, with theme shortcut: %s', async (showTheme) => {
  let width = 32, resize = () => {}
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('workspace-launcher') ? width : 0
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 32 } as DOMRect)
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe(target: Element) { if (target.classList.contains('workspace-launcher')) resize = this.callback }
    unobserve() {}
    disconnect() {}
  })
  const second = { ...plugin, id: 'other', manifest: { ...plugin.manifest!, id: 'other', name: 'Other' } }
  render(<WorkspaceMenu plugins={[plugin, second]} onOpenPlugin={vi.fn()} onOpenPluginSettings={vi.fn()} onOpenMemoryActivity={vi.fn()}
    theme={showTheme ? { value: 'system', resolvedTheme: 'light', onChange: vi.fn() } : undefined} />)
  expect(screen.queryByRole('button', { name: 'Notepad' })).toBeNull()
  if (showTheme) expect(screen.getByRole('button', { name: 'settings.theme: settings.theme_system' })).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'agent.workspace_menu' }))
  expect(screen.getByRole('menuitem', { name: 'Notepad' })).toBeVisible()
  expect(screen.getByRole('menuitem', { name: 'Other' })).toBeVisible()
  await userEvent.keyboard('{Escape}')
  act(() => { width = showTheme ? 128 : 96; resize() })
  expect(screen.getByRole('button', { name: 'Notepad' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Other' })).toBeVisible()
})
