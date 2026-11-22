/** Persisted discovery metadata, independent of live MCP connections. */
export interface McpCatalogTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
  annotations?: Record<string, unknown>
}
export interface McpToolCatalog { connection_key: string; tools: McpCatalogTool[] }

export function parseMcpToolChoices(value: unknown): Record<string, boolean> {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.entries(value).some(([name, enabled]) => !name || typeof enabled !== 'boolean')) throw new Error('Invalid MCP tool choices.')
  return Object.fromEntries(Object.entries(value)) as Record<string, boolean>
}

export function parseMcpToolCatalog(value: unknown): McpToolCatalog | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid MCP tool catalog.')
  const raw = value as McpToolCatalog
  if (typeof raw.connection_key !== 'string' || !/^[a-f0-9]{64}$/.test(raw.connection_key) || !Array.isArray(raw.tools)) throw new Error('Invalid MCP tool catalog.')
  const names = new Set<string>()
  for (const tool of raw.tools) {
    if (!tool || typeof tool.name !== 'string' || !tool.name || names.has(tool.name)
      || typeof tool.description !== 'string' || !tool.input_schema || typeof tool.input_schema !== 'object' || Array.isArray(tool.input_schema)
      || (tool.annotations !== undefined && (!tool.annotations || typeof tool.annotations !== 'object' || Array.isArray(tool.annotations)))) throw new Error('Invalid MCP cached tool.')
    names.add(tool.name)
  }
  return raw
}
