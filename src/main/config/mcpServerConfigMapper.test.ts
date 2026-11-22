import { describe, expect, it } from 'vitest'
import { mcpConfigKey, normalizeMcpServer, rawMcpServerFromSave } from './mcpServerConfigMapper'

describe('MCP server configuration', () => {
  it('binds the catalog to connection settings independently of display order and choices', () => {
    const server = normalizeMcpServer({ id: 'search', type: 'stdio', command: 'node', env: { A: 'a', B: 'b' } }, 0)
    const key = mcpConfigKey(server)
    expect(mcpConfigKey({ ...server, index: 2, name: 'Renamed', enabled: !server.enabled,
      toolCatalog: { connection_key: key, tools: [] }, toolChoices: { lookup: false }, env: { B: 'b', A: 'a' } })).toBe(key)
    for (const change of [{ command: 'other' }, { id: 'new_id' }, { timeoutMs: 1234 }, { env: { A: 'changed' } }]) {
      expect(mcpConfigKey({ ...server, ...change })).not.toBe(key)
    }
  })

  it('defaults optional catalog fields and rejects malformed saved definitions and choices', () => {
    expect(normalizeMcpServer({ id: 'search' }, 0)).toMatchObject({ toolCatalog: undefined, toolChoices: {} })
    expect(() => normalizeMcpServer({ id: 'search', tool_choices: { lookup: 'false' } }, 0)).toThrow('choices')
    const tool = { name: 'lookup', description: '', input_schema: { type: 'object' } }
    expect(() => normalizeMcpServer({ id: 'search', tool_catalog: { connection_key: 'a'.repeat(64), tools: [tool, tool] } }, 0)).toThrow('cached tool')
    expect(() => normalizeMcpServer({ id: 'search', tool_catalog: { connection_key: '', tools: [] } }, 0)).toThrow('catalog')
  })

  it('allows changing the server ID used as the tool-name namespace', () => {
    expect(rawMcpServerFromSave({
      index: 0,
      name: 'Search',
      enabled: true,
      timeoutMs: 30_000,
      type: 'stdio',
      id: 'clear_search',
      command: 'node',
      args: [],
      env: {}
    }, {
      id: 'mcp_server_1',
      name: 'Search',
      enabled: false,
      type: 'stdio',
      command: 'node'
    })).toMatchObject({
      id: 'clear_search',
      name: 'Search'
    })
  })
})
