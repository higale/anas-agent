import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { GaleApi, SkillSnapshot } from '@shared/types'
import { ProjectSkillGroup } from './ProjectSkillGroup'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))

describe('project Skill directory controls', () => {
  it('keeps directory management available at zero skills', () => {
    const roots: SkillSnapshot['roots'] = [{ id: 'empty', kind: 'project', name: 'Empty', path: '/empty/.agents/skills', shortcutAlias: 'project', available: true, removable: true }]
    const remove = vi.fn()
    const { rerender } = render(<ProjectSkillGroup renderSkill={skill => <span key={skill.id}>{skill.name}</span>} skills={{ roots, skills: [] }} onRemoveDirectory={vi.fn()} />)
    const section = screen.getByRole('region', { name: roots[0].path })
    expect(within(section).getByText('0')).toBeVisible()
    expect(screen.getByRole('button', { name: 'project.open_skills_folder' })).toBeEnabled()
    expect(within(section).getByText('settings.skill_group_project - Empty')).toBeVisible()
    expect(within(section).queryByRole('button', { name: 'settings.skill_group_project - Empty' })).not.toBeInTheDocument()
    rerender(<ProjectSkillGroup renderSkill={skill => <span key={skill.id}>{skill.name}</span>} skills={{ roots, skills: [] }} disabled onRemoveDirectory={remove} />)
    expect(screen.getByRole('button', { name: 'project.remove_skill_directory' })).toBeDisabled()
  })

  it('keeps single-directory actions beside its prefixed title without an intermediate Project group', async () => {
    const openDirectory = vi.fn().mockResolvedValue(undefined), remove = vi.fn()
    Object.defineProperty(window, 'gale', { configurable: true, value: { files: { openDirectory } } as unknown as GaleApi })
    const root: SkillSnapshot['roots'][number] = { id: 'custom', kind: 'project', name: 'Custom', path: '/custom/skills', shortcutAlias: 'project-custom', available: true, removable: true }
    render(<ProjectSkillGroup skills={{ roots: [root], skills: [] }} onRemoveDirectory={remove} renderSkill={() => null} />)
    const section = screen.getByRole('region', { name: root.path })
    expect(within(section).getByText('settings.skill_group_project - Custom')).toBeVisible()
    expect(within(section).queryByRole('button', { name: 'settings.skill_group_project - Custom' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'project.open_skills_folder' }))
    await userEvent.click(screen.getByRole('button', { name: 'project.remove_skill_directory' }))
    expect(openDirectory).toHaveBeenCalledWith(root.path)
    expect(remove).toHaveBeenCalledWith(root.path)
    expect(within(section).getByText('settings.skill_group_project - Custom')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'settings.skill_group_project' })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'project.open_skills_folder' })).toHaveLength(1)
  })

  it('opens roots and permits removing offline custom references, including empty roots', async () => {
    const openDirectory = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'gale', { configurable: true, value: { files: { openDirectory } } as unknown as GaleApi })
    const remove = vi.fn()
    const roots: SkillSnapshot['roots'] = [
      { id: 'local', kind: 'project', name: 'Workspace', path: '/workspace/.agents/skills', shortcutAlias: 'project', available: true, removable: true },
      { id: 'custom', kind: 'project', name: 'Custom', path: '/extra/skills', shortcutAlias: 'project-extra', available: false, removable: true, issue: 'not_found' }
    ]
    const skills: SkillSnapshot['skills'] = [{ id: 'local:guide', rootId: 'local', name: 'guide', description: 'Project guide',
      source: 'project', rootName: 'Workspace', dirPath: '/workspace/.agents/skills/guide', relativePath: 'guide',
      shortcutAlias: 'project', modelAvailable: true, userAvailable: true, linked: false }]
    render(<ProjectSkillGroup renderSkill={skill => <span key={skill.id}>{skill.name}</span>} skills={{ roots, skills }} onRemoveDirectory={remove} />)
    const local = screen.getByRole('region', { name: roots[0].path })
    const custom = screen.getByRole('region', { name: roots[1].path })
    expect(within(local).getByRole('button', { name: 'project.remove_skill_directory' })).toBeEnabled()
    await userEvent.click(within(local).getByRole('button', { name: 'project.open_skills_folder' }))
    expect(openDirectory).toHaveBeenCalledWith(roots[0].path)
    expect(within(local).getByText('guide')).toBeVisible()
    expect(within(custom).getByText('settings.skill_group_project - Custom')).toBeVisible()
    expect(within(custom).getByRole('button', { name: 'project.open_skills_folder' })).toBeDisabled()
    expect(custom).toHaveAccessibleDescription('settings.skill_root_not_found')
    expect(within(custom).getByText('settings.skill_group_project - Custom')).toHaveAttribute('data-tooltip', `settings.skill_root_not_found\n${roots[1].path}`)
    expect(within(custom).getByText('settings.skill_root_not_found')).not.toBeVisible()
    await userEvent.click(within(custom).getByRole('button', { name: 'project.remove_skill_directory' }))
    expect(remove).toHaveBeenCalledWith(roots[1].path)
    expect(within(local).getByText('guide')).toBeVisible()
  })

  it.each([undefined, 'not_found'] as const)('retains empty and offline references (%s) alongside actual read errors', issue => {
    const roots: SkillSnapshot['roots'] = [
      { id: 'empty', kind: 'project', name: 'Empty', path: '/empty/.agents/skills', shortcutAlias: 'project', available: !issue, removable: true, issue },
      { id: 'custom', kind: 'project', name: 'Custom', path: '/custom/skills', shortcutAlias: 'project-custom', available: true, removable: true },
      { id: 'broken', kind: 'project', name: 'Unreadable', path: '/unreadable/.agents/skills', shortcutAlias: 'project-broken', available: false, removable: true, issue: 'unreadable' }
    ]
    render(<ProjectSkillGroup renderSkill={skill => <span key={skill.id}>{skill.name}</span>} skills={{ roots, skills: [] }} onRemoveDirectory={vi.fn()} />)
    expect(screen.getByRole('region', { name: roots[0].path })).toBeVisible()
    const custom = screen.getByRole('region', { name: roots[1].path })
    expect(within(custom).getByRole('button', { name: 'project.open_skills_folder' })).toBeEnabled()
    expect(within(custom).getByRole('button', { name: 'project.remove_skill_directory' })).toBeEnabled()
    const broken = screen.getByRole('region', { name: roots[2].path })
    expect(broken).toHaveAccessibleDescription('settings.skill_root_unreadable')
    expect(within(broken).getByText('settings.skill_group_project - Unreadable')).toHaveAttribute('data-tooltip', `settings.skill_root_unreadable\n${roots[2].path}`)
    expect(within(broken).getByText('settings.skill_root_unreadable')).not.toBeVisible()
    expect(within(broken).getByRole('button', { name: 'project.open_skills_folder' })).toBeDisabled()
    expect(within(broken).getByRole('button', { name: 'project.remove_skill_directory' })).toBeEnabled()
  })
})
