import { defaultCapabilities } from '@shared/agentCapabilities'
import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { nativeCapabilityFixture } from '../../test/nativeCapabilityFixture'
import { listConversationProcesses, terminateConversationProcess } from './conversationProcesses'
import { refreshProcesses, terminateObservedProcess } from '../processObservation'
import type { ProcessIdentity, ProcessSnapshot } from '@shared/processes'

vi.mock('../processObservation', () => ({ refreshProcesses: vi.fn(), terminateObservedProcess: vi.fn() }))
const process: ProcessIdentity = { pid: 1234, birth: 'birth', name: 'QQMusic.exe', parentPid: 12, startedAt: '2026-01-01T00:00:00.000Z', role: 'child' }
const snapshot = (): ProcessSnapshot => ({ processes: [{ ...process, status: 'running' }], complete: false, checkedAt: new Date().toISOString() })
it('lists a completed Shell child, persists new associations, and terminates only its stored identity', async () => {
  const h = nativeCapabilityFixture(), id = randomUUID()
  vi.mocked(refreshProcesses).mockImplementation(known => ({ ...snapshot(), processes: known.map(info => ({ ...info, status: 'running' })) }))
  vi.mocked(terminateObservedProcess).mockClear()
  try {
    h.database.managed.createManagedCall({ id, threadId: h.thread.id, runId: h.run.id, kind: 'shell', summary: 'Open music' })
    h.database.managed.finishManagedCall({ callId: id, threadId: h.thread.id, status: 'completed', result: 'done',
      outcome: { exit_code: 0, process_snapshot: snapshot(), command: 'Start-Process QQMusic' } })
    expect(listConversationProcesses(h.database, h.thread.id).calls).toMatchObject([{ callId: id, status: 'completed',
      command: 'Start-Process QQMusic', snapshot: { processes: [{ pid: 1234, status: 'running' }] } }])
    terminateConversationProcess(h.database, { threadId: h.thread.id, callId: id, process: { ...process, name: 'untrusted name' } })
    expect(terminateObservedProcess).toHaveBeenCalledExactlyOnceWith(process)
    expect(() => terminateConversationProcess(h.database, { threadId: h.thread.id, callId: id, process: { ...process, birth: 'reused' } })).toThrow('associated')
    expect(() => terminateConversationProcess(h.database, { threadId: h.thread.id, callId: randomUUID(), process })).toThrow('belong')
    expect(terminateObservedProcess).toHaveBeenCalledOnce()
    expect(h.database.managed.getManagedCall(id, h.thread.id)).toMatchObject({ status: 'completed', result: 'done', outcome: { exit_code: 0 } })
    vi.mocked(refreshProcesses).mockReturnValue({ ...snapshot(), processes: [{ ...process, status: 'exited' }] })
    listConversationProcesses(h.database, h.thread.id)
    expect(listConversationProcesses(h.database, h.thread.id).calls).toEqual([])
  } finally { await h.close() }
})

it('includes nested subagent calls and paginates without omitting or duplicating process groups', async () => {
  const h = nativeCapabilityFixture()
  vi.mocked(refreshProcesses).mockImplementation(known => ({ ...snapshot(), processes: known.map(info => ({ ...info, status: 'running' })) }))
  vi.mocked(terminateObservedProcess).mockClear()
  try {
    await h.database.runs.enter('input', { threadId: h.thread.id, runId: h.run.id })
    const createChild = (parentThreadId: string, parentRunId: string, parentSubagentId?: string) => h.database.runs.createSubagentCall({
      id: randomUUID(), ownerThreadId: h.thread.id, parentThreadId, parentRunId, parentSubagentId,
      childThreadId: randomUUID(), childRunId: randomUUID(),
      config: { name: 'worker', index: 0, enabled: true, builtIn: false, description: 'Worker',
        systemPrompt: 'Complete the task.', capabilities: structuredClone(defaultCapabilities) },
      description: 'Nested worker', childThread: { title: 'Worker' }
    })
    const child = createChild(h.thread.id, h.run.id)
    const grandchild = createChild(child.childThreadId, child.childRunId, child.id)
    const expected = new Set<string>()
    for (let index = 0; index < 102; index++) {
      const id = randomUUID(), owner = index % 2 === 0 ? child : grandchild
      h.database.managed.createManagedCall({ id, threadId: owner.childThreadId, runId: owner.childRunId, kind: 'shell', summary: 'Child command' })
      h.database.managed.finishManagedCall({ callId: id, threadId: owner.childThreadId, status: 'completed', result: 'done', outcome: { process_snapshot: snapshot() } })
      expected.add(id)
    }
    const first = listConversationProcesses(h.database, h.thread.id)
    expect(first.calls).toHaveLength(100)
    expect(first.nextCursor).toBeDefined()
    const last = listConversationProcesses(h.database, h.thread.id, first.nextCursor)
    expect(last.calls).toHaveLength(2)
    expect(last.nextCursor).toBeUndefined()
    expect(new Set([...first.calls, ...last.calls].map(call => call.callId))).toEqual(expected)
    terminateConversationProcess(h.database, { threadId: h.thread.id, callId: last.calls[0].callId, process })
    expect(terminateObservedProcess).toHaveBeenCalledExactlyOnceWith(process)
    expect(() => terminateConversationProcess(h.database, { threadId: grandchild.childThreadId,
      callId: first.calls.find(call => call.threadId === child.childThreadId)!.callId, process })).toThrow('belong')
  } finally { await h.close() }
})

it('retains recorded identities when a failed observation cannot establish direct parentage', async () => {
  const h = nativeCapabilityFixture(), id = randomUUID(), previous = snapshot()
  try {
    h.database.managed.createManagedCall({ id, threadId: h.thread.id, runId: h.run.id, kind: 'shell', summary: 'Open music' })
    h.database.managed.finishManagedCall({ callId: id, threadId: h.thread.id, status: 'completed', result: 'done',
      outcome: { process_snapshot: previous } })
    vi.mocked(refreshProcesses).mockReturnValue({ ...snapshot(), processes: [], error: 'Cannot query parent processes' })
    expect(listConversationProcesses(h.database, h.thread.id).calls[0].snapshot.error).toBe('Cannot query parent processes')
    expect(h.database.managed.getManagedCall(id, h.thread.id)?.outcome?.process_snapshot).toEqual(previous)
    vi.mocked(refreshProcesses).mockReturnValue(snapshot())
    expect(listConversationProcesses(h.database, h.thread.id).calls[0].snapshot.processes).toHaveLength(1)
  } finally { await h.close() }
})
