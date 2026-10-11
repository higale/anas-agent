vi.mock('./plugins/usePlugins', () => ({ usePlugins: () => ({ plugins: [], error: undefined }) }))
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { defaultCapabilities, mcpToolAllowed, toolAllowed, resolveSkillSelection, type AgentCapabilities } from '@shared/agentCapabilities'
import type { SkillSnapshot, McpToolStatus } from '@shared/types'
import { CapabilityEditor } from './CapabilityEditor'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
const skills: SkillSnapshot = { scriptAutoApprove: false, roots: [{ id: 'user', kind: 'user', name: 'User', path: '/skills', shortcutAlias: 'user', removable: false, available: true }], skills: [{ scriptAutoApprove: false, id: 'user:private', rootId: 'user', name: 'private', description: 'Private skill', modelAvailable: true, userAvailable: true, linked: false, dirPath: '/skills/private', relativePath: 'private', source: 'user', rootName: 'User', shortcutAlias: 'user' }] }
function Harness({ subagent = false, onChange = vi.fn(), mcpStatus, initial }: { subagent?: boolean; onChange?: (value: AgentCapabilities) => void; mcpStatus?: McpToolStatus; initial?: AgentCapabilities }) {
  const [value, setValue] = useState<AgentCapabilities>(() => initial ?? ({ ...structuredClone(defaultCapabilities), skills: { mode: 'custom', project: false, entries: [] } }))
  return <CapabilityEditor value={value} skills={skills} subagent={subagent} mcpStatus={mcpStatus} onChange={(next) => { setValue(next); onChange(next) }} />
}
async function selectSkills(mode: 'default' | 'custom' | 'off') {
  await userEvent.click(within(screen.getByRole('radiogroup', { name: 'settings.capability_skills' }))
    .getByRole('radio', { name: `capabilities.${mode === 'default' ? 'all' : mode}` }))
}
describe('shared capability editor', () => {
  it.each([false, true])('removes stale skill selections regardless of checked state in subagent mode %s', async (subagent) => {
    const retained = { id: skills.skills[0].id, shortcut: true, model: false }
    const entries = [retained, { id: 'deleted:off', shortcut: false, model: false }, { id: 'deleted:on', shortcut: true, model: true }]
    const onChange = vi.fn()
    render(<Harness subagent={subagent} onChange={onChange} initial={{ ...structuredClone(defaultCapabilities),
      skills: { mode: 'custom', project: true, entries } }} />)

    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    for (const id of ['deleted:off', 'deleted:on']) {
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

  const emptyMcp: McpToolStatus = { checkedAt: '', servers: [], loaded: [], errors: [], tools: [], toolNames: [] }

  const readyMcp: McpToolStatus = { ...emptyMcp, servers: [{ id: 'alpha', name: 'Alpha MCP', index: 0, type: 'stdio', state: 'ready', toolCount: 2, toolNames: ['search', 'read'] }] }

  it.each([false, true])('collapses custom MCP selections and retains them through all and off (%s)', async subagent => {
    const changed = vi.fn()
    const { rerender } = render(<Harness subagent={subagent} mcpStatus={readyMcp} onChange={changed} />)
    const mode = within(screen.getByRole('radiogroup', { name: 'Alpha MCP' }))
    expect(mode.getByRole('radio', { name: 'capabilities.off' })).toBeChecked()
    await userEvent.click(mode.getByRole('radio', { name: 'capabilities.custom' }))
    expect(screen.queryByRole('checkbox', { name: 'Alpha MCP search' })).toBeNull()
    const heading = screen.getByRole('button', { name: 'Alpha MCP' })
    expect(heading).toHaveAttribute('aria-expanded', 'false')
    heading.focus()
    await userEvent.keyboard('{Enter}')
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alpha MCP search' }))
    const added: McpToolStatus = { ...readyMcp, servers: [{ ...readyMcp.servers[0], toolCount: 3, toolNames: ['search', 'read', 'new_tool'] }] }
    rerender(<Harness subagent={subagent} mcpStatus={added} onChange={changed} />)
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP new_tool' })).not.toBeChecked()
    await userEvent.click(mode.getByRole('radio', { name: 'capabilities.all' }))
    expect(screen.queryByRole('checkbox', { name: 'Alpha MCP search' })).toBeNull()
    expect(mcpToolAllowed(changed.mock.lastCall![0], 'alpha', 'new_tool')).toBe(true)
    await userEvent.click(mode.getByRole('radio', { name: 'capabilities.off' }))
    expect(mcpToolAllowed(changed.mock.lastCall![0], 'alpha', 'search')).toBe(false)
    await userEvent.click(mode.getByRole('radio', { name: 'capabilities.custom' }))
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP search' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'Alpha MCP new_tool' })).not.toBeChecked()
  })
  it('keeps new MCP sources off after enable all and allows editing disabled servers', async () => {
    const changed = vi.fn()
    const view = render(<Harness mcpStatus={emptyMcp} onChange={changed} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_enable_all' }))
    view.rerender(<Harness mcpStatus={readyMcp} onChange={changed} />)
    expect(within(screen.getByRole('radiogroup', { name: 'Alpha MCP' })).getByRole('radio', { name: 'capabilities.off' })).toBeChecked()
    view.rerender(<CapabilityEditor value={defaultCapabilities} mcpServers={[{ id: 'disabled', name: 'Disabled', enabled: false }]} onChange={changed} />)
    expect(within(screen.getByRole('radiogroup', { name: 'Disabled' })).getByRole('radio', { name: 'capabilities.all' })).toBeEnabled()
  })
  it('retains unavailable MCP choices and allows removing missing references', async () => {
    const initial: AgentCapabilities = { ...defaultCapabilities, mcp: { defaultMode: 'selected', servers: [{ id: 'alpha', mode: 'selected', tools: ['search'] }] } }
    const changed = vi.fn()
    render(<Harness initial={initial} mcpStatus={emptyMcp} onChange={changed} />)
    await userEvent.click(screen.getByRole('button', { name: 'alpha' }))
    const search = screen.getByRole('checkbox', { name: 'alpha search' })
    expect(search).toBeChecked()
    await userEvent.click(search)
    expect(changed.mock.lastCall![0].mcp.servers).toEqual([])
  })

  it.each([false, true])('edits a disabled MCP source with catalog availability %s', async known => {
    const changed = vi.fn()
    function DisabledMcp() {
      const [value, setValue] = useState<AgentCapabilities>({ ...defaultCapabilities,
        mcp: { defaultMode: 'selected', servers: [{ id: 'alpha', mode: 'off', tools: ['saved'] }] } })
      return <CapabilityEditor value={value} mcpServers={[{ id: 'alpha', name: 'Alpha MCP', enabled: false }]}
        mcpStatus={known ? readyMcp : emptyMcp} onChange={next => { setValue(next); changed(next) }} />
    }
    render(<DisabledMcp />)
    await userEvent.click(within(screen.getByRole('radiogroup', { name: 'Alpha MCP' })).getByRole('radio', { name: 'capabilities.custom' }))
    await userEvent.click(screen.getByRole('button', { name: 'Alpha MCP' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'Alpha MCP saved' }))
    expect(changed.mock.lastCall![0].mcp.servers[0].tools).toEqual([])
    if (known) {
      await userEvent.click(screen.getByRole('checkbox', { name: 'Alpha MCP search' }))
      expect(changed.mock.lastCall![0].mcp.servers[0].tools).toEqual(['search'])
    } else expect(screen.getByText('capabilities.no_known_mcp_tools')).toBeVisible()
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

  it.each([false, true])('shows unloadable and missing skills with saved checkbox values in subagent mode %s', async (subagent) => {
    const broken = { ...skills.skills[0], id: 'user:broken', name: 'broken', loadError: { code: 'missing_frontmatter' as const } }
    const orphan = { ...skills.skills[0], id: 'orphan:skill', rootId: 'deleted-root', name: 'orphan' }
    const fixture: SkillSnapshot = { ...skills, skills: [...skills.skills, broken, orphan] }
    const selected = { shortcut: !subagent, model: true }
    const retained = { id: skills.skills[0].id, ...selected }
    const onChange = vi.fn()
    function MissingSkills({ snapshot }: { snapshot?: SkillSnapshot }) {
      const [value, setValue] = useState<AgentCapabilities>({ ...structuredClone(defaultCapabilities),
        skills: { mode: 'custom', project: true, entries: [retained, { id: broken.id, ...selected }, { id: orphan.id, ...selected }, { id: 'deleted:skill', ...selected }] } })
      return <CapabilityEditor value={value} skills={snapshot} subagent={subagent} onChange={(next) => { setValue(next); onChange(next) }} />
    }
    const { rerender } = render(<MissingSkills />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    expect(screen.getByRole('checkbox', { name: 'deleted:skill capabilities.model' })).toBeChecked()
    expect(screen.queryByRole('button', { name: /capabilities.remove_missing_skill/ })).toBeNull()
    rerender(<MissingSkills snapshot={fixture} />)
    expect(screen.getAllByRole('button', { name: /capabilities.remove_missing_skill/ })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'capabilities.remove_missing_skill: deleted:skill' })).toBeEnabled()
    expect(screen.getByText('settings.skill_group_user').closest('.ui-form-section')).toContainElement(screen.getByText('broken'))
    expect(onChange).not.toHaveBeenCalled()
    for (const name of ['broken', 'orphan', 'deleted:skill']) {
      const checkbox = screen.getByRole('checkbox', { name: `${name} capabilities.model` })
      expect(checkbox).toBeChecked()
      expect(checkbox.closest('.ui-capability-skill')).toHaveTextContent('capabilities.inactive')
      await userEvent.click(checkbox)
      expect(checkbox).not.toBeChecked()
      if (!subagent) await userEvent.click(screen.getByRole('checkbox', { name: `${name} capabilities.shortcut` }))
    }
    expect(onChange.mock.lastCall?.[0].skills).toEqual({ mode: 'custom', project: true, entries: [retained,
      ...[broken.id, orphan.id, 'deleted:skill'].map((id) => ({ id, shortcut: false, model: false }))] })
    const recovered: SkillSnapshot = { ...fixture, skills: fixture.skills.map((skill) => skill.id === broken.id ? { ...skill, loadError: undefined } : skill) }
    rerender(<MissingSkills snapshot={recovered} />)
    expect(screen.getByRole('checkbox', { name: 'broken capabilities.model' })).not.toBeChecked()
    expect(screen.getByText('broken').closest('.ui-capability-skill')).not.toHaveTextContent('capabilities.inactive')
  })

  it.each([0, 2])('shows one project-skill rule for subagents with %s project roots', async (count) => {
    const projectRoots: SkillSnapshot['roots'] = Array.from({ length: count }, (_, index) => ({
      ...skills.roots[0], id: `project-${index}`, kind: 'project', name: `Source ${index}`
    }))
    const fixture: SkillSnapshot = { scriptAutoApprove: false, roots: [...skills.roots, ...projectRoots], skills: [
      ...skills.skills, ...projectRoots.map((root) => ({ ...skills.skills[0], id: `${root.id}:skill`, rootId: root.id, source: root.kind, name: 'project-only' }))
    ] }
    function ProjectHarness() {
      const [value, setValue] = useState<AgentCapabilities>({ ...structuredClone(defaultCapabilities), toolMode: 'selected', tools: [],
        skills: { mode: 'custom', project: false, entries: [] } })
      return <CapabilityEditor subagent value={value} skills={fixture} onChange={(next) => { setValue(next); onChange(next) }} />
    }
    const onChange = vi.fn()
    render(<ProjectHarness />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    const project = screen.getByRole('checkbox', { name: 'capabilities.project_skills' })
    expect(project).not.toBeChecked()
    expect(screen.queryByText('project-only')).toBeNull()
    expect(screen.queryByText('Source 0')).toBeNull()
    await userEvent.click(project)
    expect(project).toBeChecked()
    expect(onChange.mock.lastCall?.[0].skills).toMatchObject({ project: true, entries: [] })
    const summary = screen.getByText('settings.capability_skills').closest('.ui-form-row')?.querySelector('small')
    expect(summary).toHaveTextContent('0 + settings.skill_group_project')
    await userEvent.click(screen.getByRole('checkbox', { name: 'private capabilities.model' }))
    expect(summary).toHaveTextContent('1 + settings.skill_group_project')
    await userEvent.click(project)
    expect(summary).toHaveTextContent(/^1$/)
    await userEvent.click(project)
    expect(document.querySelector('[data-tooltip="settings.subagent_skills_require_file_read"]')).toBeInTheDocument()
    await selectSkills('off')
    expect(screen.queryByRole('checkbox', { name: 'capabilities.project_skills' })).toBeNull()
  })

  it.each([1, 2])('groups skills by localized source with %s project directories', async (count) => {
    const roots: SkillSnapshot['roots'] = [
      { ...skills.roots[0], id: 'system', kind: 'system', name: 'System' },
      ...skills.roots,
      ...Array.from({ length: count }, (_, index) => ({ ...skills.roots[0], id: `project-${index}`, kind: 'project' as const, name: `Source ${index}` })),
      { ...skills.roots[0], id: 'external', kind: 'external', name: 'Custom directory' }
    ]
    const fixture: SkillSnapshot = { scriptAutoApprove: false, roots, skills: roots.map((root) => ({ ...skills.skills[0],
      id: `${root.id}:skill`, rootId: root.id, source: root.kind, name: `${root.id}-skill` })) }
    const onChange = vi.fn()
    render(<CapabilityEditor value={{ ...structuredClone(defaultCapabilities), skills: { mode: 'custom', project: false, entries: [] } }} skills={fixture} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    for (const kind of ['system', 'user', 'project']) expect(screen.getByText(`settings.skill_group_${kind}`)).toBeInTheDocument()
    expect(screen.getByText('Custom directory')).toBeInTheDocument()
    expect(screen.queryByText('System')).toBeNull()
    expect(screen.queryByText('User')).toBeNull()
    expect(Boolean(screen.queryByText('Source 0'))).toBe(count > 1)
    await userEvent.click(screen.getByRole('checkbox', { name: 'project-0-skill capabilities.model' }))
    expect(onChange.mock.lastCall?.[0].skills.entries).toEqual([{ id: 'project-0:skill', model: true, shortcut: false }])
    expect(screen.queryByRole('searchbox')).toBeNull()
    expect(screen.getByText('settings.skill_group_user')).toBeInTheDocument()
    expect(screen.getByText('settings.skill_group_project')).toBeInTheDocument()
  })

  it('keeps new MCP off when its catalog arrives after an unrelated checkbox edit', async () => {
    const { rerender } = render(<Harness />)
    await userEvent.click(screen.getByRole('checkbox', { name: 'settings.capability_networkAccess' }))
    const status: McpToolStatus = { checkedAt: '', loaded: [], errors: [], tools: [], toolNames: ['search'], servers: [{ id: 'server', index: 0, name: 'Delayed MCP', type: 'stdio', state: 'ready', toolCount: 1, toolNames: ['search'] }] }
    rerender(<Harness mcpStatus={status} />)
    expect(within(screen.getByRole('radiogroup', { name: 'Delayed MCP' })).getByRole('radio', { name: 'capabilities.off' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'settings.capability_networkAccess' })).not.toBeChecked()
  })
  it('visually groups the complete subagent capability controls under one heading', () => {
    render(<Harness subagent />)
    const group = screen.getByRole('group', { name: 'settings.capabilities' })
    expect(group).toHaveClass('ui-surface-flat')
    expect(group).toContainElement(screen.getByText('settings.capabilities'))
    expect(group).toContainElement(screen.getByRole('button', { name: 'settings.capabilities_enable_all' }))
    expect(group).toContainElement(screen.getByRole('radiogroup', { name: 'settings.capability_skills' }))
  })
  it.each([false, true])('enables skills with global defaults when enabling all in subagent mode %s', async (subagent) => {
    const onChange = vi.fn()
    render(<Harness subagent={subagent} onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_disable_all' }))
    await userEvent.click(screen.getByRole('button', { name: 'settings.capabilities_enable_all' }))
    expect(onChange.mock.lastCall?.[0]).toMatchObject({ toolMode: 'all', skills: { mode: 'default' } })
    expect(screen.queryByRole('checkbox', { name: 'settings.capability_skills' })).toBeNull()
    expect(within(screen.getByRole('radiogroup', { name: 'settings.capability_skills' }))
      .getByRole('radio', { name: 'capabilities.all' })).toBeChecked()
    expect(screen.queryByRole('searchbox')).toBeNull()
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
  it.each([false, true])('uses a segmented control without skill search in subagent mode %s', async (subagent) => {
    render(<Harness subagent={subagent} />)
    const picker = screen.getByRole('radiogroup', { name: 'settings.capability_skills' })
    expect(picker).toHaveClass('ui-segmented-control')
    expect(picker.closest('.ui-form-row')).toContainElement(picker)
    expect(screen.queryByText('capabilities.skill_selection')).toBeNull()
    expect(screen.queryByRole('searchbox', { name: 'capabilities.search_skills' })).toBeNull()
    await userEvent.click(within(picker).getByRole('radio', { name: 'capabilities.all' }))
    expect(within(picker).getByRole('radio', { name: 'capabilities.all' })).toBeChecked()
    expect(screen.queryByRole('searchbox')).toBeNull()
    await selectSkills('off')
    expect(within(picker).getByRole('radio', { name: 'capabilities.off' })).toBeChecked()
    expect(screen.queryByRole('searchbox')).toBeNull()
  })
  it.each([false, true])('selects recall and memory tools independently with one aggregate checkbox (subagent %s)', async (subagent) => {
    const onChange = vi.fn()
    render(<Harness subagent={subagent} onChange={onChange} />)
    const user = userEvent.setup()
    const all = screen.getByRole('checkbox', { name: 'settings.capability_memory' })
    await user.click(screen.getByText('settings.capability_memory'))
    const recall = screen.getByRole('checkbox', { name: 'settings.capability_memory_recall' })
    const tools = ['read_memory', 'save_to_memory', 'forget_memory'].map((name) => screen.getByRole('checkbox', { name }))
    expect(all).toBeChecked()
    await user.click(recall)
    expect(onChange.mock.lastCall![0].memory).toBe(false)
    expect(all).toBePartiallyChecked()
    for (const checkbox of tools) {
      expect(checkbox).toBeEnabled()
      expect(checkbox).toBeChecked()
      await user.click(checkbox)
    }
    expect(all).not.toBeChecked()
    expect(all).not.toBePartiallyChecked()
    await user.click(recall)
    expect(all).toBePartiallyChecked()
    expect(onChange.mock.lastCall![0].memory).toBe(true)
    expect(toolAllowed(onChange.mock.lastCall![0], 'read_memory')).toBe(false)
    await user.click(all)
    for (const checkbox of [recall, ...tools]) expect(checkbox).toBeChecked()
    await user.click(all)
    for (const checkbox of [recall, ...tools]) {
      expect(checkbox).not.toBeChecked()
      expect(checkbox).toBeEnabled()
    }
    await user.click(tools[0])
    expect(all).toBePartiallyChecked()
    expect(recall).not.toBeChecked()
    expect(toolAllowed(onChange.mock.lastCall![0], 'read_memory')).toBe(true)
  })
  it('retains custom choices when bulk actions change each source mode', async () => {
    const onChange = vi.fn()
    const initial: AgentCapabilities = { ...structuredClone(defaultCapabilities),
      customTools: { mode: 'custom', project: false, entries: ['user:chosen'] },
      skills: { mode: 'custom', project: false, entries: [{ id: 'retired:skill:guide', model: true, shortcut: false }] },
      subagents: { mode: 'custom', names: ['general-purpose'] },
      pluginTools: ['retired:tool:read'], pluginPrompts: ['retired:prompt:context'],
      mcp: { defaultMode: 'selected', servers: [{ id: 'alpha', mode: 'selected', tools: ['search'] }] }
    }
    render(<Harness initial={initial} mcpStatus={readyMcp} onChange={onChange} />)
    for (const [button, mode] of [['settings.capabilities_enable_all', 'all'], ['settings.capabilities_disable_all', 'off']]) {
      await userEvent.click(screen.getByRole('button', { name: button }))
      const value: AgentCapabilities = onChange.mock.lastCall![0]
      expect(value.plugins).toEqual([{ id: 'retired', mode }])
      expect(value.pluginTools).toEqual(initial.pluginTools)
      expect(value.pluginPrompts).toEqual(initial.pluginPrompts)
      expect(value.customTools).toEqual({ ...initial.customTools, mode })
      expect(value.skills.entries).toEqual(initial.skills.entries)
      expect(value.subagents.names).toEqual(initial.subagents.names)
      expect(value.mcp.servers).toEqual([{ id: 'alpha', mode, tools: ['search'] }])
    }
  })
  it('blocks unselected globally disabled skill uses without warnings while project skills remain independent', async () => {
    const root = { ...skills.roots[0], id: 'project', kind: 'project' as const }
    const fixture: SkillSnapshot = { ...skills, roots: [...skills.roots, root], skills: [
      { ...skills.skills[0], modelAvailable: false },
      { ...skills.skills[0], id: 'project:local', rootId: 'project', name: 'local', source: 'project', modelAvailable: false, userAvailable: false }
    ] }
    render(<CapabilityEditor value={{ ...defaultCapabilities, skills: { mode: 'custom', project: false, entries: [] } }} skills={fixture} onChange={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    expect(screen.getByRole('checkbox', { name: 'private capabilities.model' })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: 'private capabilities.shortcut' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'local capabilities.model' })).toBeEnabled()
    expect(screen.getByRole('checkbox', { name: 'local capabilities.shortcut' })).toBeEnabled()
    expect(screen.queryByText('capabilities.skill_model_globally_off')).toBeNull()
    expect(screen.queryByText('capabilities.skill_user_globally_off')).toBeNull()
  })
  it.each([false, true])('warns only about selected conflicting skill uses and allows clearing but not reselecting them (subagent %s)', async subagent => {
    const changed = vi.fn()
    function AvailabilityHarness({ available }: { available: boolean }) {
      const [value, setValue] = useState<AgentCapabilities>({ ...defaultCapabilities,
        skills: { mode: 'custom', project: false, entries: [{ id: 'user:private', model: true, shortcut: true }] } })
      const catalog = { ...skills, skills: skills.skills.map(skill => ({ ...skill, modelAvailable: available, userAvailable: available })) }
      return <CapabilityEditor value={value} skills={catalog} subagent={subagent} onChange={next => { setValue(next); changed(next) }} />
    }
    const view = render(<AvailabilityHarness available />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    view.rerender(<AvailabilityHarness available={false} />)
    const model = screen.getByRole('checkbox', { name: 'private capabilities.model' })
    expect(model).toBeChecked()
    expect(model).toBeEnabled()
    expect(screen.getByRole('alert')).toHaveTextContent('capabilities.skill_model_globally_off')
    expect(Boolean(screen.queryByText(/capabilities.skill_user_globally_off/))).toBe(!subagent)
    for (const option of subagent ? ['model'] : ['model', 'shortcut']) {
      const checkbox = screen.getByRole('checkbox', { name: `private capabilities.${option}` })
      await userEvent.click(checkbox)
      expect(checkbox).not.toBeChecked()
      expect(checkbox).toBeDisabled()
      expect(screen.queryByText(new RegExp(`capabilities.skill_${option === 'model' ? 'model' : 'user'}_globally_off`))).toBeNull()
      if (!subagent && option === 'model') expect(screen.getByRole('alert')).toHaveTextContent('capabilities.skill_user_globally_off')
      await userEvent.click(checkbox)
      expect(checkbox).not.toBeChecked()
    }
    expect(screen.queryByRole('alert')).toBeNull()
    expect(resolveSkillSelection(changed.mock.lastCall![0].skills, skills.skills.map(skill => ({ ...skill, modelAvailable: false, userAvailable: false }))).entries)
      .toEqual([{ id: 'user:private', model: false, shortcut: false }])
    view.rerender(<AvailabilityHarness available />)
    expect(model).not.toBeChecked()
    expect(model).toBeEnabled()
    await userEvent.click(model)
    expect(model).toBeChecked()
    expect(screen.queryByRole('alert')).toBeNull()
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
  it('keeps allowed shortcut and model selections independent', async () => {
    const onChange = vi.fn()
    render(<Harness onChange={onChange} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    await userEvent.click(screen.getByRole('checkbox', { name: 'private capabilities.shortcut' }))
    expect(screen.getByRole('checkbox', { name: 'private capabilities.model' })).not.toBeChecked()
    expect(onChange.mock.lastCall?.[0].skills.entries).toEqual([{ id: 'user:private', shortcut: true, model: false }])
    await userEvent.click(screen.getByRole('checkbox', { name: 'private capabilities.model' }))
    expect(onChange.mock.lastCall?.[0].skills.entries).toEqual([{ id: 'user:private', shortcut: true, model: true }])
    await userEvent.click(screen.getByRole('checkbox', { name: 'private capabilities.shortcut' }))
    expect(onChange.mock.lastCall?.[0].skills.entries).toEqual([{ id: 'user:private', shortcut: false, model: true }])
  })
  it.each([false, true])('keeps custom choices across off and default modes (subagent %s)', async (subagent) => {
    render(<Harness subagent={subagent} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.capability_skills' }))
    if (subagent) expect(screen.queryByRole('checkbox', { name: 'private capabilities.shortcut' })).toBeNull()
    await userEvent.click(screen.getByRole('checkbox', { name: 'private capabilities.model' }))
    await selectSkills('off')
    expect(screen.queryByRole('checkbox', { name: 'private capabilities.model' })).toBeNull()
    await selectSkills('custom')
    expect(screen.getByRole('checkbox', { name: 'private capabilities.model' })).toBeChecked()
  })
})
