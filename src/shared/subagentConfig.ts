import rawSubagentsConfig from '../../data/config/subagents.json'
import { parseCapabilities } from './agentCapabilities'
import type { ProjectModelSelection, SubagentDefaults } from './types'

/** Missing fields follow the parent; null explicitly selects no parameter preset. */
export function validateSubagentModelSelection(value: { modelConfigId?: unknown; modelParameterPresetId?: unknown }): ProjectModelSelection {
  const { modelConfigId, modelParameterPresetId } = value
  if (modelConfigId !== undefined && (typeof modelConfigId !== 'string' || !modelConfigId.trim())) {
    throw new Error('Invalid subagent model configuration ID.')
  }
  if (modelParameterPresetId !== undefined && modelParameterPresetId !== null
    && (typeof modelParameterPresetId !== 'string' || !modelParameterPresetId.trim())) {
    throw new Error('Invalid subagent model parameter preset ID.')
  }
  if (modelParameterPresetId !== undefined && !modelConfigId) throw new Error('A subagent parameter preset requires a model.')
  return { ...(modelConfigId ? { modelConfigId } : {}),
    ...(modelParameterPresetId !== undefined ? { modelParameterPresetId } : {}) }
}

export const defaultSubagentConfig: SubagentDefaults = {
  enabled: rawSubagentsConfig.subagent_defaults.enabled,
  capabilities: parseCapabilities(rawSubagentsConfig.subagent_defaults.capabilities)
}
