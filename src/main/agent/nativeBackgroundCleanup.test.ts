import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { ManagedCallService } from './managedCallService'
import { cleanupUnresolvedBackgroundTasks, hasUnresolvedBackgroundTasks } from './backgroundTaskCleanup'
import { defaultCapabilities } from '../../shared/agentCapabilities'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
afterEach(() => vi.useRealTimers())

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-background-')), file = join(root, 'conversation.sqlite')
  const global = new Database(':memory:')
  const options = { attachmentRoot: join(root, 'attachments'), memoryStore: new SqliteMemoryStore(global),
    fileEditStore: new FileEditStore(join(root, 'file_edits')) }
  let database = NativeConversationDatabase.open(file, options)
  const identity = { threadId: 'thread', runId: 'run' }
  database.runs.createThreadAndRun({ ...identity, thread: {}, submissionId: 'submission',
    message: { id: 'run:input', value: { id: 'run:input', kind: 'user', content: 'Task', context: { runId: 'run' } } } })
  await database.runs.enter('input', identity)
  return { get database() { return database }, file, identity,
    complete(runId = 'run') {
      const scope = () => ({ threadId: identity.threadId, runId, expectedRevisionId: database.runs.store.load('thread')!.revisionId })
      database.runs.store.acceptModel(scope(), { id: runId + ':answer', value: { id: runId + ':answer', kind: 'assistant', content: 'Final answer', context: { runId } } }, [], { modelCalls: 1, todos: [] })
      database.runs.store.finish(scope(), 'completed')
    },
    reopen() { database.close(); database = NativeConversationDatabase.open(file, options) },
    close() { database.close(); global.close(); rmSync(root, { recursive: true, force: true }) } }
}

it.each(['local', 'remote', 'noncooperative remote'] as const)('retains the final reply and older descendant cleanup while preserving unrelated work across reopen (%s)', async kind => {
  const ignoresCancellation = kind === 'noncooperative remote', uncertain = kind !== 'local'
  vi.useFakeTimers()
  const h = await fixture(), database = h.database
  const service = new ManagedCallService(database.managed, database.results)
  for (const [id, parentThreadId, parentRunId, parentSubagentId] of [['child', 'thread', 'run', undefined], ['grandchild', 'child', 'child-run', 'child']] as const) {
    database.runs.createSubagentCall({ id, ownerThreadId: 'thread', parentThreadId, parentRunId, parentSubagentId,
      childThreadId: id, childRunId: id + '-run', childThread: {}, description: 'Old descendant',
      config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
  }
  database.managed.createManagedCall({ id: 'old-call', ...h.identity, kind: 'shell', summary: 'Earlier failure' })
  database.managed.markManagedCallDetached('old-call', 'thread')
  database.managed.finishManagedCall({ callId: 'old-call', threadId: 'thread', status: 'failed', result: 'Retained old result' })
  database.runs.createThreadAndRun({ threadId: 'other', runId: 'other-run', thread: {}, submissionId: 'other-submission',
    message: { id: 'other-run:input', value: { id: 'other-run:input', kind: 'user', content: 'Other', context: { runId: 'other-run' } } } })
  database.managed.createManagedCall({ id: 'other-call', threadId: 'other', runId: 'other-run', kind: 'mcp', summary: 'Unrelated work' })
  database.managed.markManagedCallDetached('other-call', 'other')
  database.managed.finishManagedCall({ callId: 'other-call', threadId: 'other', status: 'completed', result: 'Unrelated result' })
  let finish!: () => void
  const starting = service.start({ kind: uncertain ? 'mcp' : 'shell', threadId: 'grandchild', runId: 'grandchild-run', summary: 'Background operation', uncertainWhenCancelledAfterDispatch: uncertain,
    execute: async control => {
      control.markRunning()
      await new Promise<void>(resolve => {
        finish = resolve
        if (!ignoresCancellation) control.signal.addEventListener('abort', resolve.bind(null, undefined), { once: true })
      })
      control.output('stdout', 'Final output')
      return 'Stopped operation'
    } })
  try {
    await vi.advanceTimersByTimeAsync(10_000)
    const { call_id: callId } = JSON.parse(await starting) as { call_id: string }
    database.runs.store.finish({ ...h.identity, expectedRevisionId: database.runs.store.load('thread')!.revisionId }, 'failed', 'Old failure')
    database.runs.createRun({ threadId: 'thread', runId: 'cleanup-run', operation: 'agent',
      message: { id: 'cleanup-run:input', value: { id: 'cleanup-run:input', kind: 'user', content: 'Finish', context: { runId: 'cleanup-run' } } } })
    await database.runs.enter('input', { threadId: 'thread', runId: 'cleanup-run' })
    h.complete('cleanup-run')
    const history = database.runs.store.readHistory('thread')
    expect(hasUnresolvedBackgroundTasks(database.background, 'thread')).toBe(true)
    const cleanup = cleanupUnresolvedBackgroundTasks({ database: database.background, managedCalls: service, threadId: 'thread', runId: 'cleanup-run',
      cancelSubagents: async list => {
        for (const call of list()) {
          const child = { threadId: call.childThreadId, runId: call.childRunId }
          database.runs.requestCancellation(child); database.runs.completeCancellation(child)
          database.runs.reconcileSubagent(call.id, call.ownerThreadId)
        }
      }, subagentIsActive: () => false,
      report: report => database.background.updateRunBackgroundCleanup('cleanup-run', report) })
    await vi.advanceTimersByTimeAsync(10_000)
    await cleanup
    expect(service.hasActiveForRun('grandchild-run')).toBe(ignoresCancellation)
    expect(database.readSnapshot('thread', { settlingRunId: 'cleanup-run' }).settlingRun).toMatchObject({ status: 'completed', backgroundCleanup: { status: uncertain ? 'unconfirmed' : 'completed' } })
    expect(database.runs.store.readHistory('thread')).toEqual(history)
    expect(hasUnresolvedBackgroundTasks(database.background, 'thread')).toBe(false)
    finish(); await service.waitForIdle()
    expect(database.managed.getManagedCall(callId, 'grandchild')).toMatchObject({ status: uncertain ? 'uncertain' : 'cancelled', result: 'Stopped operation' })
    h.reopen(); h.database.validate()
    expect(h.database.managed.getManagedCall(callId, 'grandchild')).toMatchObject({ status: uncertain ? 'uncertain' : 'cancelled', result: 'Stopped operation', outputChars: 12 })
    expect(h.database.messages.activities.getRun('cleanup-run')?.backgroundCleanup?.status).toBe(uncertain ? 'unconfirmed' : 'completed')
    expect(h.database.runs.store.readHistory('thread')).toEqual(history)
    const report = h.database.messages.activities.getRun('cleanup-run')!.backgroundCleanup!.report
    for (const id of ['old-call', 'child', 'grandchild']) expect(report).toContain(id)
    expect(h.database.managed.listUnresolvedManagedCallsForThread('other')).toHaveLength(1)
    expect(h.database.managed.getManagedCall('old-call', 'thread')?.result).toBe('Retained old result')
    expect(h.database.background.listDescendantSubagentCalls('thread').map(call => call.status)).toEqual(['cancelled', 'cancelled'])
  } finally { finish?.(); await service.waitForIdle(); h.close() }
})

it('rolls back background handoff as a unit and persists native child cancellation without changing the parent answer', async () => {
  const h = await fixture(), database = h.database
  try {
    const child = database.runs.createSubagentCall({ id: 'child', ownerThreadId: 'thread', parentThreadId: 'thread', parentRunId: 'run',
      childThreadId: 'child-thread', childRunId: 'child-run', childThread: {}, description: 'Child task',
      config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
    database.managed.createManagedCall({ id: 'managed', threadId: child.childThreadId, runId: child.childRunId, kind: 'shell', summary: 'Finished search' })
    database.managed.markManagedCallDetached('managed', child.childThreadId)
    database.managed.finishManagedCall({ callId: 'managed', threadId: child.childThreadId, status: 'failed', error: 'Search failed' })
    h.complete()
    const history = database.runs.store.readHistory('thread')
    const raw = new Database(h.file)
    try {
      raw.exec("CREATE TRIGGER fail_cleanup BEFORE INSERT ON agent_subagent_cleanup BEGIN SELECT RAISE(ABORT, 'handoff failed'); END")
      expect(() => database.background.handoffBackgroundTasksToCleanup('run')).toThrow('handoff failed')
      expect(database.managed.listUnresolvedManagedCallsForThread(child.childThreadId)).toHaveLength(1)
      expect(database.resources.listUnresolvedSubagentCallsForRun('run')).toHaveLength(1)
      raw.exec('DROP TRIGGER fail_cleanup')
    } finally { raw.close() }
    await cleanupUnresolvedBackgroundTasks({ database: database.background, managedCalls: new ManagedCallService(database.managed, database.results), ...h.identity,
      cancelSubagents: async list => {
        for (const call of list()) {
          const identity = { threadId: call.childThreadId, runId: call.childRunId }
          database.runs.requestCancellation(identity); database.runs.completeCancellation(identity)
          database.runs.reconcileSubagent(call.id, call.ownerThreadId)
        }
      }, subagentIsActive: () => false, report: report => database.background.updateRunBackgroundCleanup('run', report) })
    h.reopen(); h.database.validate()
    expect(h.database.background.listDescendantSubagentCalls('thread')).toMatchObject([{ id: 'child', status: 'cancelled' }])
    expect(h.database.messages.activities.getRun('run')?.backgroundCleanup).toMatchObject({ status: 'completed', report: expect.stringContaining('call_id=managed: failed') })
    expect(h.database.runs.store.readHistory('thread')).toEqual(history)
  } finally { h.close() }
})

it('preserves background cleanup handoffs after deleting their reporting run and recovering the native database', async () => {
  const h = await fixture(), database = h.database
  try {
    const child = database.runs.createSubagentCall({ id: 'retained-child', ownerThreadId: 'thread', parentThreadId: 'thread', parentRunId: 'run',
      childThreadId: 'retained-child-thread', childRunId: 'retained-child-run', childThread: {}, description: 'Unconfirmed child',
      config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
    for (const [id, threadId, runId] of [['parent-call', 'thread', 'run'], ['child-call', child.childThreadId, child.childRunId]]) {
      database.managed.createManagedCall({ id, threadId, runId, kind: 'mcp', summary: 'Unconfirmed remote call' })
      database.managed.markManagedCallRunning(id, threadId)
      database.managed.markManagedCallDetached(id, threadId)
    }
    database.runs.store.finish({ ...h.identity, expectedRevisionId: database.runs.store.load('thread')!.revisionId }, 'failed', 'Original failure')
    database.runs.createRun({ threadId: 'thread', runId: 'cleanup-run', operation: 'agent',
      message: { id: 'cleanup-run:input', value: { id: 'cleanup-run:input', kind: 'user', content: 'Cleanup report', context: { runId: 'cleanup-run' } } } })
    await database.runs.enter('input', { threadId: 'thread', runId: 'cleanup-run' })
    const handedOff = database.background.handoffBackgroundTasksToCleanup('cleanup-run')
    expect(handedOff.calls.map(call => call.id).sort()).toEqual(['child-call', 'parent-call'])
    expect(handedOff.subagents.map(call => call.id)).toEqual([child.id])
    expect(database.background.handoffBackgroundTasksToCleanup('cleanup-run')).toEqual({ calls: [], subagents: [] })
    expect(() => database.managed.resolveManagedCall('parent-call', 'thread', 'cleanup-run')).toThrow('still running')
    expect(() => database.runs.subagents.resolve(child.id, 'thread', 'run')).toThrow('still running')
    database.runs.store.finish({ threadId: 'thread', runId: 'cleanup-run', expectedRevisionId: database.runs.store.load('thread')!.revisionId }, 'failed', 'Cancellation unconfirmed')
    database.history.commit(database.history.prepare({ threadId: 'thread', messageId: 'cleanup-run:input', kind: 'truncate' }))
    expect(database.messages.activities.getRun('cleanup-run')).toBeNull()
    h.reopen()
    expect(h.database.recover()).toEqual([])
    h.database.validate()
    expect(h.database.managed.listUnresolvedManagedCalls('run')).toEqual([])
    expect(h.database.managed.listUnresolvedManagedCallsForThread('thread')).toEqual([])
    expect(h.database.managed.listUnresolvedManagedCallsForThread(child.childThreadId)).toEqual([])
    expect(h.database.resources.listUnresolvedSubagentCallsForRun('run')).toEqual([])
    expect(h.database.managed.getManagedCall('parent-call', 'thread')?.status).toBe('uncertain')
    expect(h.database.runs.subagents.find(child.id, 'thread')).toMatchObject({ status: 'cancelled' })
    const raw = new Database(h.file, { readonly: true })
    try {
      expect(raw.prepare('SELECT count(*) AS count FROM agent_managed_call_observations').get()).toEqual({ count: 0 })
      expect(raw.prepare('SELECT count(*) AS count FROM agent_subagent_observations').get()).toEqual({ count: 0 })
    } finally { raw.close() }
  } finally { h.close() }
})

it('reports abandoned cleanup progress as unconfirmed after reopening without rewriting the saved evidence', async () => {
  const h = await fixture()
  try {
    h.complete()
    h.database.background.updateRunBackgroundCleanup('run', { status: 'running', report: 'Cancelling background work' })
    expect(h.database.readSnapshot('thread', { settlingRunId: 'run' }).settlingRun?.backgroundCleanup?.status).toBe('running')
    h.reopen()
    expect(h.database.readSnapshot('thread').activities[0].backgroundCleanup).toMatchObject({ status: 'unconfirmed', report: expect.stringContaining('Cancelling background work') })
    expect(h.database.readActivityWindow('thread', 'run', 100).backgroundCleanup?.status).toBe('unconfirmed')
    expect(h.database.messages.activities.getRun('run')?.backgroundCleanup?.status).toBe('running')
    expect(h.database.runs.store.readHistory('thread')?.messages.at(-1)?.value.content).toBe('Final answer')
  } finally { h.close() }
})
