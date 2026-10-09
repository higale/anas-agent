import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentRunActivity, AgentRuntimeEvent } from '@shared/agentTypes'
import { PanelViewState } from '../agent/PanelViewState'
import { usePanelActivity } from './usePanelActivity'

const get = vi.fn(), details = vi.fn(), earlier = vi.fn(), stop = vi.fn(), cancel = vi.fn()
let receive: (event: AgentRuntimeEvent) => void
let synchronize: () => Promise<void>
const child = { id: 'child', name: 'Child', sequence: 1, status: 'running' as const }
function activity(): AgentRunActivity {
  return { runId: 'run-a', operation: 'agent', status: 'running', createdAt: '', updatedAt: '',
    models: [], tools: [], subagents: [], activityWindow: { startSequence: 100, endSequence: 199, totalCount: 200, hasEarlier: true } }
}
beforeEach(() => {
  vi.clearAllMocks()
  get.mockResolvedValue(activity()); details.mockResolvedValue(child)
  Object.defineProperty(window, 'gale', { configurable: true, value: { agent: {
    activities: { get, subagent: details, loadEarlier: earlier }, runs: { cancel },
    onEvent: (listener: typeof receive, subscribed: typeof synchronize) => { receive = listener; synchronize = subscribed; return stop }
  } } })
})
describe('independent activity projection', () => {
  it('loads a historical selected child even outside the latest activity window, without recovering a run', async () => {
    const view = renderHook(() => usePanelActivity('thread-a', 'run-a', 'child'))
    await act(synchronize)
    expect(get).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread-a', runId: 'run-a' })
    expect(view.result.current.run?.subagents).toEqual([child])
    act(() => receive({ type: 'subagent_updated', threadId: 'thread-b', runId: 'run-a', subagent: { ...child, name: 'Wrong conversation' } }))
    expect(view.result.current.run?.subagents[0].name).toBe('Child')
    act(() => receive({ type: 'subagent_updated', threadId: 'thread-a', runId: 'other-run', subagent: { ...child, name: 'Wrong run' } }))
    expect(view.result.current.run?.subagents[0].name).toBe('Child')
    act(() => receive({ type: 'subagent_updated', threadId: 'thread-a', runId: 'run-a', subagent: { ...child, status: 'completed', result: 'Finished' } }))
    expect(view.result.current.run?.subagents[0].result).toBe('Finished')
    view.unmount()
    expect(stop).toHaveBeenCalledOnce()
    expect(cancel).not.toHaveBeenCalled()
  })
  it('merges pagination without losing updates that arrive while older rows are loading', async () => {
    const view = renderHook(() => usePanelActivity('thread-a', 'run-a', 'child'))
    await act(synchronize)
    let finish!: (page: AgentRunActivity) => void
    earlier.mockImplementation(() => new Promise(resolve => { finish = resolve }))
    const loading = view.result.current.loadEarlier({ threadId: 'thread-a', runId: 'run-a', signal: new AbortController().signal })
    act(() => receive({ type: 'subagent_updated', threadId: 'thread-a', runId: 'run-a', subagent: { ...child, status: 'completed', result: 'Latest' } }))
    await act(async () => { finish({ ...activity(), subagents: [child], activityWindow: { startSequence: 1, endSequence: 99, hasEarlier: false, totalCount: 200 } }); await loading })
    expect(view.result.current.run?.subagents[0].result).toBe('Latest')
    expect(view.result.current.run?.activityWindow?.hasEarlier).toBe(false)
  })
  it('reloads the restored history range before exposing the target projection', async () => {
    const state = new Map<string, unknown>([['activities.earliest', { current: 1 }]])
    earlier.mockResolvedValue({ ...activity(), subagents: [child], activityWindow: { startSequence: 1, endSequence: 99, hasEarlier: false, totalCount: 200 } })
    const view = renderHook(() => usePanelActivity('thread-a', 'run-a', 'child'), {
      wrapper: ({ children }) => <PanelViewState state={state}>{children}</PanelViewState>
    })
    await act(synchronize)
    expect(earlier).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread-a', runId: 'run-a', beforeSequence: 100 })
    expect(view.result.current.run?.activityWindow?.startSequence).toBe(1)
    expect(cancel).not.toHaveBeenCalled()
  })
  it('reads committed completion again when it arrives during an older snapshot', async () => {
    let finish!: (page: AgentRunActivity) => void
    get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = renderHook(() => usePanelActivity('thread-a', 'run-a', 'child'))
    const pending = synchronize()
    get.mockResolvedValue({ ...activity(), status: 'completed' })
    act(() => receive({ type: 'run_settled', threadId: 'thread-a', runId: 'run-a', operation: 'agent', status: 'completed' }))
    await act(async () => { finish(activity()); await pending })
    expect(get).toHaveBeenCalledTimes(2)
    expect(view.result.current.run?.status).toBe('completed')
  })
  it('does not let an old asynchronous read overwrite the next panel context', async () => {
    let finish!: (page: AgentRunActivity) => void
    get.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = renderHook(({ threadId, runId }) => usePanelActivity(threadId, runId, 'child'), { initialProps: { threadId: 'thread-a', runId: 'run-a' } })
    const oldRead = synchronize()
    get.mockResolvedValue({ ...activity(), runId: 'run-b' })
    view.rerender({ threadId: 'thread-b', runId: 'run-b' })
    await act(synchronize)
    await act(async () => { finish(activity()); await oldRead })
    await waitFor(() => expect(view.result.current.run?.runId).toBe('run-b'))
  })
})
