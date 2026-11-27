import { describe, expect, it } from 'vitest'
import { normalizeIconEmoji } from './iconEmoji'

describe('project emoji values', () => {
  it.each(['🚀', '❤️', '👍🏽', '👩‍💻', '🇨🇳', '1️⃣'])('preserves the complete emoji %s', value => {
    expect(normalizeIconEmoji(value)).toBe(value)
  })

  it('uses no emoji by default', () => {
    expect(normalizeIconEmoji(undefined)).toBe('')
    expect(normalizeIconEmoji('')).toBe('')
  })

  it.each([null, 1, {}, 'hello', '<img src=x>', '🚀🚀', ' 🚀'])('rejects invalid emoji %s', value => {
    expect(() => normalizeIconEmoji(value)).toThrow('Project icon emoji is invalid.')
  })
})
