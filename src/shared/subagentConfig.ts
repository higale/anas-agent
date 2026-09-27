import rawSubagentsConfig from '../../data/config/subagents.json'
import { parseCapabilities } from './agentCapabilities'
import type { SubagentDefaults } from './types'

export const defaultSubagentConfig: SubagentDefaults = {
  enabled: rawSubagentsConfig.subagent_defaults.enabled,
  capabilities: parseCapabilities(rawSubagentsConfig.subagent_defaults.capabilities)
}
