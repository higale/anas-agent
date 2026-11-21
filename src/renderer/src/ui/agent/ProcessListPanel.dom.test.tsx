import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import { ProcessListPanel } from './ProcessListPanel'
import type { ProcessCallGroup } from '@shared/processes'
const list = vi.fn(), terminate = vi.fn()
vi.mock('./PanelViewState', () => ({ usePanelReady: vi.fn(), usePanelScroll: () => undefined }))
vi.mock('react-i18next', () => { const t = (key: string) => key; return { useTranslation: () => ({ t }) } })
const call: ProcessCallGroup = { callId: 'call', threadId: 'thread', runId: 'run', summary: 'Open music', command: 'Start-Process QQMusic',
  status: 'completed', createdAt: '', snapshot: { checkedAt: '', complete: false, processes: [
    { pid: 1234, birth: 'birth', name: 'QQMusic.exe', parentPid: 12, startedAt: '', role: 'child', status: 'running' }
  ] } }
beforeEach(() => {
  vi.clearAllMocks(); list.mockResolvedValue({ calls: [call] }); terminate.mockResolvedValue(undefined)
  Object.defineProperty(window, 'gale', { configurable: true, value: { agent: { processes: { list, terminate } } } })
})
it('shows a child after its Shell completed and terminates the exact selected identity', async () => {
  const view = render(<ProcessListPanel threadId="thread" />)
  await screen.findByText('QQMusic.exe')
  expect(screen.getByText('process_list.call_completed')).toBeInTheDocument()
  expect(list).toHaveBeenCalledWith({ threadId: 'thread' })
  fireEvent.click(screen.getByRole('button', { name: 'process_list.terminate QQMusic.exe (1234)' }))
  await waitFor(() => expect(terminate).toHaveBeenCalledExactlyOnceWith({ threadId: 'thread', callId: 'call', process: call.snapshot.processes[0] }))
  view.unmount()
})
it('keeps failed refresh visible and disables termination of stale rows', async () => {
  const view = render(<ProcessListPanel threadId="thread" />)
  await screen.findByText('QQMusic.exe')
  list.mockRejectedValue(new Error('Cannot query processes'))
  fireEvent.click(screen.getByRole('button', { name: 'process_list.refresh' }))
  await screen.findByRole('alert')
  expect(screen.getByRole('alert')).toHaveTextContent('panels.operation_failed')
  expect(screen.queryByText('Cannot query processes')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'process_list.terminate QQMusic.exe (1234)' })).toBeDisabled()
  expect(terminate).not.toHaveBeenCalled()
  view.unmount()
})
it('keeps the selected process visible and localizes a failed termination', async () => {
  terminate.mockRejectedValue(new Error('Cannot terminate process'))
  const view = render(<ProcessListPanel threadId="thread" />)
  await screen.findByText('QQMusic.exe')
  fireEvent.click(screen.getByRole('button', { name: 'process_list.terminate QQMusic.exe (1234)' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('panels.operation_failed')
  expect(screen.queryByText('Cannot terminate process')).not.toBeInTheDocument()
  expect(screen.getByText('QQMusic.exe')).toBeInTheDocument()
  view.unmount()
})
