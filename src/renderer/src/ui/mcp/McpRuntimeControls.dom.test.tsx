import { fireEvent, render, screen, act, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import type { McpToolStatus } from '@shared/types'
import { McpRuntimeControls } from './McpRuntimeControls'
import { McpStartupLabel } from './McpStartupLabel'
import { McpEditor } from './McpEditor'
import { buildMcpPayload, emptyMcpDraft } from './mcpDraft'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))
afterEach(() => vi.unstubAllGlobals())

const names = ['mcp__alpha__lookup', 'mcp__alpha__read']
const status: McpToolStatus = { checkedAt: '', servers: [{ id: 'alpha', index: 0, name: 'Alpha', type: 'http', state: 'stopped', toolCount: 2, toolNames: names }],
  loaded: [{ id: 'alpha', index: 0, name: 'Alpha', toolCount: 2, toolNames: names }], errors: [], tools: [], toolNames: names }

it('blocks enabling without a non-empty catalog while allowing discovery and turning an existing selection off', async () => {
  const draft = { ...emptyMcpDraft(((key: string) => key) as Parameters<typeof emptyMcpDraft>[0]), id: 'alpha', index: 0, command: 'node' }
  const selectedServer = { ...buildMcpPayload(draft), index: 0, command: 'node', url: '', workingDir: '', apiKey: '' }
  const setRunning = vi.fn(async () => status)
  vi.stubGlobal('gale', { mcp: { setRunning } })
  const props = { mcpDraft: draft, selectedServer, onFlushDraft: async () => 'alpha', onAutosizeInput: vi.fn(), onUpdateDraft: vi.fn() }
  const { rerender } = render(<McpEditor {...props} status={undefined} />)
  const enabled = screen.getByRole('checkbox', { name: 'settings.enabled' })
  expect(enabled).toBeDisabled()
  expect(enabled.closest('label')).toHaveAttribute('data-tooltip', 'settings.mcp_tools_required_enable')
  await userEvent.click(enabled)
  expect(props.onUpdateDraft).not.toHaveBeenCalled()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.mcp_start' })))
  expect(setRunning).toHaveBeenCalledWith('alpha', true)
  rerender(<McpEditor {...props} status={status} />)
  expect(enabled).not.toBeDisabled()
  fireEvent.click(enabled)
  expect(props.onUpdateDraft).toHaveBeenLastCalledWith({ enabled: true })
  rerender(<McpEditor {...props} mcpDraft={{ ...draft, id: ' alpha ' }} status={status} />)
  expect(enabled).not.toBeDisabled()
  const empty = { ...status, loaded: [{ ...status.loaded[0], toolNames: [], toolCount: 0 }] }
  rerender(<McpEditor {...props} status={empty} />)
  expect(enabled).toBeDisabled()
  rerender(<McpEditor {...props} mcpDraft={{ ...draft, id: 'another' }} status={status} />)
  expect(enabled).toBeDisabled()
  rerender(<McpEditor {...props} mcpDraft={{ ...draft, enabled: true }} status={empty} />)
  expect(enabled).not.toBeDisabled()
  fireEvent.click(enabled)
  expect(props.onUpdateDraft).toHaveBeenLastCalledWith({ enabled: false })
})

it('renders a stopped catalog, saves selections optimistically without replacing or disabling controls, and rolls back failures', async () => {
  let reject!: (error: Error) => void
  const setToolsEnabled = vi.fn(() => new Promise<McpToolStatus>((_resolve, fail) => { reject = fail }))
  const setRunning = vi.fn()
  vi.stubGlobal('gale', { mcp: { setToolsEnabled, setRunning } })
  render(<McpRuntimeControls id="alpha" enabled status={status} onFlushDraft={async () => 'alpha'} />)
  const choice = screen.getByRole('checkbox', { name: 'lookup' })
  expect(choice).toBeChecked()
  fireEvent.click(choice)
  expect(choice).not.toBeChecked()
  expect(choice).not.toBeDisabled()
  expect(screen.getByRole('checkbox', { name: 'lookup' })).toBe(choice)
  expect(setToolsEnabled).toHaveBeenCalledWith('alpha', [names[0]], false)
  expect(setRunning).not.toHaveBeenCalled()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  await act(async () => reject(new Error('save failed')))
  expect(choice).toBeChecked()
  fireEvent.click(screen.getByRole('button', { name: 'capabilities.clear_group_all' }))
  expect(setToolsEnabled).toHaveBeenLastCalledWith('alpha', names, false)
  expect(screen.getByRole('checkbox', { name: 'read' })).not.toBeChecked()
  await act(async () => reject(new Error('save failed')))
})

it('opens a saved definition by name without toggling or starting a disabled, stopped server', () => {
  const setToolsEnabled = vi.fn()
  const setRunning = vi.fn()
  const flush = vi.fn()
  vi.stubGlobal('gale', { mcp: { setToolsEnabled, setRunning } })
  const tool = { name: names[0], description: 'Look up an item', parameters: [], inputSchema: {
    type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false
  } }
  const { rerender } = render(<McpRuntimeControls id="alpha" enabled={false}
    status={{ ...status, tools: [tool] }} onFlushDraft={flush} />)
  const choice = screen.getByRole('checkbox', { name: 'lookup' })
  fireEvent.click(screen.getByRole('button', { name: 'lookup' }))
  const dialog = screen.getByRole('dialog', { name: names[0] })
  expect(JSON.parse(dialog.querySelector('pre')!.textContent!)).toEqual({
    name: tool.name, description: tool.description, parameters: tool.inputSchema
  })
  expect(within(dialog).getByRole('button', { name: 'common.copy' })).not.toBeDisabled()
  expect(choice).toBeChecked()
  expect(setToolsEnabled).not.toHaveBeenCalled()
  expect(setRunning).not.toHaveBeenCalled()
  expect(flush).not.toHaveBeenCalled()
  fireEvent.click(within(dialog).getByRole('button', { name: 'common.close' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByRole('checkbox', { name: 'lookup' })).toBe(choice)
  fireEvent.click(screen.getByRole('button', { name: 'lookup' }))
  rerender(<McpRuntimeControls id="alpha" enabled={false}
    status={{ ...status, loaded: [], tools: [] }} onFlushDraft={flush} />)
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

it('waits for autosave before starting and allows stopping while discovery is pending', async () => {
  let resolve!: (id: string) => void
  const flush = vi.fn(() => new Promise<string>(done => { resolve = done }))
  const setRunning = vi.fn(async () => status)
  vi.stubGlobal('gale', { mcp: { setRunning } })
  const { rerender } = render(<McpRuntimeControls id="alpha" enabled status={status} onFlushDraft={flush} />)
  fireEvent.click(screen.getByRole('button', { name: 'settings.mcp_start' }))
  expect(setRunning).not.toHaveBeenCalled()
  await act(async () => resolve('alpha'))
  expect(setRunning).toHaveBeenCalledWith('alpha', true)
  rerender(<McpRuntimeControls id="alpha" enabled status={{ ...status, servers: [{ ...status.servers[0], state: 'starting' }] }} onFlushDraft={flush} />)
  fireEvent.click(screen.getByRole('button', { name: 'settings.mcp_stop' }))
  expect(setRunning).toHaveBeenCalledWith('alpha', false)
})

it('allows manual start and stop while model availability is disabled', async () => {
  const setRunning = vi.fn(async () => status)
  vi.stubGlobal('gale', { mcp: { setRunning } })
  const props = { id: 'alpha', enabled: false, onFlushDraft: async () => 'alpha' }
  const { rerender } = render(<McpRuntimeControls {...props} status={status} />)
  const start = screen.getByRole('button', { name: 'settings.mcp_start' })
  expect(start).not.toBeDisabled()
  await act(async () => fireEvent.click(start))
  expect(setRunning).toHaveBeenCalledWith('alpha', true)
  rerender(<McpRuntimeControls {...props} status={{ ...status, servers: [{ ...status.servers[0], state: 'ready' }] }} />)
  expect(screen.getByRole('checkbox', { name: 'lookup' })).toBeChecked()
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'settings.mcp_stop' })))
  expect(setRunning).toHaveBeenCalledWith('alpha', false)
})

it('shows live startup on the original tool, ignores a stale initial status read, and clears it when ready', async () => {
  let resolve!: (status: McpToolStatus) => void
  let publish!: (status: McpToolStatus) => void
  const unsubscribe = vi.fn()
  vi.stubGlobal('gale', { mcp: {
    status: () => new Promise<McpToolStatus>(done => { resolve = done }),
    onStatus: (listener: typeof publish) => { publish = listener; return unsubscribe }
  } })
  const { unmount } = render(<McpStartupLabel toolName={names[0]} />)
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  act(() => publish({ ...status, servers: [{ ...status.servers[0], state: 'starting' }] }))
  expect(screen.getByRole('status')).toHaveTextContent('agent.mcp_starting')
  await act(async () => resolve(status))
  expect(screen.getByRole('status')).toBeVisible()
  act(() => publish({ ...status, servers: [{ ...status.servers[0], state: 'ready' }] }))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
})
