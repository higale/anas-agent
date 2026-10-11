import { act, renderHook, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SpeechGenerateRequest, SpeechReplyConfig } from '@shared/types'
import type { AgentEventEnvelope, AgentRuntimeEvent, AgentThreadSnapshot } from '@shared/agentTypes'
import { subscribeAgentRuntimeEvents } from '../../../../preload/agentEventSubscription'
import { useAgentSpeech } from './useAgentSpeech'

vi.mock('react-i18next', () => {
  const t = (key: string): string => key
  return { useTranslation: () => ({ t }) }
})
const config = { enabled: true, voice: 'zh-CN-XiaoxiaoNeural', speed: 1 }
const pending: Array<{ request: SpeechGenerateRequest; resolve: (audio: Uint8Array) => void; reject: (error: Error) => void }> = []
const audioPlayers: FakeAudio[] = []
class FakeAudio extends EventTarget {
  preload = ''
  volume = 1
  error = undefined
  pause = vi.fn()
  play = vi.fn(async () => {})
  load = vi.fn()
  constructor(public src: string) { super(); audioPlayers.push(this) }
  removeAttribute(): void { this.src = '' }
}
const generate = vi.fn((request: SpeechGenerateRequest) => new Promise<Uint8Array>((resolve, reject) => {
  pending.push({ request, resolve, reject })
}))
const cancel = vi.fn(async (_requestId: string) => {})
const revoke = vi.fn()
beforeEach(() => {
  pending.length = 0
  audioPlayers.length = 0
  vi.stubGlobal('Audio', FakeAudio)
  Object.defineProperty(window, 'gale', { configurable: true, value: {
    agent: { onEvent: vi.fn(() => () => {}) },
    speech: { generate, cancel, logWarning: vi.fn(async () => {}) }
  } })
  let counter = 0
  vi.stubGlobal('URL', { createObjectURL: vi.fn(() => `blob:audio-${++counter}`), revokeObjectURL: revoke })
})
afterEach(() => vi.unstubAllGlobals())
async function complete(index: number): Promise<void> {
  await act(async () => pending[index].resolve(new Uint8Array([0xff, 0xfb, index])))
}

const run = { id: 'run', threadId: 'thread-1', operation: 'agent' as const, status: 'running' as const, createdAt: '', updatedAt: '' }

function startModel(handleEvent: (event: AgentRuntimeEvent) => void, id: string, startedAt = 0) {
  const model = { id, sequence: 1, status: 'running' as const, text: '', reasoning: '', toolCallIds: [], startedAt: new Date(startedAt).toISOString() }
  handleEvent({ type: 'model_started', runId: 'run', threadId: 'thread-1', model })
  return {
    delta: (text: string, type: 'text' | 'reasoning' = 'text') => handleEvent({ type: 'model_delta', runId: 'run', threadId: 'thread-1', modelId: id, delta: { type, text } }),
    complete: (text: string, toolCallIds: string[] = []) => handleEvent({ type: 'model_completed', runId: 'run', threadId: 'thread-1', model: { ...model, messageId: `${id}-message`, status: 'completed', text, toolCallIds } })
  }
}

function startCandidate(handleEvent: (event: AgentRuntimeEvent) => void, startedAt: number) {
  handleEvent({ type: 'run_started', run, newUserTurn: true, userMessage: { id: 'input', role: 'user', content: [{ type: 'text', text: 'Hello' }] } })
  return startModel(handleEvent, 'model', startedAt)
}

function finishRun(handleEvent: (event: AgentRuntimeEvent) => void, modelId: string, text: string) {
  const snapshot: AgentThreadSnapshot = {
    thread: { id: run.threadId, projectId: 'default-workspace', title: 'Speech test', pinned: false, accessMode: 'read_only_allowed', status: 'idle', userTurnCount: 1, createdAt: '', updatedAt: '' },
    messages: [{ id: `${modelId}-message`, runId: run.id, role: 'assistant', content: [{ type: 'text', text }] }],
    todos: [], interrupts: [], activities: [], messageWindow: { startIndex: 0, shown: 1, total: 1, remaining: 0 }
  }
  handleEvent({ type: 'run_completed', run: { ...run, status: 'completed' }, snapshot })
}

async function drainPlayback(): Promise<void> {
  for (let index = 0; index < pending.length; index += 1) {
    await complete(index)
    // Every generated chunk must become playable, even across candidate cuts.
    expect(audioPlayers).toHaveLength(index + 1)
    await act(async () => audioPlayers[index].dispatchEvent(new Event('ended')))
  }
}

describe('speech generation and playback', () => {
  const followupEvents: AgentRuntimeEvent[] = [
    { type: 'model_tool_calls', runId: run.id, threadId: run.threadId, modelId: 'model', progress: [{ index: 0, name: 'search', characterCount: 1, complete: false }] },
    { type: 'tool_started', runId: run.id, threadId: run.threadId, call: { id: 'search', name: 'search', args: {} }, sequence: 2 },
    { type: 'tool_approval_requested', runId: run.id, threadId: run.threadId, call: { id: 'search', name: 'search', args: {} }, sequence: 2, approval: { status: 'pending_approval', interruptId: 'approval', actionIndex: 0 } },
    { type: 'subagent_updated', runId: run.id, threadId: run.threadId, subagent: { id: 'child', name: 'helper', sequence: 3, status: 'running' } },
    { type: 'run_interrupted', run: { ...run, status: 'interrupted' }, interrupts: [] }
  ]

  it.each(followupEvents)('cancels unplayed synthesis on $type without replaying it later', async (event) => {
    const { result } = renderHook(() => useAgentSpeech(config, run.threadId))
    let reply!: ReturnType<typeof startCandidate>
    const text = '先查询。'.repeat(60)
    await act(async () => {
      reply = startCandidate(result.current.handleEvent, 0)
      reply.delta(text)
    })
    expect(pending).toHaveLength(1)
    await act(async () => {
      result.current.handleEvent(event)
      result.current.handleEvent({ type: 'run_started', run, newUserTurn: false })
      reply.complete(`${text}尾文。`, ['search'])
      startModel(result.current.handleEvent, 'tools-only').complete('', ['search-again'])
      finishRun(result.current.handleEvent, 'model', `${text}尾文。`)
    })
    expect(cancel).toHaveBeenCalledWith(pending[0].request.requestId)
    await complete(0)
    expect(pending).toHaveLength(1)
    expect(audioPlayers).toHaveLength(0)
    expect(result.current.state.status).toBe('idle')
    await act(async () => startCandidate(result.current.handleEvent, 0).complete('下一条正常朗读。'))
    await complete(1)
    expect(result.current.state.status).toBe('playing')
  })

  it('discards buffered text when tools appear before synthesis starts', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, run.threadId))
    await act(async () => {
      const reply = startCandidate(result.current.handleEvent, Date.now())
      reply.delta('先查一下。')
      result.current.handleEvent(followupEvents[0])
      reply.delta('正在准备。')
      reply.complete('先查一下。正在准备。')
      finishRun(result.current.handleEvent, 'model', '先查一下。正在准备。')
    })
    expect(pending).toHaveLength(0)
    expect(audioPlayers).toHaveLength(0)
  })

  it('cancels audio waiting to start and ignores its late play promise', async () => {
    let beginPlayback!: () => void
    vi.stubGlobal('Audio', class extends FakeAudio {
      play = vi.fn(() => new Promise<void>(resolve => { beginPlayback = resolve }))
    })
    const { result } = renderHook(() => useAgentSpeech(config, run.threadId))
    await act(async () => startCandidate(result.current.handleEvent, 0).complete('尚未开播。'))
    await complete(0)
    await act(async () => {
      result.current.handleEvent(followupEvents[1])
      startModel(result.current.handleEvent, 'new').complete('新的待播放回复。')
      beginPlayback()
    })
    expect(audioPlayers[0].pause).toHaveBeenCalledOnce()
    await act(async () => result.current.handleEvent(followupEvents[1]))
    expect(cancel).toHaveBeenCalledWith(pending[1].request.requestId)
    await complete(1)
    expect(audioPlayers).toHaveLength(1)
    expect(result.current.state.status).toBe('idle')
  })

  it('continues a started reply when tools arrive between audio chunks', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, run.threadId))
    await act(async () => startCandidate(result.current.handleEvent, 0).complete('甲'.repeat(440)))
    await complete(0)
    await act(async () => {
      audioPlayers[0].dispatchEvent(new Event('ended'))
      result.current.handleEvent(followupEvents[1])
    })
    expect(result.current.state.status).toBe('generating')
    expect(cancel).not.toHaveBeenCalled()
    await complete(1)
    expect(audioPlayers).toHaveLength(2)
    expect(result.current.state.status).toBe('playing')
  })

  it('leaves manually requested pending speech alone when tools start', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, run.threadId))
    await act(async () => {
      startCandidate(result.current.handleEvent, 0)
      result.current.playText('manual', '手动朗读。', true)
    })
    await act(async () => result.current.handleEvent(followupEvents[1]))
    expect(cancel).not.toHaveBeenCalled()
    await complete(0)
    expect(result.current.state).toMatchObject({ status: 'playing', messageId: 'manual' })
  })

  it('does not treat manual playback as the automatic reply having started', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, run.threadId))
    let reply!: ReturnType<typeof startCandidate>
    const text = '甲'.repeat(220)
    await act(async () => {
      reply = startCandidate(result.current.handleEvent, 0)
      reply.delta(text)
    })
    await act(async () => result.current.playText('manual', '手动朗读。', true))
    await complete(1)
    await act(async () => {
      result.current.handleEvent(followupEvents[1])
      reply.complete(`${text}自动回复尾文。`)
    })
    await complete(0)
    expect(pending).toHaveLength(2)
    expect(audioPlayers).toHaveLength(1)
    expect(audioPlayers[0].pause).not.toHaveBeenCalled()
    expect(result.current.state).toMatchObject({ status: 'playing', messageId: 'manual' })
  })

  it.each([true, false])('skips unstarted tool-calling replies and their final snapshot (streaming: %s)', async (streaming) => {
    const { result } = renderHook(() => useAgentSpeech(config, run.threadId))
    await act(async () => {
      const reply = startCandidate(result.current.handleEvent, Date.now())
      if (streaming) reply.delta('先查一下。')
      reply.complete('先查一下。然后汇总。', ['search'])
    })
    await act(async () => finishRun(result.current.handleEvent, 'model', '先查一下。然后汇总。'))
    expect(pending).toHaveLength(0)
    expect(audioPlayers).toHaveLength(0)
    expect(result.current.state.status).toBe('idle')
  })

  it('keeps playing and generating through tools, subagents, approval and resume', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, run.threadId))
    const chunks = ['甲'.repeat(220), '乙'.repeat(220), '最后的说明。']
    let reply!: ReturnType<typeof startCandidate>
    await act(async () => {
      reply = startCandidate(result.current.handleEvent, 0)
      reply.delta(chunks.slice(0, 2).join(''))
    })
    await complete(0)
    await act(async () => reply.complete(chunks.join(''), ['search']))
    await complete(1)
    expect(pending).toHaveLength(3)
    await act(async () => {
      const base = { runId: run.id, threadId: run.threadId }
      const call = { id: 'search', name: 'search', args: {} }
      result.current.handleEvent({ ...base, type: 'tool_started', call, sequence: 2 })
      result.current.handleEvent({ ...base, type: 'subagent_updated', subagent: { id: 'child', name: 'helper', sequence: 3, status: 'running' } })
      result.current.handleEvent({ ...base, type: 'tool_approval_requested', call, sequence: 2, approval: { status: 'pending_approval', interruptId: 'approval', actionIndex: 0 } })
      result.current.handleEvent({ type: 'run_interrupted', run: { ...run, status: 'interrupted' }, interrupts: [] })
      result.current.handleEvent({ type: 'run_started', run, newUserTurn: false })
      result.current.handleEvent({ ...base, type: 'tool_completed', call, sequence: 2, output: 'Done' })
    })
    expect(cancel).not.toHaveBeenCalled()
    expect(audioPlayers[0].pause).not.toHaveBeenCalled()
    await complete(2)
    for (let index = 0; index < chunks.length; index++) {
      expect(audioPlayers).toHaveLength(index + 1)
      await act(async () => audioPlayers[index].dispatchEvent(new Event('ended')))
    }
    expect(pending.map(item => item.request.text)).toEqual(chunks)
    expect(result.current.state.status).toBe('idle')
  })

  it.each([true, false])('replaces old audio only when a new reply has body text (streaming: %s)', async (streaming) => {
    const { result } = renderHook(() => useAgentSpeech(config, run.threadId))
    await act(async () => startCandidate(result.current.handleEvent, 0).complete('旧'.repeat(660)))
    await complete(0)
    await complete(1)
    let next!: ReturnType<typeof startModel>
    await act(async () => {
      const toolsOnly = startModel(result.current.handleEvent, 'tools-only')
      toolsOnly.delta('Thinking without speech', 'reasoning')
      toolsOnly.delta(' \n')
      toolsOnly.complete('', ['search-again'])
      next = startModel(result.current.handleEvent, 'new')
      next.delta('More thinking', 'reasoning')
    })
    expect(cancel).not.toHaveBeenCalled()
    expect(audioPlayers[0].pause).not.toHaveBeenCalled()
    expect(result.current.state.messageId).toBe('run:model:model')
    await act(async () => {
      if (streaming) next.delta('新回复。')
      else next.complete('新回复。')
    })
    expect(cancel).toHaveBeenCalledWith(pending[2].request.requestId)
    expect(audioPlayers[0].pause).toHaveBeenCalledOnce()
    expect(revoke).toHaveBeenCalledWith('blob:audio-2')
    await complete(2) // A cancelled synthesis may still return; never play it.
    expect(audioPlayers).toHaveLength(1)
    if (streaming) await act(async () => next.complete('新回复。'))
    expect(pending.map(item => item.request.text)).toEqual(['旧'.repeat(220), '旧'.repeat(220), '旧'.repeat(220), '新回复。'])
    await complete(3)
    expect(audioPlayers).toHaveLength(2)
    await act(async () => {
      audioPlayers[0].dispatchEvent(new Event('ended'))
      finishRun(result.current.handleEvent, 'new', '新回复。')
    })
    expect(audioPlayers[1].pause).not.toHaveBeenCalled()
    expect(result.current.state).toMatchObject({ status: 'playing', messageId: 'new-message' })
    expect(pending).toHaveLength(4)
  })

  it('does not replay a finished reply after a later model returns only tools', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, run.threadId))
    await act(async () => startCandidate(result.current.handleEvent, 0).complete('已经朗读。'))
    await drainPlayback()
    await act(async () => {
      startModel(result.current.handleEvent, 'tools-only').complete('', ['search'])
      finishRun(result.current.handleEvent, 'model', '已经朗读。')
    })
    expect(pending).toHaveLength(1)
    expect(result.current.state.status).toBe('idle')
  })

  it('replaces prior audio when the final snapshot is the first source of new text', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, run.threadId))
    await act(async () => {
      startCandidate(result.current.handleEvent, 0)
      result.current.playText('manual', '当前正在播放。', true)
    })
    await complete(0)
    await act(async () => finishRun(result.current.handleEvent, 'final', '完整回复。'))
    expect(audioPlayers[0].pause).toHaveBeenCalledOnce()
    expect(pending[1].request.text).toBe('完整回复。')
    await complete(1)
    expect(result.current.state).toMatchObject({ status: 'playing', messageId: 'final-message' })
  })

  it('keeps explicit stop in effect after approval resume', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, run.threadId))
    await act(async () => startCandidate(result.current.handleEvent, 0).complete('停止前。'))
    await complete(0)
    await act(async () => {
      result.current.stop()
      result.current.handleEvent({ type: 'run_started', run, newUserTurn: false })
      startModel(result.current.handleEvent, 'resumed').complete('不应自动朗读。')
    })
    expect(audioPlayers[0].pause).toHaveBeenCalledOnce()
    expect(pending).toHaveLength(1)
    expect(result.current.state.status).toBe('idle')
  })

  it.each(['thread', 'config', 'both'] as const)('reads the first reply when %s becomes ready after the run starts', async (late) => {
    let receive!: (event: unknown, envelope: AgentEventEnvelope) => void
    let revision = 0
    const ipc = {
      invoke: vi.fn(async () => ({ revision: 0, replay: [], replayComplete: true })),
      on: (_channel: string, listener: typeof receive) => { receive = listener },
      removeListener: vi.fn()
    }
    const onEvent = vi.fn((listener: (event: AgentRuntimeEvent) => void) => subscribeAgentRuntimeEvents(ipc, listener))
    window.gale.agent.onEvent = onEvent
    // The workspace subscribes before speech settings and new-thread selection
    // are available; use the real shared preload hub for this ordering.
    const workspace = vi.fn()
    const unsubscribeWorkspace = onEvent(workspace)
    const { result, rerender, unmount } = renderHook(
      ({ settings, thread }: { settings?: SpeechReplyConfig; thread?: string }) => useAgentSpeech(settings, thread),
      { initialProps: {
        settings: late === 'thread' ? config : undefined,
        thread: late === 'config' ? 'thread-1' : undefined
      }, wrapper: StrictMode }
    )
    await waitFor(() => expect(ipc.invoke).toHaveBeenCalledOnce())
    const emit = (event: AgentRuntimeEvent): void => receive({}, {
      revision: ++revision, event, replayActive: event.type !== 'run_completed'
    })
    let candidate!: ReturnType<typeof startCandidate>
    await act(async () => {
      candidate = startCandidate(emit, Date.now())
      candidate.delta('第一条回复。')
    })
    expect(generate).not.toHaveBeenCalled()
    expect(workspace).toHaveBeenCalledTimes(3)
    rerender({ settings: config, thread: 'thread-1' })
    await act(async () => candidate.complete('第一条回复。'))
    expect(pending).toHaveLength(1)
    expect(pending[0].request).toMatchObject({ text: '第一条回复。', voice: config.voice, speed: config.speed })
    await complete(0)
    expect(result.current.state.status).toBe('playing')
    expect(audioPlayers[0].play).toHaveBeenCalledOnce()
    rerender({ settings: { ...config }, thread: 'thread-1' })
    expect(pending).toHaveLength(1)
    unmount()
    unsubscribeWorkspace()
  })

  it('serializes generation and bounds prefetched audio while preserving playback order', async () => {
    const { result, unmount } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    await act(async () => result.current.playText('message', 'a'.repeat(1100)))
    expect(pending).toHaveLength(1)
    await complete(0)
    expect(audioPlayers).toHaveLength(1)
    expect(pending).toHaveLength(2)
    await complete(1)
    await complete(2)
    expect(pending).toHaveLength(3)
    await act(async () => audioPlayers[0].dispatchEvent(new Event('ended')))
    expect(revoke).toHaveBeenCalledWith('blob:audio-1')
    expect(audioPlayers[1].src).toBe('blob:audio-2')
    expect(pending).toHaveLength(4)
    unmount()
    expect(cancel).toHaveBeenCalledWith(pending[3].request.requestId)
    expect(revoke).toHaveBeenCalledWith('blob:audio-2')
    expect(revoke).toHaveBeenCalledWith('blob:audio-3')
  })

  it('stops active synthesis, discards late audio, and can start a new playback', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    await act(async () => result.current.playText('first', 'First sentence.'))
    act(() => result.current.stop())
    expect(cancel).toHaveBeenCalledWith(pending[0].request.requestId)
    await act(async () => result.current.playText('second', 'Second sentence.'))
    await complete(0)
    expect(audioPlayers).toHaveLength(0)
    await complete(1)
    expect(audioPlayers).toHaveLength(1)
    expect(result.current.state).toMatchObject({ status: 'playing', messageId: 'second' })
  })

  it('cancels synthesis on thread switch', async () => {
    const { result, rerender } = renderHook(({ thread }) => useAgentSpeech(config, thread), { initialProps: { thread: 'one' } })
    await act(async () => result.current.playText('message', 'Hello.'))
    rerender({ thread: 'two' })
    expect(cancel).toHaveBeenCalledWith(pending[0].request.requestId)
    await complete(0)
    expect(audioPlayers).toHaveLength(0)
    expect(result.current.state.status).toBe('idle')
  })

  it('continues to the next chunk after synthesis failure', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    await act(async () => result.current.playText('message', 'a'.repeat(440)))
    await act(async () => pending[0].reject(new Error('Disconnected')))
    expect(pending).toHaveLength(2)
    await complete(1)
    expect(result.current.state.status).toBe('playing')
  })

  it('retains cleaning and waits for short streaming text to complete', async () => {
    const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    const run = { id: 'run', threadId: 'thread-1', operation: 'agent' as const, status: 'running' as const, createdAt: '', updatedAt: '' }
    const model = { id: 'model', sequence: 1, status: 'running' as const, text: '', reasoning: '', toolCallIds: [] }
    const text = '**你好** ![图片](https://example.com/image.png) 😀'
    await act(async () => {
      result.current.handleEvent({ type: 'run_started', run, newUserTurn: true, userMessage: { id: 'input', role: 'user', content: [{ type: 'text', text: 'Hello' }] } })
      result.current.handleEvent({ type: 'model_started', runId: 'run', threadId: 'thread-1', model })
      result.current.handleEvent({ type: 'model_delta', runId: 'run', threadId: 'thread-1', modelId: 'model', delta: { type: 'text', text } })
    })
    expect(pending).toHaveLength(0)
    await act(async () => result.current.handleEvent({ type: 'model_completed', runId: 'run', threadId: 'thread-1', model: { ...model, status: 'completed', text } }))
    expect(pending).toHaveLength(1)
    expect(pending[0].request.text).toBe('你好')
  })

  it.each(['completion only', 'buffered delta', 'large punctuated delta'] as const)('splits a long %s into playable requests without dropping text', async (mode) => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    const text = `${'甲'.repeat(219)}𠀀${'乙'.repeat(9000)}。`
    await act(async () => {
      const candidate = startCandidate(result.current.handleEvent, mode === 'large punctuated delta' ? 0 : 1000)
      if (mode !== 'completion only') candidate.delta(text)
      if (mode !== 'large punctuated delta') candidate.complete(text)
    })
    expect(pending).toHaveLength(1)
    await drainPlayback()
    expect(pending.length).toBeGreaterThan(1)
    expect(pending.every(({ request }) => request.text.length <= 8192)).toBe(true)
    expect(pending.every(({ request }) => Array.from(request.text).every((char) => {
      const code = char.codePointAt(0)!
      return code < 0xd800 || code > 0xdfff
    }))).toBe(true)
    expect(pending.map(({ request }) => request.text).join('')).toBe(text)
    expect(result.current.state.status).toBe('idle')
  })

  it('keeps continuous playback order across empty, split, and later streamed candidates', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    const empty = `![image](data:image/png;base64,${'A'.repeat(9000)})\n\n`
    const first = `${'甲'.repeat(9000)}。`
    const later = `${'乙'.repeat(400)}。`
    const tail = '结束'
    let candidate!: ReturnType<typeof startCandidate>
    await act(async () => {
      candidate = startCandidate(result.current.handleEvent, 0)
      candidate.delta(empty)
    })
    expect(pending).toHaveLength(0)
    await act(async () => candidate.delta(first))
    // Fill the prefetch slots before more deltas arrive.
    await complete(0)
    await complete(1)
    await complete(2)
    expect(pending).toHaveLength(3)
    await act(async () => {
      candidate.delta(later)
      candidate.complete(`${empty}${first}${later}${tail}`)
    })
    expect(pending).toHaveLength(3)
    for (let index = 0; index < pending.length; index += 1) {
      if (index >= 3) await complete(index)
      expect(audioPlayers).toHaveLength(index + 1)
      await act(async () => audioPlayers[index].dispatchEvent(new Event('ended')))
    }
    expect(pending.map(({ request }) => request.text).join('')).toBe(`${first}${later}${tail}`)
    expect(result.current.state.status).toBe('idle')
  })

  describe.each(['manual', 'completion', 'delta', 'forced delta'] as const)('%s text preparation', (mode) => {
    it.each(['>', '+', '-'])('cleans Markdown before splitting and preserves a boundary %s operator', async (operator) => {
      vi.spyOn(Date, 'now').mockReturnValue(1000)
      const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
      const prefix = `${'甲'.repeat(219)}x`
      const suffix = `${operator} 5${mode === 'forced delta' ? '' : '。'}`
      const source = mode === 'forced delta' ? `${prefix} ${suffix}` : `**${prefix}** ${suffix}`
      await act(async () => {
        if (mode === 'manual') result.current.playText('message', source)
        else {
          const candidate = startCandidate(result.current.handleEvent, mode === 'completion' ? 1000 : 0)
          if (mode === 'delta' || mode === 'forced delta') candidate.delta(source)
          else candidate.complete(source)
          if (mode === 'forced delta') candidate.complete(source)
        }
      })
      await drainPlayback()
      expect(pending.map(({ request }) => request.text)).toEqual([prefix, suffix])
      expect(result.current.state.status).toBe('idle')
    })
  })

  it('recognizes genuine line markers after a streaming cut and resets context for the next candidate', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1000)
    const { result } = renderHook(() => useAgentSpeech(config, 'thread-1'))
    const prefix = '甲'.repeat(220)
    await act(async () => {
      const candidate = startCandidate(result.current.handleEvent, 0)
      candidate.delta(prefix)
      candidate.complete(`${prefix}\n> 引用\n+ 列表`)
    })
    await drainPlayback()
    expect(pending.map(({ request }) => request.text)).toEqual([prefix, '引用。 列表'])
    const previousRequests = pending.length
    await act(async () => startCandidate(result.current.handleEvent, 1000).complete('> 新引用'))
    expect(pending[previousRequests].request.text).toBe('新引用')
  })
})
