import { expect, it } from 'vitest'
import { parsePluginCapabilityChoices, pluginCapabilityEnabled } from './pluginCapabilities'

it('defaults missing choices on and preserves explicit false and stale IDs', () => {
  expect(parsePluginCapabilityChoices(undefined)).toEqual({})
  expect(pluginCapabilityEnabled(undefined, 'tool', 'echo')).toBe(true)
  const choices = parsePluginCapabilityChoices({ tool: { echo: false, retired: true }, skill: {} })
  expect(pluginCapabilityEnabled(choices, 'tool', 'echo')).toBe(false)
  expect(pluginCapabilityEnabled(choices, 'skill', 'new-skill')).toBe(true)
  expect(choices.tool?.retired).toBe(true)
})
it.each([null, [], { unknown: {} }, { tool: [] }, { skill: { guide: 'false' } }, { tool: { 'bad-id': true } }, { prompt: { '../bad': false } }])('rejects invalid choices: %j', value => {
  expect(() => parsePluginCapabilityChoices(value)).toThrow()
})
