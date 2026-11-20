import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { GaleApi, PythonRuntimeStatus } from '@shared/types'
import { notice } from './notice'
import { usePythonRuntimeNotice } from './usePythonRuntimeNotice'

const t = (key: string) => key
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))
vi.mock('./notice', () => ({ notice: { info: vi.fn(), success: vi.fn(), error: vi.fn(), dismiss: vi.fn() } }))
let status: PythonRuntimeStatus
const getStatus = vi.fn(async () => status)
beforeEach(() => {
  vi.useFakeTimers()
  status = { state: 'preparing' }
  window.gale = { app: { getPythonRuntimeStatus: getStatus } } as unknown as GaleApi
})
afterEach(() => { cleanup(); vi.useRealTimers() })

it('keeps quick startup silent and stops polling when ready', async () => {
  status = { state: 'ready' }
  renderHook(() => usePythonRuntimeNotice())
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(getStatus).toHaveBeenCalledTimes(1)
  expect(notice.info).not.toHaveBeenCalled()
  expect(notice.success).not.toHaveBeenCalled()
})

it('shows a persistent notice for slow preparation then replaces it with success', async () => {
  renderHook(() => usePythonRuntimeNotice())
  await act(async () => { await vi.advanceTimersByTimeAsync(500) })
  expect(notice.info).not.toHaveBeenCalled()
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(notice.info).toHaveBeenCalledExactlyOnceWith('startup.python_preparing', { id: 'python-startup', description: '', duration: Infinity })
  status = { state: 'ready' }
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(notice.success).toHaveBeenCalledExactlyOnceWith('startup.python_ready', { id: 'python-startup', description: '' })
})

it('reports a preparation failure and stops polling', async () => {
  status = { state: 'error', error: 'Disk full' }
  renderHook(() => usePythonRuntimeNotice())
  await act(async () => { await vi.advanceTimersByTimeAsync(2000) })
  expect(notice.error).toHaveBeenCalledExactlyOnceWith('startup.python_failed', {
    id: 'python-startup', description: 'Disk full', duration: Infinity
  })
  expect(getStatus).toHaveBeenCalledTimes(1)
})

it('does not show a late response after unmount', async () => {
  let resolve!: (value: PythonRuntimeStatus) => void
  getStatus.mockReturnValueOnce(new Promise<PythonRuntimeStatus>(done => { resolve = done }))
  const hook = renderHook(() => usePythonRuntimeNotice())
  hook.unmount()
  await act(async () => { resolve({ state: 'error', error: 'late failure' }); await vi.advanceTimersByTimeAsync(2000) })
  expect(notice.error).not.toHaveBeenCalled()
  expect(getStatus).toHaveBeenCalledTimes(1)
})
