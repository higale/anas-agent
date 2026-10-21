import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { defaultCapabilities } from '@shared/agentCapabilities'
import { CapabilityEditor } from '../CapabilityEditor'
import type { SubagentDraft } from './subagentDraft'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../plugins/usePlugins', () => ({ usePlugins: () => ({ plugins: [], error: undefined }) }))
const draft: SubagentDraft = { id: 'reporter', index: 0, directory: '/subagents/reporter', name: 'reporter', enabled: true,
  builtIn: false, description: 'Report', systemPrompt: 'Read reports', capabilities: structuredClone(defaultCapabilities) }
const root = { id: 'subagent:reporter:skill', kind: 'subagent', name: 'reporter', path: '/subagents/reporter/skills', removable: false, available: true }
function api() {
  const resources = { skills: { roots: [root], scriptAutoApprove: false, skills: [{ id: 'subagent:reporter:skill:report', rootId: root.id, name: 'report' }] }, tools: [{ id: 'subagent:reporter:tool:query', rootId: 'subagent:reporter:tool', name: 'query' }] }
  const file = { name: 'PROMPT.md', relativePath: 'PROMPT.md', path: '/subagents/reporter/PROMPT.md', kind: 'text' }
  const config = { subagentResources: vi.fn(async () => resources), listSubagentFiles: vi.fn(async () => [file]),
    readSubagentFile: vi.fn(async () => ({ ...file, content: 'Read reports', revision: 'original', resolvedPath: file.path, editable: true })),
    saveSubagentFile: vi.fn(async () => ({ ...file, content: 'Saved prompt', revision: 'saved', resolvedPath: file.path, editable: true })) }
  Object.defineProperty(window, 'gale', { configurable: true, value: { config, files: { showItemInFolder: vi.fn() } } })
  return config
}
describe('Agent package resource panel', () => {
  it('defaults resources on and persists explicit off choices', async () => {
    api()
    const changes = vi.fn()
    function Harness() {
      const [value, setValue] = useState(draft)
      return <CapabilityEditor subagent subagentId={value.id} value={value.capabilities}
        onChange={capabilities => { changes({ capabilities }); setValue({ ...value, capabilities }) }} />
    }
    render(<Harness />)
    const skill = within(await screen.findByRole('group', { name: 'settings.subagent_package_skills' })).getByRole('checkbox', { name: 'report' })
    expect(skill).toBeChecked()
    await userEvent.click(skill)
    expect(changes).toHaveBeenLastCalledWith({ capabilities: { ...draft.capabilities, skills: { ...draft.capabilities.skills, package: { report: false } } } })
    expect(skill).not.toBeChecked()
    const tool = within(screen.getByRole('group', { name: 'settings.subagent_package_tools' })).getByRole('checkbox', { name: 'query' })
    expect(tool).toBeChecked()
    await userEvent.click(tool)
    expect(changes).toHaveBeenLastCalledWith({ capabilities: { ...draft.capabilities,
      skills: { ...draft.capabilities.skills, package: { report: false } }, customTools: { ...draft.capabilities.customTools, package: { query: false } } } })
    expect(tool).not.toBeChecked()

  })
  it('shows resource load failures instead of presenting an empty successful catalog', async () => {
    const config = api()
    config.subagentResources.mockRejectedValueOnce(new Error('Package unreadable'))
    render(<CapabilityEditor subagent subagentId={draft.id} value={draft.capabilities} onChange={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Package unreadable')
    expect(screen.getByRole('button', { name: 'settings.capabilities_enable_all' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'settings.capabilities_disable_all' })).toBeDisabled()
  })

  it('includes package resource checkboxes in enable all and disable all', async () => {
    api()
    const changes = vi.fn()
    function Harness() {
      const [value, setValue] = useState({ ...structuredClone(defaultCapabilities),
        skills: { ...draft.capabilities.skills, package: { report: false, retained: false } },
        customTools: { ...draft.capabilities.customTools, package: { query: false } } })
      return <CapabilityEditor subagent subagentId={draft.id} value={value} onChange={next => { changes(next); setValue(next as typeof value) }} />
    }
    render(<Harness />)
    const skill = await screen.findByRole('checkbox', { name: 'report' })
    const tool = screen.getByRole('checkbox', { name: 'query' })
    expect(skill).not.toBeChecked()
    expect(tool).not.toBeChecked()
    for (const checked of [true, false, true]) {
      await userEvent.click(screen.getByRole('button', { name: checked ? 'settings.capabilities_enable_all' : 'settings.capabilities_disable_all' }))
      expect(skill).toHaveProperty('checked', checked)
      expect(tool).toHaveProperty('checked', checked)
      const value = changes.mock.lastCall![0]
      expect(value.skills).toMatchObject({ mode: checked ? 'default' : 'off', package: { report: checked, retained: checked } })
      expect(value.customTools).toMatchObject({ mode: checked ? 'all' : 'off', package: { query: checked } })
    }
  })

  it('waits for the current Agent catalog and ignores a late result from a previous Agent', async () => {
    const config = api()
    const resources = await config.subagentResources()
    let resolveFirst!: (value: typeof resources) => void
    let resolveSecond!: (value: typeof resources) => void
    config.subagentResources.mockImplementationOnce(() => new Promise(resolve => { resolveFirst = resolve }))
      .mockImplementationOnce(() => new Promise(resolve => { resolveSecond = resolve }))
    const onChange = vi.fn()
    const view = render(<CapabilityEditor subagent subagentId="first" value={draft.capabilities} onChange={onChange} />)
    const enableAll = screen.getByRole('button', { name: 'settings.capabilities_enable_all' })
    expect(enableAll).toBeDisabled()
    view.rerender(<CapabilityEditor subagent subagentId="second" value={draft.capabilities} onChange={onChange} />)
    await act(async () => resolveFirst(resources))
    expect(enableAll).toBeDisabled()
    expect(screen.queryByRole('checkbox', { name: 'report' })).not.toBeInTheDocument()
    await act(async () => resolveSecond({ skills: { ...resources.skills, skills: [] }, tools: [] }))
    expect(enableAll).toBeEnabled()
    expect(screen.queryByRole('group', { name: 'settings.subagent_package_skills' })).not.toBeInTheDocument()
    expect(screen.queryByRole('group', { name: 'settings.subagent_package_tools' })).not.toBeInTheDocument()
    expect(onChange).not.toHaveBeenCalled()
  })
})
