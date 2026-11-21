import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { GaleApi, SkillSnapshot } from '@shared/types'
import { ProjectSkillGroup } from './ProjectSkillGroup'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))

describe('project Skill directory controls', () => {
  it('keeps directory management available at zero skills', async () => {
    const roots: SkillSnapshot['roots'] = [{ id: 'empty', kind: 'project', name: 'Empty', path: '/empty/.agents/skills', shortcutAlias: 'project', available: true, removable: true }]
    const remove = vi.fn()
    const { rerender } = render(<ProjectSkillGroup renderSkill={skill => <span key={skill.id}>{skill.name}</span>} skills={{ roots, skills: [] }} onRemoveDirectory={vi.fn()} />)
    const section = screen.getByRole('region', { name: roots[0].path })
    expect(within(section).getByText('0')).toBeVisible()
    expect(screen.getByRole('button', { name: 'project.open_skills_folder' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'settings.skill_group_project - Empty' })).toHaveAttribute('aria-expanded', 'false')
    rerender(<ProjectSkillGroup renderSkill={skill => <span key={skill.id}>{skill.name}</span>} skills={{ roots, skills: [] }} disabled onRemoveDirectory={remove} />)
    expect(screen.getByRole('button', { name: 'project.remove_skill_directory' })).toBeDisabled()
  })

  it('keeps single-directory actions beside its prefixed title without an intermediate Project group', async () => {
    const openDirectory = vi.fn().mockResolvedValue(undefined), remove = vi.fn()
    Object.defineProperty(window, 'gale', { configurable: true, value: { files: { openDirectory } } as unknown as GaleApi })
    const root: SkillSnapshot['roots'][number] = { id: 'custom', kind: 'project', name: 'Custom', path: '/custom/skills', shortcutAlias: 'project-custom', available: true, removable: true }
    render(<ProjectSkillGroup skills={{ roots: [root], skills: [] }} onRemoveDirectory={remove} renderSkill={() => null} />)
    const disclosure = screen.getByRole('button', { name: 'settings.skill_group_project - Custom' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(screen.getByRole('button', { name: 'project.open_skills_folder' }))
    await userEvent.click(screen.getByRole('button', { name: 'project.remove_skill_directory' }))
    expect(openDirectory).toHaveBeenCalledWith(root.path)
    expect(remove).toHaveBeenCalledWith(root.path)
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(disclosure)
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
    expect(within(local).getByRole('button', { name: 'settings.skill_group_project - Workspace' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(custom).getByRole('button', { name: 'settings.skill_group_project - Custom' })).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(within(custom).getByRole('button', { name: 'settings.skill_group_project - Custom' }))
    expect(within(custom).getByRole('button', { name: 'project.open_skills_folder' })).toBeDisabled()
    expect(within(custom).getByRole('alert')).toHaveTextContent('settings.skill_root_not_found')
    await userEvent.click(within(custom).getByRole('button', { name: 'project.remove_skill_directory' }))
    expect(remove).toHaveBeenCalledWith(roots[1].path)
    expect(within(custom).getByRole('button', { name: 'settings.skill_group_project - Custom' })).toHaveAttribute('aria-expanded', 'true')
  })

  it.each([undefined, 'not_found'] as const)('retains empty and offline references (%s) alongside actual read errors', async issue => {
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
    await userEvent.click(screen.getByRole('button', { name: 'settings.skill_group_project - Unreadable' }))
    expect(within(screen.getByRole('region', { name: roots[2].path })).getByRole('alert')).toHaveTextContent('settings.skill_root_unreadable')
  })
})
