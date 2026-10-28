import { describe, expect, it, vi } from 'vitest'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { McpToolResultError, projectMcpToolResult } from './toolResult'

describe('native MCP result projection', () => {
  const client = { readResource: vi.fn() }
  const options = { server: 'fixture', tool: 'read', client }

  it('keeps text-only results simple and retains structured data and metadata as artifacts', async () => {
    expect(await projectMcpToolResult({ content: [{ type: 'text', text: 'done' }] }, options)).toEqual({ content: 'done', artifacts: [] })
    const raw = { content: [{ type: 'text' as const, text: 'done' }], structuredContent: { zero: 0, disabled: false }, _meta: { source: 'fixture' } }
    const before = JSON.stringify(raw)
    expect(await projectMcpToolResult(raw, options)).toEqual({
      content: [{ type: 'text', source_type: 'text', text: 'done', structuredContent: raw.structuredContent, meta: raw._meta }],
      artifacts: [{ type: 'mcp_structured_content', data: raw.structuredContent }, { type: 'mcp_meta', data: raw._meta }]
    })
    expect(JSON.stringify(raw)).toBe(before)
  })

  it('preserves images, audio, resource links and embedded text/blob artifacts', async () => {
    const result: CallToolResult = { content: [
      { type: 'image', data: 'AA==', mimeType: 'image/png' }, { type: 'audio', data: 'BB==', mimeType: 'audio/wav' },
      { type: 'resource_link', uri: 'file:///fixture/result.txt', name: 'result', mimeType: 'text/plain' },
      { type: 'resource', resource: { uri: 'fixture:text', text: 'retained text', mimeType: 'text/plain' } },
      { type: 'resource', resource: { uri: 'fixture:blob', blob: 'CC==', mimeType: 'application/pdf' } }
    ] }
    const output = await projectMcpToolResult(result, options)
    expect(output.content).toEqual([
      { type: 'image', source_type: 'base64', data: 'AA==', mime_type: 'image/png' },
      { type: 'audio', source_type: 'base64', data: 'BB==', mime_type: 'audio/wav' },
      { type: 'file', source_type: 'url', url: 'file:///fixture/result.txt', mime_type: 'text/plain' }
    ])
    expect(output.artifacts).toEqual([
      { type: 'file', source_type: 'text', text: 'retained text', mime_type: 'text/plain', metadata: { uri: 'fixture:text' } },
      { type: 'file', source_type: 'base64', data: 'CC==', mime_type: 'application/pdf', metadata: { uri: 'fixture:blob' } }
    ])
    expect(client.readResource).not.toHaveBeenCalled()
    const legacy = await projectMcpToolResult({ content: [result.content[0]] }, { ...options, imageFormat: 'data_url' })
    expect(legacy.content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }])
  })

  it('keeps a confirmed remote error distinct from transport failure and cancellation', async () => {
    const raw: CallToolResult = { isError: true, content: [{ type: 'text', text: 'target unavailable' }], _meta: { diagnostic: 'retained' } }
    try { await projectMcpToolResult(raw, options); throw new Error('Expected remote failure') } catch (error) {
      expect(error).toBeInstanceOf(McpToolResultError)
      expect((error as McpToolResultError).result).toBe(raw)
      expect((error as Error).message).toContain('target unavailable')
    }
    const controller = new AbortController(), cancellation = new Error('Cancelled projection')
    controller.abort(cancellation)
    await expect(projectMcpToolResult({ content: [{ type: 'text', text: 'result' }] }, { ...options, signal: controller.signal })).rejects.toBe(cancellation)
  })
})
