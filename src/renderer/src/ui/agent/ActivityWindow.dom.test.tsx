import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityWindow, evictActivityPages, splitActivityPage } from './ActivityWindow'
import type { AgentRunActivity, AgentRuntimeEvent } from '@shared/agentTypes'
const api = vi.hoisted(() => ({ page: vi.fn(), onEvent: vi.fn((_listener: (event: AgentRuntimeEvent) => void, synchronize: () => Promise<void>, _onError?: (reason: string) => void) => {
  void synchronize()
  return vi.fn()
}) }))
vi.mock('../panels/contentServices', () => ({ contentServices: () => ({ agent: { activities: { page: api.page }, onEvent: api.onEvent } }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))

const base: AgentRunActivity = { runId: 'r', status: 'completed', operation: 'agent', models: [], tools: [], subagents: [], createdAt: '', updatedAt: '' }
function page(start: number, count: number): AgentRunActivity {
  return { ...base, memoryRecalls: Array.from({ length: count }, (_, index) => ({ id: String(start + index), sequence: start + index,
    query: '', promptText: '', memoryCount: 1, createdAt: '' })),
    activityWindow: { startSequence: start, endSequence: start + count - 1, totalCount: 900, hasEarlier: start > 0, hasLater: start + count < 900 } }
}
const visible = new Map<Element, () => void>()
beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe(element: Element) { visible.set(element, () => this.callback([{ isIntersecting: true }])) }
    disconnect() {}
  })
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: () => void) {}
    observe() { this.callback() }
    disconnect() {}
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ height: 1000, top: 0, bottom: 1000 } as DOMRect)
  api.page.mockReset().mockImplementation(async ({ before, after, limit = 300 }) => {
    const end = before ?? (after === undefined ? 900 : Math.min(900, after + 1 + limit))
    const start = after === undefined ? Math.max(0, end - limit) : after + 1
    return page(start, end - start)
  })
})
afterEach(() => { cleanup(); visible.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('activity reading window', () => {
  it('keeps repeated live bursts and delayed boundary reads ordered, unique and bounded', async () => {
    let total = 900, receive!: (event: AgentRuntimeEvent) => void
    const snapshot = ({ before, after, limit = 300 }: { before?: number; after?: number; limit?: number }) => {
      const end = Math.min(total, before ?? (after === undefined ? total : after + 1 + limit))
      const start = after === undefined ? Math.max(0, end - limit) : after + 1
      return { ...page(start, end - start), activityWindow: { startSequence: start, endSequence: end - 1,
        totalCount: total, hasEarlier: start > 0, hasLater: end < total } }
    }
    api.page.mockImplementation(async input => snapshot(input))
    api.onEvent.mockImplementationOnce((listener, ready) => { receive = listener; void ready(); return vi.fn() })
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={{ ...base, status: 'running' }}>{value =>
      <>{value.memoryRecalls?.map(item => <span data-row={item.sequence} key={item.id}>ROW_{item.id}</span>)}</>
    }</ActivityWindow></div>)
    await screen.findByText('ROW_899')
    const panel = view.container.firstElementChild as HTMLElement
    Object.defineProperties(panel, { scrollHeight: { value: 10000 }, clientHeight: { value: 300 } })
    panel.scrollTop = 500
    const burst = (count: number) => {
      for (let index = 0; index < count; index++) {
        const sequence = total++
        receive({ type: 'memory_recalled', threadId: 'thread', runId: 'r', recall: { id: String(sequence), sequence, query: '', promptText: '', memoryCount: 1, createdAt: '' } })
      }
    }
    const rows = () => [...view.container.querySelectorAll<HTMLElement>('[data-row]')].map(element => Number(element.dataset.row))
    for (let cycle = 0; cycle < 3; cycle++) {
      await act(async () => burst(350))
      for (const edge of ['first', 'latest'] as const) {
        let finish!: () => void
        api.page.mockImplementationOnce(input => new Promise(resolve => { const saved = snapshot(input); finish = () => resolve(saved) }))
        fireEvent(panel, new CustomEvent('activity-boundary', { cancelable: true, detail: { edge } }))
        await act(async () => { burst(cycle === 2 ? 600 : 60); finish() })
        await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
        const ids = rows()
        expect(ids.length).toBeLessThanOrEqual(500)
        expect(ids).toEqual([...new Set(ids)].sort((left, right) => left - right))
        if (edge === 'first') expect(ids[0]).toBe(0)
        else expect(ids.at(-1)).toBe(total - 1)
      }
    }
  })

  it('routes first and last commands only to windows in their own scroll panel', async () => {
    const view = render(<div className="workspace-content-scroll">
      <ActivityWindow threadId="thread" run={base}>{value => <span>ROOT_{value.activityWindow?.startSequence}</span>}</ActivityWindow>
      <div className="agent-subagent-panel-body">
        <ActivityWindow threadId="thread" run={base} subagentId="child">{value => <span>CHILD_{value.activityWindow?.startSequence}</span>}</ActivityWindow>
      </div>
    </div>)
    await screen.findByText('ROOT_0')
    await screen.findByText('CHILD_0')
    fireEvent(view.container.firstElementChild!, new CustomEvent('activity-boundary', { cancelable: true, detail: { edge: 'latest' } }))
    await screen.findByText('ROOT_600')
    expect(screen.getByText('CHILD_0')).toBeTruthy()
    fireEvent(view.container.querySelector('.agent-subagent-panel-body')!, new CustomEvent('activity-boundary', { cancelable: true, detail: { edge: 'latest' } }))
    await screen.findByText('CHILD_600')
    expect(screen.getByText('ROOT_600')).toBeTruthy()
    expect(api.page).toHaveBeenCalledTimes(4)
  })

  it.each([false, true])('does not let a delayed tail refresh replace a newer page request or its error: %s', async failed => {
    let receive!: (event: AgentRuntimeEvent) => void
    api.onEvent.mockImplementationOnce((listener, ready) => { receive = listener; void ready(); return vi.fn() })
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={{ ...base, status: 'running' }}>{value =>
      <>{value.memoryRecalls?.map(item => <span key={item.id}>ROW_{item.id}</span>)}</>
    }</ActivityWindow></div>)
    await screen.findByText('ROW_899')
    const panel = view.container.firstElementChild as HTMLElement
    Object.defineProperties(panel, { scrollHeight: { value: 1000 }, clientHeight: { value: 300 } })
    panel.scrollTop = 700
    vi.useFakeTimers()
    try {
      act(() => receive({ type: 'memory_recalled', threadId: 'thread', runId: 'r', recall: { id: '900', sequence: 900, query: '', promptText: '', memoryCount: 1, createdAt: '' } }))
      if (failed) api.page.mockRejectedValueOnce(new Error('earlier page failed'))
      await act(async () => { fireEvent.click(screen.getByText('agent.load_earlier_activities')) })
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    } finally { vi.useRealTimers() }
    expect(api.page).toHaveBeenCalledTimes(2)
    if (failed) expect(screen.getByRole('alert')).toHaveTextContent('earlier page failed')
    else expect(screen.getByText('ROW_500')).toBeTruthy()
  })

  it.each([false, true])('keeps the first live activity reachable when its automatic refresh is cancelled: %s', async moved => {
    let receive!: (event: AgentRuntimeEvent) => void
    api.onEvent.mockImplementationOnce((listener, ready) => { receive = listener; void ready(); return vi.fn() })
    api.page.mockResolvedValueOnce({ ...base, activityWindow: { startSequence: null, endSequence: null, totalCount: 0, hasEarlier: false, hasLater: false } })
    api.page.mockResolvedValueOnce({ ...page(0, 1), activityWindow: { startSequence: 0, endSequence: 0, totalCount: 1, hasEarlier: false, hasLater: false } })
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={{ ...base, status: 'running' }}>{value =>
      <>{value.memoryRecalls?.map(item => <span key={item.id}>ROW_{item.id}</span>)}</>
    }</ActivityWindow></div>)
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    const panel = view.container.firstElementChild as HTMLElement
    Object.defineProperties(panel, { scrollHeight: { value: 1000 }, clientHeight: { value: 300 } })
    panel.scrollTop = 700
    vi.useFakeTimers()
    try {
      act(() => receive({ type: 'memory_recalled', threadId: 'thread', runId: 'r', recall: { id: '0', sequence: 0, query: '', promptText: '', memoryCount: 1, createdAt: '' } }))
      if (moved) { fireEvent.wheel(panel, { deltaY: -100 }); panel.scrollTop = 500 }
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
    } finally { vi.useRealTimers() }
    expect(api.page).toHaveBeenCalledTimes(moved ? 1 : 2)
    if (moved) fireEvent.click(screen.getByText('agent.load_later_activities'))
    await screen.findByText('ROW_0')
    if (moved) expect(api.page).toHaveBeenLastCalledWith(expect.objectContaining({ after: -1 }))
  })

  it('keeps a restored slot within its original range when removed records shift the returned page backwards', async () => {
    let synchronize!: () => Promise<void>
    api.onEvent.mockImplementationOnce((_listener, ready) => { synchronize = ready; void ready(); return vi.fn() })
    const view = render(<ActivityWindow threadId="thread" run={base}>{value => <>{value.memoryRecalls?.map(item => <span data-row key={item.id}>ROW_{item.id}</span>)}</>}</ActivityWindow>)
    await screen.findByText('ROW_299')
    const shifted = page(99, 101)
    shifted.memoryRecalls = shifted.memoryRecalls!.filter(item => item.sequence !== 150)
    api.page.mockResolvedValueOnce(page(0, 100)).mockResolvedValueOnce(shifted).mockResolvedValueOnce(page(200, 100))
    await act(synchronize)
    expect(screen.getAllByText('ROW_99')).toHaveLength(1)
    expect(screen.queryByText('ROW_150')).toBeNull()
    expect(view.container.querySelectorAll('[data-row]')).toHaveLength(299)
  })

  it.each([0, 300])('keeps new activities beyond an in-flight first page reachable: %s existing rows', async count => {
    let finish!: (value: AgentRunActivity) => void, receive!: (event: AgentRuntimeEvent) => void
    api.onEvent.mockImplementationOnce((listener, ready) => { receive = listener; void ready(); return vi.fn() })
    api.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    render(<ActivityWindow threadId="thread" run={base}>{value => <>{value.memoryRecalls?.map(item => <span key={item.id}>ROW_{item.id}</span>)}</>}</ActivityWindow>)
    await act(async () => {
      receive({ type: 'memory_recalled', threadId: 'thread', runId: 'r', recall: { id: String(count), sequence: count, query: '', promptText: '', memoryCount: 1, createdAt: '' } })
      finish({ ...page(0, count), activityWindow: { startSequence: count ? 0 : null, endSequence: count ? count - 1 : null, totalCount: count, hasEarlier: false, hasLater: false } })
    })
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    fireEvent.click(screen.getByText('agent.load_later_activities'))
    await screen.findByText(`ROW_${count}`)
    expect(api.page).toHaveBeenLastCalledWith(expect.objectContaining({ after: count - 1 }))
  })

  it('does not copy events outside a restored page into that page', async () => {
    let finish!: (value: AgentRunActivity) => void, receive!: (event: AgentRuntimeEvent) => void, synchronize!: () => Promise<void>
    api.onEvent.mockImplementationOnce((listener, ready) => { receive = listener; synchronize = ready; void ready(); return vi.fn() })
    const view = render(<ActivityWindow threadId="thread" run={base}>{value => <>{value.memoryRecalls?.map(item => <span data-row key={item.id}>ROW_{item.id}</span>)}</>}</ActivityWindow>)
    await screen.findByText('ROW_299')
    api.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    let refreshing!: Promise<void>
    act(() => { refreshing = synchronize() })
    await act(async () => {
      receive({ type: 'memory_recalled', threadId: 'thread', runId: 'r', recall: { id: '300', sequence: 300, query: '', promptText: '', memoryCount: 1, createdAt: '' } })
      receive({ type: 'memory_recalled', threadId: 'thread', runId: 'r', recall: { id: '150', sequence: 150, query: '', promptText: '', memoryCount: 1, createdAt: '' } })
      finish(page(0, 100))
      await refreshing
    })
    expect(screen.queryByText('ROW_300')).toBeNull()
    expect(view.container.querySelectorAll('[data-row]')).toHaveLength(300)
  })

  it('preserves new rows already appended to a short live page while that page is refreshed', async () => {
    let finish!: (value: AgentRunActivity) => void, receive!: (event: AgentRuntimeEvent) => void, synchronize!: () => Promise<void>
    const snapshot = { ...page(0, 50), activityWindow: { startSequence: 0, endSequence: 49, totalCount: 50, hasEarlier: false, hasLater: false } }
    api.onEvent.mockImplementationOnce((listener, ready) => { receive = listener; synchronize = ready; void ready(); return vi.fn() })
    api.page.mockResolvedValueOnce(snapshot)
    render(<ActivityWindow threadId="thread" run={{ ...base, status: 'running' }}>{value => <>{value.memoryRecalls?.map(item => <span key={item.id}>ROW_{item.id}</span>)}</>}</ActivityWindow>)
    await screen.findByText('ROW_49')
    api.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    let refreshing!: Promise<void>
    act(() => { refreshing = synchronize() })
    act(() => receive({ type: 'memory_recalled', threadId: 'thread', runId: 'r', recall: { id: '50', sequence: 50, query: '', promptText: '', memoryCount: 1, createdAt: '' } }))
    expect(screen.getByText('ROW_50')).toBeTruthy()
    await act(async () => { finish(snapshot); await refreshing })
    expect(screen.getByText('ROW_50')).toBeTruthy()
    expect(screen.queryByText('agent.load_later_activities')).toBeNull()
  })

  it.each(['complete', 'cancel', 'fail'] as const)('resumes following only after successful boundary positioning: %s', async result => {
    let finish!: (value: AgentRunActivity) => void, fail!: (reason: Error) => void
    const onPosition = vi.fn()
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={base}>{value =>
      <span>START_{value.activityWindow?.startSequence}</span>
    }</ActivityWindow></div>)
    await screen.findByText('START_0')
    const panel = view.container.firstElementChild as HTMLElement
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 2000 })
    panel.scrollTop = 123
    api.page.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
    fireEvent(panel, new CustomEvent('activity-boundary', { cancelable: true, detail: { edge: 'latest', onPosition } }))
    expect(panel.scrollTop).toBe(123)
    expect(onPosition).not.toHaveBeenCalled()
    if (result === 'cancel') fireEvent.wheel(panel, { deltaY: -50 })
    await act(async () => { if (result === 'fail') fail(new Error('read failed')); else finish(page(600, 300)) })
    expect(onPosition).toHaveBeenCalledTimes(result === 'complete' ? 1 : 0)
    expect(panel.scrollTop).toBe(result === 'complete' ? 2000 : 123)
    if (result === 'fail') {
      fireEvent.click(screen.getByText('common.retry'))
      await screen.findByText('START_600')
      expect(onPosition).toHaveBeenCalledOnce()
      expect(panel.scrollTop).toBe(2000)
    }
  })

  it.each(['page', 'error'] as const)('ignores a superseded pagination %s from another open run', async result => {
    let finish!: (value: AgentRunActivity) => void, fail!: (reason: Error) => void
    const view = render(<div className="workspace-content-scroll">
      <ActivityWindow threadId="thread" run={base}>{value => <span>FIRST_{value.activityWindow?.startSequence}</span>}</ActivityWindow>
      <ActivityWindow threadId="thread" run={{ ...base, runId: 'second' }}>{value => <span>SECOND_{value.activityWindow?.startSequence}</span>}</ActivityWindow>
    </div>)
    await screen.findByText('FIRST_0')
    await screen.findByText('SECOND_0')
    api.page.mockImplementationOnce(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
    fireEvent.click(screen.getAllByText('agent.load_later_activities')[0])
    fireEvent(view.container.firstElementChild!, new CustomEvent('activity-boundary', { cancelable: true, detail: { edge: 'latest' } }))
    await screen.findByText('SECOND_600')
    await act(async () => { if (result === 'page') finish(page(300, 100)); else fail(new Error('superseded read failed')) })
    expect(screen.queryByText('FIRST_300')).toBeNull()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stops an obsolete reconnect sweep after a new panel navigation', async () => {
    let synchronize!: () => Promise<void>, finish!: (value: AgentRunActivity) => void
    api.onEvent.mockImplementationOnce((_listener, ready) => { synchronize = ready; void ready(); return vi.fn() })
    const view = render(<div className="workspace-content-scroll">
      <ActivityWindow threadId="thread" run={base}>{value => <span>FIRST_{value.activityWindow?.startSequence}</span>}</ActivityWindow>
      <ActivityWindow threadId="thread" run={{ ...base, runId: 'second' }}>{value => <span>SECOND_{value.activityWindow?.startSequence}</span>}</ActivityWindow>
    </div>)
    await screen.findByText('FIRST_0')
    await screen.findByText('SECOND_0')
    api.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    let refreshing!: Promise<void>
    act(() => { refreshing = synchronize() })
    fireEvent(view.container.firstElementChild!, new CustomEvent('activity-boundary', { cancelable: true, detail: { edge: 'latest' } }))
    await screen.findByText('SECOND_600')
    await act(async () => { finish(page(0, 100)); await refreshing })
    expect(api.page).toHaveBeenCalledTimes(4)
  })

  it('cancels a pending last-window jump when the panel is redirected to its first window', async () => {
    let finish!: (value: AgentRunActivity) => void
    const view = render(<div className="workspace-content-scroll">
      <ActivityWindow threadId="thread" run={base}>{value => <span>FIRST_{value.activityWindow?.startSequence}</span>}</ActivityWindow>
      <ActivityWindow threadId="thread" run={{ ...base, runId: 'second' }}>{value => <span>SECOND_{value.activityWindow?.startSequence}</span>}</ActivityWindow>
    </div>)
    await screen.findByText('FIRST_0')
    await screen.findByText('SECOND_0')
    const panel = view.container.firstElementChild as HTMLElement
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 2000 })
    api.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent(panel, new CustomEvent('activity-boundary', { cancelable: true, detail: { edge: 'latest' } }))
    fireEvent(panel, new CustomEvent('activity-boundary', { cancelable: true, detail: { edge: 'first' } }))
    await waitFor(() => expect(api.page).toHaveBeenCalledTimes(4))
    await act(async () => finish(page(600, 300)))
    expect(panel.scrollTop).toBe(0)
    expect(screen.getByText('SECOND_0')).toBeTruthy()
    expect(screen.queryByText('SECOND_600')).toBeNull()
  })

  it('loads the real first or last window before positioning the whole panel', async () => {
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={{ ...base, status: 'running' }}>{value =>
      <span>START_{value.activityWindow?.startSequence}</span>
    }</ActivityWindow></div>)
    const panel = view.container.firstElementChild as HTMLElement
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 2000 })
    await screen.findByText('START_600')
    panel.scrollTop = 500
    const first = new CustomEvent('activity-boundary', { cancelable: true, detail: { edge: 'first' } })
    fireEvent(panel, first)
    expect(first.defaultPrevented).toBe(true)
    await screen.findByText('START_0')
    expect(panel.scrollTop).toBe(0)
    expect(api.page).toHaveBeenLastCalledWith(expect.objectContaining({ after: -1, limit: 300 }))
    fireEvent(panel, new CustomEvent('activity-boundary', { cancelable: true, detail: { edge: 'latest' } }))
    await screen.findByText('START_600')
    expect(panel.scrollTop).toBe(2000)
    expect(api.page).toHaveBeenCalledTimes(3)
  })

  it('honors the newest boundary command while another page is loading', async () => {
    let finish!: (value: AgentRunActivity) => void
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={base}>{value =>
      <span>START_{value.activityWindow?.startSequence}</span>
    }</ActivityWindow></div>)
    await screen.findByText('START_0')
    api.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const panel = view.container.firstElementChild!
    fireEvent(panel, new CustomEvent('activity-boundary', { cancelable: true, detail: { edge: 'latest' } }))
    fireEvent(panel, new CustomEvent('activity-boundary', { cancelable: true, detail: { edge: 'first' } }))
    await act(async () => finish(page(600, 300)))
    expect(screen.getByText('START_0')).toBeTruthy()
    expect(screen.queryByText('START_600')).toBeNull()
    expect(api.page).toHaveBeenLastCalledWith(expect.objectContaining({ after: -1 }))
  })

  it('does not retain child activity events inside a parent reading window', async () => {
    let receive!: (event: AgentRuntimeEvent) => void
    api.onEvent.mockImplementationOnce((listener, synchronize) => { receive = listener; void synchronize(); return vi.fn() })
    api.page.mockResolvedValueOnce({ ...base, models: [0, 2000].map(sequence => ({ id: `root-${sequence}`, sequence,
      status: 'completed', text: '', reasoning: '', toolCallIds: [] })),
      activityWindow: { startSequence: 0, endSequence: 2000, totalCount: 2, hasEarlier: false, hasLater: false } })
    render(<ActivityWindow threadId="thread" run={base}>{value => <>
      {value.models.map(item => <span key={item.id}>{item.id}</span>)}{value.tools.map(item => <span key={item.call.id}>{item.call.id}</span>)}
    </>}</ActivityWindow>)
    await screen.findByText('root-2000')
    await act(async () => {
      receive({ type: 'model_started', threadId: 'thread', runId: 'r', model: { id: 'hidden-child-model', sequence: 1000,
        subagentId: 'child', status: 'running', text: '', reasoning: '', toolCallIds: [] } })
      receive({ type: 'tool_started', threadId: 'thread', runId: 'r', subagentId: 'child', sequence: 1001,
        call: { id: 'hidden-child-tool', name: 'pwsh', args: {} } })
    })
    expect(screen.queryByText('hidden-child-model')).toBeNull()
    expect(screen.queryByText('hidden-child-tool')).toBeNull()
  })

  it('cancels a queued latest navigation when the user continues scrolling', async () => {
    let finish!: (value: AgentRunActivity) => void
    api.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={base}>{value =>
      <span>START_{value.activityWindow?.startSequence}</span>
    }</ActivityWindow></div>)
    const panel = view.container.firstElementChild as HTMLElement
    fireEvent(panel, new CustomEvent('activity-boundary', { cancelable: true, detail: { edge: 'latest' } }))
    fireEvent.wheel(panel, { deltaY: -100 })
    await act(async () => finish(page(0, 300)))
    await screen.findByText('START_0')
    expect(api.page).toHaveBeenCalledTimes(1)
  })

  it('keeps the visible pages when a latest read finishes after the user scrolls', async () => {
    let finish!: (value: AgentRunActivity) => void
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={base}>{value =>
      <span>START_{value.activityWindow?.startSequence}</span>
    }</ActivityWindow></div>)
    await screen.findByText('START_0')
    api.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    fireEvent.click(screen.getByText('agent.latest_activities'))
    fireEvent.wheel(view.container.firstElementChild!, { deltaY: -100 })
    await act(async () => finish(page(600, 300)))
    expect(screen.getByText('START_0')).toBeTruthy()
    expect(screen.queryByText('START_600')).toBeNull()
    expect(api.page).toHaveBeenCalledTimes(2)
  })

  it.each(['completed', 'running'] as const)('chooses the child entry using its own status: %s', async status => {
    render(<ActivityWindow threadId="thread" subagentId="child" run={{ ...base, status: status === 'running' ? 'completed' : 'running',
      subagents: [{ id: 'child', name: 'child', sequence: 0, status }] }}>{value => <span>START_{value.activityWindow?.startSequence}</span>}</ActivityWindow>)
    await screen.findByText(status === 'running' ? 'START_600' : 'START_0')
    expect(api.page).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ subagentId: 'child', after: status === 'running' ? undefined : -1, limit: 300 }))
  })

  it('opens a finished run at its beginning and reads forwards without skipping records', async () => {
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={base}>{value =>
      <>{value.memoryRecalls?.map(item => <div data-row={item.id} key={item.id}>ROW_{item.id}</div>)}</>
    }</ActivityWindow></div>)
    await screen.findByText('ROW_0')
    expect(screen.queryByText('ROW_899')).toBeNull()
    expect(api.page).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ after: -1, limit: 300 }))
    for (let index = 0; index < 3; index++) {
      fireEvent.click(screen.getByText('agent.load_later_activities'))
      await screen.findByText(`ROW_${399 + index * 100}`)
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    }
    expect(view.container.querySelectorAll('[data-row]')).toHaveLength(500)
    expect(screen.queryByText('ROW_0')).toBeNull()
    const first = view.container.querySelector('[data-activity-page="0"]')!
    await act(async () => visible.get(first)!())
    await screen.findByText('ROW_0')
    expect(view.container.querySelectorAll('[data-row]')).toHaveLength(500)
  })

  it.each([false, true])('positions live entry at its own end unless the reader moves: %s', async moved => {
    let finish!: (value: AgentRunActivity) => void
    api.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={{ ...base, status: 'running' }}>{value =>
      <>{value.memoryRecalls?.map(item => <div key={item.id}>ROW_{item.id}</div>)}</>
    }</ActivityWindow><div>Later conversation content</div></div>)
    const panel = view.container.firstElementChild as HTMLElement
    vi.mocked(HTMLElement.prototype.getBoundingClientRect).mockImplementation(function (this: HTMLElement) {
      return { top: 0, bottom: this.classList.contains('agent-activity-window') ? 4000 - panel.scrollTop : 400, height: 400 } as DOMRect
    })
    if (moved) { fireEvent.wheel(panel, { deltaY: -100 }); panel.scrollTop = 123 }
    await act(async () => finish(page(600, 300)))
    await screen.findByText('ROW_899')
    expect(panel.scrollTop).toBe(moved ? 123 : 3600)
    expect(api.page).toHaveBeenCalledTimes(1)
  })

  it('retries a failed initial read from the beginning instead of switching to the tail', async () => {
    api.page.mockRejectedValueOnce(new Error('read failed'))
    render(<ActivityWindow threadId="thread" run={base}>{value => <span>{value.activityWindow?.startSequence}</span>}</ActivityWindow>)
    await screen.findByRole('alert')
    fireEvent.click(screen.getByText('common.retry'))
    await screen.findByText('0')
    expect(api.page.mock.calls.map(([input]) => input.after)).toEqual([-1, -1])
  })

  it('releases old display rows as a running turn keeps producing activities', async () => {
    let receive!: (event: AgentRuntimeEvent) => void
    api.onEvent.mockImplementationOnce((listener, synchronize) => { receive = listener; void synchronize(); return vi.fn() })
    api.page.mockResolvedValueOnce({ ...page(0, 300), activityWindow: { startSequence: 0, endSequence: 299, totalCount: 300, hasEarlier: false, hasLater: false } })
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={{ ...base, status: 'running' }}>{value =>
      <>{value.memoryRecalls?.map(item => <div data-row={item.id} key={item.id}>ROW_{item.id}</div>)}</>
    }</ActivityWindow></div>)
    await screen.findByText('ROW_0')
    await act(async () => {
      for (let sequence = 300; sequence < 900; sequence++) receive({ type: 'memory_recalled', threadId: 'thread', runId: 'r',
        recall: { id: String(sequence), sequence, query: '', promptText: '', memoryCount: 1, createdAt: '' } })
    })
    await waitFor(() => expect(api.page).toHaveBeenCalledTimes(2))
    await screen.findByText('ROW_899')
    expect(screen.queryByText('ROW_0')).toBeNull()
    expect(view.container.querySelectorAll('[data-row]').length).toBeLessThanOrEqual(500)
  })

  it('reads once after subscription is ready, then refreshes after reconnect', async () => {
    let synchronize!: () => Promise<void>
    api.onEvent.mockImplementationOnce((_listener, ready) => { synchronize = ready; return vi.fn() })
    render(<ActivityWindow threadId="thread" run={base}>{value => <span>{value.activityWindow?.endSequence}</span>}</ActivityWindow>)
    expect(api.page).not.toHaveBeenCalled()
    await act(synchronize)
    expect(api.page).toHaveBeenCalledTimes(1)
    await screen.findByText('299')
    await act(synchronize)
    expect(api.page).toHaveBeenCalledTimes(4)
    expect(api.page).toHaveBeenLastCalledWith(expect.objectContaining({ before: 300, limit: 100 }))
    expect(screen.getByText('299')).toBeTruthy()
  })

  it('does not paginate on live entry or downward input at the upper boundary', async () => {
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={{ ...base, status: 'running' }}>{value =>
      <>{value.memoryRecalls?.map(item => <div key={item.id}>ROW_{item.id}</div>)}</>
    }</ActivityWindow></div>)
    await screen.findByText('ROW_899')
    const boundary = screen.getByText('agent.load_earlier_activities').parentElement!
    await act(async () => visible.get(boundary)?.())
    expect(api.page).toHaveBeenCalledTimes(1)
    const panel = view.container.firstElementChild!
    fireEvent.wheel(panel, { deltaY: 100 })
    expect(api.page).toHaveBeenCalledTimes(1)
    fireEvent.wheel(panel, { deltaY: -100 })
    await screen.findByText('ROW_500')
    expect(api.page).toHaveBeenCalledTimes(2)
    await act(async () => visible.get(boundary)?.())
    expect(api.page).toHaveBeenCalledTimes(2)
  })

  it('drops page data and keeps only heights/cursors beyond the window limit', () => {
    const pages = splitActivityPage(page(0, 800)).map(slot => ({ ...slot, height: 1000 }))
    const evicted = evictActivityPages(pages, 0)
    expect(evicted.filter(slot => slot.data)).toHaveLength(5)
    expect(evicted.at(-1)).toEqual({ start: 700, end: 799, count: 100, height: 1000, data: undefined })
    expect(JSON.stringify(evicted.at(-1))).not.toContain('memoryRecalls')
  })

  it('can evict measured pages with no visible rows', () => {
    const pages = splitActivityPage(page(0, 800)).map(slot => ({ ...slot, height: 0 }))
    expect(evictActivityPages(pages, 0).filter(slot => slot.data)).toHaveLength(5)
  })

  it('loads upwards, releases the distant bottom, and rereads it when scrolled back', async () => {
    const view = render(<div className="workspace-content-scroll"><ActivityWindow threadId="thread" run={{ ...base, status: 'running' }}>{value =>
      <>{value.memoryRecalls?.map(item => <div data-row={item.id} key={item.id}>ROW_{item.id}</div>)}</>
    }</ActivityWindow></div>)
    await screen.findByText('ROW_899')
    expect(view.container.querySelectorAll('[data-row]')).toHaveLength(300)
    for (let index = 0; index < 3; index++) {
      fireEvent.click(screen.getByText('agent.load_earlier_activities'))
      await waitFor(() => expect(api.page).toHaveBeenCalledTimes(index + 2))
      await waitFor(() => expect(screen.queryByRole('status')).toBeNull())
    }
    expect(view.container.querySelectorAll('[data-row]')).toHaveLength(500)
    expect(screen.queryByText('ROW_899')).toBeNull()
    const placeholder = view.container.querySelector('[data-activity-page="800"]')!
    await act(async () => visible.get(placeholder)!())
    await screen.findByText('ROW_899')
    expect(api.page).toHaveBeenLastCalledWith(expect.objectContaining({ before: 900, limit: 100 }))
    expect(view.container.querySelectorAll('[data-row]')).toHaveLength(500)
    view.unmount()
    expect(screen.queryByText('ROW_899')).toBeNull()
  })
  it('preserves a completion that arrives while its page is being read', async () => {
    let finish!: (value: AgentRunActivity) => void
    let receive!: (event: AgentRuntimeEvent) => void
    api.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    api.onEvent.mockImplementationOnce((listener, synchronize) => { receive = listener; void synchronize(); return vi.fn() })
    const model = { id: 'm', sequence: 1, status: 'running' as const, text: '', reasoning: '', toolCallIds: [] }
    render(<ActivityWindow threadId="thread" run={base}>{value => <>{value.models.map(item => <div key={item.id}>{item.status}:{String(item.hasText)}</div>)}</>}</ActivityWindow>)
    await act(async () => {
      receive({ type: 'model_completed', threadId: 'thread', runId: 'r', model: { ...model, status: 'completed', text: 'BODY_NOT_RETAINED' } })
      finish({ ...base, models: [model], activityWindow: { startSequence: 1, endSequence: 1, totalCount: 1, hasEarlier: false } })
    })
    await screen.findByText('completed:true')
    expect(screen.queryByText('running:false')).toBeNull()
  })

  it('ignores a late page from the previous conversation', async () => {
    let finish!: (value: AgentRunActivity) => void
    api.page.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValueOnce(page(0, 1))
    const renderWindow = (threadId: string) => <ActivityWindow threadId={threadId} run={base}>{value => <>{value.memoryRecalls?.map(item => <div key={item.id}>ROW_{item.id}</div>)}</>}</ActivityWindow>
    const view = render(renderWindow('old'))
    view.rerender(renderWindow('new'))
    await screen.findByText('ROW_0')
    await act(async () => finish(page(800, 100)))
    expect(screen.queryByText('ROW_899')).toBeNull()
    expect(screen.getByText('ROW_0')).toBeTruthy()
  })

})
