import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type { Client } from '@modelcontextprotocol/sdk/client/index.js'

export class McpToolResultError extends Error {
  constructor(server: string, tool: string, readonly result: CallToolResult) {
    super(`MCP tool '${tool}' on server '${server}' returned an error: ${result.content
      .filter(block => block.type === 'text').map(block => block.text).join('\n')}`)
    this.name = 'McpToolResultError'
  }
}

export interface McpToolOutput {
  content: string | Record<string, unknown>[]
  artifacts: Record<string, unknown>[]
}

/** Preserve protocol data in the existing product content/artifact slots.
 * A confirmed remote error is distinct from losing the transport after dispatch. */
export async function projectMcpToolResult(result: CallToolResult, options: {
  server: string
  tool: string
  client: Pick<Client, 'readResource'>
  signal?: AbortSignal
  imageFormat?: 'native' | 'data_url'
}): Promise<McpToolOutput> {
  if (result.isError) throw new McpToolResultError(options.server, options.tool, result)
  const content: Record<string, unknown>[] = []
  const artifacts: Record<string, unknown>[] = []
  for (const block of result.content) {
    options.signal?.throwIfAborted()
    switch (block.type) {
      case 'text':
        content.push({ type: 'text', source_type: 'text', text: block.text })
        break
      case 'image':
        content.push(options.imageFormat === 'data_url'
          ? { type: 'image_url', image_url: { url: `data:${block.mimeType};base64,${block.data}` } }
          : { type: 'image', source_type: 'base64', data: block.data, mime_type: block.mimeType })
        break
      case 'audio':
        content.push({ type: 'audio', source_type: 'base64', data: block.data, mime_type: block.mimeType })
        break
      case 'resource_link':
        content.push({ type: 'file', source_type: 'url', url: block.uri, mime_type: block.mimeType })
        break
      case 'resource': {
        const source = block.resource
        const resources = ('text' in source && typeof source.text === 'string') || ('blob' in source && typeof source.blob === 'string')
          ? [source] : (await options.client.readResource({ uri: source.uri }, { signal: options.signal })).contents
        for (const resource of resources) {
          artifacts.push({ type: 'file', mime_type: resource.mimeType, metadata: { uri: resource.uri },
            ...('blob' in resource ? { source_type: 'base64', data: resource.blob }
              : { source_type: 'text', text: resource.text }) })
        }
        break
      }
      default: throw new Error(`MCP tool '${options.tool}' returned an unsupported content block.`)
    }
  }
  if (result.structuredContent !== undefined) artifacts.push({ type: 'mcp_structured_content', data: result.structuredContent })
  if (result._meta !== undefined) artifacts.push({ type: 'mcp_meta', data: result._meta })
  if (content.length === 1 && content[0].type === 'text') {
    if (result.structuredContent === undefined && result._meta === undefined) return { content: content[0].text as string, artifacts }
    content[0] = { ...content[0], ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
      ...(result._meta !== undefined ? { meta: result._meta } : {}) }
  }
  return { content, artifacts }
}
