import type OpenAI from 'openai'

type Fields = Record<string, unknown>
export interface OpenAiRequestSettings {
  model: string
  protocol: 'chat' | 'responses'
  streaming: boolean
  maxOutputTokens?: number
  parameters: Fields
}

function record(value: unknown): Fields { return value && typeof value === 'object' && !Array.isArray(value) ? value as Fields : {} }
function defined(fields: Fields): Fields { return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined)) }
function reasoningModel(model: string): boolean { return /^o\d/.test(model) || model.startsWith('gpt-5') && !model.startsWith('gpt-5-chat') }

/** Accept JSON Schema and native provider declarations; no framework tools enter here. */
export function openAiToolDefinition(tool: Fields, protocol: OpenAiRequestSettings['protocol'], strict?: boolean, streaming = false): Fields {
  if (tool.type === 'custom') {
    if (protocol === 'responses') {
      if (!tool.custom) return { ...tool }
      const custom = record(tool.custom), format = record(custom.format)
      return defined({ type: 'custom', ...custom, format: format.type === 'grammar' ? { type: 'grammar', ...record(format.grammar) } : custom.format })
    }
    if (tool.custom) return { ...tool }
    const { type: _type, format, ...custom } = tool
    const shape = record(format)
    return { type: 'custom', custom: { ...custom, ...(format ? { format: shape.type === 'grammar'
      ? { type: 'grammar', grammar: { definition: shape.definition, syntax: shape.syntax } } : format } : {}) } }
  }
  if (tool.type && tool.type !== 'function') return tool.type === 'image_generation' && streaming
    ? { ...tool, partial_images: tool.partial_images ?? 1 } : { ...tool }
  const nested = tool.function !== undefined, fn = nested ? record(tool.function) : tool
  if (typeof fn.name !== 'string' || !fn.name) throw new Error('OpenAI tool declaration requires a name.')
  const schema = fn.parameters ?? { type: 'object', properties: {} }
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error(`OpenAI tool ${fn.name} requires a JSON Schema object.`)
  const functionFields: Fields = { ...fn, parameters: schema, ...(strict !== undefined ? { strict } : {}) }
  if (protocol === 'chat') {
    const { type: _type, defer_loading, ...fields } = functionFields
    return { ...(nested ? tool : {}), ...(!nested && defer_loading !== undefined ? { defer_loading } : {}), type: 'function', function: fields }
  }
  const { function: _function, ...extras } = nested ? tool : {}
  return { ...extras, ...functionFields, type: 'function', strict: strict ?? fn.strict ?? null }
}

function choice(value: unknown, protocol: OpenAiRequestSettings['protocol']): unknown {
  if (value === undefined) return undefined
  if (value === 'any') return 'required'
  if (typeof value === 'string') return ['auto', 'none', 'required'].includes(value) ? value
    : protocol === 'responses' ? { type: 'function', name: value } : { type: 'function', function: { name: value } }
  const fields = record(value)
  if (protocol === 'responses') {
    if (fields.type === 'function' && fields.function) return { type: 'function', name: record(fields.function).name }
    if (fields.type === 'custom' && fields.custom) return { type: 'custom', name: record(fields.custom).name }
    if (fields.type === 'allowed_tools' && fields.allowed_tools) return { type: 'allowed_tools', ...record(fields.allowed_tools) }
  }
  return value
}

/** Call-level execution fields are explicitly selected; saved provider kwargs retain their native names. */
export function openAiRequestParameters(settings: OpenAiRequestSettings, call: Fields = {}, streamUsage = true): Fields {
  const { protocol, parameters, model, streaming, maxOutputTokens } = settings
  let strict = typeof call.strict === 'boolean' ? call.strict : undefined
  const format = record(call.response_format)
  if (protocol === 'chat' && !streaming && format.type === 'json_schema' && strict !== false) strict = true
  const tools = Array.isArray(call.tools) ? call.tools.map(tool => openAiToolDefinition(record(tool), protocol, strict, streaming)) : undefined
  const reasoning = reasoningModel(model) ? { ...record(call.reasoning), ...(call.reasoningEffort !== undefined && record(call.reasoning).effort === undefined ? { effort: call.reasoningEffort } : {}) } : {}
  const common = { model, stream: streaming, tools: tools?.length ? tools : undefined, tool_choice: choice(call.tool_choice, protocol), parallel_tool_calls: call.parallel_tool_calls }
  if (protocol === 'responses') {
    const json = record(format.json_schema)
    const responseFormat = format.type === 'json_schema' ? defined({ type: 'json_schema', ...json }) : call.response_format
    return defined({ ...common, previous_response_id: call.previous_response_id, truncation: call.truncation, include: call.include,
      text: call.text ?? defined({ format: responseFormat, verbosity: call.verbosity }),
      max_output_tokens: maxOutputTokens, prompt_cache_key: call.promptCacheKey, prompt_cache_retention: call.promptCacheRetention,
      ...parameters, ...(Object.keys(reasoning).length ? { reasoning: { ...record(parameters.reasoning), ...reasoning } } : {}) })
  }
  return defined({ ...common, stop: call.stop, response_format: call.response_format, seed: call.seed,
    ...(streaming && streamUsage ? { stream_options: { include_usage: true } } : {}),
    ...(call.stream_options !== undefined ? { stream_options: call.stream_options } : {}),
    audio: call.audio, modalities: call.modalities, ...parameters,
    ...defined({ prompt_cache_key: call.promptCacheKey ?? parameters.prompt_cache_key,
      prompt_cache_retention: call.promptCacheRetention ?? parameters.prompt_cache_retention, verbosity: call.verbosity ?? parameters.verbosity,
      prediction: call.prediction, service_tier: call.service_tier }),
    ...(reasoning.effort !== undefined ? { reasoning_effort: reasoning.effort } : {}),
    [reasoningModel(model) ? 'max_completion_tokens' : 'max_tokens']: maxOutputTokens })
}

export function openAiChatParameters(settings: OpenAiRequestSettings, call: Fields = {}, streamUsage = true) {
  return openAiRequestParameters({ ...settings, protocol: 'chat' }, call, streamUsage) as unknown as Omit<OpenAI.Chat.ChatCompletionCreateParams, 'messages'>
}
export function openAiResponsesParameters(settings: OpenAiRequestSettings, call: Fields = {}) {
  return openAiRequestParameters({ ...settings, protocol: 'responses' }, call) as unknown as Omit<OpenAI.Responses.ResponseCreateParams, 'input'>
}
