import { describe, expect, it } from 'vitest'
import { modelSystemGuidance } from './modelGuidance'

describe('retained model-specific guidance', () => {
  it.each(['gpt-5.1-codex', 'gpt-5.2-codex', 'gpt-5.3-codex'])('keeps the existing engineering guidance for %s', model => {
    expect(modelSystemGuidance('openai', model)).toContain('## Codex-Specific Behavior')
    expect(modelSystemGuidance('openai', model)).toContain('## Plan Hygiene')
    expect(modelSystemGuidance('anthropic', model)).toBeUndefined()
  })

  it.each(['claude-opus-4-7', 'claude-sonnet-4-6', 'claude-haiku-4-5'])('keeps the existing investigation guidance for %s', model => {
    expect(modelSystemGuidance('anthropic', model)).toContain('<investigate_before_answering>')
    expect(modelSystemGuidance('anthropic', model)).toContain('<tool_result_reflection>')
    expect(modelSystemGuidance('openai', model)).toBeUndefined()
  })

  it('does not apply a known model overlay to unknown names or suffix variants', () => {
    expect(modelSystemGuidance('openai', 'custom-model')).toBeUndefined()
    expect(modelSystemGuidance('openai', 'gpt-5.3-codex-custom')).toBeUndefined()
    expect(modelSystemGuidance('anthropic', 'claude-opus-4-7-custom')).toBeUndefined()
  })
})
