import { toolPackageFixture, selectedTools } from '../../../../test/toolPackageFixture'
import type { ToolLoadError, ToolPackage } from '@shared/toolPackages'
import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { customToolDefaults, type CustomToolDefinition } from '@shared/customTools'
import { defaultCapabilities, type AgentCapabilities } from '@shared/agentCapabilities'
import { CustomToolsGroup } from './CustomToolsGroup'
import { CustomToolEditor } from './CustomToolEditor'
import { CapabilityEditor } from '../CapabilityEditor'
import { notice } from '../notice'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../notice', () => ({ notice: { success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
vi.mock('../CodeFileEditor', () => ({ CodeFileEditor: ({ content, onChange }: { content: string; onChange?(value: string): void }) => onChange
  ? <textarea aria-label="Code" defaultValue={content} onChange={event => onChange(event.target.value)} />
  : <pre>{content}</pre> }))
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const definition: CustomToolDefinition = { ...customToolDefaults, id: 'stable', name: 'submit_result', description: 'Submit data.', inputSchema: { type: 'object', properties: {} } }

let serverTools: ToolPackage[] = []
const toolApi = { get: vi.fn(async () => ({ roots: [{ id: 'user', name: 'User', source: 'user', path: '/tools' }], tools: serverTools })), refresh: vi.fn(async () => ({ customTools: serverTools })) }
beforeEach(() => { serverTools = []; vi.clearAllMocks(); vi.stubGlobal('gale', { tools: toolApi }) })
function Harness() {
  const [tools, setTools] = useState<ToolPackage[]>([])
  return <CustomToolsGroup tools={tools} onConfigChange={(config) => setTools(config.customTools)} />
}

async function openGroup(button: HTMLElement): Promise<void> {
  await userEvent.click(button)
  const row = button.closest('.settings-skill-tree-root') as HTMLElement
  const toggle = within(row).queryByRole('button', { expanded: false })
  if (toggle) await userEvent.click(toggle)
}

describe('custom tool settings', () => {
  async function commandFixture(present = true, source: 'user' | 'system' = 'user') {
    const tool = { ...toolPackageFixture({ ...definition, command: 'scripts/run.py {{args}}' }), source, rootId: source }
    const file = { name: 'run.py', relativePath: 'scripts/run.py', path: `${tool.directory}/scripts/run.py`, kind: 'text' }
    const fileExists = vi.fn(async () => present)
    const createFile = vi.fn(async () => { present = true })
    const listFiles = vi.fn(async (_id: string, path?: string) => path ? [file] : [{ name: 'scripts', relativePath: 'scripts', path: `${tool.directory}/scripts`, kind: 'directory' }])
    const readFile = vi.fn(async () => ({ ...file, content: 'print(1)', size: 8, resolvedPath: file.path, revision: 'v', editable: source !== 'system' }))
    vi.stubGlobal('gale', { tools: { ...toolApi, fileExists, createFile, listFiles, readFile,
      get: vi.fn(async () => ({ roots: [{ id: source, name: source, source, path: '/tools' }], tools: [tool] })) } })
    render(<CustomToolsGroup tools={[tool]} onConfigChange={vi.fn()} />)
    const group = await screen.findByRole('button', { name: new RegExp(`^settings.skill_group_${source}`) })
    await userEvent.click(group)
    await userEvent.click(within(screen.getByRole('list')).getByRole('button'))
    return { tool, group, fileExists, createFile, listFiles, readFile }
  }
  it('locates a command script by expanding its ancestors and selecting the preview', async () => {
    const { tool, createFile, readFile } = await commandFixture()
    await userEvent.click(screen.getByRole('button', { name: 'scripts/run.py' }))
    const tree = within(document.querySelector('.settings-skill-tree') as HTMLElement)
    expect(await tree.findByRole('button', { name: 'run.py', current: true })).toBeVisible()
    expect(readFile).toHaveBeenCalledExactlyOnceWith(tool.id, 'scripts/run.py')
    expect(screen.getByRole('button', { name: 'scripts/run.py' })).toBeVisible()
    expect(createFile).not.toHaveBeenCalled()
  })
  it('creates a missing command script only after confirmation, then locates it', async () => {
    const { tool, createFile } = await commandFixture(false)
    await userEvent.click(screen.getByRole('button', { name: 'scripts/run.py' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'common.cancel' }))
    expect(createFile).not.toHaveBeenCalled()
    await userEvent.click(screen.getByRole('button', { name: 'scripts/run.py' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'custom_tools.command_file_create' }))
    expect(createFile).toHaveBeenCalledExactlyOnceWith(tool.id, 'scripts/run.py')
    expect(await screen.findByRole('button', { name: 'run.py', current: true })).toBeVisible()
  })
  it('keeps system tools read-only when a command script is missing', async () => {
    const { createFile } = await commandFixture(false, 'system')
    await userEvent.click(screen.getByRole('button', { name: 'scripts/run.py' }))
    expect(notice.error).toHaveBeenCalledWith('custom_tools.command_file_missing', { id: 'settings-tool-status' })
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(createFile).not.toHaveBeenCalled()
  })
  it('reports a failed creation without leaving the tool busy or selecting a nonexistent file', async () => {
    const { createFile } = await commandFixture(false)
    createFile.mockRejectedValueOnce(new Error('File already exists'))
    await userEvent.click(screen.getByRole('button', { name: 'scripts/run.py' }))
    await userEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'custom_tools.command_file_create' }))
    expect(notice.error).toHaveBeenLastCalledWith('custom_tools.command_file_create_failed', expect.objectContaining({ description: 'File already exists' }))
    expect(screen.getByRole('button', { name: 'scripts/run.py' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'custom_tools.edit_information' })).toBeEnabled()
  })
  it('does not mistake a filtered file or a filesystem failure for a missing script', async () => {
    const { listFiles, fileExists, createFile } = await commandFixture()
    listFiles.mockResolvedValueOnce([])
    await userEvent.click(screen.getByRole('button', { name: 'scripts/run.py' }))
    expect(notice.error).toHaveBeenLastCalledWith('custom_tools.command_file_unlisted', expect.anything())
    fileExists.mockRejectedValueOnce(new Error('Permission denied'))
    await userEvent.click(screen.getByRole('button', { name: 'scripts/run.py' }))
    expect(notice.error).toHaveBeenLastCalledWith('custom_tools.command_file_failed', expect.objectContaining({ description: 'Permission denied' }))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(createFile).not.toHaveBeenCalled()
  })
  it('ignores a command lookup completed after navigating away', async () => {
    const { group, fileExists } = await commandFixture()
    let finish!: (present: boolean) => void
    fileExists.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    await userEvent.click(screen.getByRole('button', { name: 'scripts/run.py' }))
    await userEvent.click(group)
    await act(async () => finish(false))
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
    expect(screen.getByRole('list')).toBeVisible()
  })
  it.each(['{Enter}', '{Tab}'])('saves an added directory name with %s without a Save button', async key => {
    const source = { id: 'shared', name: 'Shared', source: 'external', path: '/shared' }
    const updateDirectory = vi.fn(async (_id: string, name: string) => { source.name = name })
    vi.stubGlobal('gale', { tools: { ...toolApi, get: vi.fn(async () => ({ roots: [source], tools: [] })), updateDirectory } })
    render(<CustomToolsGroup tools={[]} onConfigChange={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: /^Shared/ }))
    expect(screen.queryByRole('button', { name: 'common.save' })).not.toBeInTheDocument()
    const name = screen.getByRole('textbox', { name: 'settings.skill_directory_display_name' })
    await userEvent.clear(name)
    await userEvent.type(name, 'Renamed')
    expect(updateDirectory).not.toHaveBeenCalled()
    await userEvent.keyboard(key)
    await waitFor(() => expect(updateDirectory).toHaveBeenCalledExactlyOnceWith('shared', 'Renamed'))
    await waitFor(() => expect(name).toBeEnabled())
    await userEvent.click(name)
    await userEvent.tab()
    expect(updateDirectory).toHaveBeenCalledTimes(1)
    await userEvent.clear(name)
    await userEvent.keyboard(key)
    expect(updateDirectory).toHaveBeenCalledTimes(1)
  })
  it.each(['manifest_not_found', 'permission_denied'] as const)('localizes %s while retaining the tool path', async code => {
    const path = '/tools/协作转出讲义优化/TOOL.json'
    const tool = { ...toolPackageFixture(definition), definition: undefined,
      error: { code, path, detail: `ENOENT: no such file or directory, open '${path}'` } }
    serverTools = [tool]
    render(<CustomToolsGroup tools={serverTools} onConfigChange={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: /^settings.skill_group_user/ }))
    await userEvent.click(within(screen.getByRole('list')).getByRole('button'))
    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent(`custom_tools.load_error_${code}`)
    expect(alert).toHaveTextContent(path)
    expect(alert).not.toHaveTextContent('ENOENT')
  })

  it('localizes source and import load errors through the same issue codes', async () => {
    const path = '/missing/tools'
    const issue: ToolLoadError = { code: 'path_not_found', path, detail: 'ENOENT: raw system error' }
    const get = vi.fn(async () => ({ roots: [{ id: 'user', name: 'User', source: 'user', path, error: issue }], tools: [] }))
    const importDirectories = vi.fn(async () => ({ status: 'error', error: { code: 'invalid_tool', issue } }))
    vi.stubGlobal('gale', { tools: { ...toolApi, get, importDirectories } })
    render(<CustomToolsGroup tools={[]} onConfigChange={vi.fn()} />)
    await userEvent.click(await screen.findByRole('button', { name: /^settings.skill_group_user/ }))
    expect(screen.getByRole('alert')).toHaveTextContent('custom_tools.load_error_path_not_found')
    expect(screen.getByRole('alert')).not.toHaveTextContent('ENOENT')
    await userEvent.click(screen.getByRole('button', { name: 'custom_tools.import' }))
    expect(notice.error).toHaveBeenCalledWith(`custom_tools.import_error_invalid_tool\ncustom_tools.load_error_path_not_found\n${path}`, { id: 'settings-tool-status' })
  })
  it.each(['all', 'system', 'user', 'external'] as const)('selects %s without toggling and keeps the detail when toggling its disclosure', async group => {
    const source = group === 'all' ? 'user' : group
    const tool = { ...toolPackageFixture(definition), source, rootId: source }
    vi.stubGlobal('gale', { tools: { ...toolApi, get: vi.fn(async () => ({ roots: [{ id: source, source, name: 'Shared', path: '/tools' }], tools: [tool] })) } })
    render(<CustomToolsGroup tools={[tool]} onConfigChange={vi.fn()} />)
    const tree = within(document.querySelector('.settings-skill-tree') as HTMLElement)
    const detail = within(document.querySelector('.settings-skill-viewer') as HTMLElement)
    const name = group === 'all' ? /^custom_tools.all/ : group === 'external' ? /^Shared/ : new RegExp(`^settings.skill_group_${group}`)
    const select = await tree.findByRole('button', { name })
    const row = select.closest('.settings-skill-tree-root') as HTMLElement
    const toggle = within(row).getByRole('button', { expanded: false })
    await userEvent.click(select)
    await userEvent.click(select)
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(select).toHaveAttribute('aria-pressed', 'true')
    expect(detail.getByRole('list')).toHaveTextContent('submit_result')
    if (group === 'all') expect(detail.queryByText('settings.tools_count')).not.toBeInTheDocument()
    expect(tree.queryByRole('button', { name: /^submit_result/ })).not.toBeInTheDocument()
    await userEvent.click(toggle)
    await userEvent.click(select)
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await userEvent.click(tree.getByRole('button', { name: /^submit_result/ }))
    expect(detail.queryByRole('list')).not.toBeInTheDocument()
    expect(detail.getByRole('button', { name: 'submit_result' })).toBeVisible()
    toggle.focus()
    await userEvent.keyboard('{Enter}')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(tree.queryByRole('button', { name: /^submit_result/ })).not.toBeInTheDocument()
    expect(detail.getByRole('button', { name: 'submit_result' })).toBeVisible()
    expect(select).toHaveAttribute('aria-pressed', 'false')
    await userEvent.keyboard(' ')
    expect(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(tree.getByRole('button', { name: /^submit_result/, pressed: true })).toBeVisible()
  })
  it('clears a failed file preview on navigation and allows retrying the same file', async () => {
    const tool = toolPackageFixture(definition)
    const file = { name: 'large.txt', path: '/tools/large.txt', relativePath: 'large.txt', kind: 'text' }
    const readFile = vi.fn().mockRejectedValueOnce(new Error('Package file exceeds 1048576 bytes.'))
      .mockResolvedValue({ ...file, resolvedPath: file.path, size: 4, content: 'Recovered preview' })
    vi.stubGlobal('gale', { tools: { ...toolApi, get: vi.fn(async () => ({ roots: [{ id: 'user', name: 'User', source: 'user', path: '/tools' }], tools: [tool] })),
      listFiles: vi.fn(async () => [file]), readFile } })
    render(<CustomToolsGroup tools={[tool]} onConfigChange={vi.fn()} />)
    await openGroup(await screen.findByRole('button', { name: /^settings.skill_group_user/ }))
    await userEvent.click(screen.getByRole('button', { name: 'custom_tools.expand' }))
    await userEvent.click(await screen.findByRole('button', { name: 'large.txt' }))
    await waitFor(() => expect(notice.error).toHaveBeenLastCalledWith('Package file exceeds 1048576 bytes.', { id: 'settings-tool-status' }))
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    vi.mocked(notice.dismiss).mockClear()
    await userEvent.click(screen.getByRole('button', { name: 'submit_result' }))
    expect(notice.dismiss).toHaveBeenCalledWith('settings-tool-status')
    readFile.mockRejectedValueOnce(new Error('File is still too large'))
    await userEvent.click(within(document.querySelector('.settings-skill-tree') as HTMLElement).getByRole('button', { name: 'large.txt' }))
    await waitFor(() => expect(notice.error).toHaveBeenLastCalledWith('File is still too large', { id: 'settings-tool-status' }))
    vi.mocked(notice.dismiss).mockClear()
    await userEvent.click(within(document.querySelector('.settings-skill-tree') as HTMLElement).getByRole('button', { name: 'large.txt' }))
    expect(await screen.findByText('Recovered preview')).toBeVisible()
    expect(notice.dismiss).toHaveBeenCalledWith('settings-tool-status')
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('loads a file when selecting it from an expanded tree while the built-in catalog is open', async () => {
    const tool = toolPackageFixture(definition)
    const file = { name: 'README.md', path: '/tools/README.md', relativePath: 'README.md', kind: 'text' }
    let resolveRead!: (value: unknown) => void
    vi.stubGlobal('gale', { tools: { ...toolApi, get: vi.fn(async () => ({ roots: [{ id: 'user', name: 'User', source: 'user', path: '/tools' }], tools: [tool] })),
      listFiles: vi.fn(async () => [file]), readFile: vi.fn(() => new Promise(resolve => { resolveRead = resolve })) } })
    const tools = [tool]
    function CatalogHarness() {
      const [catalog, setCatalog] = useState(true)
      return <CustomToolsGroup tools={tools} onConfigChange={vi.fn()} catalogView={catalog ? <div>Built-in tools</div> : undefined}
        onSelectCustom={() => setCatalog(false)} catalogNavigation={<button onClick={() => setCatalog(true)}>Catalog</button>} />
    }
    render(<CatalogHarness />)
    await openGroup(await screen.findByRole('button', { name: /^settings.skill_group_user/ }))
    await userEvent.click(screen.getByRole('button', { name: 'custom_tools.expand' }))
    await userEvent.click(screen.getByRole('button', { name: 'Catalog' }))
    await userEvent.click(screen.getByRole('button', { name: 'README.md' }))
    await act(async () => { resolveRead({ ...file, size: 7, content: 'Current preview', resolvedPath: file.path }) })
    expect(await screen.findByText('Current preview')).toBeVisible()
  })

  it.each(['selection', 'catalog', 'refresh'])('ignores a late directory failure after %s changes', async destination => {
    const tool = toolPackageFixture(definition)
    let reject!: (error: Error) => void
    const listFiles = vi.fn(() => new Promise((_resolve, rejectRequest) => { reject = rejectRequest }))
    vi.stubGlobal('gale', { tools: { ...toolApi, get: vi.fn(async () => ({ roots: [{ id: 'user', name: 'User', source: 'user', path: '/tools' }], tools: [tool] })), listFiles } })
    const props = { tools: [tool], onConfigChange: vi.fn() }
    const view = render(<CustomToolsGroup {...props} />)
    await openGroup(await screen.findByRole('button', { name: /^settings.skill_group_user/ }))
    await userEvent.click(screen.getByRole('button', { name: 'custom_tools.expand' }))
    if (destination === 'selection') await userEvent.click(screen.getByRole('button', { name: /^custom_tools.all/ }))
    else if (destination === 'catalog') view.rerender(<CustomToolsGroup {...props} catalogView={<div>Built-in tools</div>} />)
    else await userEvent.click(screen.getByRole('button', { name: 'common.refresh' }))
    await act(async () => { reject(new Error('Late directory failure')) })
    expect(notice.error).not.toHaveBeenCalled()
  })

  it('clears an existing directory error when retrying or switching to the built-in catalog', async () => {
    const tool = toolPackageFixture(definition)
    const listFiles = vi.fn().mockRejectedValue(new Error('Directory unavailable'))
    vi.stubGlobal('gale', { tools: { ...toolApi, get: vi.fn(async () => ({ roots: [{ id: 'user', name: 'User', source: 'user', path: '/tools' }], tools: [tool] })), listFiles } })
    const props = { tools: [tool], onConfigChange: vi.fn() }
    const view = render(<CustomToolsGroup {...props} />)
    await openGroup(await screen.findByRole('button', { name: /^settings.skill_group_user/ }))
    await userEvent.click(screen.getByRole('button', { name: 'custom_tools.expand' }))
    await waitFor(() => expect(notice.error).toHaveBeenLastCalledWith('Directory unavailable', { id: 'settings-tool-status' }))
    vi.mocked(notice.dismiss).mockClear()
    view.rerender(<CustomToolsGroup {...props} catalogView={<div>Built-in tools</div>} />)
    expect(notice.dismiss).toHaveBeenCalledWith('settings-tool-status')
    view.rerender(<CustomToolsGroup {...props} />)
    await userEvent.click(screen.getByRole('button', { name: 'custom_tools.expand' }))
    await waitFor(() => expect(notice.error).toHaveBeenLastCalledWith('Directory unavailable', { id: 'settings-tool-status' }))
    vi.mocked(notice.dismiss).mockClear()
    listFiles.mockResolvedValueOnce([])
    await userEvent.click(screen.getByRole('button', { name: 'custom_tools.expand' }))
    expect(notice.dismiss).toHaveBeenCalledWith('settings-tool-status')
  })

  it('moves only selected external groups from the sidebar and disables moves in catalog views', async () => {
    const roots = [
      { id: 'user', name: 'User', source: 'user', path: '/user' },
      { id: 'first', name: 'First', source: 'external', path: '/first' },
      { id: 'last', name: 'Last', source: 'external', path: '/last' }
    ]
    const moveDirectory = vi.fn(async () => {})
    vi.stubGlobal('gale', { tools: { ...toolApi, get: vi.fn(async () => ({ roots, tools: [] })), moveDirectory } })
    const props = { tools: [], onConfigChange: vi.fn() }
    const view = render(<CustomToolsGroup {...props} />)
    const sidebar = within(view.container.querySelector('.ui-list-pane') as HTMLElement)
    const up = sidebar.getByRole('button', { name: 'common.move_up' })
    const down = sidebar.getByRole('button', { name: 'common.move_down' })
    expect(up).toBeDisabled(); expect(down).toBeDisabled()
    await userEvent.click(await sidebar.findByRole('button', { name: /^First/ }))
    expect(up).toBeDisabled(); expect(down).toBeEnabled()
    await userEvent.click(down)
    expect(moveDirectory).toHaveBeenCalledWith('first', 1)
    await userEvent.click(sidebar.getByRole('button', { name: /^Last/ }))
    expect(up).toBeEnabled(); expect(down).toBeDisabled()
    expect(within(view.container.querySelector('.settings-skill-viewer') as HTMLElement).queryByRole('button', { name: 'common.move_up' })).not.toBeInTheDocument()
    view.rerender(<CustomToolsGroup {...props} catalogView={<div>Built-in tools</div>} />)
    expect(up).toBeDisabled(); expect(down).toBeDisabled()
  })

  it('lists each group and navigates to the exact tool even when names match', async () => {
    const user = userEvent.setup()
    const roots = [
      { id: 'system', name: 'System', source: 'system', path: '/system' },
      { id: 'user', name: 'User', source: 'user', path: '/user' },
      { id: 'shared', name: 'Shared', source: 'external', path: '/shared' }
    ]
    const items: ToolPackage[] = [
      { ...toolPackageFixture({ ...definition, id: 'system-tool' }), rootId: 'system', source: 'system', directory: '/system/example' },
      { ...toolPackageFixture({ ...definition, id: 'user-tool' }), directory: '/user/example' },
      { ...toolPackageFixture({ ...definition, id: 'broken-tool', name: 'broken' }), rootId: 'shared', source: 'external', directory: '/shared/broken', definition: undefined, error: { code: 'invalid_definition', path: '/shared/broken/TOOL.json', detail: 'Invalid manifest' } }
    ]
    vi.stubGlobal('gale', { tools: { ...toolApi, get: vi.fn(async () => ({ roots, tools: items })) } })
    const view = render(<CustomToolsGroup tools={items} onConfigChange={vi.fn()} />)
    const tree = within(view.container.querySelector('.settings-skill-tree') as HTMLElement)
    const detail = within(view.container.querySelector('.settings-skill-viewer') as HTMLElement)
    for (const [label, index] of [['settings.skill_group_system', 0], ['settings.skill_group_user', 1], ['Shared', 2]] as const) {
      await openGroup(await tree.findByRole('button', { name: new RegExp(`^${label}`) }))
      const list = detail.getByRole('list', { name: 'custom_tools.title' })
      expect(within(list).getAllByRole('listitem')).toHaveLength(1)
      expect(list).toHaveTextContent(items[index].name)
      if (index === 2) {
        expect(list).toHaveTextContent('capabilities.inactive')
        expect(detail.getByRole('button', { name: 'custom_tools.remove_directory' })).toBeEnabled()
      }
    }
    await openGroup(tree.getByRole('button', { name: /^custom_tools.all/ }))
    const list = detail.getByRole('list', { name: 'custom_tools.title' })
    const rows = within(list).getAllByRole('listitem')
    expect(rows).toHaveLength(3)
    expect(rows[0]).toHaveTextContent('settings.skill_group_system · /system/example')
    expect(rows[1]).toHaveTextContent('settings.skill_group_user · /user/example')
    within(rows[1]).getByRole('button').focus()
    await user.keyboard('{Enter}')
    expect(detail.queryByRole('list')).not.toBeInTheDocument()
    expect(detail.getByText('/user/example')).toBeVisible()
    expect(detail.getByRole('button', { name: 'custom_tools.edit_information' })).toBeEnabled()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(tree.getAllByRole('button', { pressed: true }).some(button => button.textContent?.includes('submit_result'))).toBe(true)
    await openGroup(tree.getByRole('button', { name: /^Shared/ }))
    await user.click(within(detail.getByRole('list')).getByRole('button'))
    expect(detail.getByRole('alert')).toHaveTextContent('Invalid manifest')
    expect(detail.getByRole('button', { name: 'custom_tools.edit_information' })).toBeDisabled()
  })

  it('shows an empty group and refreshes its list after tools are added', async () => {
    const view = render(<CustomToolsGroup tools={serverTools} onConfigChange={vi.fn()} />)
    const tree = within(view.container.querySelector('.settings-skill-tree') as HTMLElement)
    const detail = within(view.container.querySelector('.settings-skill-viewer') as HTMLElement)
    await openGroup(await tree.findByRole('button', { name: /^settings.skill_group_user/ }))
    expect(detail.getByText('custom_tools.group_empty')).toBeVisible()
    expect(screen.getByRole('button', { name: 'custom_tools.add' })).toBeEnabled()
    serverTools = [toolPackageFixture(definition)]
    view.rerender(<CustomToolsGroup tools={serverTools} onConfigChange={vi.fn()} />)
    expect(await detail.findByRole('list')).toHaveTextContent('submit_result')
    expect(detail.queryByText('custom_tools.group_empty')).not.toBeInTheDocument()
  })

  it.each(['user', 'system', 'external'] as const)('shows creation and import in writable group headers only (%s)', async source => {
    const user = userEvent.setup()
    const tool = { ...toolPackageFixture(definition), source, rootId: source }
    const root = { id: source, source, name: 'Shared', path: '/tools' }
    const file = { name: 'asset.bin', path: '/tools/asset.bin', relativePath: 'asset.bin', kind: 'binary' }
    vi.stubGlobal('gale', { tools: { ...toolApi,
      get: vi.fn(async () => ({ roots: [root], tools: [tool] })),
      listFiles: vi.fn(async () => [file]), readFile: vi.fn(async () => ({ ...file, size: 1 }))
    } })
    const props = { tools: [tool], onConfigChange: vi.fn() }
    const view = render(<CustomToolsGroup {...props} />)
    function expectActions(visible: boolean) {
      for (const name of ['custom_tools.add', 'custom_tools.import']) {
        const button = screen.queryByRole('button', { name })
        if (visible) expect(button).toBeVisible()
        else expect(button).not.toBeInTheDocument()
      }
    }
    expectActions(false)
    const label = source === 'external' ? 'Shared' : `settings.skill_group_${source}`
    await openGroup(await screen.findByRole('button', { name: new RegExp(`^${label}`) }))
    expectActions(source !== 'system')
    if (source !== 'system') {
      const header = within(view.container.querySelector('.settings-skill-viewer-heading') as HTMLElement)
      expect(header.getByRole('button', { name: 'custom_tools.add' })).toBeVisible()
      expect(header.getByRole('button', { name: 'custom_tools.import' })).toBeVisible()
      expect(within(view.container.querySelector('.settings-skill-tree') as HTMLElement).queryByRole('button', { name: 'custom_tools.add' })).not.toBeInTheDocument()
    }
    await user.click(screen.getByRole('button', { name: 'submit_result' }))
    expectActions(false)
    await user.click(screen.getByRole('button', { name: 'custom_tools.expand' }))
    await user.click(await screen.findByRole('button', { name: 'asset.bin' }))
    await screen.findByText('settings.skill_binary_preview_unavailable')
    expectActions(false)
    view.rerender(<CustomToolsGroup {...props} catalogView={<div>Catalog</div>} />)
    expectActions(false)
    view.rerender(<CustomToolsGroup {...props} />)
    await openGroup(screen.getByRole('button', { name: /^custom_tools.all/ }))
    expectActions(false)
  })
  it('opens source and tool directories from their titles and the tool location using the keyboard', async () => {
    const user = userEvent.setup()
    const showItemInFolder = vi.fn(async () => '')
    vi.stubGlobal('gale', { tools: toolApi, files: { showItemInFolder } })
    serverTools = [toolPackageFixture(definition)]
    const view = render(<Harness />)
    await openGroup(await screen.findByRole('button', { name: /^settings.skill_group_user/ }))
    const detail = within(view.container.querySelector('.settings-skill-viewer') as HTMLElement)
    const rootTitle = detail.getByRole('button', { name: 'settings.skill_group_user' })
    rootTitle.focus()
    await user.keyboard('{Enter}')
    expect(showItemInFolder).toHaveBeenLastCalledWith('/tools')
    await user.click(screen.getByRole('button', { name: 'submit_result' }))
    detail.getByRole('button', { name: 'submit_result' }).focus()
    await user.keyboard(' ')
    expect(showItemInFolder).toHaveBeenLastCalledWith(serverTools[0].directory)
    expect(showItemInFolder).toHaveBeenCalledTimes(2)
    expect(detail.getByText('custom_tools.path')).toBeVisible()
    detail.getByRole('button', { name: serverTools[0].directory }).focus()
    await user.keyboard('{Enter}')
    expect(showItemInFolder).toHaveBeenLastCalledWith(serverTools[0].directory)
    expect(showItemInFolder).toHaveBeenCalledTimes(3)
    expect(screen.queryByRole('button', { name: 'common.open' })).not.toBeInTheDocument()
  })
  it.each(['user', 'external'] as const)('imports into the selected %s group and selects the imported tool', async source => {
    const imported = { ...toolPackageFixture(definition), source, rootId: source }
    const get = vi.fn(async () => ({ roots: [{ id: source, name: 'Shared', source, path: '/tools' }], tools: serverTools }))
    const importDirectories = vi.fn(async () => { serverTools = [imported]; return { status: 'imported', ids: [imported.id], names: [imported.name], config: { customTools: [imported] } } })
    vi.stubGlobal('gale', { tools: { ...toolApi, get, importDirectories } })
    render(<Harness />)
    expect(screen.queryByRole('button', { name: 'custom_tools.import' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: source === 'user' ? /^settings.skill_group_user/ : /^Shared/ }))
    fireEvent.click(screen.getByRole('button', { name: 'custom_tools.import' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'submit_result', pressed: true })).toBeVisible())
    expect(importDirectories).toHaveBeenCalledExactlyOnceWith(source)
    expect(notice.success).toHaveBeenCalledWith('custom_tools.imported')
    expect(screen.getByRole('button', { name: 'custom_tools.edit_information' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'custom_tools.import' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^custom_tools.all/ }))
    expect(screen.queryByRole('button', { name: 'custom_tools.import' })).not.toBeInTheDocument()
  })
  it.each(['cancelled', 'error'])('preserves the current list when import is %s', async status => {
    const change = vi.fn()
    const importDirectories = vi.fn(async () => ({ status, error: { code: 'already_exists', name: 'submit_result' } }))
    vi.stubGlobal('gale', { tools: { ...toolApi, importDirectories } })
    serverTools = [toolPackageFixture(definition)]
    render(<CustomToolsGroup tools={serverTools} onConfigChange={change} />)
    fireEvent.click(await screen.findByRole('button', { name: /^settings.skill_group_user/ }))
    fireEvent.click(screen.getByRole('button', { name: 'custom_tools.import' }))
    await waitFor(() => expect(screen.getByRole('button', { name: 'custom_tools.import' })).toBeEnabled())
    expect(change).not.toHaveBeenCalled()
    expect(screen.getByRole('list', { name: 'custom_tools.title' })).toHaveTextContent('submit_result')
    if (status === 'error') expect(notice.error).toHaveBeenCalledWith('custom_tools.import_error_already_exists', { id: 'settings-tool-status' })
    else expect(notice.error).not.toHaveBeenCalled()
  })
  it.each([false, true])('selects individual tools and toggles the whole group (subagent %s)', subagent => {
    function Capabilities() {
      const [value, setValue] = useState(structuredClone(defaultCapabilities))
      return <CapabilityEditor subagent={subagent} value={value} onChange={setValue}
        customTools={[toolPackageFixture(definition), toolPackageFixture({ ...definition, id: 'other', name: 'other_tool' })]} />
    }
    render(<Capabilities />)
    const group = screen.getByRole('checkbox', { name: 'custom_tools.title' })
    expect(group).not.toBeChecked()
    fireEvent.click(screen.getByText('custom_tools.title', { selector: 'summary' }))
    const first = screen.getByRole('checkbox', { name: 'User submit_result' })
    const second = screen.getByRole('checkbox', { name: 'User other_tool' })
    expect(first).not.toBeChecked()
    expect(second).not.toBeChecked()
    fireEvent.click(first)
    expect(group).toBePartiallyChecked()
    fireEvent.click(group)
    expect(first).toBeChecked()
    expect(second).toBeChecked()
    if (subagent) expect(screen.getByRole('checkbox', { name: 'custom_tools.project_tools' })).toBeChecked()
    fireEvent.click(group)
    expect(first).not.toBeChecked()
    expect(second).not.toBeChecked()
    if (subagent) expect(screen.getByRole('checkbox', { name: 'custom_tools.project_tools' })).not.toBeChecked()
  })
  it.each([false, true])('collapses sources independently and keeps selection counts current (subagent %s)', async subagent => {
    const user = userEvent.setup()
    const tools: ToolPackage[] = [
      { ...toolPackageFixture({ ...definition, id: 'external' }), source: 'external', rootId: 'external', rootName: 'Shared' },
      { ...toolPackageFixture({ ...definition, id: 'project' }), source: 'project', rootId: 'project', rootName: 'Project' },
      toolPackageFixture(definition),
      { ...toolPackageFixture({ ...definition, id: 'system' }), source: 'system', rootId: 'system', rootName: 'System' }
    ]
    function Capabilities() {
      const [value, setValue] = useState<AgentCapabilities>({ ...structuredClone(defaultCapabilities), customTools: selectedTools(['missing']) })
      return <CapabilityEditor subagent={subagent} value={value} onChange={setValue} customTools={tools} />
    }
    render(<Capabilities />)
    await user.click(screen.getByText('custom_tools.title', { selector: 'summary' }))
    const system = screen.getByText('settings.skill_group_system', { selector: 'summary' })
    const userSource = screen.getByText('settings.skill_group_user', { selector: 'summary' })
    const shared = screen.getByText('Shared', { selector: 'summary' })
    const missing = screen.getByText('capabilities.other_tools', { selector: 'summary' })
    expect(system).toHaveTextContent('0/1')
    expect(missing).toHaveTextContent('1/1')
    expect(Boolean(system.compareDocumentPosition(userSource) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    expect(Boolean(userSource.compareDocumentPosition(shared) & Node.DOCUMENT_POSITION_FOLLOWING)).toBe(true)
    if (subagent) {
      expect(screen.queryByText('Project', { selector: 'summary' })).not.toBeInTheDocument()
      expect(screen.getByRole('checkbox', { name: 'custom_tools.project_tools' })).not.toBeChecked()
    } else {
      expect(screen.getByText('Project', { selector: 'summary' })).toHaveTextContent('0/1')
    }
    await user.click(userSource)
    expect(screen.getByLabelText('User submit_result')).not.toBeVisible()
    await user.click(screen.getByRole('checkbox', { name: 'System submit_result' }))
    expect(system).toHaveTextContent('1/1')
    expect(userSource).toHaveTextContent('0/1')
    expect(screen.getByLabelText('User submit_result')).not.toBeVisible()
    await user.click(screen.getByRole('checkbox', { name: 'custom_tools.title' }))
    expect(userSource).toHaveTextContent('1/1')
    expect(shared).toHaveTextContent('1/1')
    expect(screen.getByLabelText('User submit_result')).not.toBeVisible()
    await user.click(userSource)
    expect(screen.getByRole('checkbox', { name: 'User submit_result' })).toBeChecked()
    await user.click(screen.getByRole('checkbox', { name: 'missing' }))
    expect(screen.queryByText('capabilities.other_tools', { selector: 'summary' })).not.toBeInTheDocument()
  })
  it.each([['', 0], ['0', 0], ['7200', 7200]] as const)('saves the timeout draft %s as %s seconds', async (value, timeoutSeconds) => {
    const onSave = vi.fn(async () => {})
    const onClose = vi.fn()
    render(<CustomToolEditor tool={{ ...definition, timeoutSeconds: 120 }} onSave={onSave} onClose={onClose} />)
    const field = screen.getByRole('spinbutton', { name: 'custom_tools.timeout' })
    expect(field).toHaveValue('120')
    fireEvent.change(field, { target: { value } })
    if (timeoutSeconds === 0) expect(field).toHaveValue('')
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(onClose).toHaveBeenCalled())
    expect(onSave).toHaveBeenCalledWith(expect.objectContaining({ timeoutSeconds }))
  })
  it('explains the missing background dependency without losing the saved selection', () => {
    const props = { value: { ...defaultCapabilities, backgroundTools: false, customTools: selectedTools(['stable']) },
      customTools: [toolPackageFixture({ ...definition, interactive: true })], onChange: vi.fn() }
    const view = render(<CapabilityEditor {...props} />)
    fireEvent.click(screen.getByText('custom_tools.title', { selector: 'summary' }))
    expect(screen.getByRole('checkbox', { name: 'User submit_result' })).toBeChecked()
    expect(screen.getByText('custom_tools.requires_background')).toBeVisible()
    view.rerender(<CapabilityEditor {...props} value={{ ...props.value, backgroundTools: true }} />)
    expect(screen.queryByText('custom_tools.requires_background')).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'User submit_result' })).toBeChecked()
  })
  it('does not mark a usable tool shadowed by an interactive tool whose dependency is disabled', () => {
    const projectTool: ToolPackage = { ...toolPackageFixture({ ...definition, id: 'project-tool', interactive: true }),
      source: 'project', rootId: 'project', rootName: 'Project' }
    const props = { value: { ...defaultCapabilities, backgroundTools: false, customTools: selectedTools(['project-tool', 'stable']) },
      customTools: [projectTool, toolPackageFixture(definition)], onChange: vi.fn() }
    const view = render(<CapabilityEditor {...props} />)
    fireEvent.click(screen.getByText('custom_tools.title', { selector: 'summary' }))
    expect(screen.queryByText('custom_tools.shadowed')).toBeNull()
    expect(screen.getByRole('checkbox', { name: 'User submit_result' })).toBeChecked()
    view.rerender(<CapabilityEditor {...props} value={{ ...props.value, backgroundTools: true }} />)
    expect(screen.getByText('custom_tools.shadowed')).toBeVisible()
  })
  it('selects on click and edits only through the edit button or a double click', async () => {
    const user = userEvent.setup()
    const other = toolPackageFixture({ ...definition, id: 'other', name: 'other_tool' })
    serverTools = [toolPackageFixture(definition), other]
    const view = render(<CustomToolsGroup tools={serverTools} onConfigChange={vi.fn()} />)
    expect(screen.queryByRole('button', { name: 'custom_tools.edit_information' })).toBeNull()
    await openGroup(await screen.findByRole('button', { name: /^settings.skill_group_user/ }))

    await user.click(screen.getByRole('button', { name: 'submit_result' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('button', { name: 'submit_result', pressed: true })).toBeVisible()
    const edit = screen.getByRole('button', { name: 'custom_tools.edit_information' })
    expect(edit).toBeEnabled()
    expect(screen.getByRole('button', { name: 'custom_tools.delete' })).toBeEnabled()
    expect(within(view.container.querySelector('.settings-skill-viewer') as HTMLElement).getByRole('button', { name: 'common.move_down' })).toBeEnabled()
    expect(within(view.container.querySelector('.settings-skill-viewer') as HTMLElement).getByRole('button', { name: 'common.move_up' })).toBeDisabled()
    await user.click(edit)
    expect(screen.getByLabelText('custom_tools.name')).toHaveValue('submit_result')
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))

    await user.click(screen.getByRole('button', { name: 'custom_tools.edit_parameters' }))
    expect(within(screen.getByRole('radiogroup', { name: 'custom_tools.editor_section' })).getByRole('radio', { name: 'custom_tools.parameter_form' })).toBeChecked()
    expect(screen.queryByRole('textbox', { name: 'custom_tools.name' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))

    await user.dblClick(screen.getByRole('button', { name: 'other_tool' }))
    expect(screen.getByLabelText('custom_tools.name')).toHaveValue('other_tool')
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))
    expect(screen.getByRole('button', { name: 'submit_result', pressed: false })).toBeVisible()
    expect(screen.getByRole('button', { name: 'other_tool', pressed: true })).toBeVisible()

    serverTools = [toolPackageFixture(definition)]
    view.rerender(<CustomToolsGroup tools={serverTools} onConfigChange={vi.fn()} />)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'custom_tools.edit_information' })).toBeNull())
  })
  it('keeps unsaved input when the backdrop is clicked and still allows explicit cancellation', async () => {
    const user = userEvent.setup()
    const save = vi.fn()
    vi.stubGlobal('gale', { tools: toolApi, config: { saveCustomTool: save } })
    render(<Harness />)
    await openGroup(await screen.findByRole('button', { name: /^settings.skill_group_user/ }))
    await user.click(screen.getByRole('button', { name: 'custom_tools.add' }))
    await user.type(screen.getByLabelText('custom_tools.name'), 'draft_tool')
    const command = 'python "tools/submit.py"\n --data {{args}}'
    fireEvent.change(screen.getByLabelText('custom_tools.command'), { target: { value: command } })
    await user.click(document.querySelector('.ui-backdrop') as HTMLElement)
    expect(screen.getByRole('dialog')).toBeVisible()
    expect(screen.getByLabelText('custom_tools.name')).toHaveValue('draft_tool')
    expect(screen.getByLabelText('custom_tools.command')).toHaveValue(command)
    expect(save).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'common.cancel' }))
    await user.click(screen.getByRole('button', { name: 'common.confirm' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
  })
  it.each(['user', 'external'] as const)('creates in %s with the current draft and keeps validation failures editable', async source => {
    const save = vi.fn().mockRejectedValueOnce(new Error('Schema required must be an array.')).mockImplementation(async (tool) => { serverTools = [
      { ...toolPackageFixture({ ...definition, id: 'discovered-id', name: 'another_tool' }), source, rootId: source },
      { ...toolPackageFixture({ ...tool, id: 'new-id' }), source, rootId: source }
    ]; return { customTools: serverTools } })
    vi.stubGlobal('gale', { tools: { ...toolApi, get: vi.fn(async () => ({ roots: [{ id: source, name: 'Shared', source, path: '/tools' }], tools: serverTools })) }, config: { saveCustomTool: save } })
    render(<Harness />)
    fireEvent.click(await screen.findByRole('button', { name: source === 'user' ? /^settings.skill_group_user/ : /^Shared/ }))
    fireEvent.click(screen.getByRole('button', { name: 'custom_tools.add' }))
    expect(screen.getByRole('checkbox', { name: 'custom_tools.interactive' })).not.toBeChecked()
    fireEvent.click(screen.getByRole('checkbox', { name: 'custom_tools.interactive' }))
    fireEvent.change(screen.getByLabelText('custom_tools.name'), { target: { value: 'submit_result' } })
    fireEvent.change(screen.getByLabelText('custom_tools.description'), { target: { value: '提交结果' } })
    fireEvent.click(within(screen.getByRole('radiogroup', { name: 'custom_tools.editor_section' })).getByRole('radio', { name: 'custom_tools.parameter_form' }))
    fireEvent.click(screen.getByRole('radio', { name: 'settings.file_source' }))
    fireEvent.change(screen.getByLabelText('custom_tools.schema'), { target: { value: '{"type":"object","required":"bad"}' } })
    const command = 'python "script with spaces.py"\n  --mode validate --data {{args}} --verbose'
    fireEvent.change(screen.getByLabelText('custom_tools.command'), { target: { value: command } })
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(screen.getAllByRole('alert').some(alert => alert.textContent?.includes('Schema required'))).toBe(true))
    expect(screen.getByLabelText('custom_tools.name')).toHaveValue('submit_result')
    fireEvent.change(screen.getByLabelText('custom_tools.schema'), { target: { value: '{"type":"object","properties":{}}' } })
    fireEvent.click(screen.getByRole('button', { name: 'common.save' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(save.mock.lastCall?.[0]).toMatchObject({ rootId: source, name: 'submit_result', description: '提交结果', command, interactive: true, inputSchema: { type: 'object', properties: {} } })
    expect(screen.getByRole('button', { name: 'submit_result', pressed: true })).toBeVisible()
  })
  it.each([false, true])('preserves explicit capability selection through rename and deletion (subagent %s)', async (subagent) => {
    const onChange = vi.fn()
    const props = { subagent, value: { ...defaultCapabilities, customTools: selectedTools(['stable']) }, onChange }
    const { rerender } = render(<CapabilityEditor {...props} customTools={[toolPackageFixture(definition)]} />)
    fireEvent.click(screen.getByText('custom_tools.title', { selector: 'summary' }))
    expect(screen.getByRole('checkbox', { name: 'User submit_result' })).toBeChecked()
    rerender(<CapabilityEditor {...props} customTools={[toolPackageFixture({ ...definition, name: 'renamed' }), toolPackageFixture({ ...definition, id: 'new', name: 'new_tool' })]} />)
    expect(screen.getByRole('checkbox', { name: 'User renamed' })).toBeChecked()
    expect(screen.getByRole('checkbox', { name: 'User new_tool' })).not.toBeChecked()
    rerender(<CapabilityEditor {...props} customTools={[]} />)
    fireEvent.click(screen.getByRole('checkbox', { name: /stable/ }))
    expect(onChange.mock.lastCall?.[0].customTools).toEqual(selectedTools())
  })
})

it('browses external packages and removes only their source reference', async () => {
  const user = userEvent.setup()
  const externalTool = { ...toolPackageFixture(definition), rootId: 'external-test', rootName: 'Shared', source: 'external' as const }
  const root = { id: 'external-test', name: 'Shared', source: 'external', path: '/shared' }
  const listFiles = vi.fn(async () => [{ name: 'TOOL.json', path: '/shared/tool/TOOL.json', relativePath: 'TOOL.json', kind: 'text' }])
  const readFile = vi.fn(async () => ({ name: 'TOOL.json', path: '/shared/tool/TOOL.json', relativePath: 'TOOL.json', resolvedPath: '/shared/tool/TOOL.json', size: 4, kind: 'text', content: 'manifest preview' }))
  const removeDirectory = vi.fn(async () => {})
  const api = { ...toolApi, get: vi.fn(async () => ({ roots: [root], tools: [externalTool] })), listFiles, readFile, removeDirectory }
  vi.stubGlobal('gale', { tools: api })
  render(<CustomToolsGroup tools={[externalTool]} onConfigChange={vi.fn()} />)
  await openGroup(await screen.findByRole('button', { name: /^Shared/ }))
  await user.click(screen.getByRole('button', { name: 'submit_result' }))
  expect(screen.queryByRole('button', { name: 'custom_tools.import' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'custom_tools.edit_information' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: 'custom_tools.edit_information' }))
  expect(screen.getByLabelText('custom_tools.name')).toHaveValue('submit_result')
  await user.click(screen.getByRole('button', { name: 'common.cancel' }))
  expect(screen.getByRole('button', { name: 'custom_tools.delete' })).toBeEnabled()
  await user.click(screen.getByRole('button', { name: 'custom_tools.expand' }))
  await user.click(await screen.findByRole('button', { name: 'TOOL.json' }))
  expect(await screen.findByText('manifest preview')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'custom_tools.import' })).not.toBeInTheDocument()
  expect(readFile).toHaveBeenCalledWith('stable', 'TOOL.json')
  await openGroup(screen.getByRole('button', { name: /^Shared/ }))
  await user.click(screen.getByRole('button', { name: 'custom_tools.remove_directory' }))
  expect(screen.getByRole('alertdialog')).toHaveTextContent('custom_tools.remove_directory_hint')
  expect(removeDirectory).not.toHaveBeenCalled()
})
