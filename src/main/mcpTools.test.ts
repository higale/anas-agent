import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from './config/appConfig'
import { mcpServerConfigDetail, normalizeMcpServer, rawMcpServerFromSave } from './config/mcpServerConfigMapper'
import { createMcpClientForServer, mcpConnectionSnapshotForServer, mcpErrorMessage, mcpToolDefinitions } from './mcpTools'

describe('native MCP capabilities', () => {
  it.each([undefined, 0, 250])('preserves the invocation timeout override %s and explicit result data', async timeoutMs => {
    const callTool = vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }], structuredContent: { enabled: false, count: 0 } }))
    const client = { callTool, readResource: vi.fn() } as unknown as Parameters<typeof mcpToolDefinitions>[1]
    const afterToolCall = vi.fn()
    const [tool] = mcpToolDefinitions('local', client, [{ name: 'read', inputSchema: { type: 'object' } }], { timeoutMs: 1000, afterToolCall })
    const controller = new AbortController()
    const result = await tool.execute({}, { signal: controller.signal, timeoutMs })
    const options = callTool.mock.calls[0] as unknown as [unknown, unknown, { timeout?: number; signal: AbortSignal }]
    expect(options[2].signal).toBe(controller.signal)
    expect(options[2].timeout).toBe(timeoutMs === 0 ? undefined : timeoutMs ?? 1000)
    expect(result.artifact).toEqual([{ type: 'mcp_structured_content', data: { enabled: false, count: 0 } }])
    expect(afterToolCall).toHaveBeenCalledExactlyOnceWith({ name: 'read', args: {}, failed: false })
  })

  it('does not dispatch or save a new intent when already cancelled', async () => {
    const callTool = vi.fn(), beforeToolCall = vi.fn()
    const client = { callTool, readResource: vi.fn() } as unknown as Parameters<typeof mcpToolDefinitions>[1]
    const [tool] = mcpToolDefinitions('local', client, [{ name: 'read', inputSchema: { type: 'object' } }], { beforeToolCall })
    const controller = new AbortController()
    controller.abort(new Error('Stopped'))
    await expect(tool.execute({}, { signal: controller.signal })).rejects.toThrow('Stopped')
    expect(beforeToolCall).not.toHaveBeenCalled()
    expect(callTool).not.toHaveBeenCalled()
  })
})

const stdioServer: McpServerConfig = {
  index: 0,
  name: 'Alpha',
  enabled: true,
  timeoutMs: 1000,
  type: 'stdio',
  id: 'alpha',
  command: 'alpha-server',
  args: ['--serve'],
  workingDir: 'D:/workspace',
  env: {}
}

describe('MCP connection snapshots', () => {
  it.each([undefined, '', ' \t '])('uses the home directory for a blank stdio working directory (%j) without persisting it', (workingDir) => {
    const raw = rawMcpServerFromSave({ ...stdioServer, workingDir })
    const server = normalizeMcpServer(raw, 0)
    const snapshot = mcpConnectionSnapshotForServer(server)
    const explicitHome = mcpConnectionSnapshotForServer({ ...server, workingDir: homedir() })

    expect(raw.working_dir?.trim()).toBe('')
    expect(mcpServerConfigDetail(raw, 0).workingDir).toBe('')
    expect(snapshot?.connection).toMatchObject({ transport: 'stdio', cwd: homedir() })
    expect(snapshot?.identity.endpoint).toMatchObject({ workingDirectory: homedir() })
    expect(snapshot?.identity.fingerprint).toBe(explicitHome?.identity.fingerprint)
    expect(snapshot?.identity.fingerprint).not.toBe(mcpConnectionSnapshotForServer(stdioServer)?.identity.fingerprint)
  })

  it.each(['http', 'sse'] as const)('preserves explicit %s transport and disables automatic SSE fallback', (type) => {
    const snapshot = mcpConnectionSnapshotForServer({
      ...stdioServer,
      type,
      command: undefined,
      url: 'https://example.test/mcp'
    })

    expect(snapshot?.connection).toMatchObject({ transport: type })
    expect(snapshot?.identity.transport).toBe(type)
    expect(mcpConnectionSnapshotForServer(stdioServer)?.connection).not.toHaveProperty('automaticSSEFallback')
  })

  it('reports HTTP initialization failure without opening a legacy SSE connection', async () => {
    const methods: Array<string | undefined> = []
    const server = createServer((request, response) => {
      methods.push(request.method)
      response.writeHead(405).end('Method not allowed')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Missing test server address')
    const { client } = createMcpClientForServer({
      ...stdioServer,
      type: 'http',
      command: undefined,
      url: `http://127.0.0.1:${address.port}/sse`
    })

    try {
      await expect(client.initialize()).rejects.toThrow('Method not allowed')
      expect(methods).toEqual(['POST'])
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })

  it('removes the configured credential from error messages and causes', () => {
    const credential = 'mcp-secret-canary'
    const error = new Error(`Request rejected for Bearer ${credential}`, {
      cause: `remote response included ${credential}`
    })

    const message = mcpErrorMessage(error, credential)
    expect(message).not.toContain(credential)
    expect(message).toBe('Request rejected for Bearer [credential] Cause: remote response included [credential]')
  })

  it('derives a secret-safe identity from the same effective stdio environment passed to the client', () => {
    const inheritedEnvKey = 'ANAS_MCP_SNAPSHOT_TEST'
    const previousValue = process.env[inheritedEnvKey]
    try {
      process.env[inheritedEnvKey] = 'first-secret-value'
      const first = mcpConnectionSnapshotForServer(stdioServer)
      expect(first).toBeDefined()
      expect((first?.connection as { env?: Record<string, string> }).env?.[inheritedEnvKey])
        .toBe('first-secret-value')
      expect(JSON.stringify(first?.identity)).not.toContain('first-secret-value')

      process.env[inheritedEnvKey] = 'second-secret-value'
      const second = mcpConnectionSnapshotForServer(stdioServer)
      expect(second).toBeDefined()
      expect(first?.identity.fingerprint).not.toBe(second?.identity.fingerprint)
      expect(first?.identity.endpoint).toEqual({
        command: 'alpha-server',
        argumentCount: 1,
        workingDirectory: 'D:/workspace'
      })
    } finally {
      if (previousValue === undefined) delete process.env[inheritedEnvKey]
      else process.env[inheritedEnvKey] = previousValue
    }
  })

  it('includes the actual remote authorization header in the fingerprint without exposing it', () => {
    const first = mcpConnectionSnapshotForServer({
      ...stdioServer,
      type: 'http',
      command: undefined,
      url: 'https://example.test/mcp',
      apiKey: 'first-api-key'
    })
    const second = mcpConnectionSnapshotForServer({
      ...stdioServer,
      type: 'http',
      command: undefined,
      url: 'https://example.test/mcp',
      apiKey: 'second-api-key'
    })

    expect((first?.connection as { headers?: Record<string, string> }).headers?.Authorization)
      .toBe('Bearer first-api-key')
    expect(first?.identity.fingerprint).not.toBe(second?.identity.fingerprint)
    expect(JSON.stringify(first?.identity)).not.toContain('first-api-key')
    expect(JSON.stringify(second?.identity)).not.toContain('second-api-key')
  })

  it('keeps stdio arguments and remote URL credentials out of the display endpoint', () => {
    const stdioSecret = 'stdio-secret-canary'
    const stdio = mcpConnectionSnapshotForServer({
      ...stdioServer,
      args: ['--token', stdioSecret]
    })
    const changedStdio = mcpConnectionSnapshotForServer({
      ...stdioServer,
      args: ['--token', 'different-secret']
    })
    expect((stdio?.connection as { args?: string[] }).args).toContain(stdioSecret)
    expect(JSON.stringify(stdio?.identity)).not.toContain(stdioSecret)
    expect(stdio?.identity.endpoint).toEqual({
      command: 'alpha-server',
      argumentCount: 2,
      workingDirectory: 'D:/workspace'
    })
    expect(stdio?.identity.fingerprint).not.toBe(changedStdio?.identity.fingerprint)

    const remoteSecret = 'remote-secret-canary'
    const remote = mcpConnectionSnapshotForServer({
      ...stdioServer,
      type: 'http',
      command: undefined,
      url: `https://user:${remoteSecret}@example.test/hooks/${remoteSecret}/mcp?token=${remoteSecret}`
    })
    const changedRemote = mcpConnectionSnapshotForServer({
      ...stdioServer,
      type: 'http',
      command: undefined,
      url: 'https://user:different-secret@example.test/hooks/different-secret/mcp?token=different-secret'
    })
    expect((remote?.connection as { url?: string }).url).toContain(remoteSecret)
    expect(JSON.stringify(remote?.identity)).not.toContain(remoteSecret)
    expect(remote?.identity.endpoint).toEqual({
      origin: 'https://example.test',
      pathSegmentCount: 3
    })
    expect(remote?.identity.fingerprint).not.toBe(changedRemote?.identity.fingerprint)
  })

  it('binds the effective tool timeout into the connection fingerprint', () => {
    const first = mcpConnectionSnapshotForServer(stdioServer)
    const second = mcpConnectionSnapshotForServer({
      ...stdioServer,
      timeoutMs: stdioServer.timeoutMs + 1
    })

    expect(first?.identity.endpoint).toEqual(second?.identity.endpoint)
    expect(first?.identity.fingerprint).not.toBe(second?.identity.fingerprint)
  })
})
