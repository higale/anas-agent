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
const toggle = (name: string) => screen.getByRole('checkbox', { name })

it('applies group actions once, preserves other directories and never enables an invalid tool', async () => {
  const changed = vi.fn()
  const another = tool(roots[0], 'another')
  const broken = { ...tool(roots[0], 'broken'), definition: undefined, error: { code: 'invalid_json' as const, path: '/tools/broken/TOOL.json' } }
  function Harness() {
    const [value, setValue] = useState<ToolSelection>({ mode: 'custom', project: true, entries: [tools[1].id, another.id], package: { owned: false } })
    return <CustomToolSelectionEditor value={value} tools={[...tools, another, broken]} roots={roots} backgroundTools
      projectTools={{ onAddDirectories: vi.fn(), onRemoveDirectory: vi.fn() }}
      onChange={next => { setValue(next); changed(next) }} />
  }
  render(<Harness />)
  await userEvent.click(screen.getByRole('button', { name: 'custom_tools.title' }))
  const group = within(screen.getByRole('region', { name: 'settings.skill_group_user' }))
  const select = group.getByRole('button', { name: 'capabilities.select_group_all' })
  expect(group.getAllByRole('button')).toHaveLength(1)
  expect(select).not.toHaveAttribute('aria-pressed')
  await userEvent.click(select)
  expect(changed).toHaveBeenCalledTimes(1)
  expect(toggle('User format')).toBeChecked()
  expect(toggle('User another')).toBeChecked()
  expect(toggle('User broken')).not.toBeChecked()
  expect(toggle('Workspace inspect')).toBeChecked()
  expect(select).toHaveAccessibleName('capabilities.clear_group_all')
  await userEvent.click(select)
  expect(changed).toHaveBeenCalledTimes(2)
  expect(toggle('User another')).not.toBeChecked()
  expect(select).toHaveAccessibleName('capabilities.select_group_all')
  expect(changed).toHaveBeenLastCalledWith({ mode: 'custom', project: true, entries: [tools[1].id], package: { owned: false } })
  const project = within(screen.getByRole('region', { name: roots[1].path }))
  await userEvent.click(project.getByRole('button', { name: 'capabilities.clear_group_all' }))
  expect(toggle('Workspace inspect')).not.toBeChecked()
  expect(toggle('User format')).not.toBeChecked()
  await userEvent.click(project.getByRole('button', { name: 'capabilities.select_group_all' }))
  expect(toggle('Workspace inspect')).toBeChecked()
  expect(toggle('User format')).not.toBeChecked()
})

it.each(['all', 'off'] as const)('omits subgroup bulk actions outside Custom mode: %s', async mode => {
  render(<CustomToolSelectionEditor value={{ mode, project: false, entries: [] }} tools={tools} roots={roots} backgroundTools onChange={vi.fn()} />)
  await userEvent.click(screen.getByRole('button', { name: 'custom_tools.title' }))
  expect(screen.queryByRole('button', { name: 'capabilities.select_group_all' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'capabilities.clear_group_all' })).toBeNull()
})

it('keeps project bulk actions disabled while its directory controls are locked', async () => {
  const changed = vi.fn()
  render(<CustomToolSelectionEditor value={{ mode: 'custom', project: false, entries: [] }} tools={tools} roots={roots} backgroundTools
    projectTools={{ disabled: true, onAddDirectories: vi.fn(), onRemoveDirectory: vi.fn() }} onChange={changed} />)
  await userEvent.click(screen.getByRole('button', { name: 'capabilities.select_group_all' }))
  expect(changed).toHaveBeenLastCalledWith({ mode: 'custom', project: false, entries: [tools[0].id] })
  changed.mockClear()
  await userEvent.click(screen.getByRole('button', { name: 'custom_tools.title' }))
  const project = within(screen.getByRole('region', { name: roots[1].path }))
  const select = project.getByRole('button', { name: 'capabilities.select_group_all' })
  expect(select).toBeDisabled()
  await userEvent.click(select)
  expect(changed).not.toHaveBeenCalled()
  expect(within(screen.getByRole('region', { name: 'settings.skill_group_user' })).getByRole('button', { name: 'capabilities.select_group_all' })).toBeEnabled()
})

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
  expect(toggle('Workspace inspect')).toBeEnabled()
  const missing = within(screen.getByRole('region', { name: '/offline' }))
  expect(screen.getByRole('region', { name: '/offline' })).toHaveAccessibleDescription('custom_tools.load_error_path_not_found')
  expect(missing.getByRole('button', { name: 'project.open_tools_folder' })).toBeDisabled()
  await userEvent.click(missing.getByRole('button', { name: 'project.remove_tool_directory' }))
  expect(remove).toHaveBeenCalledWith('/offline')
  expect(changed).not.toHaveBeenCalled()
})

it('shows all inner sources immediately and preserves selections when the top-level section folds', async () => {
  const openDirectory = vi.fn().mockResolvedValue(undefined), changed = vi.fn(), user = userEvent.setup()
  vi.stubGlobal('gale', { files: { openDirectory } })
  function Harness() {
    const [value, setValue] = useState<ToolSelection>({ mode: 'all', project: false, entries: [tools[1].id] })
    return <CustomToolSelectionEditor value={value} tools={tools} roots={roots} backgroundTools
      onChange={next => { setValue(next); changed(next) }} />
  }
  render(<Harness />)
  await user.click(screen.getByRole('button', { name: 'custom_tools.title' }))
  const userGroup = screen.getByRole('region', { name: 'settings.skill_group_user' })
  const projectGroup = screen.getByRole('region', { name: 'project.local_tools' })
  expect(userGroup).toBeVisible()
  expect(projectGroup).toBeVisible()
  expect(screen.queryByRole('button', { name: 'settings.skill_group_user' })).toBeNull()
  expect(screen.getAllByText('inspect')).toHaveLength(1)
  expect(screen.getByText('format').compareDocumentPosition(projectGroup) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  for (const item of tools) {
    expect(toggle(`${item.rootName} ${item.name}`)).toBeChecked()
    expect(toggle(`${item.rootName} ${item.name}`)).toBeEnabled()
  }
  expect(changed).not.toHaveBeenCalled()
  await user.click(toggle('User format'))
  expect(toggle('User format')).not.toBeChecked()
  expect(toggle('Workspace inspect')).toBeChecked()
  expect(changed).toHaveBeenLastCalledWith({ mode: 'custom', project: true, entries: [tools[1].id] })
  await user.click(screen.getByRole('button', { name: 'custom_tools.title' }))
  expect(projectGroup).not.toBeVisible()
  await user.click(screen.getByRole('button', { name: 'custom_tools.title' }))
  expect(toggle('Workspace inspect')).toBeChecked()
  expect(screen.getAllByRole('radiogroup')).toHaveLength(1)
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
  for (const label of ['custom_tools.title']) await userEvent.click(screen.getByRole('button', { name: label }))
  expect(screen.queryByRole('alert')).toBeNull()
  expect(toggle('User format')).toHaveAccessibleDescription('custom_tools.load_error_invalid_json')
  expect(screen.getByRole('region', { name: 'project.local_tools' })).toHaveAccessibleDescription(expect.stringContaining('custom_tools.load_error_permission_denied'))
  expect(screen.queryByRole('button', { name: 'gone:tool' })).not.toBeInTheDocument()
  await userEvent.click(toggle('gone:tool'))
  expect(screen.queryByRole('checkbox', { name: 'gone:tool' })).not.toBeInTheDocument()
  expect(toggle('User format')).toBeEnabled()
  await userEvent.click(toggle('User format'))
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
  for (const label of ['custom_tools.title']) await userEvent.click(screen.getByRole('button', { name: label }))
  expect(toggle('User format')).toBeChecked()
  expect(toggle('Workspace format')).toBeChecked()
  expect(toggle('Workspace format')).toHaveAccessibleDescription('custom_tools.shadowed_by')
  expect(screen.queryByText('custom_tools.shadowed')).toBeNull()
  expect(toggle('User disabled')).toBeChecked()
  expect(toggle('User disabled')).toBeEnabled()
  expect(toggle('User interactive')).toBeChecked()
  expect(toggle('User interactive')).toBeEnabled()
  expect(toggle('User disabled')).toHaveAccessibleDescription('capabilities.globally_disabled')
  expect(screen.queryByText('capabilities.inactive')).toBeNull()
  expect(toggle('User interactive')).toHaveAccessibleDescription('custom_tools.requires_background')
  expect(screen.getByText('custom_tools.requires_background')).not.toBeVisible()
  await userEvent.click(toggle('User disabled'))
  expect(changed.mock.lastCall![0].entries).not.toContain(disabled.id)
  for (const mode of ['off', 'custom'] as const) {
    view.rerender(<CustomToolSelectionEditor value={{ ...value, mode }} tools={fixture} roots={roots} backgroundTools={false} onChange={changed} />)
    expect(toggle('User disabled')).not.toBeChecked()
    expect(toggle('User interactive')).not.toBeChecked()
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

it.each([false, true])('bulk selects the main tool section including project inheritance for a subagent: %s', async subagent => {
  const changed = vi.fn()
  function Editor() {
    const [value, setValue] = useState<ToolSelection>({ mode: 'custom', entries: [], project: false, package: { own: false } })
    return <CustomToolSelectionEditor value={value} tools={tools} roots={roots} subagent={subagent} backgroundTools
      onChange={next => { setValue(next); changed(next) }} />
  }
  render(<Editor />)
  const button = screen.getByRole('button', { name: 'capabilities.select_group_all' })
  await userEvent.click(button)
  expect(changed).toHaveBeenLastCalledWith({ mode: 'custom', entries: subagent ? [tools[0].id] : tools.map(tool => tool.id), project: subagent, package: { own: false } })
  await userEvent.click(button)
  expect(changed).toHaveBeenLastCalledWith({ mode: 'custom', entries: [], project: false, package: { own: false } })
})
