import { describe, expect, it } from 'vitest'
import { codingSummaryPrompt, normalizeCompressionPrompt, summaryPrompt, summaryPromptForLanguage } from './summaryPrompt'

describe('summary prompt composition', () => {
  it('uses a complete custom template and preserves the history placeholder', () => {
    const custom = 'Preserve research sources in {output_language}: {conversation}'
    expect(summaryPromptForLanguage({ code: 'en', name: 'English' }, true, custom))
      .toBe('Preserve research sources in English (en): {conversation}')
    for (const empty of [undefined, '', '  ']) {
      expect(summaryPromptForLanguage({ code: 'en', name: 'English' }, true, empty))
        .toBe(summaryPromptForLanguage({ code: 'en', name: 'English' }, true))
    }
    for (const invalid of [null, 1, 'No history', '{conversation}{conversation}', 'a'.repeat(50_000) + '{conversation}']) {
      expect(() => normalizeCompressionPrompt(invalid)).toThrow('compression prompt')
    }
  })

  it.each([false, true])('selects the template and substitutes language without consuming conversation input (coding: %s)', (codingMode) => {
    const template = codingMode ? codingSummaryPrompt : summaryPrompt
    const prompt = summaryPromptForLanguage({ code: ' zh-CN ', name: ' 简体中文 ' }, codingMode)
    expect(prompt).toBe(template.replace('{output_language}', '简体中文 (zh-CN)'))
    expect(prompt).toContain('{conversation}')
    expect(prompt).not.toContain('{output_language}')
    expect(codingSummaryPrompt).not.toBe(summaryPrompt)
  })
})
