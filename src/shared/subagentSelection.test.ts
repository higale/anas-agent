import { expect, it } from 'vitest'
import { selectedSubagents } from './subagentSelection'

it('enforces global enabled state for custom names and excludes incomplete definitions', () => {
  const definitions = [
    { name: 'default-agent', enabled: true, description: 'Default', systemPrompt: 'Complete task.' },
    { name: 'custom-agent', enabled: false, description: 'Custom', systemPrompt: 'Complete task.' },
    { name: 'draft-agent', enabled: false, description: 'Draft', systemPrompt: '' }
  ]
  expect(selectedSubagents(definitions).map(item => item.name)).toEqual(['default-agent'])
  expect(selectedSubagents(definitions, { mode: 'custom', names: ['custom-agent', 'draft-agent', 'missing'] }).map(item => item.name)).toEqual([])
  expect(selectedSubagents(definitions, { mode: 'custom', names: [] })).toEqual([])
  expect(selectedSubagents(definitions, { mode: 'off', names: ['default-agent', 'custom-agent'] })).toEqual([])
  expect(definitions[1].enabled).toBe(false)
})
