import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { McpSession, listMcpTools } from './session'

describe('native MCP sessions', () => {
  it('loads every tools page and rejects a repeated cursor without looping forever', async () => {
    const listTools = vi.fn().mockResolvedValueOnce({ tools: [{ name: 'first' }], nextCursor: 'next' })
      .mockResolvedValueOnce({ tools: [{ name: 'second' }] })
    expect(await listMcpTools({ listTools })).toEqual([{ name: 'first' }, { name: 'second' }])
    expect(listTools.mock.calls).toEqual([[{}], [{ cursor: 'next' }]])
    listTools.mockReset().mockResolvedValue({ tools: [], nextCursor: 'again' })
    await expect(listMcpTools({ listTools })).rejects.toThrow('repeated page cursor')
    expect(listTools).toHaveBeenCalledTimes(2)
  })

  it('uses the selected stdio working directory and environment and closes the process', async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'anas-native-mcp-')))
    const onClose = vi.fn()
    const session = new McpSession({ transport: 'stdio', command: process.execPath,
      args: [fileURLToPath(new URL('./stdioFixture.mjs', import.meta.url))], cwd: directory,
      env: { ELECTRON_RUN_AS_NODE: '1', ANAS_MCP_TEST: 'isolated-value' } }, { onClose })
    try {
      await session.connect()
      expect((await listMcpTools(session.client)).map(tool => tool.name)).toEqual(['context'])
      const result = await session.client.callTool({ name: 'context', arguments: {} })
      expect(result.content).toEqual([{ type: 'text', text: JSON.stringify({ cwd: directory, selected: 'isolated-value' }) }])
      await session.close()
      await expect(session.connect()).rejects.toThrow('closed')
      expect(onClose).not.toHaveBeenCalled()
    } finally { await session.close(); await rm(directory, { recursive: true, force: true }) }
  })

  it.each(['http', 'sse'] as const)('settles initialization when %s is closed before the handshake completes', async protocol => {
    let received!: () => void
    const requestReceived = new Promise<void>(resolve => { received = resolve })
    const http = createServer((_request, response) => {
      if (protocol === 'sse') {
        response.writeHead(200, { 'Content-Type': 'text/event-stream' })
        response.write(': waiting for endpoint\n\n')
      }
      received()
    })
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('Missing fixture address')
    const session = new McpSession({ transport: protocol, url: `http://127.0.0.1:${address.port}/mcp` })
    try {
      const opening = session.connect()
      const rejected = expect(opening).rejects.toThrow(/closed|aborted/i)
      await requestReceived
      await session.close()
      await rejected
      await expect(session.connect()).rejects.toThrow('closed')
    } finally {
      await session.close()
      http.closeAllConnections()
      await new Promise<void>(resolve => http.close(() => resolve()))
    }
  }, 3000)

  it.each(['http', 'sse'] as const)('keeps %s authentication, notifications, request identity and cancellation', async protocol => {
    const remote = new Server({ name: 'anas-local-fixture', version: '1.0.0' }, { capabilities: { tools: { listChanged: true }, logging: {} } })
    const calls: Array<{ id: string | number; signal: AbortSignal }> = []
    remote.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'wait', inputSchema: { type: 'object' } }] }))
    remote.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
      calls.push({ id: extra.requestId, signal: extra.signal })
      const token = request.params._meta?.progressToken
      if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: 0, total: 1 } })
      await new Promise<void>(resolve => { if (extra.signal.aborted) resolve(); else extra.signal.addEventListener('abort', () => resolve(), { once: true }) })
      return { content: [{ type: 'text', text: 'cancelled fixture' }] }
    })
    let transport: SSEServerTransport | StreamableHTTPServerTransport | undefined
    const headers: Array<string | undefined> = []
    const http = createServer((request, response) => {
      headers.push(request.headers.authorization)
      if (protocol === 'sse' && request.method === 'GET') {
        transport = new SSEServerTransport('/messages', response)
        void remote.connect(transport)
      } else if (transport instanceof SSEServerTransport) void transport.handlePostMessage(request, response)
      else if (transport instanceof StreamableHTTPServerTransport) void transport.handleRequest(request, response)
      else response.writeHead(503).end()
    })
    if (protocol === 'http') {
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID })
      await remote.connect(transport)
    }
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    const address = http.address()
    if (!address || typeof address === 'string') throw new Error('Missing local fixture address')
    const changed = vi.fn(), message = vi.fn(), progress = vi.fn()
    const session = new McpSession({ transport: protocol, url: `http://127.0.0.1:${address.port}/mcp`, headers: { Authorization: 'Bearer local-fixture' } }, {
      onToolsChanged: changed, onMessage: message
    })
    const controller = new AbortController()
    try {
      await session.connect()
      expect((await listMcpTools(session.client))[0].name).toBe('wait')
      await remote.notification({ method: 'notifications/tools/list_changed' })
      await remote.notification({ method: 'notifications/message', params: { level: 'info', data: 'fixture log' } })
      await vi.waitFor(() => { expect(changed).toHaveBeenCalledOnce(); expect(message).toHaveBeenCalledOnce() })
      const request = session.client.callTool({ name: 'wait', arguments: {} }, undefined, { signal: controller.signal, onprogress: progress })
      const rejection = expect(request).rejects.toThrow()
      await vi.waitFor(() => expect(progress).toHaveBeenCalledOnce())
      controller.abort(new Error('Stop this invocation'))
      await rejection
      await vi.waitFor(() => expect(calls[0].signal.aborted).toBe(true))
      await expect(session.client.ping()).resolves.toBeDefined()
      expect(calls).toHaveLength(1)
      await expect(session.client.callTool({ name: 'wait', arguments: {} }, undefined, { timeout: 50 })).rejects.toThrow(/timed out/i)
      await vi.waitFor(() => expect(calls[1].signal.aborted).toBe(true))
      await expect(session.client.ping()).resolves.toBeDefined()
      expect(calls).toHaveLength(2)
      expect(headers.length).toBeGreaterThan(2)
      expect(headers.every(value => value === 'Bearer local-fixture')).toBe(true)
    } finally {
      controller.abort()
      await session.close()
      await remote.close()
      http.closeAllConnections()
      await new Promise<void>(resolve => http.close(() => resolve()))
    }
  })
})
