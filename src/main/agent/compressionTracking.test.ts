import { summaryPromptForLanguage } from '@shared/summaryPrompt'
import { describe, expect, it, vi } from 'vitest'
import {
  trackCompressionSummary,
  prepareCompression
} from '../../runtime/compression'
import { ModelSelectionError, ModelRequestChangedError } from '../../runtime/errors'
import { countConversationTokens } from './conversationContext'

const compressionInput = [
  { kind: 'user' as const, content: summaryPromptForLanguage({
    code: 'zh-CN',
    name: '简体中文'
  }).replace('{conversation}', 'Long conversation') }
]

describe('compression model tracking', () => {
  it.each(['', '   ', '\n\t', '<active_user_request>Only the current request</active_user_request>'])('rejects an empty provider summary before adding the active request', async (text) => {
    const onCompressionFailed = vi.fn(), onCompressionCompleted = vi.fn()
    await expect(prepareCompression({ activeUserRequest: 'This request cannot replace the missing summary.' }, preparation =>
      trackCompressionSummary(compressionInput[0].content,
        { onCompressionStart: () => 'empty', onCompressionFailed, onCompressionCompleted },
        async () => ({ text }), { preparation })))
      .rejects.toThrow('empty summary')
    expect(onCompressionCompleted).not.toHaveBeenCalled()
    expect(onCompressionFailed).toHaveBeenCalledWith('empty')
  })

  it('reprepares changed configuration before rejecting summary input against an obsolete budget', async () => {
    const invoke = vi.fn(async () => ({ text: 'Must not send with the old budget' }))
    const changed = new ModelRequestChangedError()
    const onCompressionFailed = vi.fn()
    await expect(prepareCompression({ inputCapacityTokens: 1 }, preparation => trackCompressionSummary(
        compressionInput[0].content,
      { onCompressionStart: () => 'stale-budget', onCompressionFailed }, invoke,
      { preparation, beforePrepare: async () => { throw changed } }
    ))).rejects.toBe(changed)
    expect(invoke).not.toHaveBeenCalled()
    expect(onCompressionFailed).toHaveBeenCalledWith('stale-budget')
  })

  it('stops when the selected model cannot fit the required summary input', async () => {
    const invoke = vi.fn(async () => ({ text: 'Must not summarize' }))
    const onCompressionFailed = vi.fn()
    const onCompressionCompleted = vi.fn()
    await expect(prepareCompression({ inputCapacityTokens: 1 }, preparation => trackCompressionSummary(
      compressionInput[0].content,
      { onCompressionStart: () => 'summary-too-large', onCompressionFailed, onCompressionCompleted }, invoke, { preparation }
    ))).rejects.toBeInstanceOf(ModelSelectionError)
    expect(invoke).not.toHaveBeenCalled()
    expect(onCompressionFailed).toHaveBeenCalledWith('summary-too-large')
    expect(onCompressionCompleted).not.toHaveBeenCalled()
  })

  it('includes Responses instructions in the complete summary request capacity check', async () => {
    const invoke = vi.fn(async () => ({ text: 'Must not summarize' }))
    const protocol = 'openai_responses'
    const capacity = countConversationTokens(compressionInput, [], { protocol }) + 10
    await expect(prepareCompression({ inputCapacityTokens: capacity,
      tokenCountingOptions: { protocol, parameters: { instructions: 'Required summary instruction '.repeat(100) } } }, preparation =>
      trackCompressionSummary(compressionInput[0].content, {}, invoke, { preparation })))
      .rejects.toBeInstanceOf(ModelSelectionError)
    expect(invoke).not.toHaveBeenCalled()
  })

  it('reports the actual compression model lifecycle', async () => {
    const onCompressionStart = vi.fn(() => 'summary-1')
    const onCompressionCompleted = vi.fn()
    const onCompressionFailed = vi.fn()

    const response = await trackCompressionSummary(
          compressionInput[0].content,
      { onCompressionStart, onCompressionCompleted, onCompressionFailed },
      async () => {
        return ({ text: 'Condensed conversation' })
      }
    )

    expect(response.text).toBe('Condensed conversation')
    expect(onCompressionStart).toHaveBeenCalledOnce()
    expect(onCompressionCompleted).toHaveBeenCalledWith('summary-1', 'Condensed conversation')
    expect(onCompressionFailed).not.toHaveBeenCalled()

  })

  it('deterministically carries an omitted active user request into the summary', async () => {
    const response = await prepareCompression(
      { activeUserRequest: 'Finish the repository audit exactly as requested.' },
      preparation => trackCompressionSummary(
      compressionInput[0].content,
        undefined,
        async () => ({ text: [
          'Condensed conversation',
          '<active_user_request>',
          'stale request',
          '</active_user_request>'
        ].join('\n') }), { preparation }
      )
    )

    expect(response.text).toBe([
      'Condensed conversation',
      '<active_user_request>',
      'Finish the repository audit exactly as requested.',
      '</active_user_request>'
    ].join('\n\n'))
  })

  it('removes a started summary when compression fails', async () => {
    const failure = new Error('Compression provider failed.')
    const onCompressionStart = vi.fn(() => 'summary-2')
    const onCompressionCompleted = vi.fn()
    const onCompressionFailed = vi.fn()

    await expect(trackCompressionSummary(
      compressionInput[0].content,
      { onCompressionStart, onCompressionCompleted, onCompressionFailed },
      async () => {
        throw failure
      }
    )).rejects.toBe(failure)
    expect(onCompressionCompleted).not.toHaveBeenCalled()
    expect(onCompressionFailed).toHaveBeenCalledWith('summary-2')
  })

  it('preserves provider identity and usage when finalizing a plain summary result', async () => {
    const usage = { input_tokens: 18, output_tokens: 5, total_tokens: 23 }
    const response = await prepareCompression({ activeUserRequest: 'Continue the audit.' }, preparation =>
      trackCompressionSummary(compressionInput[0].content, undefined, async () => ({
        id: 'summary', text: 'Condensed context', usage
      }), { preparation }))
    expect(response.text).toContain('Condensed context')
    expect(response.text).toContain('Continue the audit.')
    expect(response.id).toBe('summary')
    expect(response.usage).toEqual(usage)
  })
})
