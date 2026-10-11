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
const skills: SkillSnapshot = { scriptAutoApprove: false, roots: [], skills: [{ id: 'example:skill:review', name: 'review', description: 'Review', rootId: 'plugin:example',
  rootName: 'Example', source: 'plugin', shortcutAlias: 'plugin:example', dirPath: '/example/review', relativePath: 'review', linked: false,
  modelAvailable: true, userAvailable: true, scriptAutoApprove: false, requiredTools: ['example:tool:echo'] }] }
function Harness({ initial = defaultCapabilities, plugins = [plugin], subagent = false, changed = vi.fn(), catalog = skills }: {
  initial?: AgentCapabilities; plugins?: PluginSummary[]; subagent?: boolean; changed?: (value: AgentCapabilities) => void; catalog?: SkillSnapshot
}) {
  const [value, setValue] = useState(initial)
  return <PluginCapabilitySelection plugins={plugins} skills={catalog} value={value} subagent={subagent}
    onChange={next => { setValue(next); changed(next) }} />
}
it('groups contributions and explains tool dependencies and prompt scope without locking choices', async () => {
  const changed = vi.fn()
  render(<Harness changed={changed} initial={{ ...defaultCapabilities, skills: { mode: 'off', project: false, entries: [] }, pluginPrompts: ['example:prompt:help'] }} />)
  const group = within(screen.getByRole('region', { name: 'Example' }))
  expect(group.queryByRole('checkbox')).toBeNull()
  await userEvent.click(group.getByRole('button', { name: 'Example' }))
  expect(group.getByRole('checkbox', { name: 'help' })).toBeChecked()
  expect(group.getByRole('checkbox', { name: 'review capabilities.model' })).toBeEnabled()
  expect(group.getAllByText('plugins.missing_tools_detail: plugin__example__echo')).toHaveLength(2)
  await userEvent.click(group.getByRole('checkbox', { name: 'plugin__example__echo' }))
  expect(group.queryByText(/plugins.missing_tools_detail/)).toBeNull()
  expect(group.getByText('plugins.scope_subagent')).toBeVisible()
  expect(group.getByRole('checkbox', { name: 'help' })).toBeEnabled()
  await userEvent.click(group.getByRole('checkbox', { name: 'review capabilities.model' }))
  expect(changed.mock.lastCall?.[0]).toMatchObject({ skills: { mode: 'off', entries: [{ id: 'example:skill:review', model: true }] } })
})
it('starts new plugins off, collapses custom choices and retains them through all and off', async () => {
  const changed = vi.fn()
  render(<Harness changed={changed} />)
  const mode = within(screen.getByRole('radiogroup', { name: 'Example' }))
  expect(mode.getByRole('radio', { name: 'capabilities.off' })).toBeChecked()
  await userEvent.click(mode.getByRole('radio', { name: 'capabilities.custom' }))
  expect(screen.queryByRole('checkbox')).toBeNull()
  await userEvent.click(screen.getByRole('button', { name: 'Example' }))
  await userEvent.click(screen.getByRole('checkbox', { name: 'plugin__example__echo' }))
  for (const name of ['capabilities.all', 'capabilities.off']) {
    await userEvent.click(mode.getByRole('radio', { name }))
    expect(screen.queryByRole('checkbox')).toBeNull()
  }
  await userEvent.click(mode.getByRole('radio', { name: 'capabilities.custom' }))
  expect(screen.getByRole('checkbox', { name: 'plugin__example__echo' })).toBeChecked()
  expect(changed.mock.lastCall?.[0].pluginTools).toEqual(['example:tool:echo'])
})
it('fully edits disabled plugin contributions from the manifest without activating them', async () => {
  const changed = vi.fn(), disabledPlugin = { ...plugin, enabled: false }
  render(<Harness changed={changed} plugins={[disabledPlugin]} catalog={{ ...skills, skills: [] }} initial={{ ...defaultCapabilities, pluginTools: ['example:tool:echo'] }} />)
  await userEvent.click(screen.getByRole('button', { name: 'Example' }))
  expect(screen.getByRole('checkbox', { name: 'plugin__example__echo' })).toBeChecked()
  for (const name of ['plugin__example__echo', 'review capabilities.model', 'review capabilities.shortcut', 'help']) {
    const checkbox = screen.getByRole('checkbox', { name })
    expect(checkbox).toBeEnabled()
    await userEvent.click(checkbox)
  }
  await userEvent.click(screen.getByRole('checkbox', { name: 'plugin__example__echo' }))
  expect(screen.getAllByText('capabilities.inactive')).toHaveLength(1)
  const resolved = resolvePluginCapabilities(changed.mock.lastCall![0], [disabledPlugin])
  expect(resolved.pluginTools).toEqual([])
  expect(resolved.pluginPrompts).toEqual([])
  expect(resolved.skills.entries).toEqual([])
  await userEvent.click(screen.getByRole('radio', { name: 'capabilities.all' }))
  expect(screen.getByRole('radio', { name: 'capabilities.all' })).toBeChecked()
  await userEvent.click(screen.getByRole('radio', { name: 'capabilities.custom' }))
  expect(screen.getByRole('checkbox', { name: 'review capabilities.model' })).toBeChecked()
})
it.each([false, true])('blocks unselected disabled plugin skill uses without warnings (subagent %s)', async subagent => {
  const changed = vi.fn()
  render(<Harness changed={changed} subagent={subagent} initial={{ ...defaultCapabilities, pluginTools: ['example:tool:echo'] }}
    catalog={{ ...skills, skills: skills.skills.map(skill => ({ ...skill, modelAvailable: false, userAvailable: false })) }} />)
  await userEvent.click(screen.getByRole('button', { name: 'Example' }))
  if (subagent) expect(screen.queryByRole('checkbox', { name: 'review capabilities.shortcut' })).toBeNull()
  for (const option of subagent ? ['model'] : ['model', 'shortcut']) {
    const checkbox = screen.getByRole('checkbox', { name: `review capabilities.${option}` })
    expect(checkbox).toBeDisabled()
    await userEvent.click(checkbox)
    expect(checkbox).not.toBeChecked()
  }
  expect(screen.getByRole('checkbox', { name: 'help' })).toBeEnabled()
  expect(screen.queryByRole('alert')).toBeNull()
  expect(changed).not.toHaveBeenCalled()
})
it.each([false, true])('warns for saved conflicting plugin skill uses until they are cleared (subagent %s)', async subagent => {
  const changed = vi.fn()
  const catalog = { ...skills, skills: skills.skills.map(skill => ({ ...skill, modelAvailable: false, userAvailable: false })) }
  const initial: AgentCapabilities = { ...defaultCapabilities, pluginTools: ['example:tool:echo'],
    skills: { ...defaultCapabilities.skills, entries: [{ id: 'example:skill:review', model: true, shortcut: true }] } }
  const view = render(<Harness changed={changed} subagent={subagent} initial={initial} catalog={catalog} />)
  await userEvent.click(screen.getByRole('button', { name: 'Example' }))
  expect(screen.getByRole('alert')).toHaveTextContent('capabilities.skill_model_globally_off')
  expect(Boolean(screen.queryByText(/capabilities.skill_user_globally_off/))).toBe(!subagent)
  for (const option of subagent ? ['model'] : ['model', 'shortcut']) {
    const checkbox = screen.getByRole('checkbox', { name: `review capabilities.${option}` })
    expect(checkbox).toBeChecked()
    expect(checkbox).toBeEnabled()
    await userEvent.click(checkbox)
    expect(checkbox).not.toBeChecked()
    expect(checkbox).toBeDisabled()
    expect(screen.queryByText(new RegExp(`capabilities.skill_${option === 'model' ? 'model' : 'user'}_globally_off`))).toBeNull()
    if (!subagent && option === 'model') expect(screen.getByRole('alert')).toHaveTextContent('capabilities.skill_user_globally_off')
    await userEvent.click(checkbox)
    expect(checkbox).not.toBeChecked()
  }
  expect(screen.queryByRole('alert')).toBeNull()
  expect(resolveSkillSelection(changed.mock.lastCall![0].skills, catalog.skills, false, subagent).entries[0])
    .toMatchObject({ model: false, shortcut: false })
  view.rerender(<Harness changed={changed} subagent={subagent} initial={initial} catalog={skills} />)
  const model = screen.getByRole('checkbox', { name: 'review capabilities.model' })
  expect(model).not.toBeChecked()
  expect(model).toBeEnabled()
  await userEvent.click(model)
  expect(model).toBeChecked()
  expect(screen.queryByRole('alert')).toBeNull()
})
