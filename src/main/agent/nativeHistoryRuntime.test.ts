import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentRuntimeEvent } from '../../shared/agentTypes'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeRunHost } from './nativeRunHost'
import { ManagedCallService } from './managedCallService'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { archiveAgentAttachments } from './agentAttachmentStore'

vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
afterEach(() => vi.useRealTimers())
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-history-runtime-')), global = new Database(':memory:')
  const attachmentRoot = join(root, 'attachments'), temporaryRoot = join(root, 'temporary'), threadId = randomUUID()
  const database = NativeConversationDatabase.open(join(root, 'conversation.sqlite'), { attachmentRoot,
    memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) })
  database.runs.createThread({}, threadId)
  const managed = new ManagedCallService(database.managed, database.results), events: AgentRuntimeEvent[] = []
  const host = new NativeRunHost(database, managed, { push: event => events.push(event) })
  let requests = 0
  const services: ConversationExecutionServices = { store: database.runs.store, enter: database.execution.enter,
    prepareModel: async state => ({ kind: 'model', invoke: async () => ({
      message: { id: `${state.runId}:answer`, value: { kind: 'assistant', content: `Answer ${++requests}`, context: { runId: state.runId } } },
      calls: [], context: { ...state.context, modelCalls: state.context.modelCalls + 1 } }) }),
    afterModel: async () => ({ kind: 'complete' }), prepareTools: async () => ({ calls: [] }),
    executeTool: async () => { throw new Error('No tool expected') }, directions: async () => [], drain: async () => {}, retry: { maxRetries: 0 } }
  const create = async () => ({ execution: conversationExecution(services), dispose: async () => {} })
  return { root, temporaryRoot, threadId, database, managed, host, services, events, create, get requests() { return requests },
    async input(options: { attachments?: boolean; content?: ConversationMessage['content'] } = {}) {
      const runId = randomUUID(), id = `${runId}:input`, source = join(root, `${runId}.txt`); writeFileSync(source, 'Original attachment')
      const attachments = options.attachments ? await archiveAgentAttachments([{ path: source, name: 'original.txt', mimeType: 'text/plain', kind: 'text', size: 19, contextPolicy: 'conversation' }],
        { threadId, runId, messageId: id }, attachmentRoot) : []
      database.runs.createRun({ threadId, runId, operation: 'agent', attachments,
        message: { id, value: { id, kind: 'user', content: options.content ?? 'Task', context: { runId, displayText: 'Visible task' } } } })
      return { threadId, runId, messageId: id, attachments }
    },
    async complete(owner: { threadId: string; runId: string }) { const handle = host.start(owner, 'input', create); await handle.completed; await handle.drained },
    async close() { await host.waitForIdle(); database.validate(); database.close(); global.close(); rmSync(root, { recursive: true, force: true }) }
  }
}

it('copies edit attachments before truncating their archived history and allows the next conversation turn', async () => {
  const h = fixture()
  try {
    const first = await h.input({ attachments: true }); await h.complete(first)
    const second = await h.input(); await h.complete(second)
    const edited = await h.host.prepareMessageEdit(first, h.temporaryRoot)
    expect(edited.snapshot.messages).toEqual([])
    expect(edited.attachments).toMatchObject([{ name: 'original.txt', temporary: true, contextPolicy: 'conversation' }])
    expect(readFileSync(edited.attachments[0].path, 'utf8')).toBe('Original attachment')
    expect(existsSync(first.attachments[0].artifact.path)).toBe(false)
    expect(h.database.messages.activities.getRun(second.runId)).toBeNull()
    const next = await h.input(); await h.complete(next)
    expect(h.host.readSnapshot(h.threadId).messages).toHaveLength(2)
  } finally { await h.close() }
})

it.each(['completed', 'failed', 'cancelled'] as const)('regenerates a %s input with its media and attachments, without announcing a new user turn', async status => {
  const h = fixture()
  try {
    const content = [{ type: 'text', text: 'Original prompt' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }]
    const first = await h.input({ attachments: true, content }), prepare = h.services.prepareModel
    if (status !== 'completed') h.services.prepareModel = async () => {
      if (status === 'cancelled') h.host.cancel(first)
      throw new Error('Provider unavailable')
    }
    await h.complete(first); h.services.prepareModel = prepare
    expect(h.database.readModel.getRun(first.runId)?.status).toBe(status)
    const uncertain = status === 'failed' ? [randomUUID(), randomUUID()] : []
    for (const id of uncertain) {
      h.database.managed.createManagedCall({ id, ...first, kind: 'mcp', summary: 'Remote result unknown' })
      h.database.managed.markManagedCallRunning(id, h.threadId); h.database.managed.markManagedCallDetached(id, h.threadId)
      h.database.managed.finishManagedCall({ callId: id, threadId: h.threadId, status: 'uncertain', error: 'No confirmed result' })
    }
    await h.complete(await h.input())
    const runId = randomUUID(), changed = await h.host.regenerateMessage({ ...first, runId }, h.create)
    expect((await changed.handle.completed).status).toBe('completed'); await changed.handle.drained
    expect(h.requests).toBe(status === 'completed' ? 3 : 2)
    for (const id of uncertain) expect(h.database.managed.getManagedCall(id, h.threadId)).toBeUndefined()
    expect(h.events.filter(event => event.type === 'run_started').at(-1)).toMatchObject({ run: { id: runId }, newUserTurn: false })
    const history = h.database.runs.store.readHistory(h.threadId)!.messages
    expect(history).toHaveLength(2)
    expect(history[0]).toMatchObject({ id: first.messageId, value: { content, context: { runId, displayText: 'Visible task' } } })
    expect(h.database.resources.listAttachmentsForMessages(h.threadId, [first.messageId])).toMatchObject([{ runId, path: first.attachments[0].artifact.path }])
    expect(existsSync(first.attachments[0].artifact.path)).toBe(true)
    expect(h.database.resources.getThread(h.threadId)?.userTurnCount).toBe(1)
  } finally { await h.close() }
})

it('preserves history and removes only the draft when an original attachment is missing', async () => {
  const h = fixture()
  try {
    const first = await h.input({ attachments: true }); await h.complete(first)
    const history = h.database.runs.store.readHistory(h.threadId)
    unlinkSync(first.attachments[0].artifact.path)
    await expect(h.host.prepareMessageEdit(first, h.temporaryRoot)).rejects.toThrow('no longer available')
    expect(h.database.runs.store.readHistory(h.threadId)).toEqual(history)
    expect(readdirSync(join(h.temporaryRoot, 'message_edit'))).toEqual([])
  } finally { await h.close() }
})

it('owns the conversation during history mutation and keeps shutdown waiting for it', async () => {
  const h = fixture(), entered = deferred(), proceed = deferred()
  try {
    const first = await h.input(); await h.complete(first)
    const cancel = h.managed.cancelRuns.bind(h.managed)
    vi.spyOn(h.managed, 'cancelRuns').mockImplementationOnce(async (...args) => { entered.resolve(); await proceed.promise; return cancel(...args) })
    const changing = h.host.truncateMessages(first); await entered.promise
    await expect(h.host.truncateMessages(first)).rejects.toThrow()
    expect(() => h.host.start(first, 'continue', h.create)).toThrow('history is being changed')
    let idle = false
    const waiting = h.host.waitForIdle().then(() => { idle = true })
    await Promise.resolve(); expect(idle).toBe(false)
    proceed.resolve(); expect((await changing).messages).toEqual([])
    await waiting; expect(idle).toBe(true)
  } finally { proceed.resolve(); await h.close() }
})

it('does not truncate a completed run while a recovered background executor is still exiting', async () => {
  vi.useFakeTimers()
  const h = fixture(), operation = deferred()
  try {
    const retained = await h.input(); await h.complete(retained)
    const first = await h.input(); await h.complete(first)
    const retainedCall = randomUUID()
    h.database.managed.createManagedCall({ id: retainedCall, ...retained, kind: 'shell', summary: 'Earlier result observed by later turn' })
    h.database.managed.markManagedCallDetached(retainedCall, h.threadId)
    h.database.managed.finishManagedCall({ callId: retainedCall, threadId: h.threadId, status: 'completed', result: 'Retained result' })
    h.database.managed.resolveManagedCall(retainedCall, h.threadId, first.runId)
    expect(h.database.managed.listUnresolvedManagedCallsForThread(h.threadId)).toEqual([])
    const before = h.database.runs.store.readHistory(h.threadId)
    const started = h.managed.start({ ...first, kind: 'mcp', summary: 'Recovered external call', uncertainWhenCancelledAfterDispatch: true,
      execute: async control => { control.markRunning(); await operation.promise; return 'Late result' } })
    await vi.advanceTimersByTimeAsync(10_000); await started
    const changed = h.host.truncateMessages(first)
    const rejected = expect(changed).rejects.toThrow('background work is still executing')
    await vi.advanceTimersByTimeAsync(10_000); await rejected
    expect(h.database.runs.store.readHistory(h.threadId)).toEqual(before)
    operation.resolve(); await h.managed.waitForRunIdle(first.runId)
    expect((await h.host.truncateMessages(first)).messages.map(message => message.id)).toEqual([retained.messageId, `${retained.runId}:answer`])
    expect(h.database.managed.listUnresolvedManagedCallsForThread(h.threadId)).toMatchObject([{ id: retainedCall, result: 'Retained result' }])
  } finally { operation.resolve(); await h.close() }
})

it('cancels and drains a live child before deleting its owning historical turn', async () => {
  const h = fixture(), childEntered = deferred()
  try {
    const parent = await h.input(); await h.database.runs.enter('input', parent)
    const call = h.database.runs.createSubagentCall({ id: randomUUID(), ownerThreadId: h.threadId, parentThreadId: h.threadId, parentRunId: parent.runId,
      childThreadId: randomUUID(), childRunId: randomUUID(), description: 'Old child', childThread: {},
      config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
    h.database.runs.store.finish({ ...parent, expectedRevisionId: h.database.runs.store.load(h.threadId)!.revisionId }, 'completed')
    const childServices: ConversationExecutionServices = { ...h.services, prepareModel: async (_state, request) => ({ kind: 'model', invoke: async () => {
      childEntered.resolve()
      await new Promise<void>((_, reject) => { if (request.signal.aborted) reject(request.signal.reason); else request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true }) })
      throw new Error('Cancelled child must not answer')
    } }) }
    const child = h.host.start({ threadId: call.childThreadId, runId: call.childRunId }, 'input', async () => ({ execution: conversationExecution(childServices), dispose: async () => {} }))
    await childEntered.promise
    expect((await h.host.truncateMessages(parent)).messages).toEqual([])
    await child.drained
    expect(h.database.resources.getThread(call.childThreadId)).toBeNull()
    expect(h.database.runs.subagents.find(call.id, h.threadId)).toBeUndefined()
    expect(h.host.isActive({ threadId: call.childThreadId, runId: call.childRunId })).toBe(false)
  } finally { await h.close() }
})

it('waits for the cancellation owner created for an inactive saved child before deleting its rows', async () => {
  const h = fixture(), cleaning = deferred(), release = deferred()
  try {
    const parent = await h.input(); await h.database.runs.enter('input', parent)
    const call = h.database.runs.createSubagentCall({ id: randomUUID(), ownerThreadId: h.threadId, parentThreadId: h.threadId, parentRunId: parent.runId,
      childThreadId: randomUUID(), childRunId: randomUUID(), description: 'Unaccepted child', childThread: {},
      config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
    h.database.runs.store.finish({ ...parent, expectedRevisionId: h.database.runs.store.load(h.threadId)!.revisionId }, 'completed')
    const cleanup = h.database.resources.fileEditStore.deleteFileEditRecordsForRequest.bind(h.database.resources.fileEditStore)
    vi.spyOn(h.database.resources.fileEditStore, 'deleteFileEditRecordsForRequest').mockImplementation(async (runId, retained) => {
      if (runId === call.childRunId) { cleaning.resolve(); await release.promise }
      await cleanup(runId, retained)
    })
    const changing = h.host.truncateMessages(parent)
    await cleaning.promise
    expect(h.database.resources.getThread(call.childThreadId)).not.toBeNull()
    expect(h.database.runs.store.readHistory(h.threadId)?.messages).toHaveLength(1)
    release.resolve(); expect((await changing).messages).toEqual([])
    expect(h.database.resources.getThread(call.childThreadId)).toBeNull()
    expect(h.requests).toBe(0)
  } finally { release.resolve(); await h.close() }
})

it('rolls failed history deletion back through the host and permits repeated truncation afterward', async () => {
  const h = fixture()
  const sql = new Database(join(h.root, 'conversation.sqlite'))
  try {
    const first = await h.input(); await h.complete(first)
    const second = await h.input(); await h.complete(second)
    const third = await h.input(); await h.complete(third)
    const history = h.database.runs.store.readHistory(h.threadId), snapshot = h.host.readSnapshot(h.threadId)
    sql.exec("CREATE TRIGGER fail_history_runs BEFORE DELETE ON agent_runs BEGIN SELECT RAISE(ABORT,'history run cleanup failed'); END")
    await expect(h.host.truncateMessages(third)).rejects.toThrow('history run cleanup failed')
    expect(h.database.runs.store.readHistory(h.threadId)).toEqual(history)
    expect(h.host.readSnapshot(h.threadId)).toEqual(snapshot)
    expect(h.database.messages.activities.getRun(third.runId)).toMatchObject({ status: 'completed' })
    sql.exec('DROP TRIGGER fail_history_runs')
    const afterThird = await h.host.truncateMessages(third)
    expect(afterThird.messages.map(message => message.id)).toEqual(snapshot.messages.slice(0, 4).map(message => message.id))
    const afterSecond = await h.host.truncateMessages(second)
    expect(afterSecond.messages.map(message => message.id)).toEqual(snapshot.messages.slice(0, 2).map(message => message.id))
    expect(h.database.messages.activities.getRun(first.runId)).toMatchObject({ status: 'completed' })
    expect(h.database.messages.activities.getRun(second.runId)).toBeNull()
    expect(h.database.messages.activities.getRun(third.runId)).toBeNull()
    expect(h.database.resourceCleanup.listAttachmentFileCleanup()).toEqual([])
    expect(sql.pragma('foreign_key_check')).toEqual([])
  } finally { sql.close(); await h.close() }
})
