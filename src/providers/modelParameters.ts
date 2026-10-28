import { ModelSelectionError } from '../runtime/errors'

type ModelParameters = Record<string, unknown>

export interface OpenAiModelParameters extends ModelParameters {
  temperature?: number | null
  top_p?: number | null
  frequency_penalty?: number | null
  presence_penalty?: number | null
  n?: number | null
  stop?: string | string[] | null
}

export interface AnthropicModelParameters extends ModelParameters {
  temperature?: number
  top_p?: number
  top_k?: number
  stop_sequences?: string[]
}

function takeNumber(parameters: ModelParameters, keys: string[], allowNull?: false): number | undefined
function takeNumber(parameters: ModelParameters, keys: string[], allowNull: true): number | null | undefined
function takeNumber(parameters: ModelParameters, keys: string[], allowNull = false): number | null | undefined {
  let selected: number | null | undefined
  for (const key of keys) {
    if (!Object.hasOwn(parameters, key)) continue
    const value = parameters[key]
    if (!(allowNull && value === null) && (typeof value !== 'number' || !Number.isFinite(value))) {
      throw new ModelSelectionError(`Model parameter "${key}" must be a finite number${allowNull ? ' or null' : ''}. Correct its settings and send again.`)
    }
    if (selected === undefined) selected = value as number | null
  }
  return selected
}

function takeStringArray(parameters: ModelParameters, key: string): string[] | undefined {
  if (!Object.hasOwn(parameters, key)) return undefined
  const value = parameters[key]
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new ModelSelectionError(`Model parameter "${key}" must be an array of strings. Correct its settings and send again.`)
  }
  return value
}

function takeOpenAiStop(parameters: ModelParameters): string | string[] | null | undefined {
  if (!Object.hasOwn(parameters, 'stop')) return undefined
  const value = parameters.stop
  if (value === null || typeof value === 'string') return value
  return takeStringArray(parameters, 'stop')
}

function omit(parameters: ModelParameters, keys: readonly string[]): ModelParameters {
  const excluded = new Set(keys)
  return Object.fromEntries(Object.entries(parameters).filter(([key]) => !excluded.has(key)))
}

/** Keep native provider keys and explicit empty values; do not mutate saved settings. */
export function openAiModelParameters(parameters: ModelParameters): OpenAiModelParameters {
  const numbers = {
    temperature: takeNumber(parameters, ['temperature'], true),
    top_p: takeNumber(parameters, ['topP', 'top_p'], true),
    frequency_penalty: takeNumber(parameters, ['frequencyPenalty', 'frequency_penalty'], true),
    presence_penalty: takeNumber(parameters, ['presencePenalty', 'presence_penalty'], true),
    n: takeNumber(parameters, ['n'], true)
  }
  const stop = takeOpenAiStop(parameters)
  return {
    ...omit(parameters, ['temperature', 'topP', 'top_p', 'frequencyPenalty', 'frequency_penalty', 'presencePenalty', 'presence_penalty', 'n', 'stop']),
    ...Object.fromEntries(Object.entries(numbers).filter(([, value]) => value !== undefined)),
    ...(stop !== undefined ? { stop } : {})
  }
}

export function anthropicModelParameters(parameters: ModelParameters): AnthropicModelParameters {
  const numbers = {
    temperature: takeNumber(parameters, ['temperature']),
    top_p: takeNumber(parameters, ['topP', 'top_p']),
    top_k: takeNumber(parameters, ['topK', 'top_k'])
  }
  const stop = takeStringArray(parameters, 'stop_sequences')
  return {
    ...omit(parameters, ['temperature', 'topP', 'top_p', 'topK', 'top_k', 'stop_sequences']),
    ...Object.fromEntries(Object.entries(numbers).filter(([, value]) => value !== undefined)),
    ...(stop !== undefined ? { stop_sequences: stop } : {})
  }
}
