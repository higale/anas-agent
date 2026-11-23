import { expect, it } from 'vitest'
import { parsePluginCapabilityChoices, pluginCapabilityEnabled } from './pluginCapabilities'

it('defaults missing choices on and preserves explicit false and stale IDs', () => {
  expect(parsePluginCapabilityChoices(undefined)).toEqual({})
  expect(pluginCapabilityEnabled(undefined, 'tool', 'echo')).toBe(true)
  const choices = parsePluginCapabilityChoices({ tool: { echo: false, retired: true }, skill: {} })
  expect(pluginCapabilityEnabled(choices, 'tool', 'echo')).toBe(false)
  expect(choices).toEqual({ tool: { echo: false, retired: true } })
  expect(choices.tool?.retired).toBe(true)
})
it.each([null, [], { unknown: {} }, { tool: [] }, { tool: { 'bad-id': true } }, { prompt: { '../bad': false } }])('rejects invalid choices: %j', value => {
  expect(() => parsePluginCapabilityChoices(value)).toThrow()
})

it.each([false, { guide: false }, { guide: 'invalid' }])('ignores retired skill choices without rejecting the file: %j', skill => {
  expect(parsePluginCapabilityChoices({ skill, tool: { echo: false } })).toEqual({ tool: { echo: false } })
})
