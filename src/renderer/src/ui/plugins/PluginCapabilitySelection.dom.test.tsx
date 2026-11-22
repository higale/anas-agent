import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { expect, it, vi } from 'vitest'
import { defaultCapabilities, resolvePluginCapabilities, resolveSkillSelection, type AgentCapabilities } from '@shared/agentCapabilities'
import { parsePluginManifest, type PluginSummary } from '@shared/plugins'
import type { SkillSnapshot } from '@shared/types'
import { PluginCapabilitySelection } from './PluginCapabilitySelection'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { language: 'en' }, t: (key: string, args?: { tools: string }) => args?.tools ? `${key}: ${args.tools}` : key }) }))
const plugin: PluginSummary = { id: 'example', enabled: true, backendStatus: 'stopped', manifest: parsePluginManifest({
  version: 0, api_version: 2, id: 'example', name: 'Example', plugin_version: '1.0.0', backend: 'backend.cjs',
  tools: [{ id: 'echo', handler: 'echo', description: 'Echo', effect: 'read', input_schema: { type: 'object', properties: {} } }],
  skills: [{ id: 'review', path: 'review/SKILL.md', tools: ['echo'] }],
  prompts: [{ id: 'help', path: 'help.md', description: 'Help instructions', scope: 'subagent', tools: ['echo'] }]
}) }
const skills: SkillSnapshot = { roots: [], skills: [{ id: 'example:skill:review', name: 'review', description: 'Review', rootId: 'plugin:example',
  rootName: 'Example', source: 'plugin', shortcutAlias: 'plugin:example', dirPath: '/example/review', relativePath: 'review', linked: false,
  modelAvailable: true, userAvailable: true, requiredTools: ['example:tool:echo'] }] }
function Harness({ initial = defaultCapabilities, plugins = [plugin], changed = vi.fn() }: {
  initial?: AgentCapabilities; plugins?: PluginSummary[]; changed?: (value: AgentCapabilities) => void
}) {
  const [value, setValue] = useState(initial)
  return <PluginCapabilitySelection plugins={plugins} value={value} onChange={next => { setValue(next); changed(next) }} />
}
it('restores custom plugin checkboxes after toggling the outer group all and off', async () => {
  const changed = vi.fn()
  const second = { ...plugin, id: 'second', manifest: { ...plugin.manifest!, id: 'second', name: 'Second' } }
  render(<Harness plugins={[plugin, second]} changed={changed} initial={{ ...defaultCapabilities,
    pluginGroupMode: 'custom', pluginMode: 'custom', plugins: [{ id: 'example', mode: 'all' }, { id: 'second', mode: 'off' }] }} />)
  await userEvent.click(screen.getByRole('button', { name: 'plugins.title' }))
  const modes = within(screen.getByRole('radiogroup', { name: 'plugins.title' }))
  await userEvent.click(modes.getByRole('radio', { name: 'capabilities.all' }))
  expect(screen.getByRole('checkbox', { name: 'Second' })).toBeChecked()
  await userEvent.click(modes.getByRole('radio', { name: 'capabilities.off' }))
  expect(screen.getByRole('checkbox', { name: 'Example' })).not.toBeChecked()
  expect(resolvePluginCapabilities(changed.mock.lastCall![0], [plugin, second]).pluginTools).toEqual([])
  await userEvent.click(modes.getByRole('radio', { name: 'capabilities.custom' }))
  expect(screen.getByRole('checkbox', { name: 'Example' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Second' })).not.toBeChecked()
  expect(resolvePluginCapabilities(changed.mock.lastCall![0], [plugin, second]).pluginTools).toEqual(['example:tool:echo'])
})
it.each([false, true])('selects the complete plugin including applicable prompts and skills (subagent %s)', async subagent => {
  const changed = vi.fn()
  render(<Harness initial={{ ...defaultCapabilities, pluginMode: 'off' }} changed={changed} />)
  await userEvent.click(screen.getByRole('button', { name: 'plugins.title' }))
  expect(screen.getAllByRole('radiogroup')).toHaveLength(1)
  expect(screen.getAllByRole('checkbox')).toHaveLength(1)
  const checkbox = screen.getByRole('checkbox', { name: 'Example' })
  expect(checkbox).not.toBeChecked()
  await userEvent.click(checkbox)
  const resolved = resolvePluginCapabilities(changed.mock.lastCall![0], [plugin], subagent)
  expect(resolved.pluginTools).toEqual(['example:tool:echo'])
  expect(resolved.pluginPrompts).toEqual(subagent ? ['example:prompt:help'] : [])
  expect(resolveSkillSelection(resolved.skills, skills.skills, false, subagent, resolved.pluginTools).entries)
    .toEqual([{ id: 'example:skill:review', model: true, shortcut: !subagent }])
  await userEvent.click(checkbox)
  expect(resolvePluginCapabilities(changed.mock.lastCall![0], [plugin], subagent).pluginTools).toEqual([])
})
it('keeps other plugins enabled when changing one default choice', async () => {
  const second = { ...plugin, id: 'second', manifest: { ...plugin.manifest!, id: 'second', name: 'Second' } }
  const changed = vi.fn()
  render(<Harness plugins={[plugin, second]} changed={changed} />)
  await userEvent.click(screen.getByRole('button', { name: 'plugins.title' }))
  await userEvent.click(screen.getByRole('checkbox', { name: 'Example' }))
  expect(screen.getByRole('checkbox', { name: 'Second' })).toBeChecked()
  expect(resolvePluginCapabilities(changed.mock.lastCall![0], [plugin, second]).pluginTools).toEqual(['second:tool:echo'])
})
it('allows saving a disabled plugin choice without activating it globally', async () => {
  const changed = vi.fn(), disabledPlugin = { ...plugin, enabled: false }
  render(<Harness initial={{ ...defaultCapabilities, pluginMode: 'off' }} plugins={[disabledPlugin]} changed={changed} />)
  await userEvent.click(screen.getByRole('button', { name: 'plugins.title' }))
  expect(screen.getByRole('checkbox', { name: 'Example' })).toHaveAccessibleDescription('capabilities.globally_disabled')
  expect(screen.queryByText('capabilities.inactive')).toBeNull()
  await userEvent.click(screen.getByRole('checkbox', { name: 'Example' }))
  expect(screen.getByRole('checkbox', { name: 'Example' })).toBeChecked()
  expect(resolvePluginCapabilities(changed.mock.lastCall![0], [disabledPlugin]).pluginTools).toEqual([])
})
it('accepts previous partial selections as a whole plugin and allows removing missing plugins', async () => {
  const changed = vi.fn()
  render(<Harness initial={{ ...defaultCapabilities, pluginMode: 'custom', pluginTools: ['example:tool:echo', 'missing:tool:read'] }} changed={changed} />)
  await userEvent.click(screen.getByRole('button', { name: 'plugins.title' }))
  expect(screen.getByRole('checkbox', { name: 'Example' })).toBeChecked()
  await userEvent.click(screen.getByRole('checkbox', { name: 'missing' }))
  expect(screen.getByRole('checkbox', { name: 'missing' })).not.toBeChecked()
  expect(resolvePluginCapabilities(changed.mock.lastCall![0], [plugin]).skills.entries).toHaveLength(1)
})

it('bulk selects and clears all plugins without switching away from Custom', async () => {
  const changed = vi.fn()
  const second = { ...plugin, id: 'second', enabled: false, manifest: { ...plugin.manifest!, id: 'second', name: 'Second' } }
  render(<Harness plugins={[plugin, second]} changed={changed} initial={{ ...defaultCapabilities,
    pluginGroupMode: 'custom', pluginMode: 'custom', plugins: [{ id: 'example', mode: 'all' }, { id: 'second', mode: 'off' }] }} />)
  const button = screen.getByRole('button', { name: 'capabilities.select_group_all' })
  await userEvent.click(button)
  expect(changed).toHaveBeenCalledOnce()
  expect(changed.mock.lastCall![0].pluginGroupMode).toBe('custom')
  await userEvent.click(screen.getByRole('button', { name: 'plugins.title' }))
  expect(screen.getByRole('checkbox', { name: 'Example' })).toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Second' })).toBeChecked()
  await userEvent.click(button)
  expect(changed).toHaveBeenCalledTimes(2)
  expect(changed.mock.lastCall![0].pluginGroupMode).toBe('custom')
  expect(screen.getByRole('checkbox', { name: 'Example' })).not.toBeChecked()
  expect(screen.getByRole('checkbox', { name: 'Second' })).not.toBeChecked()
})
