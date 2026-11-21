import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import type { ToolPackage, ToolRoot, ToolSelection } from '@shared/toolPackages'
import { CustomToolSelectionEditor } from './CustomToolSelectionEditor'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => vi.unstubAllGlobals())
const roots: ToolRoot[] = [
  { id: 'user', name: 'User', source: 'user', path: '/tools' },
  { id: 'project', name: 'Workspace', source: 'project', path: '/workspace/.agents/tools' }
]
function tool(root: ToolRoot, name: string): ToolPackage {
  return { id: `${root.id}:${name}`, rootId: root.id, rootName: root.name, source: root.source, name,
    directory: `${root.path}/${name}`, description: `Description of ${name}`, definition: {
      id: name, name, description: `Description of ${name}`, command: 'node tool.js {{args}}', inputSchema: {}, timeoutSeconds: 0, interactive: false
    } }
}
const tools = [tool(roots[0], 'format'), tool(roots[1], 'inspect')]
const toggle = (name: string, on = true) => within(screen.getByRole('radiogroup', { name })).getByRole('radio', { name: on ? 'capabilities.on' : 'capabilities.off' })

it.each(['all', 'custom', 'off'] as const)('keeps project directory management available in %s mode with empty and offline roots', async mode => {
  const add = vi.fn(), remove = vi.fn(), openDirectory = vi.fn().mockResolvedValue(undefined), changed = vi.fn()
  vi.stubGlobal('gale', { files: { openDirectory } })
  const offline: ToolRoot = { id: 'offline', name: 'Offline', source: 'project', path: '/offline', error: { code: 'path_not_found', path: '/offline' } }
  const view = render(<CustomToolSelectionEditor value={{ mode, project: false, entries: [] }} tools={[]} roots={[]} backgroundTools
    projectTools={{ onAddDirectories: add, onRemoveDirectory: remove }} onChange={changed} />)
  const disclosure = screen.getByRole('button', { name: 'custom_tools.title' })
  await userEvent.click(screen.getByRole('button', { name: 'project.add_tool_directories' }))
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  await userEvent.click(disclosure)
  expect(add).toHaveBeenCalledOnce()
  expect(changed).not.toHaveBeenCalled()
  view.rerender(<CustomToolSelectionEditor value={{ mode, project: false, entries: [] }} tools={[tools[1]]} roots={[roots[1], offline]} backgroundTools
    projectTools={{ onAddDirectories: add, onRemoveDirectory: remove }} onChange={changed} />)
  expect(screen.queryByRole('button', { name: 'settings.skill_group_project' })).not.toBeInTheDocument()
  const liveGroup = within(screen.getByRole('region', { name: roots[1].path }))
  await userEvent.click(liveGroup.getByRole('button', { name: 'project.open_tools_folder' }))
  expect(openDirectory).toHaveBeenCalledWith(roots[1].path)
  await userEvent.click(liveGroup.getByRole('button', { name: 'settings.skill_group_project - Workspace' }))
  if (mode === 'custom') expect(toggle('Workspace inspect')).toBeEnabled()
  else expect(toggle('Workspace inspect')).toBeDisabled()
  const missing = within(screen.getByRole('region', { name: '/offline' }))
  await userEvent.click(missing.getByRole('button', { name: 'settings.skill_group_project - Offline' }))
  expect(missing.getByRole('alert')).toHaveTextContent('custom_tools.load_error_path_not_found')
  expect(missing.getByRole('button', { name: 'project.open_tools_folder' })).toBeDisabled()
  await userEvent.click(missing.getByRole('button', { name: 'project.remove_tool_directory' }))
  expect(remove).toHaveBeenCalledWith('/offline')
  expect(changed).not.toHaveBeenCalled()
})

it('shows collapsed sources in all modes, opens exact package directories, and preserves custom choices', async () => {
  const openDirectory = vi.fn().mockResolvedValue(undefined), changed = vi.fn(), user = userEvent.setup()
  vi.stubGlobal('gale', { files: { openDirectory } })
  function Harness() {
    const [value, setValue] = useState<ToolSelection>({ mode: 'all', project: false, entries: [tools[1].id] })
    return <CustomToolSelectionEditor value={value} tools={tools} roots={roots} backgroundTools
      onChange={next => { setValue(next); changed(next) }} />
  }
  render(<Harness />)
  await user.click(screen.getByRole('button', { name: 'custom_tools.title' }))
  const userGroup = screen.getByRole('button', { name: 'settings.skill_group_user' })
  const projectGroup = screen.getByRole('button', { name: 'settings.skill_group_project' })
  expect(userGroup).toHaveAttribute('aria-expanded', 'false')
  expect(projectGroup).toHaveAttribute('aria-expanded', 'false')
  await user.click(userGroup)
  await user.click(projectGroup)
  expect(screen.getAllByText('inspect')).toHaveLength(1)
  expect(screen.getByText('format').compareDocumentPosition(projectGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  for (const item of tools) {
    await user.click(screen.getByRole('button', { name: item.name }))
    expect(openDirectory).toHaveBeenLastCalledWith(item.directory)
    expect(toggle(`${item.rootName} ${item.name}`)).toBeChecked()
    expect(toggle(`${item.rootName} ${item.name}`)).toBeDisabled()
  }
  expect(changed).not.toHaveBeenCalled()
  const modes = within(screen.getByRole('radiogroup', { name: 'custom_tools.title' }))
  await user.click(modes.getByRole('radio', { name: 'capabilities.off' }))
  expect(toggle('User format', false)).toBeChecked()
  expect(toggle('Workspace inspect', false)).toBeChecked()
  expect(toggle('Workspace inspect')).toBeDisabled()
  expect(projectGroup).toHaveAttribute('aria-expanded', 'true')
  await user.click(modes.getByRole('radio', { name: 'capabilities.custom' }))
  expect(toggle('User format', false)).toBeChecked()
  expect(toggle('Workspace inspect')).toBeChecked()
  await user.click(toggle('User format'))
  await user.click(toggle('Workspace inspect', false))
  expect(changed).toHaveBeenLastCalledWith({ mode: 'custom', project: false, entries: [tools[0].id] })
  await user.click(projectGroup)
  await user.click(projectGroup)
  expect(toggle('Workspace inspect', false)).toBeChecked()
  for (const mode of ['capabilities.all', 'capabilities.off', 'capabilities.custom']) await user.click(modes.getByRole('radio', { name: mode }))
  expect(toggle('User format')).toBeChecked()
  expect(toggle('Workspace inspect', false)).toBeChecked()
})

it('retains unavailable choices for removal and displays project root and package errors', async () => {
  const broken = { ...tools[0], definition: undefined, error: { code: 'invalid_json' as const, path: '/tools/format/TOOL.json' } }
  const failedRoot = { ...roots[1], error: { code: 'permission_denied' as const, path: roots[1].path } }
  const changed = vi.fn()
  function Harness() {
    const [value, setValue] = useState<ToolSelection>({ mode: 'custom', project: false, entries: [broken.id, 'gone:tool'] })
    return <CustomToolSelectionEditor value={value} tools={[broken]} roots={[roots[0], failedRoot]} backgroundTools
      onChange={next => { setValue(next); changed(next) }} />
  }
  render(<Harness />)
  for (const label of ['custom_tools.title', 'settings.skill_group_user', 'capabilities.other_tools', 'settings.skill_group_project']) await userEvent.click(screen.getByRole('button', { name: label }))
  expect(screen.getAllByRole('alert')).toHaveLength(2)
  expect(screen.queryByRole('button', { name: 'gone:tool' })).not.toBeInTheDocument()
  await userEvent.click(toggle('gone:tool', false))
  expect(screen.queryByRole('radiogroup', { name: 'gone:tool' })).not.toBeInTheDocument()
  expect(toggle('User format')).toBeEnabled()
  await userEvent.click(toggle('User format', false))
  expect(toggle('User format')).toBeDisabled()
  expect(changed.mock.lastCall![0].entries).toEqual([])
})

it('shows all entries as on in all mode while retaining availability warnings and custom choices', async () => {
  const duplicate = { ...tools[1], name: 'format' }
  const disabled = { ...tool(roots[0], 'disabled'), enabled: false }
  const interactive = tool(roots[0], 'interactive')
  interactive.definition!.interactive = true
  const fixture = [tools[0], duplicate, disabled, interactive]
  const value: ToolSelection = { mode: 'all', entries: [], project: false }
  const changed = vi.fn()
  const view = render(<CustomToolSelectionEditor value={value} tools={fixture} roots={roots} backgroundTools={false} onChange={changed} />)
  for (const label of ['custom_tools.title', 'settings.skill_group_user', 'settings.skill_group_project']) await userEvent.click(screen.getByRole('button', { name: label }))
  expect(toggle('User format')).toBeChecked()
  expect(toggle('Workspace format')).toBeChecked()
  expect(screen.getByText('custom_tools.shadowed')).toBeVisible()
  expect(toggle('User disabled')).toBeChecked()
  expect(toggle('User disabled')).toBeDisabled()
  expect(toggle('User interactive')).toBeChecked()
  expect(toggle('User interactive')).toBeDisabled()
  expect(screen.getByText('capabilities.inactive')).toBeVisible()
  expect(screen.getByText('custom_tools.requires_background')).toBeVisible()
  await userEvent.click(toggle('User disabled', false))
  expect(changed).not.toHaveBeenCalled()
  for (const mode of ['off', 'custom'] as const) {
    view.rerender(<CustomToolSelectionEditor value={{ ...value, mode }} tools={fixture} roots={roots} backgroundTools={false} onChange={changed} />)
    expect(toggle('User disabled', false)).toBeChecked()
    expect(toggle('User interactive', false)).toBeChecked()
  }
})

it('keeps inherited project tools and package overrides independent in subagent settings', async () => {
  const changed = vi.fn()
  const value: ToolSelection = { mode: 'custom', entries: [], project: false, package: { retained: false } }
  render(<CustomToolSelectionEditor value={value} tools={tools} roots={roots} subagent backgroundTools onChange={changed} />)
  await userEvent.click(screen.getByRole('button', { name: 'custom_tools.title' }))
  expect(screen.queryByRole('button', { name: 'settings.skill_group_project' })).not.toBeInTheDocument()
  await userEvent.click(toggle('custom_tools.project_tools'))
  expect(changed).toHaveBeenLastCalledWith({ ...value, project: true })
})
