import { requireDataVersion } from './dataVersion'
import rawTemplates from '../../data/config/model-extra-parameter-templates.json'
import { mergeModelParameters } from './modelConfig'
import type { ModelProtocol } from './types'

requireDataVersion(rawTemplates, 0, 'model extra parameter templates')

export interface ModelExtraParameterTemplate {
  path: string[]
  description: string
  example: unknown
  range?: string
  note?: string
}

interface ModelExtraParameterGroup {
  label: string
  source: string
  parameters: ModelExtraParameterTemplate[]
}

export const modelExtraParameterGroups: Record<ModelProtocol, ModelExtraParameterGroup[]> = {
  openai_chat_completions: rawTemplates.openai_chat_completions,
  openai_responses: rawTemplates.openai_responses,
  anthropic_messages: rawTemplates.anthropic_messages
}

export function modelExtraParameterStatus(
  parameters: Record<string, unknown>,
  path: string[]
): 'missing' | 'present' | 'conflict' {
  let value: unknown = parameters
  for (const key of path) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return 'conflict'
    if (!Object.hasOwn(value, key)) return 'missing'
    value = (value as Record<string, unknown>)[key]
  }
  return 'present'
}

export function addModelExtraParameter(
  parameters: Record<string, unknown>,
  template: ModelExtraParameterTemplate
): Record<string, unknown> {
  if (modelExtraParameterStatus(parameters, template.path) !== 'missing') return parameters
  const defaults = template.path.reduceRight<unknown>((value, key) => ({ [key]: value }), template.example)
  return mergeModelParameters(defaults as Record<string, unknown>, parameters)
}
