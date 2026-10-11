export type PluginSettingValue = string | number | boolean
export type PluginSettingValues = Record<string, PluginSettingValue>
export interface PluginSetting {
  key: string
  label: string
  description: string
  type: 'text' | 'number' | 'boolean' | 'enum'
  default: PluginSettingValue
  minimum?: number
  maximum?: number
  maxLength?: number
  choices?: { value: string; label: string }[]
}
export interface PluginSettingsSnapshot { values: PluginSettingValues; revision: string }

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin settings.')
  return value as Record<string, unknown>
}

export function validatePluginSetting(field: PluginSetting, value: unknown): PluginSettingValue {
  const valid = field.type === 'boolean' ? typeof value === 'boolean'
    : field.type === 'number' ? typeof value === 'number' && Number.isFinite(value)
      && (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum)
      : typeof value === 'string' && (field.type === 'enum' ? field.choices!.some(choice => choice.value === value) : value.length <= (field.maxLength ?? 4096))
  if (!valid) throw new Error(`Invalid plugin setting: ${field.key}`)
  return value as PluginSettingValue
}

export function parsePluginSettings(value: unknown): PluginSetting[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 64) throw new Error('Plugin settings must contain at most 64 fields.')
  const fields = value.map(item => {
    const raw = record(item)
    if (typeof raw.key !== 'string' || !/^[a-z][a-z0-9_]{0,63}$/.test(raw.key) || ['constructor', 'prototype'].includes(raw.key)
      || typeof raw.label !== 'string' || !raw.label.trim() || raw.label.length > 200
      || (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 1024))
      || !['text', 'number', 'boolean', 'enum'].includes(String(raw.type))) throw new Error('Invalid plugin setting declaration.')
    const field: PluginSetting = { key: raw.key, label: raw.label.trim(), description: raw.description as string ?? '',
      type: raw.type as PluginSetting['type'], default: raw.default as PluginSettingValue }
    if (field.type === 'text' && raw.max_length !== undefined) {
      if (!Number.isInteger(raw.max_length) || Number(raw.max_length) < 1 || Number(raw.max_length) > 4096) throw new Error('Invalid plugin text setting limit.')
      field.maxLength = raw.max_length as number
    }
    if (field.type === 'number') {
      for (const key of ['minimum', 'maximum'] as const) if (raw[key] !== undefined) {
        if (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])) throw new Error('Invalid plugin numeric setting limit.')
        field[key] = raw[key]
      }
      if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) throw new Error('Invalid plugin numeric setting range.')
    }
    if (field.type === 'enum') {
      if (!Array.isArray(raw.choices) || !raw.choices.length || raw.choices.length > 64) throw new Error('Invalid plugin setting choices.')
      field.choices = raw.choices.map(value => {
        const choice = record(value)
        if (typeof choice.value !== 'string' || choice.value.length > 200 || typeof choice.label !== 'string' || !choice.label.trim() || choice.label.length > 200) throw new Error('Invalid plugin setting choice.')
        return { value: choice.value, label: choice.label.trim() }
      })
      if (new Set(field.choices.map(choice => choice.value)).size !== field.choices.length) throw new Error('Duplicate plugin setting choice.')
    }
    validatePluginSetting(field, field.default)
    return field
  })
  if (new Set(fields.map(field => field.key)).size !== fields.length) throw new Error('Duplicate plugin setting key.')
  return fields
}

/** Missing optional additions use defaults; explicit false, zero and empty text remain intact. */
export function pluginSettingValues(fields: PluginSetting[], value: unknown, write = false): PluginSettingValues {
  const raw = record(value)
  if (write && Object.keys(raw).some(key => !fields.some(field => field.key === key))) throw new Error('Unknown plugin setting.')
  if (write && fields.some(field => !Object.hasOwn(raw, field.key))) throw new Error('Plugin settings save requires all declared fields.')
  return Object.fromEntries(fields.map(field => [field.key,
    validatePluginSetting(field, Object.hasOwn(raw, field.key) ? raw[field.key] : field.default)]))
}
