import { toolJsonSchema } from '../../runtime/toolSchema'
import { openAiToolDefinition } from '../../providers/openAiParameters'
import { anthropicToolDefinition } from '../../providers/anthropicParameters'
import type { ModelProtocol } from '@shared/types'
import codexPatchSpec from '../codexPatchSpec.json'

type Fields = Record<string, unknown>
function record(value: unknown): Fields { return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {} }

/** Response declarations may already be bound by an inner model hook. Count
 * and send each once while retaining the original tool objects and order. */
export function withResponseTools<T, R>(tools: readonly T[], responseTools: readonly R[]): Array<T | R> {
  const names = new Set(tools.map(value => {
    const tool = record(value)
    return tool.name ?? record(tool.function).name
  }).filter(name => typeof name === 'string'))
  return [...tools, ...responseTools.filter(value => {
    const tool = record(value)
    const name = tool.name ?? record(tool.function).name
    return typeof name !== 'string' || !names.has(name)
  })]
}

/** One projection for model binding, request budgeting and usage calibration. */
export function modelToolDeclaration(value: unknown, protocol: ModelProtocol = 'openai_chat_completions', strict?: boolean): Fields {
  const tool = record(value), metadata = record(tool.metadata), extras = record(tool.extras)
  let native = tool
  if (protocol === 'openai_responses' && metadata.codexApplyPatch === true) native = codexPatchSpec
  else if (extras.providerToolDefinition) native = record(extras.providerToolDefinition)
  else if (metadata.customTool) native = { type: 'custom', ...record(metadata.customTool) }
  else if (typeof tool.name === 'string' && ('inputSchema' in tool || 'schema' in tool)) {
    const schema = toolJsonSchema('inputSchema' in tool ? tool.inputSchema : tool.schema)
    native = protocol === 'anthropic_messages'
      ? { name: tool.name, description: tool.description, input_schema: schema,
        ...Object.fromEntries(['cache_control', 'defer_loading', 'input_examples', 'allowed_callers', 'strict']
          .filter(key => extras[key] !== undefined).map(key => [key, extras[key]])) }
      : { type: 'function', name: tool.name, description: tool.description, parameters: schema,
        ...(extras.defer_loading !== undefined ? { defer_loading: extras.defer_loading } : {}) }
  }
  return protocol === 'anthropic_messages' ? anthropicToolDefinition(native, strict)
    : openAiToolDefinition(native, protocol === 'openai_responses' ? 'responses' : 'chat', strict)
}
