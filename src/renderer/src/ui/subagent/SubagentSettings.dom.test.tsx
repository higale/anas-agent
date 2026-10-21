import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { defaultCapabilities } from '@shared/agentCapabilities'
import type { SubagentRootSummary } from '@shared/subagentPackages'
import type { AppConfigSnapshot, SubagentConfig } from '@shared/types'
import type { PackageFilePreview } from '@shared/packageFiles'
import { SubagentSettings } from './SubagentSettings'
import { subagentToDraft } from './subagentDraft'
import { notice } from '../notice'

vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string, values?: { name: string }) => values?.name ? `${key} ${values.name}` : key }) }))
vi.mock('./SubagentEditor', () => ({ SubagentEditor: ({ draft }: any) => <div>Editor: {draft.name}</div> }))
vi.mock('../settings/PackageTree', async importOriginal => ({ ...await importOriginal<typeof import('../settings/PackageTree')>(),
  PackageFileViewer: ({ preview, onSave }: any) => preview && <><p>{preview.content}</p><button onClick={() => void onSave({ content: 'Saved prompt', revision: preview.revision, resolvedPath: preview.resolvedPath })}>Save file</button></>
}))
const agents: SubagentConfig[] = [
  { id: 'builtin', index: 0, directory: '/data/subagents/_system/builtin', name: 'builtin', enabled: true, builtIn: true, description: 'Built in', systemPrompt: 'Help', capabilities: defaultCapabilities },
  { id: 'reporter', index: 1, directory: '/external/reporter', name: 'reporter', enabled: true, builtIn: false, description: 'Reports', systemPrompt: 'Read', capabilities: defaultCapabilities }
]
function api() {
  let roots: SubagentRootSummary[] = [
    { id: 'system', kind: 'system', path: '/data/subagents/_system', name: 'System', available: true, agentIds: ['builtin'], errors: [] },
    { id: 'user', kind: 'user', path: '/data/subagents', name: 'User', available: true, agentIds: [], errors: [] },
    { id: 'external', kind: 'external', path: '/external', name: 'Shared agents', available: true, agentIds: ['reporter'], errors: [] }
  ]
  const preview: PackageFilePreview = { name: 'PROMPT.md', relativePath: 'PROMPT.md', path: '/external/reporter/PROMPT.md', resolvedPath: '/external/reporter/PROMPT.md', kind: 'text', size: 4, content: 'Read prompt', revision: 'old', editable: true }
  const config = {
    listSubagentRoots: vi.fn(async () => [...roots]), addSubagentDirectory: vi.fn(async () => true),
    updateSubagentDirectory: vi.fn(async (id: string, update: any) => { roots = update.remove ? roots.filter(root => root.id !== id) : roots.map(root => root.id === id ? { ...root, name: update.name ?? root.name } : root) }),
    listSubagentFiles: vi.fn(async () => [preview]), readSubagentFile: vi.fn(async () => preview),
    saveSubagentFile: vi.fn(async () => ({ ...preview, content: 'Saved prompt', revision: 'new' }))
  }
  Object.defineProperty(window, 'gale', { configurable: true, value: { config, files: { showItemInFolder: vi.fn() } } })
  return config
}
function harness(items = agents) {
  const onRefresh = vi.fn(async () => {}), onMove = vi.fn(), onDelete = vi.fn()
  function Harness() {
    const [selected, setSelected] = useState(items[0])
    const [actionsTarget, setActionsTarget] = useState<HTMLDivElement | null>(null)
    return <><header><div ref={setActionsTarget} /></header><SubagentSettings actionsTarget={actionsTarget} config={{ subagents: items } as AppConfigSnapshot} draft={subagentToDraft(selected)} editingIndex={selected.index}
      listRef={{ current: null }} mcpStatus={undefined} runtimeToolStatus={undefined} sectionClass="settings" skills={undefined}
      onRefresh={onRefresh} onAdd={vi.fn()} onAutosizeInput={vi.fn()} onDelete={onDelete} onMove={onMove} onUpdate={vi.fn()}
      onEdit={async index => { setSelected(items[index]) }} /></>
  }
  const rendered = render(<Harness />)
  return { ...rendered, onRefresh, onMove, onDelete, tree: within(rendered.container.querySelector('.ui-list-pane')!) }
}

describe('subagent source tree', () => {
  it('ignores a delayed catalog failure after leaving settings', async () => {
    const config = api()
    let rejectRead!: (reason: Error) => void
    config.listSubagentRoots.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectRead = reject }))
    const { unmount } = harness()
    unmount()
    await act(async () => rejectRead(new Error('Catalog unavailable')))
    expect(notice.error).not.toHaveBeenCalled()
  })

  it('routes sidebar actions to the selected group or Agent and disables them for files and built-ins', async () => {
    const config = api()
    const roots = await config.listSubagentRoots()
    roots[2].agentIds.push('reviewer')
    config.listSubagentRoots.mockResolvedValue([...roots, { id: 'other', kind: 'external', path: '/other', name: 'Other', available: true, agentIds: [], errors: [] }])
    const { tree, container, onMove, onDelete } = harness([...agents, { ...agents[1], index: 2, id: 'reviewer', name: 'reviewer' }])
    const up = tree.getByRole('button', { name: 'common.move_up' }), down = tree.getByRole('button', { name: 'common.move_down' })
    expect(up).toBeDisabled(); expect(down).toBeDisabled()
    expect(tree.getByRole('button', { name: 'settings.subagent_delete' })).toBeDisabled()
    await userEvent.click(await tree.findByRole('button', { name: /^Shared agents/ }))
    expect(up).toBeDisabled(); expect(down).toBeEnabled()
    expect(tree.getByRole('button', { name: 'settings.remove_subagent_directory' })).toBeEnabled()
    await userEvent.click(down)
    await waitFor(() => expect(config.updateSubagentDirectory).toHaveBeenCalledWith('external', { direction: 1 }))
    await waitFor(() => expect(down).toBeEnabled())
    await userEvent.click(tree.getByRole('button', { name: 'settings.package_group_expand Shared agents' }))
    await userEvent.click(tree.getByRole('button', { name: 'reporter' }))
    expect(up).toBeDisabled(); expect(down).toBeEnabled()
    await userEvent.click(down)
    await waitFor(() => expect(onMove).toHaveBeenCalledWith(1))
    await waitFor(() => expect(tree.getByRole('button', { name: 'settings.subagent_delete' })).toBeEnabled())
    await userEvent.click(tree.getByRole('button', { name: 'settings.subagent_delete' }))
    expect(onDelete).toHaveBeenCalledOnce()
    expect(config.updateSubagentDirectory).toHaveBeenCalledTimes(1)
    const detail = within(container.querySelector('.settings-skill-viewer')!)
    expect(detail.queryByRole('button', { name: 'common.move_down' })).not.toBeInTheDocument()
    expect(detail.queryByRole('button', { name: 'settings.subagent_delete' })).not.toBeInTheDocument()
    await userEvent.click(tree.getByRole('button', { name: 'settings.package_group_expand reporter' }))
    await userEvent.click(await tree.findByRole('button', { name: 'PROMPT.md' }))
    expect(up).toBeDisabled(); expect(down).toBeDisabled()
    expect(tree.getByRole('button', { name: 'settings.subagent_delete' })).toBeDisabled()
    await userEvent.click(tree.getByRole('button', { name: 'settings.package_group_expand settings.skill_group_system' }))
    await userEvent.click(tree.getByRole('button', { name: 'builtin' }))
    expect(up).toBeDisabled(); expect(down).toBeDisabled()
    expect(tree.getByRole('button', { name: 'settings.subagent_delete' })).toBeDisabled()
  })

  it('shows sources, updates display names and requires confirmation before removing the source reference', async () => {
    const config = api()
    const { tree, onRefresh } = harness()
    await userEvent.click(await tree.findByRole('button', { name: /^Shared agents/ }))
    expect(screen.getByText('/external', { exact: true })).toBeVisible()
    const input = screen.getByRole('textbox')
    await userEvent.clear(input); await userEvent.type(input, 'Team'); await userEvent.tab()
    await waitFor(() => expect(config.updateSubagentDirectory).toHaveBeenCalledWith('external', { name: 'Team' }))
    expect(onRefresh.mock.invocationCallOrder[0]).toBeLessThan(config.updateSubagentDirectory.mock.invocationCallOrder[0])
    await waitFor(() => expect(screen.getByRole('button', { name: 'settings.remove_subagent_directory' })).toBeEnabled())
    await userEvent.click(screen.getByRole('button', { name: 'settings.remove_subagent_directory' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'settings.remove_subagent_directory_title Team' })
    expect(within(dialog).getByText('settings.remove_subagent_directory_description')).toBeVisible()
    expect(config.updateSubagentDirectory).not.toHaveBeenCalledWith('external', { remove: true })
    await userEvent.click(within(dialog).getByRole('button', { name: 'common.cancel' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(tree.getByRole('button', { name: /^Team/ })).toBeVisible()
    expect(config.updateSubagentDirectory).not.toHaveBeenCalledWith('external', { remove: true })
    await userEvent.click(tree.getByRole('button', { name: 'settings.remove_subagent_directory' }))
    onRefresh.mockClear()
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'common.remove' }))
    await waitFor(() => expect(config.updateSubagentDirectory).toHaveBeenCalledWith('external', { remove: true }))
    expect(onRefresh.mock.invocationCallOrder[0]).toBeLessThan(config.updateSubagentDirectory.mock.invocationCallOrder[1])
    await waitFor(() => expect(tree.queryByRole('button', { name: /^Team/ })).not.toBeInTheDocument())
    expect(config.saveSubagentFile).not.toHaveBeenCalled()
  })

  it('starts collapsed and unselected, reveals overview selections, and saves files after pending settings', async () => {
    const config = api()
    const { tree, onRefresh } = harness()
    await tree.findByRole('button', { name: /^Shared agents/ })
    expect(screen.getByText('settings.select_subagent_tree_item')).toBeVisible()
    expect(tree.getAllByRole('button', { expanded: false })).toHaveLength(4)
    expect(tree.queryByRole('button', { expanded: true })).not.toBeInTheDocument()
    expect(tree.queryByRole('button', { pressed: true })).not.toBeInTheDocument()
    expect(tree.queryByRole('button', { name: 'reporter' })).not.toBeInTheDocument()
    await userEvent.click(tree.getByRole('button', { name: /^settings.subagent_group_all/ }))
    await userEvent.click(within(screen.getByRole('list', { name: 'settings.subagents' })).getByRole('button', { name: /^reporter/ }))
    expect(await tree.findByRole('button', { name: 'reporter' })).toHaveAttribute('aria-pressed', 'true')
    expect(tree.getByRole('button', { name: 'settings.package_group_collapse Shared agents' })).toHaveAttribute('aria-expanded', 'true')
    expect(await screen.findByText('Editor: reporter')).toBeVisible()
    await userEvent.click(tree.getByRole('button', { name: 'settings.package_group_expand reporter' }))
    await userEvent.click(await tree.findByRole('button', { name: 'PROMPT.md' }))
    expect(await screen.findByText('Read prompt')).toBeVisible()
    expect(screen.queryByText('Editor: reporter')).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await waitFor(() => expect(config.saveSubagentFile).toHaveBeenCalledWith('reporter', 'PROMPT.md', { content: 'Saved prompt', revision: 'old', resolvedPath: '/external/reporter/PROMPT.md' }))
    expect(onRefresh.mock.invocationCallOrder[0]).toBeLessThan(config.saveSubagentFile.mock.invocationCallOrder[0])
    expect(await screen.findByText('Saved prompt')).toBeVisible()
  })

  it('ignores a delayed file preview after selecting another Agent', async () => {
    const config = api()
    let resolveRead!: (value: PackageFilePreview) => void
    config.readSubagentFile.mockImplementationOnce(() => new Promise(resolve => { resolveRead = resolve }))
    const { tree } = harness()
    await userEvent.click(await tree.findByRole('button', { name: 'settings.package_group_expand settings.skill_group_system' }))
    await userEvent.click(tree.getByRole('button', { name: 'settings.package_group_expand builtin' }))
    await userEvent.click(await tree.findByRole('button', { name: 'PROMPT.md' }))
    await userEvent.click(tree.getByRole('button', { name: 'builtin' }))
    await act(async () => resolveRead({ name: 'PROMPT.md', relativePath: 'PROMPT.md', path: '/old', resolvedPath: '/old', content: 'Stale preview', kind: 'text', size: 0 }))
    expect(screen.queryByText('Stale preview')).not.toBeInTheDocument()
    expect(screen.getByText('Editor: builtin')).toBeVisible()
  })
})
