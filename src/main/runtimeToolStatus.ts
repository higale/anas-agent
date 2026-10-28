import { selectedSubagents } from '@shared/subagentSelection'
import { DEFAULT_WORKSPACE_PROJECT_ID, type AppConfigSnapshot, type RuntimeToolStatus } from '@shared/types'
import { planningToolSpec } from '../runtime/planning'
import { fileToolDefinitions } from './llm/fileTools'
import { runtimeToolDefinitions } from './llm/runtimeTools'
import { serializeToolDefinition } from './toolSchemaSerialization'
import { subagentToolDefinitions } from './agent/subagentTools'
import { runtimeToolSelectionId, sortToolDefinitions } from '@shared/toolRegistry'

export function agentToolDefinitions(
  subagents: AppConfigSnapshot['subagents'] = []
): RuntimeToolStatus['tools'] {
  return [serializeToolDefinition(planningToolSpec), ...subagentToolDefinitions({ subagents }).map(serializeToolDefinition)]
}

export async function getRuntimeToolStatus(
  config: AppConfigSnapshot
): Promise<RuntimeToolStatus> {
  const runtimeTools = await runtimeToolDefinitions({
    enabled: true,
    primaryFolder: process.cwd(),
    configuration: true,
    memory: true,
    memoryStore: {
      searchMemories: async () => ({ items: [], total: 0 }),
      saveMemory: async () => {
        throw new Error('Memory writes are unavailable in the settings tool preview.')
      },
      deleteMemory: async () => {
        throw new Error('Memory deletion is unavailable in the settings tool preview.')
      }
    },
    projectId: DEFAULT_WORKSPACE_PROJECT_ID,
    network: true,
    shell: true,
    backgroundTools: true,
    shellRunner: async () => JSON.stringify({
      ok: false,
      error: 'The command shell is not connected in the settings preview.'
    })
  })
  const tools = sortToolDefinitions([
    ...agentToolDefinitions(
      selectedSubagents(config.subagents)
    ),
    ...runtimeTools.map(serializeToolDefinition),
    ...fileToolDefinitions({
      maxReadBytes: null,
      primaryFolder: process.cwd()
    }).map(serializeToolDefinition)
  ], runtimeToolSelectionId)
  return {
    checkedAt: new Date().toISOString(),
    tools,
    toolNames: tools.map((tool) => tool.name)
  }
}
