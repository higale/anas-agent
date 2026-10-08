import { useEffect, useRef, useState } from 'react'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { panelIdentity, type PanelContent, type PanelState } from '@shared/panels'
import { WorkspacePanels } from './WorkspacePanels'
import { useWorkspacePanels, workspacePanelScope } from './useWorkspacePanels'

const { t } = vi.hoisted(() => ({ t: (key: string, options?: { name?: string }) => options?.name ? `${key} ${options.name}` : key }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))
let views: PanelState[]
let changed: ((views: PanelState[]) => void) | undefined
let escape: ((viewId: string) => void) | undefined
const move = vi.fn(), close = vi.fn(), cancelTask = vi.fn()
function Harness({ narrow = false }: { narrow?: boolean }) {
  const controller = useWorkspacePanels()
  const [thread, setThread] = useState('one')
  const [settings, setSettings] = useState(false)
  const toggleRef = useRef<HTMLButtonElement>(null), inputRef = useRef<HTMLTextAreaElement>(null)
  const scope = workspacePanelScope(thread, 'project')
  useEffect(() => { changed = controller.syncViews; return () => { changed = undefined } }, [controller.syncViews])
  const open = (content: PanelContent, name: string) => {
    const identity = panelIdentity(content)
    let view = views.find(item => panelIdentity(item.content) === identity)
    if (!view) { view = { viewId: identity, content, name, location: 'sidebar', locations: ['sidebar', 'window'] }; views.push(view) }
    controller.syncViews(views)
    controller.present(scope, view)
  }
  return <>
    <button onClick={() => open({ kind: 'document', documentId: 'USER_GUIDE.en.md' }, 'User Guide')}>Help</button>
    <button onClick={() => open({ kind: 'plugin', pluginId: 'example', instanceId: 'main' }, 'Example')}>Plugin</button>
    <button onClick={() => open({ kind: 'files', projectId: 'project', threadId: thread }, 'Files')}>Files</button>
    {['Alpha', 'Beta'].map(name => <button key={name} onClick={() => open({ kind: 'subagent', projectId: 'project', threadId: thread, runId: 'run', subagentId: name, name }, name)}>{name}</button>)}
    <button onClick={() => setThread(thread === 'one' ? 'two' : 'one')}>Switch conversation</button>
    <button onClick={() => setSettings(!settings)}>Settings</button>
    <button ref={toggleRef} onClick={() => controller.toggle(scope)}>Toggle panels</button>
    <textarea ref={inputRef} aria-label="Message" />
    {!settings && <WorkspacePanels controller={controller} scope={scope} activities={[]} narrow={narrow}
      width={480} minWidth={320} maxWidth={700} toggleRef={toggleRef} inputRef={inputRef} onWidthCommit={vi.fn()} />}
  </>
}
beforeEach(() => {
  views = []; vi.clearAllMocks()
  close.mockImplementation(async (id: string) => { views = views.filter(view => view.viewId !== id); changed?.(views) })
  move.mockImplementation(async (id: string, location: PanelState['location']) => {
    views = views.map(view => view.viewId === id ? { ...view, location } : view); changed?.(views)
  })
  Object.defineProperty(window, 'gale', { configurable: true, value: { panels: { move, close,
    onEscape: (listener: typeof escape) => { escape = listener; return () => { escape = undefined } }
  }, agent: { runs: { cancel: cancelTask } } } })
})

describe('native panel sidebar projection', () => {
  it('shows loading in the common slot and keeps the panel controls usable', async () => {
    const user = userEvent.setup(); render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Help' }))
    act(() => { views = views.map(view => ({ ...view, loading: true })); changed?.(views) })
    expect(screen.getByRole('status')).toHaveTextContent('common.loading')
    expect(document.querySelector('[data-panel-view]')).toHaveAttribute('aria-busy', 'true')
    expect(screen.getByRole('button', { name: 'panels.move_window' })).toBeEnabled()
    await user.click(screen.getByRole('button', { name: 'agent.hide_panels' }))
    act(() => { views = views.map(view => ({ ...view, loading: false })); changed?.(views) })
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    await user.click(screen.getByText('Toggle panels'))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(document.querySelector('[data-panel-view]')).toHaveAttribute('aria-busy', 'false')
  })
  it.each(['Help', 'Plugin', 'Files', 'Alpha'])('offers the same detach action for %s and removes only its sidebar projection', async name => {
    const user = userEvent.setup(); render(<Harness />)
    await user.click(screen.getByRole('button', { name }))
    expect(document.querySelector('[data-panel-view]')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'panels.move_window' }))
    expect(move).toHaveBeenCalledWith(views[0].viewId, 'window')
    expect(views).toHaveLength(1)
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(cancelTask).not.toHaveBeenCalled()
  })
  it('keeps scoped tabs separate and global tabs shared across conversations', async () => {
    const user = userEvent.setup(); render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Alpha' }))
    await user.click(screen.getByRole('button', { name: 'Help' }))
    await user.click(screen.getByText('Switch conversation'))
    expect(screen.queryByRole('tab', { name: 'Alpha' })).not.toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'User Guide' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Beta' }))
    await user.click(screen.getByText('Switch conversation'))
    expect(screen.getByRole('tab', { name: 'Alpha' })).toBeVisible()
    expect(screen.queryByRole('tab', { name: 'Beta' })).not.toBeInTheDocument()
  })
  it('deduplicates reopening, closes an adjacent tab, and never cancels execution', async () => {
    const user = userEvent.setup(); render(<Harness />)
    for (const name of ['Alpha', 'Beta', 'Alpha']) await user.click(screen.getByRole('button', { name }))
    expect(screen.getAllByRole('tab')).toHaveLength(2)
    await user.click(screen.getByRole('button', { name: 'agent.close_panel Alpha' }))
    expect(screen.getByRole('tab', { name: 'Beta' })).toHaveAttribute('aria-selected', 'true')
    await user.click(screen.getByRole('button', { name: 'agent.close_panel Beta' }))
    await waitFor(() => expect(screen.getByText('Toggle panels')).toHaveFocus())
    expect(close).toHaveBeenCalledTimes(2)
    expect(cancelTask).not.toHaveBeenCalled()
  })
  it('supports context-menu, keyboard and middle-click close when tabs show only icons', async () => {
    const user = userEvent.setup(); render(<Harness />)
    for (const name of ['Alpha', 'Beta', 'Help']) await user.click(screen.getByRole('button', { name }))
    const alpha = screen.getByRole('tab', { name: 'Alpha' })
    expect(alpha).toHaveAttribute('title', 'Alpha')
    await user.pointer({ target: alpha, keys: '[MouseRight]' })
    await user.click(screen.getByRole('menuitem', { name: 'common.close' }))
    await user.pointer({ target: screen.getByRole('tab', { name: 'Beta' }), keys: '[MouseMiddle]' })
    screen.getByRole('tab', { name: 'User Guide' }).focus()
    await user.keyboard('{Delete}')
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument()
    expect(cancelTask).not.toHaveBeenCalled()
  })
  it('retains tab selection and maximization while settings hide all native slots', async () => {
    const user = userEvent.setup(); render(<Harness />)
    await user.click(screen.getByRole('button', { name: 'Alpha' }))
    await user.click(screen.getByRole('button', { name: 'agent.maximize_panels' }))
    await user.click(screen.getByText('Settings'))
    expect(document.querySelector('[data-panel-view]')).not.toBeInTheDocument()
    await user.click(screen.getByText('Settings'))
    expect(screen.getByRole('button', { name: 'agent.restore_panels' })).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'agent.hide_panels' }))
    expect(close).not.toHaveBeenCalled()
    await user.click(screen.getByText('Toggle panels'))
    expect(screen.getByRole('button', { name: 'agent.maximize_panels' })).toBeVisible()
  })
  it('uses a non-modal drawer and Escape only hides its projection', async () => {
    const user = userEvent.setup(); render(<Harness narrow />)
    await user.click(screen.getByRole('button', { name: 'Alpha' }))
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'Continue')
    expect(screen.getByRole('dialog')).toBeVisible()
    await user.click(screen.getByRole('tab', { name: 'Alpha' }))
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(close).not.toHaveBeenCalled()
  })
  it('routes unhandled content Escape only from the active drawer page', async () => {
    const user = userEvent.setup(); render(<Harness narrow />)
    await user.click(screen.getByRole('button', { name: 'Alpha' }))
    await user.click(screen.getByRole('button', { name: 'Beta' }))
    act(() => escape?.(views[0].viewId))
    expect(screen.getByRole('dialog')).toBeVisible()
    act(() => escape?.(views[1].viewId))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(close).not.toHaveBeenCalled()
    expect(views).toHaveLength(2)
  })
})
