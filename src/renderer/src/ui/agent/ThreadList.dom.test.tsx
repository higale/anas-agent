import { fireEvent, render, screen } from '@testing-library/react'
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
    capabilities: defaultCapabilities, restrictSubagents: false, advancedSettings: false, codingMode: false }
]
const threads: AgentThread[] = ['one', 'two'].map(id => ({ ...base, id, title: id, projectId: 'a', status: 'idle', accessMode: 'full_access', userTurnCount: 0 }))
function fixture() {
  const onReorder = vi.fn(), onOpenThread = vi.fn(), onToggleProjectCollapsed = vi.fn()
  const result = render(<ThreadList loading={false} projects={projects} threads={threads}
    sidebarCollapsedSections={{ projects: false, simpleChats: false }} onReorder={onReorder}
    onDeleteProject={vi.fn()} onDeleteProjectThreads={vi.fn()} onDeleteThread={vi.fn()} onEditProject={vi.fn()}
    onRenameThread={vi.fn()} onStartProjectThread={vi.fn()} onToggleSidebarSection={vi.fn()}
    onToggleProjectPinned={vi.fn()} onTogglePinned={vi.fn()} onOpenThread={onOpenThread}
    onToggleProjectCollapsed={onToggleProjectCollapsed} />)
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
  return { ...result, onReorder, onOpenThread, onToggleProjectCollapsed, down, move, up, row }
}

describe('sidebar dragging', () => {
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
