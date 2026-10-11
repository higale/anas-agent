import { expect, it } from 'vitest'
import { parsePluginSettings, pluginSettingValues } from './pluginSettings'
import { parsePluginManifest } from './plugins'

const definition = [
  { key: 'label', label: 'Label', type: 'text', default: 'default', max_length: 8 },
  { key: 'count', label: 'Count', type: 'number', default: 1, minimum: 0, maximum: 2 },
  { key: 'enabled', label: 'Enabled', type: 'boolean', default: true },
  { key: 'mode', label: 'Mode', type: 'enum', default: 'one', choices: [{ value: 'one', label: 'One' }] }
]
it('uses defaults only for absent fields and validates the same values for forms and persistence', () => {
  const fields = parsePluginSettings(definition)
  expect(pluginSettingValues(fields, { label: '', count: 0, enabled: false })).toEqual({ label: '', count: 0, enabled: false, mode: 'one' })
  for (const values of [{ count: '1' }, { count: NaN }, { count: 3 }, { enabled: null }, { mode: 'missing' }, { label: '123456789' }]) {
    expect(() => pluginSettingValues(fields, values)).toThrow()
  }
  expect(pluginSettingValues(fields, { removed_key: 'keep on disk' })).not.toHaveProperty('removed_key')
  expect(() => pluginSettingValues(fields, { removed_key: 'write' }, true)).toThrow('Unknown')
  expect(() => pluginSettingValues(fields, { label: 'partial' }, true)).toThrow('all declared fields')
})
it('rejects invalid definitions and does not treat settings alone as a functional plugin', () => {
  for (const fields of [[...definition, definition[0]], [{ ...definition[0], key: 'notSnakeCase' }], [{ ...definition[0], default: undefined }],
    [{ ...definition[1], minimum: 3 }], [{ ...definition[3], choices: [] }], [{ ...definition[2], type: 'password' }]]) {
    expect(() => parsePluginSettings(fields)).toThrow()
  }
  expect(parsePluginSettings(undefined)).toEqual([])
  expect(() => parsePluginManifest({ version: 0, api_version: 2, id: 'settings-only', name: 'Settings', plugin_version: '1.0.0', settings: definition })).toThrow('entry')
})
