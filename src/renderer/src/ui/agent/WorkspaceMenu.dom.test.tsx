import { act, render, screen, within } from '@testing-library/react'
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
  render(<WorkspaceMenu project={{ name: 'My project', onOpenFiles }} plugins={[plugin]}
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
  render(<WorkspaceMenu plugins={items} onOpenPlugin={vi.fn()} onOpenPluginSettings={vi.fn()} />)
  expect(screen.getAllByRole('button')).toHaveLength(1)
  await userEvent.click(screen.getByRole('button', { name: 'agent.workspace_menu' }))
  expect(screen.getAllByRole('menuitem')).toHaveLength(1)
  expect(screen.getByRole('menuitem', { name: 'plugins.manage' })).toBeVisible()
  expect(screen.queryByRole('separator')).toBeNull()
})

it('keeps every plugin in the menu while shortcuts shrink and return with available width', async () => {
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
  render(<WorkspaceMenu plugins={[plugin, second]} onOpenPlugin={vi.fn()} onOpenPluginSettings={vi.fn()} />)
  expect(screen.queryByRole('button', { name: 'Notepad' })).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'agent.workspace_menu' }))
  expect(screen.getByRole('menuitem', { name: 'Notepad' })).toBeVisible()
  expect(screen.getByRole('menuitem', { name: 'Other' })).toBeVisible()
  await userEvent.keyboard('{Escape}')
  act(() => { width = 96; resize() })
  expect(screen.getByRole('button', { name: 'Notepad' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Other' })).toBeVisible()
})
