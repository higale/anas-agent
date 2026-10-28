import { describe, expect, it, vi } from 'vitest'
import { prepareCompression, stageCompressionSummary, stageManualCompression, summaryTranscript, trackCompressionSummary } from './compression'

describe('native compression preparation', () => {
  const manual = { summaryText: 'Summary', modelContent: 'Model summary', cutoffIndex: 0, activatedAfterMessageIndex: -1,
    inputTokensBefore: 50, inputTokensAfter: 0 }

  it('requires durable tracking before manual generation and stages the exact result without committing it', async () => {
    const generated = vi.fn(async () => manual)
    await expect(stageManualCompression(generated, {})).rejects.toThrow('durable summary tracking')
    expect(generated).not.toHaveBeenCalled()
    const events: string[] = []
    const completed = vi.fn(() => { events.push('staged') })
    const failed = vi.fn()
    const result = await stageManualCompression(async () => { events.push('generated'); return manual }, {
      onCompressionStart: () => { events.push('started'); return 'manual-1' },
      onCompressionCompleted: completed, onCompressionFailed: failed
    })
    expect(events).toEqual(['started', 'generated', 'staged'])
    expect(result).toEqual({ ...manual, id: 'manual-1' })
    expect(completed).toHaveBeenCalledExactlyOnceWith('manual-1', 'Summary', {
      modelContent: 'Model summary', cutoffIndex: 0, activatedAfterMessageIndex: -1, inputTokensBefore: 50, inputTokensAfter: 0
    })
    expect(manual).not.toHaveProperty('id')
    expect(failed).not.toHaveBeenCalled()
  })

  it.each(['generation', 'staging'] as const)('marks failed manual %s once and preserves its error', async phase => {
    const failure = new Error(`${phase} failed`)
    const failed = vi.fn()
    const completed = vi.fn(() => { if (phase === 'staging') throw failure })
    await expect(stageManualCompression(async () => {
      if (phase === 'generation') throw failure
      return manual
    }, { onCompressionStart: () => 'manual-failed', onCompressionCompleted: completed, onCompressionFailed: failed })).rejects.toBe(failure)
    expect(completed).toHaveBeenCalledTimes(phase === 'staging' ? 1 : 0)
    expect(failed).toHaveBeenCalledExactlyOnceWith('manual-failed')
  })

  it('stages only the latest generated summary and never stages one without a matching boundary', async () => {
    const failed = vi.fn(), staged = vi.fn()
    let nextId = 0
    const callbacks = { onCompressionStart: () => `summary-${++nextId}`, onCompressionFailed: failed, onCompressionCompleted: staged }
    const boundary = { modelContent: 'summary', cutoffIndex: 2, activatedAfterMessageIndex: 1,
      coveredThroughMessageId: 'last', inputTokensBefore: 100, inputTokensAfter: 20 }
    await prepareCompression({}, async preparation => {
      await trackCompressionSummary('history', callbacks, async () => ({ text: 'First' }), { preparation })
      await trackCompressionSummary('history', callbacks, async () => ({ text: 'Second' }), { preparation })
      stageCompressionSummary(preparation.generated, () => boundary)
      stageCompressionSummary(preparation.generated, () => boundary)
      expect(staged).toHaveBeenCalledExactlyOnceWith('summary-2', 'Second', boundary)
      expect(failed).toHaveBeenCalledExactlyOnceWith('summary-1')
      expect(preparation.generated.map(summary => summary.state)).toEqual(['failed', 'staged'])
    })
    await prepareCompression({}, async preparation => {
      await trackCompressionSummary('history', callbacks, async () => ({ text: 'Unmatched' }), { preparation })
      stageCompressionSummary(preparation.generated)
      expect(failed).toHaveBeenLastCalledWith('summary-3')
      expect(staged).toHaveBeenCalledOnce()
    })
  })

  it('keeps overlapping preparations and their failure cleanup independent', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const failedA = vi.fn(), failedB = vi.fn(), completed = vi.fn()
    const failure = new Error('request preparation failed after summary generation')
    const first = prepareCompression({ activeUserRequest: 'Request A' }, async preparation => {
      await gate
      const response = await trackCompressionSummary('history', {
        onCompressionStart: () => 'a', onCompressionFailed: failedA, onCompressionCompleted: completed
      }, async () => ({ text: 'Summary A' }), { preparation })
      expect(response.text).toContain('Request A')
      expect(response.text).not.toContain('Request B')
      expect(preparation.generated).toMatchObject([{ id: 'a', state: 'pending' }])
      throw failure
    })
    const second = prepareCompression({ activeUserRequest: 'Request B' }, async preparation => {
      const response = await trackCompressionSummary('history', {
        onCompressionStart: () => 'b', onCompressionFailed: failedB, onCompressionCompleted: completed
      }, async () => ({ text: 'Summary B' }), { preparation })
      release()
      expect(preparation.generated).toMatchObject([{ id: 'b', state: 'pending' }])
      return response
    })
    const [a, b] = await Promise.allSettled([first, second])
    expect(a).toEqual({ status: 'rejected', reason: failure })
    expect(b).toMatchObject({ status: 'fulfilled', value: { text: expect.stringContaining('Request B') } })
    expect(failedA).toHaveBeenCalledExactlyOnceWith('a')
    expect(failedB).not.toHaveBeenCalled()
    expect(completed).not.toHaveBeenCalled()
  })

  it('discards a staged preparation after a later failure without claiming a committed summary', async () => {
    const discarded = vi.fn(), failure = new Error('commit boundary failed')
    await expect(prepareCompression({}, async preparation => {
      await trackCompressionSummary('history', { onCompressionStart: () => 's', onCompressionFailed: discarded },
        async () => ({ text: 'summary' }), { preparation })
      preparation.generated[0].state = 'staged'
      throw failure
    })).rejects.toBe(failure)
    expect(discarded).toHaveBeenCalledExactlyOnceWith('s')
  })

  it('does not silently inherit another request budget or task text', async () => {
    const completed = vi.fn()
    await prepareCompression({ activeUserRequest: 'Unrelated task', inputCapacityTokens: 0 }, async preparation => {
      const response = await trackCompressionSummary('Independent request', {
        onCompressionStart: () => 'standalone', onCompressionCompleted: completed
      }, async () => ({ text: 'Independent summary' }))
      expect(response.text).toBe('Independent summary')
      expect(completed).toHaveBeenCalledExactlyOnceWith('standalone', 'Independent summary')
      expect(preparation.generated).toEqual([])
    })
  })

  it('preserves transcript roles and calls without copying media bytes or reasoning metadata', () => {
    const calls = [{ id: 'call', name: 'read', args: { path: 'a.txt' } }]
    const rendered = summaryTranscript([
      { speaker: 'Human', name: 'User', content: [{ type: 'text', text: 'Inspect ' },
        { type: 'image_url', image_url: { url: 'SECRET_IMAGE_BYTES' } },
        { type: 'input_audio', data: 'SECRET_AUDIO_BYTES' }, { type: 'text-plain' }] },
      { speaker: 'AI', content: [{ type: 'text', text: 'Reading' },
        { type: 'reasoning', reasoning: 'PRIVATE_REASONING' }, { type: 'tool_call', args: 'duplicate' }], calls },
      { speaker: 'Tool', name: 'read', content: 'file contents' },
      { speaker: 'AI', content: '', functionCall: { name: 'legacy', arguments: '{}' } }
    ])
    expect(rendered).toBe('Human: User, Inspect [image][audio][text-plain file]\n'
      + `AI: Reading${JSON.stringify(calls)}\nTool: read, file contents\n`
      + 'AI: {"name":"legacy","arguments":"{}"}')
  })
})
