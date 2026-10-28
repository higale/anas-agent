import { defineTool, type ToolDefinition } from '../runtime/toolDefinition'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { CallToolResultSchema, type LoggingMessageNotification, type Progress, type Tool } from '@modelcontextprotocol/sdk/types.js'
import { McpSession, listMcpTools, type McpConnection } from '../mcp/session'
import { projectMcpToolResult } from '../mcp/toolResult'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { processEnvironment } from './config/apiKeys'
import type { McpServerConfig } from './config/appConfig'
import type { McpServerType } from '@shared/types'

export interface McpToolLoadResult {
  tools: ToolDefinition[]
  loaded: Array<{ id: string; index: number; name: string; toolCount: number; toolNames: string[] }>
  errors: Array<{ id: string; index: number; name: string; error: string }>
  ping(): Promise<void>
  close(): Promise<void>
}

export type McpConnectionEndpoint = Readonly<{
  command: string
  argumentCount: number
  workingDirectory?: string
} | {
  origin: string
  pathSegmentCount: number
}>

export interface McpConnectionIdentity {
  readonly transport: McpServerType
  readonly endpoint: McpConnectionEndpoint
  readonly fingerprint: string
}

export interface McpConnectionSnapshot {
  readonly connection: McpConnection
  readonly identity: McpConnectionIdentity
}

export interface McpClientForServer {
  readonly client: McpRuntimeConnection
  readonly connectionIdentity: McpConnectionIdentity
}

export interface McpRuntimeConnection {
  initialize(): Promise<ToolDefinition[]>
  ping(options: { timeout: number }): Promise<unknown>
  close(): Promise<void>
}

interface McpToolInvocation {
  name: string
  args: Record<string, unknown>
}

export interface McpClientHooks {
  beforeToolCall?(call: McpToolInvocation): void | Promise<void>
  afterToolCall?(call: McpToolInvocation & { failed?: boolean }): void | Promise<void>
  onProgress?(progress: Progress, source: McpToolInvocation & { type: 'tool'; server: string }): void
  onConnectionError?(failure: { serverName: string; error: Error }): void
  onConnectionClosed?(): void
  onMessage?(message: LoggingMessageNotification): void
  onToolsListChanged?(): void
}

function processEnv(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(processEnvironment(true)).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  )
}

function authHeaders(apiKey?: string): Record<string, string> | undefined {
  if (!apiKey) return undefined
  return {
    Authorization: `Bearer ${apiKey}`
  }
}

function canonicalJson(value: unknown): string {
  const serialized = JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    return Object.fromEntries(Object.entries(item as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
  })
  if (serialized === undefined) throw new Error('MCP connection identity cannot be serialized.')
  return serialized
}

function connectionFingerprint(value: unknown): string {
  return createHash('sha256')
    .update(canonicalJson(value))
    .digest('hex')
}

export function mcpErrorMessage(error: unknown, credential?: string): string {
  let message: string
  if (error instanceof Error) {
    const detail = 'cause' in error && error.cause ? ` Cause: ${String(error.cause)}` : ''
    message = `${error.message}${detail}`
  } else if (typeof error === 'string') {
    message = error
  } else {
    try {
      message = JSON.stringify(error)
    } catch {
      message = String(error)
    }
  }
  return credential ? message.replaceAll(credential, '[credential]') : message
}

export function mcpConnectionSnapshotForServer(server: McpServerConfig): McpConnectionSnapshot | undefined {
  if (server.type === 'stdio') {
    if (!server.command) return undefined
    const connection = {
      transport: 'stdio',
      command: server.command,
      args: [...server.args],
      cwd: server.workingDir || homedir(),
      env: {
        ...processEnv(),
        ...server.env
      },
    } satisfies McpConnection
    const endpoint = Object.freeze({
      command: connection.command,
      argumentCount: connection.args.length,
      workingDirectory: connection.cwd
    })
    return Object.freeze({
      connection,
      identity: Object.freeze({
        transport: 'stdio',
        endpoint,
        fingerprint: connectionFingerprint({
          transport: connection.transport,
          command: connection.command,
          arguments: connection.args,
          workingDirectory: connection.cwd,
          environment: connection.env,
          defaultToolTimeout: server.timeoutMs
        })
      })
    })
  }

  if (!server.url) return undefined
  const connection = {
    transport: server.type,
    url: server.url,
    headers: authHeaders(server.apiKey)
  } satisfies McpConnection
  let endpoint: McpConnectionEndpoint
  try {
    const parsed = new URL(connection.url)
    endpoint = Object.freeze({
      origin: parsed.origin,
      pathSegmentCount: parsed.pathname.split('/').filter(Boolean).length
    })
  } catch {
    endpoint = Object.freeze({
      origin: 'configured remote endpoint',
      pathSegmentCount: 0
    })
  }
  return Object.freeze({
    connection,
    identity: Object.freeze({
      transport: server.type,
      endpoint,
      fingerprint: connectionFingerprint({
        transport: connection.transport,
        // Preserve the existing durable identity: explicit transport never falls back.
        automaticSSEFallback: false,
        url: connection.url,
        headers: connection.headers ?? {},
        defaultToolTimeout: server.timeoutMs
      })
    })
  })
}

export function createMcpClientForServer(server: McpServerConfig, hooks: McpClientHooks = {}): McpClientForServer {
  const snapshot = mcpConnectionSnapshotForServer(server)
  if (!snapshot) {
    throw new Error(server.type === 'stdio' ? 'Missing command.' : 'Missing URL.')
  }

  const session = new McpSession(snapshot.connection, {
    onError: error => hooks.onConnectionError?.({ serverName: server.id, error }),
    onClose: hooks.onConnectionClosed,
    onMessage: hooks.onMessage,
    onToolsChanged: hooks.onToolsListChanged
  })
  return Object.freeze({
    client: {
      initialize: async () => {
        await session.connect()
        return mcpToolDefinitions(server.id, session.client, await listMcpTools(session.client), { ...hooks, timeoutMs: server.timeoutMs })
      },
      ping: (options: { timeout: number }) => session.client.ping(options),
      close: () => session.close()
    },
    connectionIdentity: snapshot.identity
  })
}

/** Native MCP capabilities share the host tool result and cancellation contract. */
export function mcpToolDefinitions(server: string, client: Pick<Client, 'callTool' | 'readResource'>, definitions: Tool[],
  options: McpClientHooks & { timeoutMs?: number; imageFormat?: 'native' | 'data_url' } = {}): ToolDefinition[] {
  return definitions.map(definition => defineTool({
    name: `mcp__${server}__${definition.name}`,
    description: definition.description ?? '',
    inputSchema: definition.inputSchema,
    metadata: { annotations: definition.annotations },
    execute: async (args, context) => {
      context.signal?.throwIfAborted()
      const invocation = { name: definition.name, args }
      let failed = true
      try {
        await options.beforeToolCall?.(invocation)
        context.signal?.throwIfAborted()
        const timeout = context.timeoutMs ?? options.timeoutMs
        const result = await client.callTool({ name: definition.name, arguments: args }, undefined, {
          signal: context.signal,
          ...(typeof timeout === 'number' && timeout > 0 ? { timeout } : {}),
          onprogress: progress => options.onProgress?.(progress, { ...invocation, type: 'tool', server })
        })
        const output = await projectMcpToolResult(CallToolResultSchema.parse(result), { server, tool: definition.name, client,
          signal: context.signal, imageFormat: options.imageFormat })
        failed = false
        return { content: output.content, artifact: output.artifacts }
      } finally {
        await options.afterToolCall?.({ ...invocation, failed })
      }
    }
  }))
}
