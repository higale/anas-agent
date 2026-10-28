import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const server = new Server({ name: 'anas-isolated-stdio-fixture', version: '1.0.0' }, { capabilities: { tools: {} } })
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'context', inputSchema: { type: 'object' } }] }))
server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: JSON.stringify({
  cwd: process.cwd(), selected: process.env.ANAS_MCP_TEST
}) }] }))
await server.connect(new StdioServerTransport())
