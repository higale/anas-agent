import { expect, it, vi } from 'vitest'
import { dispatchWorkspaceAction } from './workspaceDispatch'

it('dispatches a send before subsequent navigation but does not wait for its reply', async () => {
  let ready!: () => void, acknowledge!: () => void
  const preparing = new Promise<void>(resolve => { ready = resolve })
  const pendingReply = new Promise<void>(resolve => { acknowledge = resolve })
  const calls: string[] = []
  const sent = dispatchWorkspaceAction(() => { calls.push('send B'); return pendingReply }, () => preparing)
  const switched = dispatchWorkspaceAction(async () => { calls.push('open C') })
  await Promise.resolve()
  expect(calls).toEqual([])
  ready()
  await switched
  expect(calls).toEqual(['send B', 'open C'])
  acknowledge()
  await sent
})

it('releases navigation even if send preparation fails', async () => {
  const submit = vi.fn(async () => {})
  const sent = dispatchWorkspaceAction(submit, async () => { throw new Error('Failed to load thread') })
  const switched = dispatchWorkspaceAction(async () => 'C')
  await expect(sent).rejects.toThrow('Failed to load thread')
  await expect(switched).resolves.toBe('C')
  expect(submit).not.toHaveBeenCalled()
})
