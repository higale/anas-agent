import { mcpConfigKey } from './config/mcpServerConfigMapper'
import type { McpToolCatalog } from '@shared/mcpCatalog'
import { defineContentTool } from '../runtime/toolDefinition'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { McpRuntimeConfigSnapshot, McpServerConfig } from './config/appConfig'

const server: McpServerConfig = {
  index: 0,
  name: 'Alpha',
  enabled: true,
  timeoutMs: 1000,
  type: 'stdio',
  id: 'alpha',
  command: 'alpha-server',
  args: [],
  env: {}
}

const executeMcpMock = vi.fn(async () => 'pong')
const mcpTool = defineContentTool({
  name: 'mcp_alpha_ping',
  description: 'Ping Alpha.',
  inputSchema: { type: 'object', properties: {} },
  execute: executeMcpMock
})

type McpRuntimeService = typeof import('./mcpRuntimeService')

interface Harness {
  clients: Array<{
    close: ReturnType<typeof vi.fn>
    ping: ReturnType<typeof vi.fn>
    initialize: ReturnType<typeof vi.fn>
  }>
  closeClient: ReturnType<typeof vi.fn>
  createClient: ReturnType<typeof vi.fn>
  ping: ReturnType<typeof vi.fn>
  initialize: ReturnType<typeof vi.fn>
  runtimeLog: ReturnType<typeof vi.fn>
  service: McpRuntimeService
  toolEffectScope: typeof import('./agent/toolEffectScope')
  getConfig(): McpRuntimeConfigSnapshot
  saveCatalog: ReturnType<typeof vi.fn>
  setConfig(config: McpRuntimeConfigSnapshot): void
}

let activeService: McpRuntimeService | undefined

async function loadHarness(
  initializeImplementation?: () => Promise<unknown[]>,
  pingImplementation?: () => Promise<void>
): Promise<Harness> {
  vi.resetModules()
  executeMcpMock.mockReset().mockResolvedValue('pong')
  let config: McpRuntimeConfigSnapshot = { enabled: true, servers: [server] }
  const initialize = vi.fn(initializeImplementation ?? (async () => ([mcpTool])))
  const closeClient = vi.fn(async () => {})
  const ping = vi.fn(pingImplementation ?? (async () => {}))
  const clients: Harness['clients'] = []
  let connectionSnapshotForServer: typeof import('./mcpTools').mcpConnectionSnapshotForServer | undefined
  const createClient = vi.fn((clientServer: McpServerConfig, _hooks: unknown) => {
    const snapshot = connectionSnapshotForServer?.(clientServer)
    if (!snapshot) throw new Error('Missing MCP connection in test harness.')
    const client = {
      close: vi.fn(() => closeClient()),
      ping,
      initialize
    }
    clients.push(client)
    return {
      client,
      connectionIdentity: snapshot.identity
    }
  })
  const runtimeLog = vi.fn()

  vi.doMock('electron', () => ({
    app: undefined,
    BrowserWindow: { getAllWindows: () => [] }
  }))
  const saveCatalog = vi.fn(async (id: string, catalog: McpToolCatalog) => {
    const item = config.servers.find(server => server.id === id)
    if (!item || mcpConfigKey(item) !== catalog.connection_key) return false
    config = { ...config, servers: config.servers.map(server => server.id === id ? { ...server, toolCatalog: catalog } : server) }
    return true
  })
  vi.doMock('./config/appConfig', () => ({
    getMcpRuntimeConfigSnapshot: vi.fn(async () => config), saveMcpToolCatalog: saveCatalog
  }))
  vi.doMock('./mcpTools', async () => {
    const actual = await vi.importActual<typeof import('./mcpTools')>('./mcpTools')
    connectionSnapshotForServer = actual.mcpConnectionSnapshotForServer
    return {
      ...actual,
      createMcpClientForServer: createClient,
      mcpErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error)
    }
  })
  vi.doMock('./runtimeLogger', () => ({
    runtimeChannelLog: vi.fn(),
    runtimeLog
  }))

  const service = await import('./mcpRuntimeService')
  const toolEffectScope = await import('./agent/toolEffectScope')
  activeService = service
  return {
    clients,
    closeClient,
    createClient,
    ping,
    initialize,
    runtimeLog,
    service,
    toolEffectScope,
    getConfig: () => config,
    saveCatalog,
    setConfig(nextConfig) {
      config = nextConfig
    }
  }
}

afterEach(async () => {
  await activeService?.closeCachedMcpRuntime()
  activeService = undefined
  vi.doUnmock('electron')
  vi.doUnmock('./config/appConfig')
  vi.doUnmock('./mcpTools')
  vi.doUnmock('./runtimeLogger')
  vi.resetModules()
})

function withCatalog(): McpServerConfig {
  return { ...server, toolCatalog: { connection_key: mcpConfigKey(server), tools: [{ name: mcpTool.name,
    description: mcpTool.description, input_schema: mcpTool.inputSchema as Record<string, unknown> }] } }
}

describe('MCP runtime lifecycle', () => {
  it('hydrates saved tools without starting on application or conversation startup', async () => {
    const harness = await loadHarness()
    harness.setConfig({ enabled: true, servers: [withCatalog()] })
    const status = await harness.service.loadMcpRuntimeForCurrentConfig()
    expect(status.servers[0].state).toBe('idle')
    expect(status.tools.map(tool => tool.name)).toEqual([mcpTool.name])
    const runtime = await harness.service.getCachedMcpRuntime()
    expect(runtime.tools.map(tool => tool.name)).toEqual([mcpTool.name])
    expect(harness.createClient).not.toHaveBeenCalled()
    await runtime.tools[0].execute({}, {})
    expect(harness.createClient).toHaveBeenCalledOnce()
    expect(harness.saveCatalog).toHaveBeenCalledOnce()
    expect(executeMcpMock).toHaveBeenCalledOnce()
  })

  it('reopens restored data with saved definitions and no automatic connections', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime(true)
    await harness.service.closeCachedMcpRuntime()
    await harness.service.reopenCachedMcpRuntime()
    const status = await harness.service.loadMcpRuntimeForCurrentConfig(false)
    expect(status.servers[0]).toMatchObject({ state: 'idle', toolCount: 1 })
    expect(harness.createClient).toHaveBeenCalledOnce()
    expect((await harness.service.getCachedMcpRuntime()).tools).toHaveLength(1)
  })

  it('coalesces concurrent starts, reports progress, and cancels one waiter without cancelling others', async () => {
    let release!: (tools: unknown[]) => void
    const harness = await loadHarness(() => new Promise(resolve => { release = resolve }))
    harness.setConfig({ enabled: true, servers: [withCatalog()] })
    const runtime = await harness.service.getCachedMcpRuntime()
    const { withToolExecution } = await import('./agent/toolExecutionContext')
    const controller = new AbortController()
    const control = { callId: 'lazy', signal: controller.signal, markRunning: vi.fn(), markLocalCommit: vi.fn(), markUncertain: vi.fn(),
      progress: vi.fn(), output: vi.fn(), setOutcome: vi.fn() }
    const first = withToolExecution(control, false, () => runtime.tools[0].execute({}, { signal: controller.signal }))
    const rejected = expect(first).rejects.toThrow('cancelled')
    const second = runtime.tools[0].execute({}, {})
    try {
      await vi.waitFor(() => expect(harness.initialize).toHaveBeenCalledOnce())
      expect(control.output).toHaveBeenCalledWith('progress', expect.stringContaining('正在启动 MCP Alpha'))
      controller.abort(new Error('cancelled'))
      await rejected
      release([mcpTool])
      await second
      expect(executeMcpMock).toHaveBeenCalledOnce()
      expect(harness.createClient).toHaveBeenCalledOnce()
    } finally { release?.([]) }
  })

  it('stores an empty discovery and returns a missing-tool error through the original call', async () => {
    const harness = await loadHarness(async () => [])
    harness.setConfig({ enabled: true, servers: [withCatalog()] })
    const runtime = await harness.service.getCachedMcpRuntime()
    await expect(runtime.tools[0].execute({}, {})).rejects.toThrow('此工具已不存在')
    expect(harness.getConfig().servers[0].toolCatalog?.tools).toEqual([])
    expect((await harness.service.getCachedMcpRuntime()).tools).toEqual([])
    expect(executeMcpMock).not.toHaveBeenCalled()
  })

  it('keeps the previous catalog after discovery failure without background retries', async () => {
    vi.useFakeTimers()
    try {
      const harness = await loadHarness(async () => { throw new Error('connection refused') })
      harness.setConfig({ enabled: true, servers: [withCatalog()] })
      const runtime = await harness.service.getCachedMcpRuntime()
      await expect(runtime.tools[0].execute({}, {})).rejects.toThrow('MCP 启动失败 (Alpha): connection refused')
      expect(harness.getConfig().servers[0].toolCatalog?.tools).toHaveLength(1)
      expect(harness.saveCatalog).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(120_000)
      expect(harness.createClient).toHaveBeenCalledOnce()
    } finally { vi.useRealTimers() }
  })

  it('preserves selections and catalogs on stop and reconnects only when an enabled tool is called', async () => {
    const harness = await loadHarness()
    harness.setConfig({ enabled: true, servers: [{ ...withCatalog(), toolChoices: { [mcpTool.name]: false } }] })
    await harness.service.setMcpServerRunning('alpha', true)
    expect((await harness.service.getCachedMcpRuntime()).tools).toEqual([])
    await harness.service.setMcpServerRunning('alpha', false)
    expect(harness.getConfig().servers[0].toolChoices).toEqual({ [mcpTool.name]: false })
    expect(harness.service.getCachedMcpStatus()?.toolNames).toEqual([mcpTool.name])
    expect(harness.clients).toHaveLength(1)
    harness.setConfig({ enabled: true, servers: [{ ...harness.getConfig().servers[0], toolChoices: {} }] })
    const runtime = await harness.service.getCachedMcpRuntime()
    await runtime.tools[0].execute({}, {})
    expect(harness.clients).toHaveLength(2)
    expect(harness.saveCatalog).toHaveBeenCalledTimes(2)
  })

  it('manually starts a disabled server and retains its connection through catalog reads and selection saves', async () => {
    const harness = await loadHarness()
    harness.setConfig({ enabled: true, servers: [{ ...server, enabled: false }] })
    expect((await harness.service.getCachedMcpRuntime()).tools).toEqual([])
    expect(harness.createClient).not.toHaveBeenCalled()
    const started = await harness.service.setMcpServerRunning('alpha', true)
    expect(started.servers[0]).toMatchObject({ state: 'ready', toolCount: 1 })
    expect(harness.getConfig().servers[0]).toMatchObject({ enabled: false, toolCatalog: { tools: [expect.objectContaining({ name: mcpTool.name })] } })
    harness.setConfig({ enabled: true, servers: [{ ...harness.getConfig().servers[0], toolChoices: { [mcpTool.name]: false } }] })
    await harness.service.loadMcpRuntimeForCurrentConfig()
    expect((await harness.service.getCachedMcpRuntime()).tools).toEqual([])
    expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('ready')
    expect(harness.closeClient).not.toHaveBeenCalled()
    await harness.service.setMcpServerRunning('alpha', false)
    expect(harness.service.getCachedMcpStatus()?.servers[0]).toMatchObject({ state: 'stopped', toolCount: 1 })
    await harness.service.reloadMcpRuntimeForServer(0)
    expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('ready')
    expect(harness.saveCatalog).toHaveBeenCalledTimes(2)
  })

  it('changes model availability without changing the connection when a running server is disabled or enabled', async () => {
    const harness = await loadHarness()
    const runtime = await harness.service.getCachedMcpRuntime(true)
    harness.setConfig({ enabled: true, servers: [{ ...harness.getConfig().servers[0], enabled: false }] })
    expect((await harness.service.getCachedMcpRuntime()).tools).toEqual([])
    await expect(runtime.tools[0].execute({}, {})).rejects.toThrow('disabled')
    expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('ready')
    expect(harness.closeClient).not.toHaveBeenCalled()
    harness.setConfig({ enabled: true, servers: [{ ...harness.getConfig().servers[0], enabled: true }] })
    expect((await harness.service.getCachedMcpRuntime()).tools).toHaveLength(1)
    await runtime.tools[0].execute({}, {})
    expect(harness.createClient).toHaveBeenCalledOnce()
    expect(executeMcpMock).toHaveBeenCalledOnce()
  })

  it('rejects stale calls after disabling a tool, disabling its server, changing its connection, or closing data', async () => {
    const harness = await loadHarness()
    harness.setConfig({ enabled: true, servers: [withCatalog()] })
    const runtime = await harness.service.getCachedMcpRuntime()
    harness.setConfig({ enabled: true, servers: [{ ...withCatalog(), toolChoices: { [mcpTool.name]: false } }] })
    await expect(runtime.tools[0].execute({}, {})).rejects.toThrow('disabled')
    harness.setConfig({ enabled: true, servers: [{ ...withCatalog(), enabled: false }] })
    await expect(runtime.tools[0].execute({}, {})).rejects.toThrow('disabled')
    harness.setConfig({ enabled: true, servers: [{ ...withCatalog(), command: 'other-server' }] })
    await expect(runtime.tools[0].execute({}, {})).rejects.toThrow('connection changed')
    expect((await harness.service.getCachedMcpRuntime()).tools).toEqual([])
    await harness.service.closeCachedMcpRuntime()
    harness.setConfig({ enabled: true, servers: [withCatalog()] })
    await expect(runtime.tools[0].execute({}, {})).rejects.toThrow('unavailable')
    expect(harness.createClient).not.toHaveBeenCalled()
  })

  it('does not reconnect or invalidate the catalog for rename and reorder', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime(true)
    harness.setConfig({ enabled: true, servers: [{ ...harness.getConfig().servers[0], name: 'Renamed', index: 2 }] })
    const status = await harness.service.loadMcpRuntimeForCurrentConfig()
    expect(status.servers[0]).toMatchObject({ id: 'alpha', name: 'Renamed', index: 2, state: 'ready', toolCount: 1 })
    expect(harness.createClient).toHaveBeenCalledOnce()
  })

  it('rejects changed schemas and annotations before invoking the refreshed tool', async () => {
    const harness = await loadHarness(async () => [{ ...mcpTool, metadata: { annotations: { readOnlyHint: false } } }])
    harness.setConfig({ enabled: true, servers: [withCatalog()] })
    const runtime = await harness.service.getCachedMcpRuntime()
    await expect(runtime.tools[0].execute({}, {})).rejects.toThrow('definition changed')
    expect(executeMcpMock).not.toHaveBeenCalled()
    const refreshed = await harness.service.getCachedMcpRuntime()
    await refreshed.tools[0].execute({}, {})
    expect(executeMcpMock).toHaveBeenCalledOnce()
  })

  it('stops a pending lazy start without executing the call or publishing late discovery', async () => {
    let release!: (tools: unknown[]) => void
    const harness = await loadHarness(() => new Promise(resolve => { release = resolve }))
    harness.setConfig({ enabled: true, servers: [withCatalog()] })
    const runtime = await harness.service.getCachedMcpRuntime()
    const invocation = runtime.tools[0].execute({}, {})
    const rejected = expect(invocation).rejects.toThrow('MCP 启动失败')
    try {
      await vi.waitFor(() => expect(harness.initialize).toHaveBeenCalledOnce())
      const stopping = harness.service.setMcpServerRunning('alpha', false)
      await vi.waitFor(() => expect(harness.closeClient).toHaveBeenCalled())
      release([])
      await Promise.all([stopping, rejected])
      expect(harness.saveCatalog).not.toHaveBeenCalled()
      expect(harness.service.getCachedMcpStatus()?.servers[0]).toMatchObject({ state: 'stopped', toolCount: 1 })
      expect(executeMcpMock).not.toHaveBeenCalled()
    } finally { release?.([]) }
  })

  it('retains previous definitions and returns discovery persistence failure through the tool call', async () => {
    const harness = await loadHarness(async () => [])
    harness.setConfig({ enabled: true, servers: [withCatalog()] })
    harness.saveCatalog.mockRejectedValueOnce(new Error('disk unavailable'))
    const runtime = await harness.service.getCachedMcpRuntime()
    await expect(runtime.tools[0].execute({}, {})).rejects.toThrow('disk unavailable')
    expect((await harness.service.getCachedMcpRuntime()).tools).toHaveLength(1)
    expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('failed')
    expect(executeMcpMock).not.toHaveBeenCalled()
  })

  it('blocks new effects after disconnect and replaces the session without replaying a tool', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime(true)
    const hooks = harness.createClient.mock.calls[0][1] as {
      onConnectionClosed(): void
      beforeToolCall(info: { name: string; args: object }): void
    }
    const arm = vi.fn()
    const callsBefore = executeMcpMock.mock.calls.length
    hooks.onConnectionClosed()
    expect(() => harness.toolEffectScope.runWithCurrentAgentToolEffect({ arm }, () =>
      hooks.beforeToolCall({ name: 'publish', args: {} }))).toThrow('runtime changed')
    expect(arm).not.toHaveBeenCalled()
    await harness.service.loadMcpRuntimeForCurrentConfig(true)
    expect(harness.createClient).toHaveBeenCalledTimes(2)
    expect(harness.clients[0].close).toHaveBeenCalledOnce()
    expect(executeMcpMock.mock.calls.length).toBe(callsBefore)
    expect(() => hooks.beforeToolCall({ name: 'publish', args: {} })).toThrow('runtime changed')
  })

  it('routes equal-argument progress to the invocation that owns the exact args object', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime(true)
    const { withToolExecution } = await import('./agent/toolExecutionContext')
    const hooks = harness.createClient.mock.calls[0][1] as {
      beforeToolCall(info: { name: string; args: object }): void
      afterToolCall(info: { name: string; args: object }): void
      onProgress(progress: { progress: number; total?: number; message?: string }, source: { type: string; name: string; args: object }): void
    }
    const control = () => ({ callId: 'mcp-fixture-call', signal: new AbortController().signal, markRunning: vi.fn(), markLocalCommit: vi.fn(), markUncertain: vi.fn(),
      progress: vi.fn(), output: vi.fn(), setOutcome: vi.fn() })
    const a = control()
    const b = control()
    const argsA = { query: 'same' }
    const argsB = { query: 'same' }
    withToolExecution(a, false, () => hooks.beforeToolCall({ name: 'search', args: argsA }))
    withToolExecution(b, false, () => hooks.beforeToolCall({ name: 'search', args: argsB }))
    hooks.onProgress({ progress: 0.5, total: 2, message: 'second' }, { type: 'tool', name: 'search', args: argsB })
    expect(a.progress).not.toHaveBeenCalled()
    expect(b.progress).toHaveBeenCalledWith(0.5, 'mcp', 2)
    expect(b.output).toHaveBeenCalledWith('progress', 'second\n')
    hooks.afterToolCall({ name: 'search', args: argsB })
    hooks.onProgress({ progress: 1 }, { type: 'tool', name: 'search', args: argsB })
    expect(b.progress).toHaveBeenCalledOnce()
  })

  it('distinguishes a confirmed MCP isError result from a transport failure', async () => {
    const harness = await loadHarness()
    const runtime = await harness.service.getCachedMcpRuntime(true)
    const { withToolExecution } = await import('./agent/toolExecutionContext')
    const control = { callId: 'mcp-error-fixture', signal: new AbortController().signal, markRunning: vi.fn(), markLocalCommit: vi.fn(), markUncertain: vi.fn(),
      progress: vi.fn(), output: vi.fn(), setOutcome: vi.fn() }
    const { McpToolResultError } = await import('../mcp/toolResult')
    const error = new McpToolResultError('alpha', 'ping', { isError: true, content: [{ type: 'text', text: 'unavailable' }] })
    executeMcpMock.mockRejectedValueOnce(error)
    await expect(withToolExecution(control, false, () => runtime.tools[0].execute({}, {}))).rejects.toThrow('unavailable')
    expect(control.setOutcome).toHaveBeenCalledWith({ remote_failure_confirmed: true })
    expect(harness.closeClient).not.toHaveBeenCalled()
  })

  it('does not reconnect for a normal tool error on a healthy connection', async () => {
    const harness = await loadHarness()
    const runtime = await harness.service.getCachedMcpRuntime(true)
    executeMcpMock.mockRejectedValueOnce(new Error('application error'))
    await expect(runtime.tools[0].execute({}, {})).rejects.toThrow('application error')
    await harness.service.getCachedMcpRuntime()
    expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('ready')
    expect(harness.closeClient).not.toHaveBeenCalled()
    expect(harness.clients).toHaveLength(1)
  })

  it('does not probe a busy connection or reconnect when its tool is cancelled', async () => {
    const harness = await loadHarness()
    const runtime = await harness.service.getCachedMcpRuntime(true)
    let finish!: (value: string) => void
    const done = new Promise<string>((resolve) => { finish = resolve })
    executeMcpMock.mockImplementationOnce(() => done)
    const active = runtime.tools[0].execute({}, {})
      await vi.waitFor(() => expect(executeMcpMock).toHaveBeenCalled())
    await runtime.ping()
    expect(harness.ping).not.toHaveBeenCalled()
    expect(harness.closeClient).not.toHaveBeenCalled()
    finish('done')
    await active
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(runtime.tools[0].execute({}, { signal: controller.signal })).rejects.toThrow('cancelled')
    expect(harness.ping).not.toHaveBeenCalled()
    expect(harness.closeClient).not.toHaveBeenCalled()
  })

  it('defers tools-list refresh until every active invocation has settled', async () => {
    vi.useFakeTimers()
    try {
      const harness = await loadHarness()
      const runtime = await harness.service.getCachedMcpRuntime(true)
      const hooks = harness.createClient.mock.calls[0][1] as { onToolsListChanged(): void }
      let finish!: (value: string) => void
      const done = new Promise<string>((resolve) => { finish = resolve })
      executeMcpMock.mockImplementationOnce(() => done)
      const active = runtime.tools[0].execute({}, {})
      await vi.waitFor(() => expect(executeMcpMock).toHaveBeenCalled())
      hooks.onToolsListChanged()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(harness.clients).toHaveLength(1)
      expect(harness.closeClient).not.toHaveBeenCalled()
      finish('done')
      await active
      await vi.advanceTimersByTimeAsync(1)
      expect(harness.clients).toHaveLength(2)
    } finally { vi.useRealTimers() }
  })

  it('does not degrade a connection when a tool starts while an earlier ping is pending', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    try {
      let rejectPing!: (reason: Error) => void
      const ping = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectPing = reject }))
      const harness = await loadHarness(undefined, ping)
      const runtime = await harness.service.getCachedMcpRuntime(true)
      const probing = runtime.ping()
      await vi.advanceTimersByTimeAsync(0)
      expect(ping).toHaveBeenCalledOnce()

      executeMcpMock.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
      const active = runtime.tools[0].execute({}, {})
      await vi.waitFor(() => expect(executeMcpMock).toHaveBeenCalled())
      rejectPing(new Error('Ping timed out while a tool was running'))
      await probing
      await vi.advanceTimersByTimeAsync(10_000)
      expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('ready')
      expect(harness.closeClient).not.toHaveBeenCalled()

      finish('done')
      await active
      ping.mockImplementationOnce(async () => {})
      await runtime.ping()
      expect(harness.clients).toHaveLength(1)
    } finally {
      finish?.('done')
      vi.useRealTimers()
    }
  })

  it('keeps the catalog after a failed health check and reconnects only on demand', async () => {
    const harness = await loadHarness(undefined, async () => { throw new Error('Temporary ping failure') })
    const runtime = await harness.service.getCachedMcpRuntime(true)
    await runtime.ping()
    expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('degraded')
    expect((await harness.service.getCachedMcpRuntime()).tools).toHaveLength(1)
    expect(harness.clients).toHaveLength(1)
    await runtime.tools[0].execute({}, {})
    expect(harness.clients).toHaveLength(2)
  })

  it('reconnects an unreachable running server after one manual refresh, but does not retry a failed restart automatically', async () => {
    vi.useFakeTimers()
    try {
      const harness = await loadHarness(undefined, async () => { throw new Error('Ping failed') })
      await harness.service.setMcpServerRunning('alpha', true)
      harness.initialize.mockRejectedValueOnce(new Error('Restart failed'))
      expect(await harness.service.pingAndReloadFailedMcpServers()).toMatchObject({ scheduled: true })
      await vi.advanceTimersByTimeAsync(10)
      expect(harness.initialize).toHaveBeenCalledTimes(2)
      expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('failed')
      expect(harness.service.getCachedMcpStatus()?.tools).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(120_000)
      expect(harness.initialize).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('still closes an explicitly disabled server while automatic recovery is waiting for a call', async () => {
    vi.useFakeTimers()
    let finish!: (value: string) => void
    try {
      const harness = await loadHarness()
      const runtime = await harness.service.getCachedMcpRuntime(true)
      const hooks = harness.createClient.mock.calls[0][1] as { onToolsListChanged(): void }
      executeMcpMock.mockImplementationOnce(() => new Promise<string>((resolve) => { finish = resolve }))
      const active = runtime.tools[0].execute({}, {})
      await vi.waitFor(() => expect(executeMcpMock).toHaveBeenCalled())
      hooks.onToolsListChanged()

      harness.setConfig({ enabled: false, servers: [] })
      await harness.service.loadMcpRuntimeForCurrentConfig(false)
      expect(harness.closeClient).toHaveBeenCalledOnce()
      finish('done')
      await active
      await vi.advanceTimersByTimeAsync(10_000)
      expect(harness.clients).toHaveLength(1)
    } finally {
      finish?.('done')
      vi.useRealTimers()
    }
  })

  it('does not create clients when either master switch is disabled', async () => {
    const harness = await loadHarness()
    harness.setConfig({ enabled: false, servers: [] })

    const runtime = await harness.service.getCachedMcpRuntime(true)

    expect(runtime.tools).toEqual([])
    expect(runtime.loaded).toEqual([])
    expect(harness.createClient).not.toHaveBeenCalled()
    expect(harness.service.getCachedMcpStatus()?.servers).toEqual([])
  })

  it('does not repeat logs for an unchanged empty status', async () => {
    const harness = await loadHarness()
    harness.setConfig({ enabled: true, servers: [] })

    await harness.service.loadMcpRuntimeForCurrentConfig(false)
    await harness.service.loadMcpRuntimeForCurrentConfig(false)

    expect(harness.runtimeLog).toHaveBeenCalledTimes(1)
    expect(harness.runtimeLog).toHaveBeenCalledWith(
      'info',
      'mcp',
      'MCP runtime status updated.',
      { servers: [], toolCount: 0 }
    )
  })

  it('loads tools from the current atomic configuration snapshot', async () => {
    const harness = await loadHarness()

    const runtime = await harness.service.getCachedMcpRuntime(true)

    expect(runtime.errors).toEqual([])
    expect(runtime.tools.map((tool) => tool.name)).toEqual(['mcp_alpha_ping'])
    expect(runtime.loaded).toEqual([expect.objectContaining({ id: 'alpha', toolCount: 1 })])
    expect(harness.createClient).toHaveBeenCalledTimes(1)
    expect(harness.initialize).toHaveBeenCalledTimes(1)
  })

  it('arms the journal from the MCP hook immediately before a remote tool call', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime(true)
    const hooks = harness.createClient.mock.calls[0]?.[1] as {
      beforeToolCall(input: { name: string; args: Record<string, unknown> }): void
    }
    const effects: import('./agent/toolEffectScope').AgentToolEffectArm[] = []

    harness.toolEffectScope.runWithCurrentAgentToolEffect({
      arm: (effect) => effects.push(effect)
    }, () => hooks.beforeToolCall({
      name: 'publish',
      args: { target: 'release' }
    }))

    expect(effects).toEqual([expect.objectContaining({
      kind: 'mcp_tool_call',
      target: expect.objectContaining({
        serverId: 'alpha',
        serverName: 'Alpha',
        transport: 'stdio',
        connectionFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
        tool: 'publish',
        arguments: { target: 'release' }
      })
    })])

    await harness.service.closeCachedMcpRuntime()
    expect(() => hooks.beforeToolCall({
      name: 'publish',
      args: { target: 'release' }
    })).toThrow('runtime changed before tool publish could start')
    expect(effects).toHaveLength(1)
  })

  it('changes the durable MCP target identity when the configured endpoint changes', async () => {
    const harness = await loadHarness()
    const effects: import('./agent/toolEffectScope').AgentToolEffectArm[] = []
    const invokeHook = (callIndex: number): void => {
      const hooks = harness.createClient.mock.calls[callIndex]?.[1] as {
        beforeToolCall(input: { name: string; args: Record<string, unknown> }): void
      }
      harness.toolEffectScope.runWithCurrentAgentToolEffect({
        arm: (effect) => effects.push(effect)
      }, () => hooks.beforeToolCall({
        name: 'publish',
        args: { target: 'release' }
      }))
    }

    harness.setConfig({
      enabled: true,
      servers: [{
        ...server,
        type: 'http',
        command: undefined,
        url: 'https://first.example.test/mcp'
      }]
    })
    await harness.service.loadMcpRuntimeForCurrentConfig(false)
    await harness.service.getCachedMcpRuntime(true)
    invokeHook(0)

    harness.setConfig({
      enabled: true,
      servers: [{
        ...server,
        type: 'http',
        command: undefined,
        url: 'https://second.example.test/mcp'
      }]
    })
    await harness.service.loadMcpRuntimeForCurrentConfig(false)
    await harness.service.getCachedMcpRuntime(true)
    invokeHook(1)

    expect(effects).toHaveLength(2)
    expect(effects[0].target).toMatchObject({
      endpoint: { origin: 'https://first.example.test', pathSegmentCount: 1 }
    })
    expect(effects[1].target).toMatchObject({
      endpoint: { origin: 'https://second.example.test', pathSegmentCount: 1 }
    })
    expect((effects[0].target as { connectionFingerprint: string }).connectionFingerprint)
      .not.toBe((effects[1].target as { connectionFingerprint: string }).connectionFingerprint)
  })

  it('freezes the effective connection identity and rejects a stale hook after inherited environment drift', async () => {
    const inheritedEnvKey = 'ANAS_MCP_EFFECT_IDENTITY_TEST'
    const previousValue = process.env[inheritedEnvKey]
    try {
      process.env[inheritedEnvKey] = 'first-runtime'
      const harness = await loadHarness()
      const effects: import('./agent/toolEffectScope').AgentToolEffectArm[] = []
      const invokeHook = (hook: { beforeToolCall(input: { name: string; args: Record<string, unknown> }): void }): void => {
        harness.toolEffectScope.runWithCurrentAgentToolEffect({
          arm: (effect) => effects.push(effect)
        }, () => hook.beforeToolCall({
          name: 'publish',
          args: { target: 'release' }
        }))
      }

      await harness.service.getCachedMcpRuntime(true)
      const firstHooks = harness.createClient.mock.calls[0]?.[1] as {
        beforeToolCall(input: { name: string; args: Record<string, unknown> }): void
      }
      invokeHook(firstHooks)

      process.env[inheritedEnvKey] = 'second-runtime'
      await harness.service.loadMcpRuntimeForCurrentConfig(true)
      const secondHooks = harness.createClient.mock.calls[1]?.[1] as {
        beforeToolCall(input: { name: string; args: Record<string, unknown> }): void
      }

      expect(() => invokeHook(firstHooks)).toThrow('runtime changed before tool publish could start')
      expect(effects).toHaveLength(1)
      invokeHook(secondHooks)

      expect(effects).toHaveLength(2)
      expect((effects[0].target as { connectionFingerprint: string }).connectionFingerprint)
        .not.toBe((effects[1].target as { connectionFingerprint: string }).connectionFingerprint)
    } finally {
      if (previousValue === undefined) delete process.env[inheritedEnvKey]
      else process.env[inheritedEnvKey] = previousValue
    }
  })

  it('reconciles an unchanged configuration without restarting its client', async () => {
    const harness = await loadHarness()

    await harness.service.getCachedMcpRuntime(true)
    await harness.service.loadMcpRuntimeForCurrentConfig(false)

    expect(harness.createClient).toHaveBeenCalledTimes(1)
    expect(harness.initialize).toHaveBeenCalledTimes(1)
  })

  it('returns ready tools while another server is connecting and includes it after startup', async () => {
    let release!: (tools: unknown[]) => void
    const pending = new Promise<unknown[]>(resolve => { release = resolve })
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime(true)
    harness.initialize.mockImplementationOnce(() => pending)
    harness.setConfig({ enabled: true, servers: [harness.getConfig().servers[0], { ...server, id: 'beta', index: 1, name: 'Beta' }] })
    try {
      void harness.service.setMcpServerRunning('beta', true)
      await vi.waitFor(() => expect(harness.initialize).toHaveBeenCalledTimes(2))
      const reading = harness.service.getCachedMcpRuntime()
      let returned = false
      void reading.then(() => { returned = true })
      await vi.waitFor(() => expect(returned).toBe(true), { timeout: 500 })
      const result = await reading
      expect(result.loaded.map(item => item.id)).toEqual(['alpha'])
      expect(result.tools.map(tool => tool.name)).toEqual(['mcp_alpha_ping'])
      expect(harness.service.getCachedMcpStatus()?.servers.find(item => item.id === 'beta')?.state).toBe('starting')
      release([])
      await vi.waitFor(() => expect(harness.service.getCachedMcpStatus()?.servers.find(item => item.id === 'beta')?.state).toBe('ready'))
      expect((await harness.service.getCachedMcpRuntime()).loaded.map(item => item.id)).toEqual(['alpha', 'beta'])
    } finally { release([]) }
  })

  it('does not wait for manual reconnection when a chat reads the tool catalog', async () => {
    let release!: (tools: unknown[]) => void
    const pending = new Promise<unknown[]>(resolve => { release = resolve })
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime(true)
    harness.initialize.mockImplementationOnce(() => pending)
    const hooks = harness.createClient.mock.calls[0][1] as { onConnectionClosed(): void }
    try {
      hooks.onConnectionClosed()
      await harness.service.pingAndReloadFailedMcpServers()
      await vi.waitFor(() => expect(harness.initialize).toHaveBeenCalledTimes(2))
      expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('recovering')
      const reading = harness.service.getCachedMcpRuntime()
      let returned = false
      void reading.then(() => { returned = true })
      await vi.waitFor(() => expect(returned).toBe(true), { timeout: 500 })
      expect((await reading).tools).toHaveLength(1)
      release([mcpTool])
      await vi.waitFor(() => expect(harness.service.getCachedMcpStatus()?.servers[0].state).toBe('ready'))
      expect((await harness.service.getCachedMcpRuntime()).tools).toHaveLength(1)
    } finally { release([]) }
  })

  it('lets a disable operation supersede an in-flight connection start', async () => {
    let resolveInitialization: ((value: unknown[]) => void) | undefined
    const initialization = new Promise<unknown[]>((resolve) => {
      resolveInitialization = resolve
    })
    const harness = await loadHarness(() => initialization)

    const loading = harness.service.getCachedMcpRuntime(true)
    await vi.waitFor(() => expect(harness.initialize).toHaveBeenCalledTimes(1))

    try {
      harness.setConfig({ enabled: false, servers: [] })
      const disabling = harness.service.loadMcpRuntimeForCurrentConfig(false)
      let disabled = false
      void disabling.then(() => { disabled = true })
      await vi.waitFor(() => expect(harness.closeClient).toHaveBeenCalled())
      expect(disabled).toBe(false)

      resolveInitialization?.([mcpTool])
      const disabledStatus = await disabling
      const runtime = await loading

      expect(disabledStatus.servers).toEqual([])
      expect(runtime.tools).toEqual([])
      expect(harness.service.getCachedMcpStatus()?.servers).toEqual([])
      expect(harness.createClient).toHaveBeenCalledTimes(1)
    } finally {
      resolveInitialization?.([])
    }
  })

  it('drains every overlapping forced start before shutdown completes', async () => {
    const resolvers: Array<(value: unknown[]) => void> = []
    const harness = await loadHarness(() => new Promise((resolve) => {
      resolvers.push(resolve)
    }))

    const firstLoad = harness.service.getCachedMcpRuntime(true)
    await vi.waitFor(() => expect(harness.initialize).toHaveBeenCalledTimes(1))
    const forcedLoad = harness.service.loadMcpRuntimeForCurrentConfig(true)
    await vi.waitFor(() => expect(harness.initialize).toHaveBeenCalledTimes(2))

    let stopped = false
    const shutdown = harness.service.closeCachedMcpRuntime().then(() => {
      stopped = true
    })
    await vi.waitFor(() => expect(harness.closeClient).toHaveBeenCalled())

    resolvers[1]?.([mcpTool])
    await Promise.resolve()
    expect(stopped).toBe(false)

    resolvers[0]?.([mcpTool])
    await Promise.all([firstLoad, forcedLoad, shutdown])
    expect(stopped).toBe(true)
    expect(harness.service.getCachedMcpStatus()?.servers).toEqual([])
  })

  it('tracks an in-flight health probe as shutdown work and closes its session again afterwards', async () => {
    let releaseHealthCheck: (() => void) | undefined
    const harness = await loadHarness(undefined, () => new Promise((resolve) => {
      releaseHealthCheck = resolve
    }))
    const runtime = await harness.service.getCachedMcpRuntime(true)

    const healthCheck = runtime.ping()
    await vi.waitFor(() => expect(harness.ping).toHaveBeenCalledTimes(1))
    let stopped = false
    const shutdown = harness.service.closeCachedMcpRuntime().then(() => {
      stopped = true
    })
    await vi.waitFor(() => expect(harness.closeClient).toHaveBeenCalledTimes(1))
    expect(stopped).toBe(false)

    releaseHealthCheck?.()
    await Promise.all([healthCheck, shutdown])
    expect(stopped).toBe(true)
    expect(harness.closeClient.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('does not let an older reopen race reopen a newer shutdown', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime(true)
    await harness.service.closeCachedMcpRuntime()

    const reopening = harness.service.reopenCachedMcpRuntime()
    const closing = harness.service.closeCachedMcpRuntime()
    await Promise.all([reopening, closing])

    await expect(harness.service.loadMcpRuntimeForCurrentConfig(false)).rejects.toThrow(
      'MCP runtime is unavailable'
    )
  })

  it('retains a client whose close failed so shutdown can be retried', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime(true)
    harness.closeClient
      .mockRejectedValueOnce(new Error('first close failed'))
      .mockRejectedValueOnce(new Error('retry within stop failed'))

    await expect(harness.service.closeCachedMcpRuntime()).rejects.toThrow(
      'Failed to stop every MCP server runtime'
    )
    await expect(harness.service.closeCachedMcpRuntime()).resolves.toBeUndefined()
    expect(harness.service.getCachedMcpStatus()?.servers).toEqual([])
  })

  it('retains a stale client whose close failed during a forced reload', async () => {
    const harness = await loadHarness()
    await harness.service.getCachedMcpRuntime(true)
    const staleClient = harness.clients[0]
    expect(staleClient).toBeDefined()
    staleClient!.close.mockRejectedValueOnce(new Error('reload close failed'))

    await harness.service.loadMcpRuntimeForCurrentConfig(true)
    expect(harness.clients).toHaveLength(2)
    expect(staleClient!.close).toHaveBeenCalledTimes(1)

    await harness.service.closeCachedMcpRuntime()
    expect(staleClient!.close.mock.calls.length).toBeGreaterThanOrEqual(2)
  })
})
