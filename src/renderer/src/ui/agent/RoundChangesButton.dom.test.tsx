import { StrictMode } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentRuntimeEvent } from '@shared/agentTypes'
import type { RoundChangeAvailability, RoundChangeAvailabilityInput } from '@shared/fileChanges'
import * as services from '../panels/contentServices'
import { RoundChangesButton, useRoundChangeAvailability } from './RoundChangesButton'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }))
let requests: { input: RoundChangeAvailabilityInput; resolve(value: RoundChangeAvailability[]): void }[]
let receive: (event: AgentRuntimeEvent) => void
const open = vi.fn()
function Shortcuts({ threadId }: { threadId: string }) {
  const store = useRoundChangeAvailability(threadId, true)
  return <><RoundChangesButton runId="run" store={store} onOpen={open} /><RoundChangesButton runId="run" store={store} onOpen={open} /></>
}
beforeEach(() => {
  vi.useFakeTimers(); requests = []; open.mockReset()
  vi.spyOn(services, 'contentServices').mockReturnValue({ agent: {
    changes: { availability: (input: RoundChangeAvailabilityInput) => new Promise(resolve => requests.push({ input, resolve })) },
    onEvent: (listener: typeof receive, ready: () => void) => { receive = listener; ready(); return vi.fn() }
  } } as unknown as ReturnType<typeof services.contentServices>)
})
afterEach(() => vi.useRealTimers())
const advance = () => act(async () => { await vi.advanceTimersByTimeAsync(100) })
const resolve = (index: number, state: RoundChangeAvailability['state']) => act(async () => {
  requests[index].resolve([{ runId: 'run', state, relatedRunIds: ['run', 'child'] }])
})

it('shares a batch, disables pending shortcuts, hides settled empty ones and enables newly recorded changes', async () => {
  render(<StrictMode><Shortcuts threadId="thread" /></StrictMode>)
  expect(screen.getAllByRole('button')).toHaveLength(2)
  expect(screen.getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true)
  await advance(); expect(requests).toHaveLength(1)
  expect(requests[0].input).toEqual({ threadId: 'thread', runIds: ['run'] })
  await resolve(0, 'pending')
  expect(screen.getAllByRole('button')[0]).toHaveAttribute('data-tooltip', 'agent.recorded_changes_pending')
  act(() => receive({ type: 'run_settled', threadId: 'thread', runId: 'run', operation: 'agent', status: 'completed' }))
  await advance(); await resolve(1, 'empty')
  expect(screen.queryByRole('button')).toBeNull()
  act(() => receive({ type: 'file_changes', threadId: 'thread', runId: 'child' }))
  await advance(); await resolve(2, 'available')
  const buttons = screen.getAllByRole('button')
  expect(buttons.every(button => !button.hasAttribute('disabled'))).toBe(true)
  fireEvent.click(buttons[0]); expect(open).toHaveBeenCalledExactlyOnceWith('run')
})

it('never lets an old conversation response enable the new conversation shortcut', async () => {
  const view = render(<Shortcuts threadId="old" />)
  await advance()
  view.rerender(<Shortcuts threadId="new" />)
  await advance(); expect(requests.map(request => request.input.threadId)).toEqual(['old', 'new'])
  await resolve(0, 'available')
  expect(screen.getAllByRole('button').every(button => button.hasAttribute('disabled'))).toBe(true)
  await resolve(1, 'empty')
  expect(screen.queryByRole('button')).toBeNull()
})
