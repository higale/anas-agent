import { fireEvent, render, screen, within } from '@testing-library/react'
import type { ComponentProps } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { defaultCapabilities } from '@shared/agentCapabilities'
import { DEFAULT_WORKSPACE_PROJECT_ID, type Project } from '@shared/types'
import type { AgentThread } from '@shared/agentTypes'
import { ThreadList } from './ThreadList'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const base = { pinned: false, collapsed: false, createdAt: '2026-10-01', updatedAt: '2026-10-01' }
const projects: Project[] = [
  { ...base, id: 'a', name: 'Alpha', kind: 'simple_chat', prompt: '' },
  { ...base, id: 'b', name: 'Beta', kind: 'simple_chat', prompt: '' },
  { ...base, id: 'p', name: 'Pinned', kind: 'simple_chat', prompt: '', pinned: true },
  { ...base, id: DEFAULT_WORKSPACE_PROJECT_ID, name: 'Default', kind: 'workspace', prompt: '', sourceFolders: [],
    capabilities: defaultCapabilities, restrictSubagents: false, codingMode: false }
]
const threads: AgentThread[] = ['one', 'two'].map(id => ({ ...base, id, title: id, projectId: 'a', status: 'idle', accessMode: 'full_access', userTurnCount: 0 }))
function fixture(overrides: Partial<ComponentProps<typeof ThreadList>> = {}) {
  const onReorder = vi.fn(), onOpenThread = vi.fn(), onToggleProjectCollapsed = vi.fn()
  const props: ComponentProps<typeof ThreadList> = {
    loading: false, projects, threads, sidebarCollapsedSections: { pinnedProjects: false, projects: false, simpleChats: false },
    onReorder, onOpenThread, onToggleProjectCollapsed,
    onDeleteProject: vi.fn(), onDeleteProjectThreads: vi.fn(), onDeleteThread: vi.fn(), onEditProject: vi.fn(),
    onRenameThread: vi.fn(), onStartProjectThread: vi.fn(), onToggleSidebarSection: vi.fn(),
    onToggleProjectPinned: vi.fn(), onTogglePinned: vi.fn(), ...overrides
  }
  const result = render(<ThreadList {...props} />)
  const rect = (top: number, height = 32) => ({ x: 0, y: top, left: 0, right: 200, top, bottom: top + height, width: 200, height, toJSON() {} })
  vi.spyOn(screen.getByRole('navigation'), 'getBoundingClientRect').mockReturnValue(rect(0, 500))
  const rows = [...result.container.querySelectorAll<HTMLElement>('[data-sidebar-sort-id]')]
  rows.forEach((row, index) => vi.spyOn(row, 'getBoundingClientRect').mockReturnValue(rect(30 + index * 40)))
  let hit: Element | null = null
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => hit })
  const row = (id: string) => rows.find(row => row.dataset.sidebarSortId === id)!
  const down = (id: string) => {
    const handle = row(id).querySelector('[data-sidebar-drag-handle]')!
    fireEvent.pointerDown(handle, { button: 0, isPrimary: true, pointerId: 7, clientX: 40, clientY: row(id).getBoundingClientRect().top + 10 })
  }
  const move = (id: string) => {
    hit = row(id)
    fireEvent.pointerMove(window, { pointerId: 7, buttons: 1, clientX: 40, clientY: hit.getBoundingClientRect().top + 1 })
  }
  const up = () => fireEvent.pointerUp(window, { pointerId: 7, clientX: 40, clientY: hit!.getBoundingClientRect().top + 1 })
  return { ...result, props, onReorder, onOpenThread, onToggleProjectCollapsed, down, move, up, row }
}

const pinnedWorkspace: Project = { ...projects[3], id: 'pw', name: 'Pinned workspace', pinned: true }

describe('pinned project section', () => {
  it('puts both project kinds in the first section and collapses them independently', () => {
    const f = fixture({ projects: [...projects, pinnedWorkspace, { ...pinnedWorkspace, id: 'w', name: 'Workspace', pinned: false }] })
    const sections = [...f.container.querySelectorAll<HTMLElement>('.thread-list-section')]
    expect(sections.map(section => section.querySelector('.thread-group-label')!.textContent))
      .toEqual(['project.pinned_projects', 'project.projects', 'project.simple_chats'])
    expect(within(sections[0]).getByText('Pinned')).toBeVisible()
    expect(within(sections[0]).getByText('Pinned workspace')).toBeVisible()
    expect(within(sections[1]).queryByText('Pinned workspace')).not.toBeInTheDocument()
    expect(within(sections[2]).queryByText('Pinned')).not.toBeInTheDocument()
    fireEvent.click(within(sections[0]).getByRole('button', { name: 'project.collapse_section' }))
    expect(f.props.onToggleSidebarSection).toHaveBeenCalledWith('pinnedProjects')
    f.rerender(<ThreadList {...f.props} sidebarCollapsedSections={{ ...f.props.sidebarCollapsedSections, pinnedProjects: true }} />)
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument()
    expect(screen.queryByText('Pinned workspace')).not.toBeInTheDocument()
    expect(screen.getByText('Workspace')).toBeVisible()
    expect(screen.getByText('Alpha')).toBeVisible()
    expect(screen.getByText('common.default')).toBeVisible()
  })

  it('returns unpinned projects to their original categories and removes an empty pinned section', () => {
    const f = fixture({ projects: [...projects, pinnedWorkspace] })
    f.rerender(<ThreadList {...f.props} projects={f.props.projects.map(project => ({ ...project, pinned: false }))} />)
    expect(screen.queryByText('project.pinned_projects')).not.toBeInTheDocument()
    const sections = [...f.container.querySelectorAll<HTMLElement>('.thread-list-section')]
    expect(within(sections[0]).getByText('Pinned workspace')).toBeVisible()
    expect(within(sections[1]).getByText('Pinned')).toBeVisible()
    expect(screen.getAllByText('Pinned')).toHaveLength(1)
  })
})

describe('sidebar dragging', () => {
  it('allows pinned projects of different kinds to reorder within the same pinned section', () => {
    const f = fixture({ projects: [...projects, pinnedWorkspace] })
    f.down('pw'); f.move('p'); f.up()
    expect(f.onReorder).toHaveBeenCalledWith({ kind: 'project', groupId: 'pinned', pinned: true, id: 'pw', beforeId: 'p' })
  })

  it('does not open a conversation when the mouse is released after cancelling a drag', async () => {
    const f = fixture()
    const handle = f.row('two').querySelector('[data-sidebar-drag-handle]')!
    f.down('two'); f.move('one')
    fireEvent.keyDown(window, { key: 'Escape' })
    await new Promise(resolve => setTimeout(resolve, 10))
    f.up()
    fireEvent.click(handle)
    expect(f.onOpenThread).not.toHaveBeenCalled()
    expect(f.onReorder).not.toHaveBeenCalled()
    f.down('two')
    fireEvent.pointerUp(window, { pointerId: 7, clientX: 40, clientY: f.row('two').getBoundingClientRect().top + 10 })
    fireEvent.click(handle)
    expect(f.onOpenThread).toHaveBeenCalledWith('two')
  })

  it('commits only on release, suppresses the following click and leaves the default root fixed', () => {
    const f = fixture()
    expect(f.container.querySelector('[data-default-workspace]')).not.toHaveAttribute('data-sidebar-sort-id')
    f.down('b'); f.move('a')
    expect(f.onReorder).not.toHaveBeenCalled()
    expect(document.querySelector('.sidebar-drag-marker')).toBeInTheDocument()
    f.up()
    fireEvent.click(f.row('b').querySelector('[data-sidebar-drag-handle]')!)
    expect(f.onToggleProjectCollapsed).not.toHaveBeenCalled()
    expect(f.onReorder).toHaveBeenCalledWith({ kind: 'project', groupId: 'simple_chat', pinned: false, id: 'b', beforeId: 'a' })
    expect(document.querySelector('.sidebar-drag-marker')).not.toBeInTheDocument()
    expect(document.documentElement).not.toHaveClass('ui-sidebar-dragging')
  })

  it('rejects cross-group and cross-pin drags and cancels with Escape', () => {
    const f = fixture()
    f.down('b'); f.move('p'); f.up()
    f.down('two'); f.move('b'); f.up()
    f.down('two'); f.move('one')
    expect(document.querySelector('.sidebar-drag-marker')).toBeInTheDocument()
    fireEvent.keyDown(window, { key: 'Escape' }); f.up()
    expect(f.onReorder).not.toHaveBeenCalled()
    expect(document.documentElement).not.toHaveClass('ui-sidebar-dragging')
    f.down('two'); f.move('one'); f.up()
    expect(f.onReorder).toHaveBeenCalledWith({ kind: 'thread', groupId: 'a', pinned: false, id: 'two', beforeId: 'one' })
    fireEvent.click(f.row('two').querySelector('[data-sidebar-drag-handle]')!)
    expect(f.onOpenThread).not.toHaveBeenCalled()
  })
})
