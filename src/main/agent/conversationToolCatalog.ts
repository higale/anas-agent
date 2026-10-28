import { commandShellCapabilityId, isCommandShellMetadata } from '@shared/commandShell'
import { sortToolDefinitions } from '@shared/toolRegistry'
import { planningToolSpec } from '../../runtime/planning'
import type { prepareAgentRuntimeResources } from './agentRuntimeResources'
import { managedToolDescription } from './managedToolRuntime'

/** Execution and request previews expose the same product tool order and text. */
export function conversationToolCatalog(resources: Awaited<ReturnType<typeof prepareAgentRuntimeResources>>) {
  const { runtimeTools, fileTools, subagentTools, customTools, pluginTools, activeMcpTools } = resources
  const definitions = [...runtimeTools, ...fileTools, ...subagentTools, ...customTools, ...pluginTools]
  const planning = resources.toolsEnabled && resources.features.planning
  const declarations = sortToolDefinitions([
    ...definitions.map(tool => ({ name: tool.name, inputSchema: tool.inputSchema, metadata: tool.metadata,
      description: managedToolDescription(tool, resources.capabilities.backgroundTools) })),
    ...(planning ? [planningToolSpec] : [])
  ], tool => isCommandShellMetadata('metadata' in tool ? tool.metadata : undefined) ? commandShellCapabilityId : tool.name,
  [...customTools, ...pluginTools, ...activeMcpTools].map(tool => tool.name))
  return { definitions, declarations, planning }
}
