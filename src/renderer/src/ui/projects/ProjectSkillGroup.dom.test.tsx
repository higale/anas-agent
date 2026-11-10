import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import type { GaleApi, SkillSnapshot } from '@shared/types'
import { ProjectSkillGroup } from './ProjectSkillGroup'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))

describe('project Skill directory controls', () => {
  it('keeps directory management available at zero skills', async () => {
    const add = vi.fn()
    const roots: SkillSnapshot['roots'] = [{ id: 'empty', kind: 'project', name: 'Empty', path: '/empty/.agents/skills', shortcutAlias: 'project', available: true, removable: false }]
    const { rerender } = render(<ProjectSkillGroup renderSkill={skill => <span key={skill.id}>{skill.name}</span>} skills={{ scriptAutoApprove: false, roots, skills: [] }} onAddDirectories={add} onRemoveDirectory={vi.fn()} />)
    const section = screen.getByLabelText('project.local_skills')
    expect(within(section).getByText('0')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'project.open_skills_folder' })).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'project.add_skill_directories' }))
    expect(add).toHaveBeenCalledOnce()
    expect(screen.getByRole('button', { name: 'settings.skill_group_project' })).toHaveAttribute('aria-expanded', 'false')
    rerender(<ProjectSkillGroup renderSkill={skill => <span key={skill.id}>{skill.name}</span>} disabled onAddDirectories={add} onRemoveDirectory={vi.fn()} />)
    expect(screen.getByRole('button', { name: 'project.add_skill_directories' })).toBeDisabled()
  })

  it('keeps single-directory actions outside the collapsed content without an extra directory disclosure', async () => {
    const openDirectory = vi.fn().mockResolvedValue(undefined), remove = vi.fn(), add = vi.fn()
    Object.defineProperty(window, 'gale', { configurable: true, value: { files: { openDirectory } } as unknown as GaleApi })
    const root: SkillSnapshot['roots'][number] = { id: 'custom', kind: 'project', name: 'Custom', path: '/custom/skills', shortcutAlias: 'project-custom', available: true, removable: true }
    render(<ProjectSkillGroup skills={{ scriptAutoApprove: false, roots: [root], skills: [] }} onAddDirectories={add} onRemoveDirectory={remove} renderSkill={() => null} />)
    const disclosure = screen.getByRole('button', { name: 'settings.skill_group_project' })
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(screen.getByRole('button', { name: 'project.open_skills_folder' }))
    await userEvent.click(screen.getByRole('button', { name: 'project.remove_skill_directory' }))
    await userEvent.click(screen.getByRole('button', { name: 'project.add_skill_directories' }))
    expect(openDirectory).toHaveBeenCalledWith(root.path)
    expect(remove).toHaveBeenCalledWith(root.path)
    expect(add).toHaveBeenCalledOnce()
    expect(disclosure).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(disclosure)
    expect(screen.queryByRole('button', { name: root.name })).not.toBeInTheDocument()
    expect(screen.getAllByRole('button', { name: 'project.open_skills_folder' })).toHaveLength(1)
  })

  it('opens roots and permits removing offline custom references, but not automatically discovered roots', async () => {
    const openDirectory = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(window, 'gale', { configurable: true, value: { files: { openDirectory } } as unknown as GaleApi })
    const remove = vi.fn()
    const roots: SkillSnapshot['roots'] = [
      { id: 'local', kind: 'project', name: 'Workspace', path: '/workspace/.agents/skills', shortcutAlias: 'project', available: true, removable: false },
      { id: 'custom', kind: 'project', name: 'Custom', path: '/extra/skills', shortcutAlias: 'project-extra', available: false, removable: true, issue: 'not_found' }
    ]
    const skills: SkillSnapshot['skills'] = [{ id: 'local:guide', rootId: 'local', name: 'guide', description: 'Project guide',
      source: 'project', rootName: 'Workspace', dirPath: '/workspace/.agents/skills/guide', relativePath: 'guide',
      shortcutAlias: 'project', modelAvailable: true, userAvailable: true, scriptAutoApprove: false, linked: false }]
    render(<ProjectSkillGroup renderSkill={skill => <span key={skill.id}>{skill.name}</span>} skills={{ scriptAutoApprove: false, roots, skills }} onAddDirectories={vi.fn()} onRemoveDirectory={remove} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.skill_group_project' }))
    const local = screen.getByRole('region', { name: roots[0].path })
    const custom = screen.getByRole('region', { name: roots[1].path })
    expect(within(local).queryByRole('button', { name: 'project.remove_skill_directory' })).not.toBeInTheDocument()
    await userEvent.click(within(local).getByRole('button', { name: 'project.open_skills_folder' }))
    expect(openDirectory).toHaveBeenCalledWith(roots[0].path)
    expect(within(local).getByRole('button', { name: 'Workspace' })).toHaveAttribute('aria-expanded', 'false')
    expect(within(custom).getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-expanded', 'false')
    await userEvent.click(within(custom).getByRole('button', { name: 'Custom' }))
    expect(within(custom).getByRole('button', { name: 'project.open_skills_folder' })).toBeDisabled()
    expect(within(custom).getByRole('alert')).toHaveTextContent('settings.skill_root_not_found')
    await userEvent.click(within(custom).getByRole('button', { name: 'project.remove_skill_directory' }))
    expect(remove).toHaveBeenCalledWith(roots[1].path)
    expect(within(custom).getByRole('button', { name: 'Custom' })).toHaveAttribute('aria-expanded', 'true')
  })

  it.each([undefined, 'not_found'] as const)('hides empty automatic sources (%s) while keeping custom roots and actual read errors', async issue => {
    const roots: SkillSnapshot['roots'] = [
      { id: 'empty', kind: 'project', name: 'Empty', path: '/empty/.agents/skills', shortcutAlias: 'project', available: !issue, removable: false, issue },
      { id: 'custom', kind: 'project', name: 'Custom', path: '/custom/skills', shortcutAlias: 'project-custom', available: true, removable: true },
      { id: 'broken', kind: 'project', name: 'Unreadable', path: '/unreadable/.agents/skills', shortcutAlias: 'project-broken', available: false, removable: false, issue: 'unreadable' }
    ]
    render(<ProjectSkillGroup renderSkill={skill => <span key={skill.id}>{skill.name}</span>} skills={{ scriptAutoApprove: false, roots, skills: [] }} onAddDirectories={vi.fn()} onRemoveDirectory={vi.fn()} />)
    await userEvent.click(screen.getByRole('button', { name: 'settings.skill_group_project' }))
    expect(screen.queryByRole('region', { name: roots[0].path })).not.toBeInTheDocument()
    const custom = screen.getByRole('region', { name: roots[1].path })
    expect(within(custom).getByRole('button', { name: 'project.open_skills_folder' })).toBeEnabled()
    expect(within(custom).getByRole('button', { name: 'project.remove_skill_directory' })).toBeEnabled()
    await userEvent.click(screen.getByRole('button', { name: 'Unreadable' }))
    expect(within(screen.getByRole('region', { name: roots[2].path })).getByRole('alert')).toHaveTextContent('settings.skill_root_unreadable')
  })
})
