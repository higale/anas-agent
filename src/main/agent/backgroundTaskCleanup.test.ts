import { afterEach, expect, it, vi } from 'vitest'
import { nativeCapabilityFixture } from '../../test/nativeCapabilityFixture'
import type { AgentSubagentCallRecord } from './subagentTaskStore'
import { defaultCapabilities } from '@shared/agentCapabilities'
import { randomUUID } from 'node:crypto'
import { cleanupUnresolvedBackgroundTasks, hasUnresolvedBackgroundTasks } from './backgroundTaskCleanup'
import { backgroundCallsCancelling, backgroundCleanupCompleted, backgroundCleanupUnconfirmed, backgroundSubagentsCancelling } from '@shared/backgroundCleanup'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
afterEach(() => vi.useRealTimers())

it.each(['none', 'initial', 'all'] as const)('cancels executors even when cleanup handoff writes fail (%s)', async (failure) => {
  vi.useFakeTimers()
  const h = nativeCapabilityFixture(), { database, thread, run, service } = h
  let aborted = false
  const starting = service.start({ kind: 'shell', threadId: thread.id, runId: run.id, summary: 'Stop this call',
    execute: async (control) => {
      control.markRunning()
      await new Promise<void>((resolve) => control.signal.addEventListener('abort', () => { aborted = true; resolve() }, { once: true }))
      return 'Stopped'
    } })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    const { call_id: callId } = JSON.parse(await starting)
    const handoff = vi.spyOn(database.background, 'handoffBackgroundTasksToCleanup')
    const fail = () => { throw new Error('Cannot persist cleanup handoff') }
    if (failure === 'initial') handoff.mockImplementationOnce(fail)
    if (failure === 'all') handoff.mockImplementation(fail)
    const reports: Array<{ status: string; report: string }> = []
    await cleanupUnresolvedBackgroundTasks({ database: database.background, managedCalls: service, threadId: thread.id, runId: run.id,
      cancelSubagents: async () => {}, subagentIsActive: () => false, report: (cleanup) => { reports.push(cleanup) } })
    expect(aborted).toBe(true)
    expect(service.hasActiveForThread(thread.id)).toBe(false)
    expect(database.managed.getManagedCall(callId, thread.id)).toMatchObject({ status: 'cancelled', result: 'Stopped' })
    expect(reports.at(-1)?.status).toBe(failure === 'none' ? 'completed' : 'unconfirmed')
    expect(hasUnresolvedBackgroundTasks(database.background, thread.id)).toBe(failure === 'all')
    if (failure !== 'none') expect(reports.at(-1)?.report).toContain('Cannot persist cleanup handoff')
  } finally { await service.shutdown(); await service.waitForIdle(); await h.close() }
})

it('removes noncooperative executors from model supervision while retaining cancellation ownership and records', async () => {
  vi.useFakeTimers()
  const h = nativeCapabilityFixture(), { database, thread, run, service } = h
  let finish!: () => void
  const starting = service.start({
    kind: 'mcp', threadId: thread.id, runId: run.id, summary: 'Noncooperative remote operation', uncertainWhenCancelledAfterDispatch: true,
    execute: async (control) => {
      control.markRunning()
      await new Promise<void>((resolve) => { finish = resolve })
      return 'Executor finally stopped'
    }
  })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    const id = (JSON.parse(await starting) as { call_id: string }).call_id
    const reports: string[] = []
    const cleanup = cleanupUnresolvedBackgroundTasks({
      database: database.background, managedCalls: service, threadId: thread.id, runId: run.id,
      cancelSubagents: async () => {}, subagentIsActive: () => false,
      report: (message) => { reports.push(message.report) }
    })
    await vi.advanceTimersByTimeAsync(10_000)
    await cleanup
    expect(reports.at(-1)).toContain(backgroundCallsCancelling)
    expect(reports.join('\n')).not.toContain(backgroundSubagentsCancelling)
    expect(reports.at(-1)).toContain(`call_id=${id}: unconfirmed`)
    expect(reports.at(-1)).toContain(backgroundCleanupUnconfirmed)
    expect(service.activeCallIds()).toEqual([id])
    expect(database.managed.listUnresolvedManagedCallsForThread(thread.id)).toEqual([])
    expect(hasUnresolvedBackgroundTasks(database.background, thread.id)).toBe(false)
    expect(database.managed.getManagedCall(id, thread.id)?.status).toBe('running')
    finish()
    await service.waitForIdle()
    expect(database.managed.listUnresolvedManagedCallsForThread(thread.id)).toEqual([])
    expect(database.managed.getManagedCall(id, thread.id)).toMatchObject({ status: 'uncertain', result: 'Executor finally stopped' })
  } finally {
    finish?.()
    await service.waitForIdle()
    await h.close()
  }
})

it('bounds unconfirmed subagent cancellation and excludes later user turns from its continuing scope', async () => {
  vi.useFakeTimers()
  const h = nativeCapabilityFixture(), { database, thread, run, service } = h
  await database.runs.enter('input', { threadId: thread.id, runId: run.id })
  const createChild = (parentRunId: string, parent?: AgentSubagentCallRecord) => database.runs.createSubagentCall({
    id: randomUUID(), ownerThreadId: thread.id, parentThreadId: parent?.childThreadId ?? thread.id,
    parentRunId, ...(parent ? { parentSubagentId: parent.id } : {}),
    childThreadId: randomUUID(), childRunId: randomUUID(),
    config: { name: 'worker', index: 0, enabled: true, builtIn: false, description: 'Worker',
      systemPrompt: 'Complete the assigned task.', capabilities: structuredClone(defaultCapabilities) },
    description: 'Slow subagent', childThread: { title: 'Child' }
  })
  const child = createChild(run.id)
  let finish!: () => void
  const stopping = new Promise<void>((resolve) => { finish = resolve })
  let listScope!: () => AgentSubagentCallRecord[]
  const reports: string[] = []
  try {
    const cleanup = cleanupUnresolvedBackgroundTasks({
      database: database.background, managedCalls: service, threadId: thread.id, runId: run.id,
      cancelSubagents: (list) => { listScope = list; return stopping },
      subagentIsActive: () => true, report: (message) => { reports.push(message.report) }
    })
    await vi.advanceTimersByTimeAsync(5_000)
    await cleanup
    expect(reports.at(-1)).toContain(backgroundSubagentsCancelling)
    expect(reports.join('\n')).not.toContain(backgroundCallsCancelling)
    expect(reports.at(-1)).toContain(`subagent_id=${child.id}: unconfirmed`)
    expect(reports.at(-1)).toContain(backgroundCleanupUnconfirmed)
    expect(database.resources.listUnresolvedSubagentCallsForRun(run.id)).toEqual([])
    expect(hasUnresolvedBackgroundTasks(database.background, thread.id)).toBe(false)

    database.runs.store.finish({ threadId: thread.id, runId: run.id, expectedRevisionId: database.runs.store.load(thread.id)!.revisionId }, 'failed', reports.at(-1))
    const nextRun = database.runs.createRun({ threadId: thread.id, runId: 'new-user-turn', operation: 'agent',
      message: { id: 'new-user-turn:input', value: { id: 'new-user-turn:input', kind: 'user', content: 'Next task', context: { runId: 'new-user-turn' } } } })
    const nextChild = createChild(nextRun.id)
    const lateGrandchild = createChild(child.childRunId, child)
    expect(listScope().map((call) => call.id).sort()).toEqual([child.id, lateGrandchild.id].sort())
    expect(database.resources.listUnresolvedSubagentCallsForRun(nextRun.id).map((call) => call.id)).toEqual([nextChild.id])
  } finally {
    finish()
    await stopping
    await h.close()
  }
})

it('reports only retained results when all pending calls have already failed and no subagents exist', async () => {
  const h = nativeCapabilityFixture(), { database, thread, run, service } = h
  try {
    for (const id of ['failed-search', 'failed-directory-search']) {
      database.managed.createManagedCall({ id, threadId: thread.id, runId: run.id, kind: 'shell', summary: 'Search' })
      database.managed.markManagedCallDetached(id, thread.id)
      database.managed.finishManagedCall({ callId: id, threadId: thread.id, status: 'failed', error: 'Search failed' })
    }
    const reports: string[] = []
    await cleanupUnresolvedBackgroundTasks({
      database: database.background, managedCalls: service, threadId: thread.id, runId: run.id,
      cancelSubagents: async () => { throw new Error('No subagent executor exists') },
      subagentIsActive: () => false, report: (message) => { reports.push(message.report) }
    })
    expect(reports.join('\n')).not.toMatch(/cancell|subagent/i)
    expect(reports.at(-1)).toContain('call_id=failed-search: failed; Search; Search failed')
    expect(reports.at(-1)).toContain('call_id=failed-directory-search: failed; Search; Search failed')
    expect(reports.at(-1)?.endsWith(backgroundCleanupCompleted)).toBe(true)
    expect(hasUnresolvedBackgroundTasks(database.background, thread.id)).toBe(false)
  } finally {
    await h.close()
  }
})
