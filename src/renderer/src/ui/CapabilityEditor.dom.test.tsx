vi.mock('./plugins/usePlugins', () => ({ usePlugins: () => ({ plugins: [], error: undefined }) }))
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defaultCapabilities, mcpToolAllowed, toolAllowed, resolveSkillSelection, type AgentCapabilities } from '@shared/agentCapabilities'
import type { SkillSnapshot, McpToolStatus } from '@shared/types'
import { CapabilityEditor } from './CapabilityEditor'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
afterEach(() => vi.unstubAllGlobals())
const skills: SkillSnapshot = { roots: [{ id: 'user', kind: 'user', name: 'User', path: '/skills', shortcutAlias: 'user', removable: false, available: true }], skills: [{ id: 'user:private', rootId: 'user', name: 'private', description: 'Private skill', modelAvailable: true, userAvailable: true, linked: false, dirPath: '/skills/private', relativePath: 'private', source: 'user', rootName: 'User', shortcutAlias: 'user' }] }
function Harness({ subagent = false, onChange = vi.fn(), mcpStatus, initial }: { subagent?: boolean; onChange?: (value: AgentCapabilities) => void; mcpStatus?: McpToolStatus; initial?: AgentCapabilities }) {
  const [value, setValue] = useState<AgentCapabilities>(() => initial ?? ({ ...structuredClone(defaultCapabilities), skills: { mode: 'custom', project: false, entries: [] } }))
  return <CapabilityEditor value={value} skills={skills} subagent={subagent} mcpStatus={mcpStatus} onChange={(next) => { setValue(next); onChange(next) }} />
}
describe('shared capability editor', () => {
  it('selects and clears only the chosen skill source, including individual project directories', async () => {
    const projectRoot = { ...skills.roots[0], id: 'project', kind: 'project' as const, name: 'Workspace', path: '/workspace/skills' }
    const local = { ...skills.skills[0], id: 'project:local', rootId: projectRoot.id, name: 'local', source: 'project' as const }
    const broken = { ...skills.skills[0], id: 'user:broken', name: 'broken', loadError: { code: 'missing_frontmatter' as const } }
    const catalog = { roots: [...skills.roots, projectRoot], skills: [...skills.skills, broken, local] }
    const initial = { ...structuredClone(defaultCapabilities), skills: { mode: 'custom' as const, project: false,
      entries: [{ id: local.id, model: true, shortcut: true }], package: { owned: false } } }
    const changed = vi.fn()
    function Editor() {
      const [value, setValue] = useState<AgentCapabilities>(initial)
      return <CapabilityEditor value={value} skills={catalog} projectSkills={{ onAddDirectories: vi.fn(), onRemoveDirectory: vi.fn() }}
        onChange={next => { setValue(next); changed(next) }} />
    }
    render(<Editor />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    const user = within(screen.getByRole('region', { name: 'settings.skill_group_user' }))
    await userEvent.click(user.getByRole('button', { name: 'capabilities.select_group_all' }))
    expect(changed).toHaveBeenCalledOnce()
    expect(screen.getByRole('checkbox', { name: 'private' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'broken' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'local' })).toBeChecked()
    expect(changed.mock.lastCall![0].skills.package).toEqual({ owned: false })
    const project = within(screen.getByRole('region', { name: projectRoot.path }))
    await userEvent.click(project.getByRole('button', { name: 'capabilities.clear_group_all' }))
    expect(screen.getByRole('checkbox', { name: 'local' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'private' })).toBeChecked()
    await userEvent.click(project.getByRole('button', { name: 'capabilities.select_group_all' }))
    expect(changed.mock.lastCall![0].skills.entries).toContainEqual({ id: local.id, shortcut: true, model: true })
    await userEvent.click(user.getByRole('button', { name: 'capabilities.clear_group_all' }))
    expect(screen.getByRole('checkbox', { name: 'private' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'local' })).toBeChecked()
  })
  it.each([false, true])('retains outer modes and restores custom choices in project/subagent editor %s', async subagent => {
    const initial: AgentCapabilities = { ...structuredClone(defaultCapabilities),
      customTools: { mode: 'custom', project: true, entries: ['user:format'] },
      mcp: { mode: 'custom', defaultMode: 'selected', servers: [{ id: 'alpha', mode: 'all', tools: [] }] },
      skills: { mode: 'custom', project: true, entries: [{ id: 'user:private', shortcut: true, model: true }] },
      subagents: { mode: 'custom', names: ['researcher'] } }
    const changed = vi.fn()
    function Editor() {
      const [value, setValue] = useState(initial)
      return <CapabilityEditor subagent={subagent} value={value} skills={skills}
        mcpServers={[{ id: 'alpha', name: 'Alpha', enabled: true }]}
        onChange={next => { setValue(next); changed(next) }} />
    }
    render(<Editor />)
    for (const [label, key] of [['custom_tools.title', 'customTools'], ['settings.capability_mcp', 'mcp'],
      ['settings.capability_skills', 'skills'], ['settings.capability_subagents', 'subagents']] as const) {
      const modes = within(screen.getByRole('radiogroup', { name: label }))
      for (const mode of ['all', 'off', 'custom']) {
        await userEvent.click(modes.getByRole('radio', { name: `capabilities.${mode}` }))
        expect(modes.getByRole('radio', { name: `capabilities.${mode}` })).toBeChecked()
      }
      expect(changed.mock.lastCall![0][key]).toEqual(initial[key])
    }
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_disable_all' }))
    for (const label of ['custom_tools.title', 'settings.capability_mcp', 'settings.capability_skills', 'settings.capability_subagents']) {
      await userEvent.click(within(screen.getByRole('radiogroup', { name: label })).getByRole('radio', { name: 'capabilities.custom' }))
    }
    for (const key of ['customTools', 'mcp', 'skills', 'subagents'] as const) expect(changed.mock.lastCall![0][key]).toEqual(initial[key])
  })
  it.each([false, true])('controls bundled Python independently and includes it in enable/disable all (subagent %s)', async subagent => {
    const changed = vi.fn()
    render(<Harness subagent={subagent} onChange={changed} />)
    const python = screen.getByRole('checkbox', { name: 'settings.capability_bundledPython' })
    expect(python).toBeChecked()
    await userEvent.click(python)
    expect(changed.mock.lastCall![0]).toMatchObject({ bundledPython: false, applicationEnvironment: true, environment: true })
    expect(python).not.toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_enable_all' }))
    expect(python).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_disable_all' }))
    expect(python).not.toBeChecked()
    expect(changed.mock.lastCall![0].bundledPython).toBe(false)
  })

  it.each([false, true])('controls sleep separately from background and command tools in subagent mode %s', async (subagent) => {
    const onChange = vi.fn()
    render(<Harness subagent={subagent} onChange={onChange} />)
    const toggle = screen.getByRole('checkbox', { name: 'settings.capability_sleep' })
    expect(toggle).toBeChecked()
    await userEvent.click(toggle)
    expect(toolAllowed(onChange.mock.lastCall![0], 'sleep')).toBe(false)
    expect(onChange.mock.lastCall![0].backgroundTools).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_disable_all' }))
    await userEvent.click(toggle)
    expect(onChange.mock.lastCall![0].tools).toEqual(['sleep'])
    expect(toolAllowed(onChange.mock.lastCall![0], 'sleep')).toBe(true)
    expect(toolAllowed(onChange.mock.lastCall![0], 'run_shell')).toBe(false)
    expect(onChange.mock.lastCall![0].backgroundTools).toBe(false)
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_backgroundTools' }))
    expect(toggle).toBeChecked()
  })

  it.each([false, true])('removes stale skill selections regardless of checked state in subagent mode %s', async (subagent) => {
    const retained = { id: skills.skills[0].id, shortcut: true, model: true }
    const entries = [retained, { id: 'deleted:off', shortcut: false, model: false }, { id: 'deleted:on', shortcut: true, model: true }]
    const onChange = vi.fn()
    render(<Harness subagent={subagent} onChange={onChange} initial={{ ...structuredClone(defaultCapabilities),
      skills: { mode: 'custom', project: true, entries } }} />)

    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    for (const id of ['deleted:off', 'deleted:on']) {
      expect(screen.queryByRole('button', { name: id })).not.toBeInTheDocument()
      await userEvent.click(screen.getByRole('button', { name: `capabilities.remove_missing_skill: ${id}` }))
      expect(screen.queryByText(id)).toBeNull()
    }
    expect(screen.queryByText('capabilities.other_skills')).toBeNull()
    expect(onChange.mock.lastCall?.[0].skills).toEqual({ mode: 'custom', project: true, entries: [retained] })
    expect(screen.queryByRole('button', { name: /capabilities.remove_missing_skill/ })).toBeNull()
  })

  it.each([false, true])('controls user input independently in subagent mode %s', async (subagent) => {
    const onChange = vi.fn()
    render(<Harness subagent={subagent} onChange={onChange} />)
    const user = userEvent.setup()
    const toggle = screen.getByRole('checkbox', { name: 'settings.capability_request_user_input' })
    expect(toggle).toBeChecked()
    await user.click(toggle)
    expect(toggle).not.toBeChecked()
    expect(toolAllowed(onChange.mock.lastCall![0], 'request_user_input')).toBe(false)
    expect(toolAllowed(onChange.mock.lastCall![0], 'run_shell')).toBe(true)
    await user.click(screen.getByRole('button', { name: 'settings.capabilities_disable_all' }))
    await user.click(toggle)
    expect(onChange.mock.lastCall![0].tools).toEqual(['request_user_input'])
    expect(toolAllowed(onChange.mock.lastCall![0], 'request_user_input')).toBe(true)
    expect(onChange.mock.lastCall![0].backgroundTools).toBe(false)
    await user.click(screen.getByRole('button', { name: 'settings.capabilities_enable_all' }))
    expect(toggle).toBeChecked()
  })

  it('allows a removed builtin tool exclusion to be restored and honors the editor disabled state', async () => {
    const onChange = vi.fn()
    const value: AgentCapabilities = { ...structuredClone(defaultCapabilities), toolMode: 'except', tools: ['removed_tool'] }
    const { rerender } = render(<CapabilityEditor value={value} disabled onChange={onChange} />)
    await userEvent.click(screen.getByText('capabilities.other_tools'))
    const checkbox = screen.getByRole('checkbox', { name: 'removed_tool' })
    expect(checkbox).toBeDisabled()
    expect(checkbox).not.toBeChecked()
    rerender(<CapabilityEditor value={value} onChange={onChange} />)
    await userEvent.click(checkbox)
    expect(onChange.mock.lastCall?.[0]).toEqual({ ...value, toolMode: 'all', tools: [] })
  })

  it('visually groups the complete subagent capability controls under one heading', () => {
    render(<Harness subagent />)
    const group = screen.getByRole('group', { name: 'settings.capabilities' })
    expect(group).toHaveClass('ui-surface-flat')
    expect(group).toContainElement(screen.getByText('settings.capabilities'))
    expect(group).toContainElement(screen.getByRole('button', { name: 'settings.capabilities_enable_all' }))
    expect(group).toContainElement(screen.getByRole('button', { name: 'settings.capability_skills' }))
  })
  it.each([
    ['networkAccess', 'http_request'],
    ['commandExecution', 'run_shell'],
    ['configuration', 'update_config']
  ])('renders the single-tool %s capability as a direct toggle', async (feature, toolId) => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const label = screen.getByText(`settings.capability_${feature}`)
    expect(label.closest('summary')).toBeNull()
    expect(screen.queryByText(toolId)).toBeNull()
    const checkbox = screen.getByRole('checkbox', { name: `settings.capability_${feature}` })
    expect(checkbox).toBeChecked()
    await userEvent.click(label)
    expect(checkbox).not.toBeChecked()
    expect(toolAllowed(onChange.mock.lastCall![0], toolId)).toBe(false)
    await userEvent.click(label)
    expect(checkbox).toBeChecked()
    expect(toolAllowed(onChange.mock.lastCall![0], toolId)).toBe(true)
  })
  it('controls all background tools with one direct switch and no child controls', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    const label = screen.getByText('settings.capability_backgroundTools')
    const ids = ['read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call']
    expect(label.closest('details')).toBeNull()
    for (const id of ids) expect(screen.queryByRole('checkbox', { name: id })).toBeNull()
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_commandExecution' }))
    // Terminal input also serves custom PTY tools; the runtime checks whether a terminal source exists.
    expect(toolAllowed(onChange.mock.lastCall![0], 'write_call')).toBe(true)
    expect(toolAllowed(onChange.mock.lastCall![0], 'read_call')).toBe(true)
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_commandExecution' }))
    expect(toolAllowed(onChange.mock.lastCall![0], 'write_call')).toBe(true)
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_backgroundTools' }))
    for (const id of ids) {
      expect(toolAllowed(onChange.mock.lastCall![0], id)).toBe(false)
    }
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_backgroundTools' }))
    for (const id of ids) expect(toolAllowed(onChange.mock.lastCall![0], id)).toBe(true)
  })
  it.each([false, true])('toggles completed preference context without foreground memory tools (subagent %s)', async (subagent) => {
    const onChange = vi.fn()
    render(<Harness subagent={subagent} onChange={onChange} />)
    const checkbox = screen.getByRole('checkbox', { name: 'settings.capability_memory' })
    expect(checkbox).toBeChecked()
    await userEvent.click(checkbox)
    expect(onChange.mock.lastCall![0].memory).toBe(false)
    await userEvent.click(checkbox)
    expect(onChange.mock.lastCall![0].memory).toBe(true)
    expect(screen.queryByRole('checkbox', { name: 'read_memory' })).toBeNull()
  })
  it('keeps individual file tools selectable and displays a mixed group', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.click(screen.getByText('settings.capability_fileRead'))
    await userEvent.click(screen.getByRole('checkbox', { name: 'read_multiple_files' }))
    expect(screen.getByRole('checkbox', { name: 'read_file' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'read_multiple_files' })).not.toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'settings.capability_fileRead' })).toBePartiallyChecked()
    expect(onChange.mock.lastCall?.[0].toolMode).toBe('except')
  })

  it.each([false, true])('selects an MCP server as a whole without affecting other servers (subagent %s)', async subagent => {
    const changed = vi.fn()
    const catalog: McpToolStatus = { checkedAt: '', loaded: [], errors: [], tools: [], toolNames: ['search'],
      servers: [{ id: 'alpha', name: 'Alpha', index: 0, type: 'stdio', state: 'ready', toolCount: 1, toolNames: ['search'] }] }
    render(<Harness subagent={subagent} onChange={changed} mcpStatus={catalog} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_mcp' }))
    const checkbox = screen.getByRole('checkbox', { name: 'Alpha' })
    expect(checkbox).toBeChecked()
    expect(screen.getByRole('radiogroup', { name: 'settings.capability_mcp' })).toBeVisible()
    expect(screen.queryByRole('checkbox', { name: 'search' })).toBeNull()
    await userEvent.click(checkbox)
    expect(mcpToolAllowed(changed.mock.lastCall![0], 'alpha', 'search')).toBe(false)
    expect(mcpToolAllowed(changed.mock.lastCall![0], 'other', 'read')).toBe(true)
    await userEvent.click(checkbox)
    expect(mcpToolAllowed(changed.mock.lastCall![0], 'alpha', 'new-tool')).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_disable_all' }))
    await userEvent.click(checkbox)
    expect(mcpToolAllowed(changed.mock.lastCall![0], 'alpha', 'search')).toBe(true)
    expect(mcpToolAllowed(changed.mock.lastCall![0], 'other', 'read')).toBe(false)
  })
  it.each([false, true])('uses one ordinary-skill checkbox and follows global availability (subagent %s)', async subagent => {
    const changed = vi.fn()
    const catalog = { ...skills, skills: [{ ...skills.skills[0], modelAvailable: false, userAvailable: true }] }
    function SkillHarness() {
      const [value, setValue] = useState(defaultCapabilities)
      return <CapabilityEditor subagent={subagent} skills={catalog} value={value} onChange={next => { setValue(next); changed(next) }} />
    }
    render(<SkillHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    const checkbox = screen.getByRole('checkbox', { name: 'private' })
    expect(checkbox).toBeChecked()
    expect(screen.getByRole('radiogroup', { name: 'settings.capability_skills' })).toBeVisible()
    await userEvent.click(checkbox)
    expect(resolveSkillSelection(changed.mock.lastCall![0].skills, catalog.skills, false, subagent).entries)
      .toEqual([{ id: 'user:private', model: false, shortcut: false }])
    await userEvent.click(checkbox)
    expect(resolveSkillSelection(changed.mock.lastCall![0].skills, catalog.skills, false, subagent).entries)
      .toEqual([{ id: 'user:private', model: false, shortcut: !subagent }])
    const enabledCatalog = catalog.skills.map(skill => ({ ...skill, modelAvailable: true }))
    expect(resolveSkillSelection(changed.mock.lastCall![0].skills, enabledCatalog, false, subagent).entries[0].model).toBe(true)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_disable_all' }))
    expect(checkbox).not.toBeChecked()
    await userEvent.click(checkbox)
    expect(checkbox).toBeChecked()
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_enable_all' }))
    expect(checkbox).toBeChecked()
  })
  it.each(['default', 'custom', 'off'] as const)('keeps project directories and both skill uses editable from %s', async mode => {
    const add = vi.fn(), remove = vi.fn(), openDirectory = vi.fn().mockResolvedValue(undefined), changed = vi.fn()
    vi.stubGlobal('gale', { files: { openDirectory } })
    const root = { ...skills.roots[0], id: 'project', kind: 'project' as const, name: 'Workspace', path: '/project-skills' }
    const local = { ...skills.skills[0], id: 'project:local', rootId: root.id, name: 'local', source: 'project' as const, modelAvailable: false, userAvailable: false }
    const catalog = { roots: [...skills.roots, root], skills: [...skills.skills, local] }
    function ProjectHarness() {
      const [value, setValue] = useState<AgentCapabilities>({ ...defaultCapabilities, skills: { mode, project: false, entries: [] } })
      return <CapabilityEditor value={value} skills={catalog} projectSkills={{ onAddDirectories: add, onRemoveDirectory: remove }}
        onChange={next => { setValue(next); changed(next) }} />
    }
    render(<ProjectHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'project.add_skill_directories' }))
    expect(add).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    expect(changed).not.toHaveBeenCalled()
    const checkbox = screen.getByRole('checkbox', { name: 'local' })
    expect(checkbox).toBeEnabled()
    expect(checkbox).toHaveProperty('checked', mode === 'default')
    if (mode === 'default') await userEvent.click(checkbox)
    await userEvent.click(checkbox)
    expect(resolveSkillSelection(changed.mock.lastCall![0].skills, catalog.skills).entries)
      .toContainEqual({ id: local.id, model: true, shortcut: true })
    await userEvent.click(screen.getByRole('button', { name: 'project.open_skills_folder' }))
    expect(openDirectory).toHaveBeenCalledWith(root.path)
    await userEvent.click(screen.getByRole('button', { name: 'project.remove_skill_directory' }))
    expect(remove).toHaveBeenCalledWith(root.path)
  })
  it.each([false, true])('keeps long-description skills selectable with a warning (subagent %s)', async subagent => {
    const changed = vi.fn()
    render(<CapabilityEditor value={{ ...defaultCapabilities, skills: { mode: 'custom', project: false, entries: [] } }}
      skills={{ ...skills, skills: [{ ...skills.skills[0], description: 'x'.repeat(1510) }] }} subagent={subagent} onChange={changed} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    expect(screen.getByRole('img', { name: 'settings.skill_description_too_long' })).toBeVisible()
    await userEvent.click(screen.getByRole('checkbox', { name: 'private' }))
    expect(changed.mock.lastCall![0].skills.entries).toContainEqual({ id: 'user:private', model: true, shortcut: true })
  })
  it('shows broken skills and permits deselection without enabling an invalid skill', async () => {
    const broken = { ...skills.skills[0], loadError: { code: 'missing_frontmatter' as const } }
    const changed = vi.fn()
    function BrokenHarness() {
      const [value, setValue] = useState(defaultCapabilities)
      return <CapabilityEditor value={value} skills={{ ...skills, skills: [broken] }} onChange={next => { setValue(next); changed(next) }} />
    }
    render(<BrokenHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'private' })).toHaveAccessibleDescription('settings.skill_issue_missing_frontmatter')
    expect(screen.getByRole('checkbox', { name: 'private' }).closest('label')).toHaveAttribute('data-tooltip', expect.stringContaining('settings.skill_issue_missing_frontmatter'))
    await userEvent.click(screen.getByRole('checkbox', { name: 'private' }))
    expect(screen.getByRole('checkbox', { name: 'private' })).toBeDisabled()
    expect(resolveSkillSelection(changed.mock.lastCall![0].skills, [broken]).entries).toEqual([])
  })
  it('keeps child project inheritance independent from ordinary skills', async () => {
    const changed = vi.fn()
    render(<Harness subagent onChange={changed} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    const project = screen.getByRole('checkbox', { name: 'capabilities.project_skills' })
    await userEvent.click(project)
    expect(changed.mock.lastCall![0].skills).toMatchObject({ project: true, entries: [] })
    await userEvent.click(screen.getByRole('checkbox', { name: 'private' }))
    await userEvent.click(project)
    expect(changed.mock.lastCall![0].skills).toMatchObject({ project: false, entries: [{ id: 'user:private', model: true, shortcut: true }] })
  })
})

it.each(['settings.capability_mcp', 'settings.capability_subagents', 'settings.capability_skills'])('bulk toggles a collapsed main section while retaining Custom mode: %s', async label => {
  const changed = vi.fn()
  const initial: AgentCapabilities = { ...structuredClone(defaultCapabilities),
    mcp: { mode: 'custom', defaultMode: 'selected', servers: [] },
    subagents: { mode: 'custom', names: [] }, skills: { mode: 'custom', project: false, entries: [] } }
  function Editor() {
    const [value, setValue] = useState(initial)
    return <CapabilityEditor value={value} skills={skills}
      mcpServers={[{ id: 'alpha', name: 'Alpha', enabled: false }, { id: 'beta', name: 'Beta', enabled: true }]}
      subagents={[{ name: 'worker', description: 'Work', systemPrompt: 'Work', enabled: true }]}
      onChange={next => { setValue(next); changed(next) }} />
  }
  render(<Editor />)
  const section = within(screen.getByRole('region', { name: label }))
  const disclosure = section.getByRole('button', { name: label })
  const button = section.getByRole('button', { name: 'capabilities.select_group_all' })
  await userEvent.click(button)
  expect(changed).toHaveBeenCalledOnce()
  expect(disclosure).toHaveAttribute('aria-expanded', 'false')
  expect(button).toHaveAccessibleName('capabilities.clear_group_all')
  await userEvent.click(disclosure)
  for (const checkbox of section.getAllByRole('checkbox')) expect(checkbox).toBeChecked()
  await userEvent.click(button)
  expect(changed).toHaveBeenCalledTimes(2)
  for (const checkbox of section.getAllByRole('checkbox')) expect(checkbox).not.toBeChecked()
  const next = changed.mock.lastCall![0] as AgentCapabilities
  expect(next.mcp.mode).toBe('custom')
  expect(next.skills.mode).toBe('custom')
  expect(next.subagents.mode).toBe('custom')
  expect(next.profile).toBe(initial.profile)
  await userEvent.click(section.getByRole('radio', { name: 'capabilities.off' }))
  expect(section.queryByRole('button', { name: 'capabilities.select_group_all' })).toBeNull()
})
