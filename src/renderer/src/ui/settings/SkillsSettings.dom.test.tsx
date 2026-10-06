import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GaleApi, SkillSnapshot } from '@shared/types'
import { SkillsSettings } from './SkillsSettings'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: { count?: number; name?: string }) => {
      const value = values?.count ?? values?.name
      return value === undefined ? key : `${key}:${value}`
    }
  })
}))

const listFiles = vi.fn()
const readFile = vi.fn()
const updateScriptApproval = vi.fn()
const updateAvailability = vi.fn()
const showItemInFolder = vi.fn()

beforeEach(() => {
  listFiles.mockReset()
  readFile.mockReset()
  updateScriptApproval.mockReset()
  updateAvailability.mockReset()
  listFiles.mockResolvedValue([{
    name: 'SKILL.md',
    path: '/skills/system/config/SKILL.md',
    relativePath: 'SKILL.md',
    kind: 'text',
    size: 10
  }])
  Object.defineProperty(window, 'gale', {
    configurable: true,
    value: { skills: { listFiles, readFile }, files: { showItemInFolder } } as unknown as GaleApi
  })
})

const snapshot: SkillSnapshot = {
  scriptAutoApprove: false,
  roots: [
    { id: 'system', kind: 'system', name: 'System', shortcutAlias: 'system', path: '/skills/system', removable: false, available: true },
    { id: 'user', kind: 'user', name: 'User', shortcutAlias: 'user', path: '/skills/user', removable: false, available: true }
  ],
  skills: [{
    id: 'system:config',
    rootId: 'system',
    name: 'config',
    description: 'Configure the application.',
    scriptAutoApprove: false,
    modelAvailable: true,
    userAvailable: true,
    dirPath: '/skills/system/config',
    linked: false,
    relativePath: 'config',
    source: 'system',
    rootName: 'System',
    shortcutAlias: 'system',
    shortcut: '/config'
  }]
}

function renderSkills(onImportDirectories = vi.fn(), skills = snapshot, onMoveDirectory = vi.fn()): void {
  render(
    <SkillsSettings
      sectionClass="settings-section"
      skills={skills}
      onAddDirectory={vi.fn()}
      onImportDirectories={onImportDirectories}
      onMoveDirectory={onMoveDirectory}
      onRefresh={vi.fn()}
      onRemoveDirectory={vi.fn()}
      onUpdateDirectory={vi.fn()}
      onUpdateScriptApproval={updateScriptApproval}
      onUpdateAvailability={updateAvailability}
    />
  )
}

async function openGroup(button: HTMLElement): Promise<void> {
  await userEvent.click(button)
  const row = button.closest('.settings-skill-tree-root') as HTMLElement
  const toggle = within(row).queryByRole('button', { expanded: false })
  if (toggle) await userEvent.click(toggle)
}

describe('Skills settings tree', () => {
  it('updates each segmented availability option through its existing save callback', async () => {
    renderSkills()
    await openGroup(screen.getByRole('button', { name: /^settings.skill_group_system/ }))
    await userEvent.click(within(document.querySelector('.settings-skill-tree') as HTMLElement).getByRole('button', { name: 'config' }))
    const group = within(screen.getByRole('group', { name: 'config' }))
    await userEvent.click(group.getByRole('checkbox', { name: 'settings.skill_model_available' }))
    expect(updateAvailability).toHaveBeenLastCalledWith('system:config', { modelAvailable: false })
    await userEvent.click(group.getByRole('checkbox', { name: 'settings.skill_user_available' }))
    expect(updateAvailability).toHaveBeenLastCalledWith('system:config', { userAvailable: false })
    await userEvent.click(group.getByRole('checkbox', { name: 'settings.skill_scripts_auto_approve' }))
    expect(updateScriptApproval).toHaveBeenCalledExactlyOnceWith('system:config', true)
    expect(updateAvailability).toHaveBeenCalledTimes(2)
  })

  it('saves directory fields on Enter or blur, preserves pending edits, and rejects invalid or unchanged input', async () => {
    const root = { ...snapshot.roots[1], id: 'shared', kind: 'external' as const, name: 'Shared', shortcutAlias: 'shared', removable: true }
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    const update = vi.fn(() => pending)
    render(<SkillsSettings sectionClass="settings-section" skills={{ ...snapshot, roots: [...snapshot.roots, root] }}
      onAddDirectory={vi.fn()} onImportDirectories={vi.fn()} onMoveDirectory={vi.fn()} onRefresh={vi.fn()}
      onRemoveDirectory={vi.fn()} onUpdateDirectory={update} onUpdateScriptApproval={vi.fn()} onUpdateAvailability={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: /^Shared/ }))
    expect(screen.queryByRole('button', { name: 'common.save' })).not.toBeInTheDocument()
    const name = screen.getByRole('textbox', { name: 'settings.skill_directory_display_name' })
    const alias = screen.getByRole('textbox', { name: /^settings.skill_shortcut_alias/ })
    await userEvent.clear(name)
    await userEvent.type(name, 'Renamed')
    expect(update).not.toHaveBeenCalled()
    await userEvent.keyboard('{Enter}')
    expect(update).toHaveBeenCalledExactlyOnceWith('shared', { name: 'Renamed', shortcutAlias: 'shared' })
    await userEvent.clear(alias)
    await userEvent.type(alias, 'renamed')
    await userEvent.tab()
    expect(update).toHaveBeenLastCalledWith('shared', { name: 'Renamed', shortcutAlias: 'renamed' })
    expect(update).toHaveBeenCalledTimes(2)
    await userEvent.click(alias)
    await userEvent.tab()
    expect(update).toHaveBeenCalledTimes(2)
    await userEvent.clear(alias)
    await userEvent.type(alias, 'INVALID ALIAS{Enter}')
    await userEvent.clear(name)
    await userEvent.keyboard('{Enter}')
    expect(update).toHaveBeenCalledTimes(2)
    await act(async () => finish())
  })

  it.each(['all', 'system', 'user', 'external'])('selects %s without toggling and toggles only with its disclosure button', async group => {
    const external = { ...snapshot.roots[1], id: 'external', kind: 'external' as const, name: 'Shared', removable: true }
    renderSkills(vi.fn(), { ...snapshot, roots: [...snapshot.roots, external], skills: [
      ...snapshot.skills, { ...snapshot.skills[0], id: 'user:example', rootId: 'user', name: 'user-example' },
      { ...snapshot.skills[0], id: 'external:example', rootId: 'external', name: 'external-example' }
    ] })
    const tree = within(document.querySelector('.settings-skill-tree') as HTMLElement)
    const name = group === 'external' ? /^Shared/ : new RegExp(`^settings.skill_group_${group}`)
    const select = tree.getByRole('button', { name })
    const row = select.closest('.settings-skill-tree-root') as HTMLElement
    const toggle = within(row).getByRole('button', { expanded: false })
    const itemName = group === 'all' ? /^config\s*@system$/ : group === 'system' ? 'config' : `${group}-example`
    expect(tree.queryByRole('button', { name: itemName })).not.toBeInTheDocument()
    await userEvent.click(select)
    await userEvent.click(select)
    expect(select).toHaveAttribute('aria-pressed', 'true')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    const list = screen.getByRole('list', { name: 'settings.skills' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(group === 'all' ? 3 : 1)
    expect(list).toHaveTextContent(group === 'all' || group === 'system' ? 'config' : `${group}-example`)
    await userEvent.click(toggle)
    const item = tree.getByRole('button', { name: itemName })
    expect(item).toBeVisible()
    await userEvent.click(select)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(item)
    expect(screen.getByText('Configure the application.')).toBeVisible()
    toggle.focus()
    await userEvent.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(tree.queryByRole('button', { name: itemName })).not.toBeInTheDocument()
    expect(screen.getByText('Configure the application.')).toBeVisible()
    expect(select).toHaveAttribute('aria-pressed', 'false')
    await userEvent.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(tree.getByRole('button', { name: itemName, pressed: true })).toBeVisible()
    expect(listFiles).not.toHaveBeenCalled()
  })
  it('opens the exact Skill from a collapsed group list even when names match', async () => {
    renderSkills(vi.fn(), { ...snapshot, skills: [...snapshot.skills, {
      ...snapshot.skills[0], id: 'user:config', rootId: 'user', source: 'user',
      dirPath: '/skills/user/config', modelAvailable: false, userAvailable: false
    }] })
    const tree = within(document.querySelector('.settings-skill-tree') as HTMLElement)
    await userEvent.click(tree.getByRole('button', { name: /^settings.skill_group_all/ }))
    const list = screen.getByRole('list', { name: 'settings.skills' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows[0]).toHaveTextContent('settings.skill_group_system · /skills/system/config')
    expect(rows[1]).toHaveTextContent('settings.skill_group_user · /skills/user/config')
    expect(rows[1]).toHaveTextContent('capabilities.inactive')
    within(rows[1]).getByRole('button').focus()
    await userEvent.keyboard('{Enter}')
    expect(screen.queryByRole('list')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '/skills/user/config' })).toBeVisible()
    expect(tree.getByRole('button', { name: 'config', pressed: true })).toBeVisible()
    expect(screen.getByRole('checkbox', { name: 'settings.skill_model_available' })).not.toBeChecked()
    expect(listFiles).not.toHaveBeenCalled()
  })

  it('shows an empty group and updates its list when the catalog changes', async () => {
    const props = { sectionClass: 'settings-section', skills: snapshot, onAddDirectory: vi.fn(), onImportDirectories: vi.fn(),
      onMoveDirectory: vi.fn(), onRefresh: vi.fn(), onUpdateDirectory: vi.fn(), onRemoveDirectory: vi.fn(),
      onUpdateScriptApproval: vi.fn(), onUpdateAvailability: vi.fn() }
    const view = render(<SkillsSettings {...props} />)
    const group = screen.getByRole('button', { name: /^settings.skill_group_user/ })
    await userEvent.click(group)
    expect(screen.getByText('settings.skill_group_empty')).toBeVisible()
    view.rerender(<SkillsSettings {...props} skills={{ ...snapshot, skills: [...snapshot.skills, {
      ...snapshot.skills[0], id: 'user:broken', rootId: 'user', name: 'broken', loadError: { code: 'missing_frontmatter' }
    }] }} />)
    const list = screen.getByRole('list', { name: 'settings.skills' })
    expect(list).toHaveTextContent('settings.skill_load_error_badge')
    await userEvent.click(within(list).getByRole('button'))
    expect(screen.getByText(/^settings.skill_issue_missing_frontmatter/)).toBeVisible()
  })
  it('moves external groups from the sidebar with selection and boundary checks', async () => {
    const moveDirectory = vi.fn()
    renderSkills(vi.fn(), { ...snapshot, roots: [...snapshot.roots,
      { id: 'first', kind: 'external', name: 'First', shortcutAlias: 'first', path: '/first', removable: true, available: true },
      { id: 'last', kind: 'external', name: 'Last', shortcutAlias: 'last', path: '/last', removable: true, available: true }
    ] }, moveDirectory)
    const sidebar = within(document.querySelector('.ui-list-pane') as HTMLElement)
    const up = sidebar.getByRole('button', { name: 'common.move_up' })
    const down = sidebar.getByRole('button', { name: 'common.move_down' })
    expect(up).toBeDisabled(); expect(down).toBeDisabled()
    await userEvent.click(sidebar.getByRole('button', { name: /^First/ }))
    expect(up).toBeDisabled(); expect(down).toBeEnabled()
    await userEvent.click(down)
    expect(moveDirectory).toHaveBeenCalledExactlyOnceWith('first', 1)
    await userEvent.click(sidebar.getByRole('button', { name: /^Last/ }))
    expect(up).toBeEnabled(); expect(down).toBeDisabled()
    await userEvent.click(up)
    expect(moveDirectory).toHaveBeenLastCalledWith('last', -1)
    expect(within(document.querySelector('.settings-skill-viewer') as HTMLElement).queryByRole('button', { name: 'common.move_up' })).not.toBeInTheDocument()
    await openGroup(sidebar.getByRole('button', { name: /^settings.skill_group_system/ }))
    expect(up).toBeDisabled(); expect(down).toBeDisabled()
    await userEvent.click(sidebar.getByRole('button', { name: /^config/ }))
    expect(up).toBeDisabled(); expect(down).toBeDisabled()
  })

  it.each([true, false])('opens source titles only when the directory is available (%s)', async available => {
    renderSkills(vi.fn(), { ...snapshot, roots: [{ ...snapshot.roots[0], available }] })
    await openGroup(screen.getByRole('button', { name: /^settings\.skill_group_system/ }))
    const title = within(document.querySelector('.settings-skill-viewer') as HTMLElement).getByRole('button', { name: 'settings.skill_group_system' })
    expect(title).toHaveProperty('disabled', !available)
    const heading = title.closest('.settings-skill-viewer-heading') as HTMLElement
    expect(within(heading).getByText('@system')).toBeVisible()
    expect(screen.queryByText('settings.skill_source')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.skill_shortcut_alias')).not.toBeInTheDocument()
    showItemInFolder.mockClear()
    await userEvent.click(title)
    if (available) expect(showItemInFolder).toHaveBeenCalledExactlyOnceWith('/skills/system')
    else expect(showItemInFolder).not.toHaveBeenCalled()
  })
  it.each([false, true])('marks only individually exempt Skills when global approval is %s', async (globalApproval) => {
    renderSkills(vi.fn(), {
      ...snapshot,
      scriptAutoApprove: globalApproval,
      skills: [
        snapshot.skills[0],
        { ...snapshot.skills[0], id: 'system:exempt', name: 'exempt', scriptAutoApprove: true }
      ]
    })
    await openGroup(screen.getByRole('button', { name: /^settings\.skill_group_all/ }))
    expect(screen.getByRole('button', { name: /^config\s*@system$/ })).toBeVisible()
    expect(screen.getByRole('button', { name: 'exempt · @system · settings.skill_scripts_auto_approve' })).toBeVisible()
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('opens Skill titles and locations while preserving script approval controls', async () => {
    const user = userEvent.setup()
    renderSkills(vi.fn(), { ...snapshot, scriptAutoApprove: true })
    await openGroup(screen.getByRole('button', { name: /^settings\.skill_group_all/ }))
    await user.click(screen.getByText('config', { selector: '.settings-skill-tree-select > span' }))
    const checkbox = screen.getByRole('checkbox', { name: 'settings.skill_scripts_auto_approve' })
    expect(checkbox).not.toBeChecked()
    await user.click(checkbox)
    expect(updateScriptApproval).toHaveBeenCalledWith('system:config', true)
    expect(screen.queryByRole('button', { name: 'common.open' })).not.toBeInTheDocument()
    const detail = within(document.querySelector('.settings-skill-viewer') as HTMLElement)
    await user.click(detail.getByRole('button', { name: 'config' }))
    expect(showItemInFolder).toHaveBeenCalledWith('/skills/system/config')
    await user.click(screen.getByRole('button', { name: '/skills/system/config' }))
    expect(showItemInFolder).toHaveBeenCalledWith('/skills/system/config')
    expect(screen.getByText('/config')).toBeVisible()
  })

  it('disables both title and location for a broken Skill link', async () => {
    renderSkills(vi.fn(), { ...snapshot, skills: [{ ...snapshot.skills[0], linked: true }] })
    await openGroup(screen.getByRole('button', { name: /^settings\.skill_group_all/ }))
    await userEvent.click(screen.getByText('config', { selector: '.settings-skill-tree-select > span' }))
    const detail = within(document.querySelector('.settings-skill-viewer') as HTMLElement)
    expect(detail.getByRole('button', { name: 'config' })).toBeDisabled()
    expect(detail.getByRole('button', { name: '/skills/system/config' })).toBeDisabled()
  })

  it('shows global sources without a project placeholder', () => {
    renderSkills()
    expect(screen.queryByRole('button', { name: /^settings\.skill_group_project/ })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^settings\.skill_group_system/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /^settings\.skill_group_user/ })).toBeInTheDocument()
  })

  it('shows Skill counts for every group', () => {
    renderSkills()

    const systemRoot = screen.getByRole('button', { name: /^settings\.skill_group_system/ })
    const userRoot = screen.getByRole('button', { name: /^settings\.skill_group_user/ })

    expect(within(systemRoot).getByText('1')).toBeInTheDocument()
    expect(within(userRoot).getByText('0')).toBeInTheDocument()
    expect(systemRoot).not.toHaveTextContent('@system')
    expect(userRoot).not.toHaveTextContent('@user')
  })

  it('selects a Skill from its label and expands it only from the disclosure button', async () => {
    const user = userEvent.setup()
    renderSkills()

    await openGroup(screen.getByRole('button', { name: /^settings\.skill_group_all/ }))
    const skill = screen.getByText('config', { selector: '.settings-skill-tree-select > span' }).closest('button')
    if (!skill) throw new Error('Skill selection button was not rendered.')
    await user.click(skill)

    expect(listFiles).not.toHaveBeenCalled()
    expect(skill.parentElement).toHaveClass('active')
    expect(screen.getByText('Configure the application.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'SKILL.md' })).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: 'settings.skill_expand:config' }))

    expect(listFiles).toHaveBeenCalledWith(undefined, 'system:config', undefined)
    expect(screen.getByRole('button', { name: 'SKILL.md' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'settings.skill_collapse:config' })).toBeInTheDocument()
  })

  it('offers import only while the Anas User root is selected', async () => {
    const user = userEvent.setup()
    const onImportDirectories = vi.fn()
    renderSkills(onImportDirectories, { ...snapshot, skills: [{ ...snapshot.skills[0], id: 'user:config', source: 'user', rootId: 'user' }] })

    expect(screen.queryByRole('button', { name: 'settings.import_skill' })).not.toBeInTheDocument()
    const userRoot = screen.getByText('settings.skill_group_user').closest('button')
    if (!userRoot) throw new Error('Anas User root button was not rendered.')
    await openGroup(userRoot)

    const importButton = within(document.querySelector('.settings-skill-viewer-heading') as HTMLElement).getByRole('button', { name: 'settings.import_skill' })
    expect(within(document.querySelector('.ui-list-pane') as HTMLElement).queryByRole('button', { name: 'settings.import_skill' })).not.toBeInTheDocument()
    await user.click(importButton)
    expect(onImportDirectories).toHaveBeenCalledOnce()
    await user.click(screen.getByRole('button', { name: 'config' }))
    expect(screen.queryByRole('button', { name: 'settings.import_skill' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'settings.skill_expand:config' }))
    await user.click(await screen.findByRole('button', { name: 'SKILL.md' }))
    expect(screen.queryByRole('button', { name: 'settings.import_skill' })).not.toBeInTheDocument()
    await openGroup(screen.getByRole('button', { name: /^settings\.skill_group_system/ }))
    expect(screen.queryByRole('button', { name: 'settings.import_skill' })).not.toBeInTheDocument()
  })

  it('orders All Skills by root order and then by name within each root', async () => {
    const groupedSnapshot: SkillSnapshot = {
  scriptAutoApprove: false,
      roots: [
        ...snapshot.roots,
        { id: 'external', kind: 'external', name: 'External', shortcutAlias: 'external', path: '/skills/external', removable: true, available: true }
      ],
      skills: [
        { ...snapshot.skills[0], id: 'external:alpha', rootId: 'external', name: 'alpha', source: 'external', rootName: 'External', shortcutAlias: 'external' },
        { ...snapshot.skills[0], id: 'user:zeta', rootId: 'user', name: 'zeta', source: 'user', rootName: 'User', shortcutAlias: 'user' },
        { ...snapshot.skills[0], id: 'system:zulu', name: 'zulu' },
        { ...snapshot.skills[0], id: 'user:beta', rootId: 'user', name: 'beta', source: 'user', rootName: 'User', shortcutAlias: 'user' },
        { ...snapshot.skills[0], id: 'system:alpha', name: 'alpha' }
      ]
    }
    renderSkills(vi.fn(), groupedSnapshot)

    await openGroup(screen.getByRole('button', { name: /^settings\.skill_group_all/ }))

    const labels = [...document.querySelectorAll('.settings-skill-tree-split:not(.settings-skill-tree-root) .settings-skill-tree-select > span')].map((node) => node.textContent)
    expect(labels).toEqual(['alpha', 'zulu', 'beta', 'zeta', 'alpha'])
    const list = screen.getByRole('list', { name: 'settings.skills' })
    expect(within(list).getAllByRole('listitem').map(row => row.querySelector('strong')?.textContent)).toEqual(labels)
  })

  it('keeps an older file read from replacing the currently selected preview', async () => {
    const user = userEvent.setup()
    let resolveFirst: ((value: unknown) => void) | undefined
    let resolveSecond: ((value: unknown) => void) | undefined
    const firstPreview = new Promise((resolve) => { resolveFirst = resolve })
    const secondPreview = new Promise((resolve) => { resolveSecond = resolve })
    const twoSkills: SkillSnapshot = {
  scriptAutoApprove: false,
      roots: snapshot.roots,
      skills: [
        { ...snapshot.skills[0], id: 'system:first', name: 'first' },
        { ...snapshot.skills[0], id: 'system:second', name: 'second' }
      ]
    }
    listFiles.mockImplementation(async (_projectId, skillId: string) => [{
      name: 'notes.md',
      path: `/skills/${skillId}/notes.md`,
      relativePath: 'notes.md',
      kind: 'text',
      size: 10
    }])
    readFile.mockImplementation(async (_projectId, skillId: string) => (
      skillId === 'system:first' ? firstPreview : secondPreview
    ))
    renderSkills(vi.fn(), twoSkills)
    await openGroup(screen.getByRole('button', { name: /^settings\.skill_group_all/ }))
    await user.click(screen.getByRole('button', { name: 'settings.skill_expand:first' }))
    await user.click(screen.getByRole('button', { name: 'settings.skill_expand:second' }))
    const files = screen.getAllByRole('button', { name: 'notes.md' })

    await user.click(files[0])
    await user.click(files[1])
    await act(async () => resolveSecond?.({
      skillId: 'system:second', name: 'notes.md', path: '/second/notes.md', relativePath: 'notes.md',
      resolvedPath: '/second/notes.md', size: 10, kind: 'text', content: 'second content'
    }))
    expect(screen.getByText('second content')).toBeInTheDocument()

    await act(async () => resolveFirst?.({
      skillId: 'system:first', name: 'notes.md', path: '/first/notes.md', relativePath: 'notes.md',
      resolvedPath: '/first/notes.md', size: 10, kind: 'text', content: 'first content'
    }))
    expect(screen.getByText('second content')).toBeInTheDocument()
    expect(screen.queryByText('first content')).not.toBeInTheDocument()
  })
})

it('preserves the open file when the same catalog refreshes its metadata', async () => {
  readFile.mockResolvedValue({skillId:'system:config',name:'SKILL.md',path:'/skills/system/config/SKILL.md',relativePath:'SKILL.md',resolvedPath:'/skills/system/config/SKILL.md',kind:'text',content:'Keep this preview',size:17})
  const props = {sectionClass:'settings-section',skills:snapshot,onAddDirectory:vi.fn(),onImportDirectories:vi.fn(),onMoveDirectory:vi.fn(),onRefresh:vi.fn(),onUpdateDirectory:vi.fn(),onRemoveDirectory:vi.fn(),onUpdateScriptApproval:vi.fn(),onUpdateAvailability:vi.fn()}
  const view=render(<SkillsSettings {...props} />)
  await openGroup(screen.getByRole('button',{name:/^settings\.skill_group_all/}))
  await userEvent.click(screen.getByRole('button',{name:'settings.skill_expand:config'}))
  await userEvent.click(screen.getByRole('button',{name:'SKILL.md'}))
  expect(await screen.findByText('Keep this preview')).toBeInTheDocument()
  view.rerender(<SkillsSettings {...props} skills={{...snapshot, skills:snapshot.skills.map(skill=>({...skill,description:'Refreshed'}))}} />)
  expect(screen.getByText('Keep this preview')).toBeInTheDocument()
  expect(within(view.container.querySelector('.settings-skill-tree') as HTMLElement).getByRole('button', { name: 'SKILL.md' })).toBeInTheDocument()
})
