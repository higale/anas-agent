import { act, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ActivityDetail } from './ActivityDetail'
import type { AgentRuntimeEvent } from '@shared/agentTypes'
const api = vi.hoisted(() => ({ detail: vi.fn(), onEvent: vi.fn((_listener: (event: AgentRuntimeEvent) => void, synchronize: () => Promise<void>) => {
  void synchronize()
  return vi.fn()
}) }))
vi.mock('../panels/contentServices', () => ({ contentServices: () => ({ agent: { activities: { detail: api.detail }, onEvent: api.onEvent } }) }))
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
beforeEach(() => { api.detail.mockReset() })
afterEach(() => vi.clearAllMocks())
const reference = { threadId: 'thread', runId: 'run', kind: 'model' as const, id: 'm' }
describe('activity detail lifetime', () => {
  it.each([40, 200])('loads immediately and only shows a pending hint after 150ms (response at %sms)', async delay => {
    vi.useFakeTimers()
    try {
      let finish!: (value: { reasoning: string }) => void
      api.detail.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      render(<ActivityDetail reference={reference} field="reasoning">{value => <pre>{String(value)}</pre>}</ActivityDetail>)
      expect(api.detail).toHaveBeenCalledTimes(1)
      expect(screen.queryByRole('status')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(delay) })
      expect(Boolean(screen.queryByRole('status'))).toBe(delay >= 150)
      await act(async () => finish({ reasoning: 'READY' }))
      expect(screen.getByText('READY')).toBeVisible()
      expect(screen.queryByRole('status')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(200) })
      expect(screen.queryByRole('status')).toBeNull()
    } finally { vi.useRealTimers() }
  })

  it('restarts the hint delay on identity changes and cancels it on unmount', async () => {
    vi.useFakeTimers()
    try {
      api.detail.mockImplementation(() => new Promise(() => undefined))
      const body = (id: string) => <ActivityDetail reference={{ ...reference, id }} field="reasoning">{value => <pre>{String(value)}</pre>}</ActivityDetail>
      const view = render(body('first'))
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      view.rerender(body('second'))
      expect(api.detail).toHaveBeenCalledTimes(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(149) })
      expect(screen.queryByRole('status')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(screen.getByRole('status')).toBeVisible()
      view.rerender(body('third'))
      expect(screen.queryByRole('status')).toBeNull()
      view.unmount()
      expect(vi.getTimerCount()).toBe(0)
    } finally { vi.useRealTimers() }
  })

  it('shows errors immediately and gives a retry its own hint delay', async () => {
    vi.useFakeTimers()
    try {
      api.detail.mockRejectedValueOnce(new Error('unavailable')).mockImplementation(() => new Promise(() => undefined))
      const view = render(<ActivityDetail reference={reference} field="reasoning">{value => <pre>{String(value)}</pre>}</ActivityDetail>)
      await act(async () => { await vi.advanceTimersByTimeAsync(0) })
      expect(screen.getByRole('alert')).toBeVisible()
      expect(screen.queryByRole('status')).toBeNull()
      act(() => screen.getByText('common.retry').click())
      expect(api.detail).toHaveBeenCalledTimes(2)
      await act(async () => { await vi.advanceTimersByTimeAsync(149) })
      expect(screen.queryByRole('status')).toBeNull()
      await act(async () => { await vi.advanceTimersByTimeAsync(1) })
      expect(screen.getByRole('status')).toBeVisible()
      view.unmount()
    } finally { vi.useRealTimers() }
  })

  it('ignores a child model with the same identity and refreshes only its own body', async () => {
    let receive!: (event: AgentRuntimeEvent) => void
    api.onEvent.mockImplementationOnce((listener, ready) => { receive = listener; void ready(); return vi.fn() })
    api.detail.mockResolvedValue({ reasoning: 'ROOT_BODY' })
    render(<ActivityDetail reference={reference} field="reasoning">{value => <pre>{String(value)}</pre>}</ActivityDetail>)
    await screen.findByText('ROOT_BODY')
    vi.useFakeTimers()
    try {
      const delta = { type: 'model_delta' as const, threadId: 'thread', runId: 'run', modelId: 'm', delta: { type: 'reasoning' as const, text: 'updated' } }
      act(() => receive({ ...delta, subagentId: 'child' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(api.detail).toHaveBeenCalledTimes(1)
      act(() => receive(delta))
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(api.detail).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })

  it('rereads once when several updates arrive during an outstanding body read', async () => {
    let receive!: (event: AgentRuntimeEvent) => void, finish!: (value: { reasoning: string }) => void
    api.onEvent.mockImplementationOnce((listener, ready) => { receive = listener; void ready(); return vi.fn() })
    api.detail.mockImplementationOnce(() => new Promise(resolve => { finish = resolve })).mockResolvedValueOnce({ reasoning: 'LATEST_BODY' })
    render(<ActivityDetail reference={reference} field="reasoning">{value => <pre>{String(value)}</pre>}</ActivityDetail>)
    vi.useFakeTimers()
    try {
      act(() => { for (let index = 0; index < 20; index++) receive({ type: 'model_delta', threadId: 'thread', runId: 'run', modelId: 'm', delta: { type: 'reasoning', text: 'updated' } }) })
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(api.detail).toHaveBeenCalledTimes(1)
      await act(async () => finish({ reasoning: 'OLDER_BODY' }))
      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(api.detail).toHaveBeenCalledTimes(2)
      expect(screen.getByText('LATEST_BODY')).toBeTruthy()
    } finally { vi.useRealTimers() }
  })

  it('retries a failed body without retaining its failure after success', async () => {
    api.detail.mockRejectedValueOnce(new Error('body unavailable')).mockResolvedValueOnce({ reasoning: 'RECOVERED_BODY' })
    render(<ActivityDetail reference={reference} field="reasoning">{value => <pre>{String(value)}</pre>}</ActivityDetail>)
    await screen.findByRole('alert')
    act(() => screen.getByText('common.retry').click())
    await screen.findByText('RECOVERED_BODY')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(api.detail).toHaveBeenCalledTimes(2)
  })

  it('reads again after unmount rather than retaining a hidden body cache', async () => {
    api.detail.mockResolvedValueOnce({ reasoning: 'FIRST_BODY' }).mockResolvedValueOnce({ reasoning: 'UPDATED_BODY' })
    const content = () => <ActivityDetail reference={reference} field="reasoning">{value => <pre>{String(value)}</pre>}</ActivityDetail>
    const first = render(content())
    await screen.findByText('FIRST_BODY')
    expect(api.detail).toHaveBeenCalledTimes(1)
    first.unmount()
    expect(screen.queryByText('FIRST_BODY')).toBeNull()
    render(content())
    await screen.findByText('UPDATED_BODY')
    expect(api.detail).toHaveBeenCalledTimes(2)
    expect(api.detail).toHaveBeenLastCalledWith({ ...reference, field: 'reasoning' })
  })
  it('discards a late response after the entry changes', async () => {
    let complete!: (result: { reasoning: string }) => void
    api.detail.mockImplementationOnce(() => new Promise(resolve => { complete = resolve })).mockResolvedValueOnce({ reasoning: 'NEW_BODY' })
    const view = render(<ActivityDetail reference={reference} field="reasoning">{value => <pre>{String(value)}</pre>}</ActivityDetail>)
    view.rerender(<ActivityDetail reference={{ ...reference, id: 'next' }} field="reasoning">{value => <pre>{String(value)}</pre>}</ActivityDetail>)
    await screen.findByText('NEW_BODY')
    await act(async () => complete({ reasoning: 'STALE_BODY' }))
    await waitFor(() => expect(screen.queryByText('STALE_BODY')).toBeNull())
  })
})
