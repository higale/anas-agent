import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpToolStatus, RuntimeToolStatus } from '@shared/types'
import type { PluginSummary } from '@shared/plugins'
import { ToolsSettings } from './ToolsSettings'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } })
}))

const runtimeToolStatus: RuntimeToolStatus = {
  checkedAt: '',
  tools: [{ name: 'read_call', description: 'Read background call status.', parameters: [] }],
  toolNames: ['read_call']
}

const props = { plugins: [], customTools: [], onConfigChange: vi.fn(), mcpServers: [], mcpStatus: undefined, runtimeToolStatus }

const inputSchema = {
  type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1 } },
  required: ['query'], additionalProperties: false
}
function plugin(id: string, enabled = true): PluginSummary {
  return {
    id, enabled, backendStatus: 'stopped',
    languages: [{ code: 'en', name: 'English', pluginName: `${id} tools` }],
    manifest: { id, name: id, pluginVersion: '1.0.0', apiVersion: 2, description: '', backend: 'backend.cjs',
      tools: [{ id: 'lookup', description: `Look up with ${id}.`, inputSchema, handler: 'lookup', effect: 'read', timeoutSeconds: 30 }] }
  }
}

beforeEach(() => { vi.stubGlobal('gale', { tools: { get: vi.fn(async () => ({ roots: [], tools: [] })) } }) })

describe('tool catalog', () => {
  it('groups every built-in and framework tool under its matching capability', () => {
    render(<ToolsSettings {...props} />)
    const expected = {
      planning: ['write_todos'],
      request_user_input: ['request_user_input'],
      subagents: ['start_subagent', 'read_subagent', 'wait_subagent', 'cancel_subagent'],
      backgroundTools: ['read_call', 'read_call_output', 'write_call', 'wait_call', 'cancel_call'],
      fileRead: ['list_directory', 'directory_tree', 'get_file_info', 'read_file', 'read_multiple_files', 'view_image', 'view_multiple_images'],
      fileWrite: ['create_directory', 'write_file', 'apply_patch', 'get_file_edit_diff', 'restore_file_edit', 'move_file', 'delete_file'],
      commandExecution: ['run_shell'],
      networkAccess: ['http_request'],
      memory: ['read_memory', 'save_to_memory', 'forget_memory'],
      configuration: ['update_config']
    }
    for (const [group, names] of Object.entries(expected)) {
      expect(within(screen.getByRole('region', { name: `settings.capability_${group}` })).getAllByRole('button').map(button => button.textContent)).toEqual(names)
    }
    for (const group of ['profile', 'environment', 'workspaceContext', 'applicationEnvironment', 'skills', 'memory_recall']) {
      expect(screen.queryByText(`settings.capability_${group}`)).not.toBeInTheDocument()
    }
  })

  it('shows the runtime Shell name in the command capability group', () => {
    render(<ToolsSettings {...props} runtimeToolStatus={{ checkedAt: '', toolNames: ['zsh'], tools: [
      { name: 'zsh', capabilityId: 'run_shell', description: 'Run Z shell.', parameters: [] }
    ] }} />)
    expect(screen.getByRole('button', { name: /^zsh:/ })).toBeEnabled()
    expect(screen.queryByRole('button', { name: /^run_shell:/ })).not.toBeInTheDocument()
  })

  it('retains empty MCP server groups and hides import when returning from user tools to the catalogs', async () => {
    vi.stubGlobal('gale', { tools: { get: vi.fn(async () => ({ roots: [{ id: 'user', name: 'User', source: 'user', path: '/tools' }], tools: [] })) } })
    const view = render(<ToolsSettings {...props} />)
    expect(screen.queryByRole('button', { name: 'custom_tools.import' })).not.toBeInTheDocument()
    fireEvent.click(await screen.findByRole('button', { name: /^settings.skill_group_user/ }))
    expect(screen.getByRole('button', { name: 'custom_tools.import' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /^settings\.mcp\s*0$/ }))
    expect(screen.queryByRole('button', { name: 'custom_tools.import' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^settings.skill_group_user/ }))
    expect(screen.getByRole('button', { name: 'custom_tools.import' })).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: /^custom_tools.builtin/ }))
    expect(screen.queryByRole('button', { name: 'custom_tools.import' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /^settings\.mcp\s*0$/ }))
    expect(screen.getByRole('button', { name: /^custom_tools\.all\s*0$/ })).toBeVisible()
    expect(screen.getByText('settings.tools_mcp_empty')).toBeVisible()
    view.rerender(<ToolsSettings {...props} mcpStatus={{ checkedAt: '',
      servers: [{ id: 'empty', index: 0, name: 'Empty MCP', type: 'http', state: 'stopped', toolCount: 0, toolNames: [] }],
      loaded: [], tools: [], toolNames: [], errors: []
    }} />)
    expect(screen.getByText('Empty MCP')).toBeVisible()
    expect(screen.getByText('settings.tools_mcp_server_empty')).toBeVisible()
  })

  it('allows inspecting every catalog entry even before runtime definitions are available', async () => {
    const user = userEvent.setup()
    const view = render(<ToolsSettings {...props} runtimeToolStatus={undefined} />)
    for (const name of ['start_subagent', 'write_call', 'read_call', 'read_memory']) {
      const button = screen.getByRole('button', { name: `${name}: settings.tools_view_details` })
      expect(button).toBeEnabled()
      await user.click(button)
      expect(screen.getByRole('dialog')).toHaveTextContent(`"name": "${name}"`)
      await user.keyboard('{Escape}')
    }
    await user.click(screen.getByRole('button', { name: 'read_call: settings.tools_view_details' }))
    view.rerender(<ToolsSettings {...props} />)
    expect(screen.getByRole('dialog')).toHaveTextContent('Read background call status.')
  })

  it('groups plugin declarations by source and copies the complete model definition even when disabled', async () => {
    const user = userEvent.setup()
    const writeText = vi.spyOn(navigator.clipboard, 'writeText')
    const onConfigChange = vi.fn()
    render(<ToolsSettings {...props} onConfigChange={onConfigChange} plugins={[plugin('first'), plugin('second', false)]} />)
    await user.click(screen.getByRole('button', { name: /^plugins\.title\s*2$/ }))
    const first = screen.getByRole('region', { name: 'first tools' })
    const second = screen.getByRole('region', { name: 'second tools' })
    expect(within(first).getByRole('button', { name: /^plugin__first__lookup:/ })).toBeEnabled()
    expect(within(second).getByText('settings.disabled')).toBeVisible()
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'custom_tools.import' })).not.toBeInTheDocument()
    await user.click(within(second).getByRole('button', { name: /^plugin__second__lookup:/ }))
    const dialog = screen.getByRole('dialog')
    const expected = { name: 'plugin__second__lookup', description: 'Look up with second.', parameters: inputSchema }
    expect(JSON.parse(dialog.querySelector('pre')!.textContent!)).toEqual(expected)
    await user.click(within(dialog).getByRole('button', { name: 'common.copy' }))
    expect(JSON.parse(writeText.mock.calls[0][0])).toEqual(expected)
    expect(onConfigChange).not.toHaveBeenCalled()
  })

  it('refreshes open plugin definitions and closes details after uninstall', async () => {
    const user = userEvent.setup()
    const source = plugin('source')
    const view = render(<ToolsSettings {...props} plugins={[source]} />)
    await user.click(screen.getByRole('button', { name: /^plugins\.title\s*1$/ }))
    await user.click(screen.getByRole('button', { name: /^plugin__source__lookup:/ }))
    view.rerender(<ToolsSettings {...props} plugins={[{ ...source, backendStatus: 'failed', backendError: 'Backend exited',
      manifest: { ...source.manifest!, tools: [{ ...source.manifest!.tools[0], description: 'Updated lookup.' }] }
    }]} />)
    expect(screen.getByRole('dialog')).toHaveTextContent('Updated lookup.')
    view.rerender(<ToolsSettings {...props} plugins={[]} />)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(screen.getByText('plugins.tools_catalog_empty')).toBeVisible()
  })

  it('distinguishes unavailable plugin declarations from an empty catalog', async () => {
    const user = userEvent.setup()
    const source = plugin('ui-only')
    const view = render(<ToolsSettings {...props} plugins={[{ ...source, manifest: { ...source.manifest!, tools: [] } }]} />)
    await user.click(screen.getByRole('button', { name: /^plugins\.title\s*0$/ }))
    expect(screen.getByText('plugins.tools_catalog_empty')).toBeVisible()
    expect(screen.queryByRole('region', { name: 'ui-only tools' })).not.toBeInTheDocument()
    view.rerender(<ToolsSettings {...props} pluginError="Could not read the plugin directory." />)
    expect(screen.getByRole('alert')).toHaveTextContent('Could not read the plugin directory.')
    expect(screen.queryByText('plugins.tools_catalog_empty')).not.toBeInTheDocument()
    view.rerender(<ToolsSettings {...props} plugins={[{ id: 'broken', enabled: false, backendStatus: 'stopped', error: 'Invalid PLUGIN.json.' }]} />)
    expect(within(screen.getByRole('region', { name: 'broken' })).getByRole('alert')).toHaveTextContent('Invalid PLUGIN.json.')
    expect(screen.queryByText('plugins.tools_catalog_empty')).not.toBeInTheDocument()
  })

  it.each(['stopped', 'failed', 'recovering', 'ready'] as const)('keeps MCP definitions inspectable when the source is %s', async (state) => {
    const status: McpToolStatus = {
      checkedAt: '',
      servers: [{ id: 'source', index: 0, name: 'Source', type: 'http', state, toolCount: 1, toolNames: ['lookup'] }],
      loaded: [{ id: 'source', index: 0, name: 'Source', toolCount: 1, toolNames: ['lookup'] }],
      tools: [{ name: 'lookup', description: 'Look up a record.', parameters: [] }],
      toolNames: ['lookup'], errors: []
    }
    render(<ToolsSettings {...props} mcpStatus={status} />)
    await userEvent.click(screen.getByRole('button', { name: /^settings\.mcp\s*1$/ }))
    const button = screen.getByRole('button', { name: 'lookup: settings.tools_view_details' })
    expect(button).toBeEnabled()
    expect(screen.queryByText('settings.load_failed')).not.toBeInTheDocument()
    expect(screen.queryByText('settings.mcp_state_recovering')).not.toBeInTheDocument()
    await userEvent.click(button)
    expect(screen.getByRole('dialog')).toHaveTextContent('Look up a record.')
  })
})
