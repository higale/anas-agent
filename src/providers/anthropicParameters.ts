import type Anthropic from '@anthropic-ai/sdk'
import type { AnthropicModelParameters } from './modelParameters'

// Preserve the imported product's @langchain/anthropic 1.5.10 parameter rules.
// These are request defaults, not limits inferred from a provider response.
type Fields = Record<string, unknown>
export interface AnthropicRequestSettings {
  model: string
  maxOutputTokens?: number
  streaming: boolean
  parameters: AnthropicModelParameters
}
export interface AnthropicCallParameters {
  tools?: Fields[]
  toolChoice?: string | Fields
  stop?: string[]
  betas?: string[]
  outputConfig?: Fields
  outputFormat?: unknown
  container?: unknown
  inferenceGeo?: string
  mcpServers?: unknown
  cacheControl?: unknown
}

const adaptivePrefixes = ['claude-opus-4-7', 'claude-opus-4-8', 'claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5', 'claude-mythos-preview']
const modernPrefixes = ['claude-opus-5', 'claude-sonnet-5', 'claude-fable-5', 'claude-mythos-5', 'claude-mythos-preview',
  'claude-opus-4-7', 'claude-opus-4-6', 'claude-sonnet-4-6', 'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1', 'claude-sonnet-4', 'claude-opus-4']
const toolBetas: Record<string, string> = {
  tool_search_tool_regex_20251119: 'advanced-tool-use-2025-11-20', tool_search_tool_bm25_20251119: 'advanced-tool-use-2025-11-20',
  memory_20250818: 'context-management-2025-06-27', web_fetch_20250910: 'web-fetch-2025-09-10',
  code_execution_20250825: 'code-execution-2025-08-25', computer_20251124: 'computer-use-2025-11-24',
  computer_20250124: 'computer-use-2025-01-24', mcp_toolset: 'mcp-client-2025-11-20'
}

function fields(value: unknown): Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {}
}

function optionalObject(value: unknown, name: string): Fields {
  if (value === undefined) return {}
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Anthropic ${name} must be an object.`)
  return value as Fields
}

export function defaultAnthropicOutputTokens(model: string): number {
  if (modernPrefixes.some(prefix => model.startsWith(prefix))) return 16384
  if (['claude-3-7-sonnet', 'claude-3-5-sonnet', 'claude-3-5-haiku'].some(prefix => model.startsWith(prefix))) return 8192
  return 4096
}

function sampling(model: string, parameters: AnthropicModelParameters, outputConfig: Fields): Fields {
  const thinking = optionalObject(parameters.thinking, 'thinking')
  const type = thinking.type ?? 'disabled'
  const adaptive = adaptivePrefixes.some(prefix => model.startsWith(prefix))
  const fable = model.startsWith('claude-fable-5')
  const enabled = type === 'enabled' || type === 'adaptive'
  const { temperature, top_k: topK, top_p: topP } = parameters
  if (fable && parameters.thinking !== undefined && type === 'disabled') throw new Error(`thinking.type="disabled" is not supported for ${model}; omit thinking to use adaptive thinking instead`)
  if (adaptive && type === 'enabled') throw new Error(`thinking.type="enabled" is not supported for ${model}; use thinking.type="adaptive" instead`)
  if (adaptive && 'budget_tokens' in thinking) throw new Error(`thinking.budget_tokens is not supported for ${model}; use output_config.effort instead`)
  if (model.startsWith('claude-opus-5') && type === 'disabled' && ['xhigh', 'max'].includes(String(outputConfig.effort))) {
    throw new Error(`thinking.type="disabled" is not supported for ${model} with output_config.effort="${outputConfig.effort}"; use thinking.type="adaptive" or omit thinking instead`)
  }
  if (adaptive) {
    if (topK !== undefined) throw new Error(`topK is not supported for ${model}; omit topK/topP/temperature or use model prompting instead`)
    if (topP !== undefined && topP !== 1) throw new Error(`topP is not supported for ${model} when set to non-default values`)
    if (temperature !== undefined && temperature !== 1) throw new Error(`temperature is not supported for ${model} when set to non-default values`)
  }
  if (!fable && enabled) {
    if (topK !== undefined) throw new Error('topK is not supported when thinking is enabled')
    if (topP !== undefined) throw new Error('topP is not supported when thinking is enabled')
    if (temperature !== undefined && temperature !== 1) throw new Error('temperature is not supported when thinking is enabled')
  }
  if (enabled || adaptive) return {}
  return Object.fromEntries(Object.entries({ temperature, top_k: topK, top_p: topP }).filter(([, value]) => value !== undefined))
}

/** Settings remain unchanged; build one native request from the selected model. */
export function anthropicRequestParameters(settings: AnthropicRequestSettings, call: AnthropicCallParameters = {}) {
  const { model, parameters, maxOutputTokens, streaming } = settings
  if (parameters.stop_sequences !== undefined && call.stop !== undefined) throw new Error('Stop sequences were provided in both configuration and call options.')
  const outputConfig = { ...optionalObject(parameters.output_config, 'output_config'), ...call.outputConfig }
  if (call.outputFormat !== undefined && !outputConfig.format) outputConfig.format = call.outputFormat
  const choice = call.toolChoice
  const toolChoice = typeof choice !== 'string' ? choice
    : choice === 'required' || choice === 'any' ? { type: 'any' }
      : choice === 'auto' || choice === 'none' ? { type: choice } : { type: 'tool', name: choice }
  if (toolChoice?.type === 'tool' && !call.tools?.some(tool => tool.name === toolChoice.name)) throw new Error(`Anthropic tool_choice references "${toolChoice.name}", but that tool is not available.`)
  if (toolChoice?.type === 'any' && !call.tools?.length) throw new Error('Anthropic tool_choice requires at least one available tool.')
  const edits = fields(parameters.context_management).edits
  for (const value of [parameters.betas, call.betas]) {
    if (value !== undefined && (!Array.isArray(value) || value.some(beta => typeof beta !== 'string'))) throw new Error('Anthropic betas must be an array of strings.')
  }
  const betas = [...new Set([
    ...parameters.betas as string[] ?? [], ...call.betas ?? [],
    ...call.tools?.flatMap(tool => toolBetas[String(tool.type)] ? [toolBetas[String(tool.type)]] : []) ?? [],
    ...(Array.isArray(edits) && edits.some(edit => fields(edit).type === 'compact_20260112') ? ['compact-2026-01-12'] : []),
    ...(model.startsWith('claude-opus-4-7') && outputConfig.task_budget != null ? ['task-budgets-2026-03-13'] : [])
  ])]
  const { temperature: _temperature, top_p: _topP, top_k: _topK, output_config: _outputConfig, betas: _betas, ...native } = parameters
  return {
    ...native, model, max_tokens: maxOutputTokens ?? defaultAnthropicOutputTokens(model), stream: streaming,
    ...sampling(model, parameters, outputConfig),
    ...(call.stop !== undefined ? { stop_sequences: call.stop } : {}),
    ...(call.tools !== undefined ? { tools: call.tools } : {}),
    ...(toolChoice !== undefined ? { tool_choice: toolChoice } : {}),
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...(betas.length ? { betas } : {}),
    ...Object.fromEntries(Object.entries({ container: call.container, inference_geo: call.inferenceGeo,
      mcp_servers: call.mcpServers, cache_control: call.cacheControl }).filter(([, value]) => value !== undefined))
  } as Omit<Anthropic.MessageCreateParams, 'messages' | 'system'> & { betas?: string[] }
}

/** Already-normalized tool definitions have no framework identity or methods. */
export function anthropicToolDefinition(definition: Fields, strict?: boolean): Fields {
  if ('input_schema' in definition) return { ...definition, ...(strict !== undefined ? { strict } : {}) }
  if (definition.type === 'function') {
    const fn = definition.function ? fields(definition.function) : definition
    return { name: fn.name, description: fn.description, input_schema: fn.parameters,
      ...(strict !== undefined || fn.strict !== undefined ? { strict: strict ?? fn.strict } : {}) }
  }
  if (typeof definition.type === 'string' && ('name' in definition || 'mcp_server_name' in definition)) return { ...definition }
  throw new Error('Anthropic tool definition requires an input schema or native provider tool type.')
}
