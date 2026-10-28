import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import { LoggingMessageNotificationSchema, ToolListChangedNotificationSchema, type LoggingMessageNotification, type Tool } from '@modelcontextprotocol/sdk/types.js'

export type McpConnection = {
  transport: 'stdio'
  command: string
  args: string[]
  cwd: string
  env: Record<string, string>
} | {
  transport: 'http' | 'sse'
  url: string
  headers?: Record<string, string>
}

export interface McpSessionEvents {
  onError?(error: Error): void
  onClose?(): void
  onMessage?(message: LoggingMessageNotification): void
  onToolsChanged?(): void
}

/** One SDK transport. The application manager owns reconnect scheduling;
 * this session never replays a tool call or silently switches protocols. */
export class McpSession {
  readonly client = new Client({ name: 'anas', version: '1.0.0' }, { capabilities: {} })
  private readonly transport: Transport
  private opening?: Promise<void>
  private stopped = false
  private readonly lifetime = new AbortController()

  constructor(connection: McpConnection, events: McpSessionEvents = {}) {
    this.transport = connection.transport === 'stdio'
      ? new StdioClientTransport({ ...connection, stderr: 'inherit' })
      : connection.transport === 'sse'
        ? new SSEClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } })
        : new StreamableHTTPClientTransport(new URL(connection.url), { requestInit: { headers: connection.headers } })
    this.client.onerror = error => { if (!this.stopped) events.onError?.(error) }
    this.client.onclose = () => { if (!this.stopped) events.onClose?.() }
    this.client.setNotificationHandler(LoggingMessageNotificationSchema, message => { events.onMessage?.(message) })
    this.client.setNotificationHandler(ToolListChangedNotificationSchema, () => { events.onToolsChanged?.() })
  }

  async connect(): Promise<void> {
    if (this.stopped) throw new Error('MCP session has been closed.')
    this.opening ??= this.open()
    await this.opening
    if (this.stopped) throw new Error('MCP session closed during initialization.')
  }

  async close(): Promise<void> {
    this.stopped = true
    this.lifetime.abort(new Error('MCP session closed during initialization.'))
    // Keep the transport reference so a failed close can be retried, including
    // while the SDK is still entering its initialization handshake.
    await this.transport.close()
  }

  private async open(): Promise<void> {
    const signal = this.lifetime.signal
    // SSE may still be waiting for its endpoint event. Closing that transport
    // releases the socket but does not settle the SDK's start promise.
    let onClose!: () => void
    const closed = new Promise<never>((_resolve, reject) => {
      onClose = () => reject(signal.reason)
      signal.addEventListener('abort', onClose, { once: true })
    })
    try {
      await Promise.race([this.client.connect(this.transport, { signal }), closed])
    } finally {
      signal.removeEventListener('abort', onClose)
    }
  }
}

export async function listMcpTools(client: Pick<Client, 'listTools'>): Promise<Tool[]> {
  const tools: Tool[] = []
  const cursors = new Set<string>()
  let cursor: string | undefined
  do {
    const page = await client.listTools(cursor === undefined ? {} : { cursor })
    tools.push(...page.tools)
    cursor = page.nextCursor
    if (cursor !== undefined) {
      if (cursors.has(cursor)) throw new Error('MCP tools/list returned a repeated page cursor.')
      cursors.add(cursor)
    }
  } while (cursor !== undefined)
  return tools
}
