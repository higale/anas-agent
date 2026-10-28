import { randomUUID } from 'node:crypto'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import type { ExecutionToolCall } from '../../runtime/executionState'
import Database from 'better-sqlite3'
import { collectNativeMessageBodies } from './nativeMessageCleanup'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { defineTool } from '../../runtime/toolDefinition'
import { invokeCapability } from '../../runtime/toolInvocation'
import { ManagedCallStore } from './managedCallStore'
import { initializeNativeConversationStorage } from './nativeDatabaseSchema'
import { NativeRunOwner } from './nativeRunOwner'
import { NativeMessageProjection } from './nativeMessageProjection'
import { ManagedCallService } from './managedCallService'
import { createManagedToolRuntime } from './managedToolRuntime'
import { NativeManagedResults } from './nativeManagedResults'
import { toolResultMessage } from '../../runtime/toolResultMessage'
import { currentToolExecution } from './toolExecutionContext'
import { beginToolEffect } from './toolExecutionContext'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-managed-')), file = join(root, 'agent.sqlite')
  let sql = new Database(file)
  const open = () => {
    initializeNativeConversationStorage(sql)
    const results = new NativeManagedResults(sql), database = new ManagedCallStore(sql, call => results.validateCallResult(call))
    const projection = new NativeMessageProjection(sql)
    return { database, results, service: new ManagedCallService(database, results), owner: new NativeRunOwner(sql, commit => projection.commit(commit)) }
  }
  let current = open()
  return { get database() { return current.database }, get sql() { return sql }, get results() { return current.results }, get service() { return current.service },
    get owner() { return current.owner },
    createRun(threadId: string, runId: string) {
      return current.owner.createRun({ threadId, runId, operation: 'agent', message: { id: `${runId}:input`,
        value: { id: `${runId}:input`, kind: 'user', content: 'Fixture', context: { runId } } } })
    },
    async reopen() {
      await current.service.shutdown(); sql.close(); sql = new Database(file); current = open()
    },
    async dispose() { await current.service.shutdown(); sql.close(); rmSync(root, { recursive: true, force: true }) } }
}
const message = (text = 'complete'): ConversationMessage => ({ id: 'same-message-id', kind: 'tool', resultFor: 'provider', content: text,
  artifact: { bytes: new Uint8Array([0, 255]), values: new Map([['value', new Set([0, false])]]) } })
function createCall(h: ReturnType<typeof fixture>, id: string, threadId?: string, runId?: string) {
  const thread = threadId ?? h.owner.createThread().id, run = runId ?? h.createRun(thread, id).id
  const call = h.database.createManagedCall({ id, threadId: thread, runId: run, kind: 'builtin', summary: 'Fixture' })
  return { threadId: thread, runId: run, managedCallId: call.id }
}
const counts = (sql: Database.Database) => ({
  bodies: (sql.prepare('SELECT count(*) AS count FROM execution_message_bodies').get() as { count: number }).count,
  owners: (sql.prepare('SELECT count(*) AS count FROM execution_managed_results').get() as { count: number }).count
})

describe('native managed result ownership', () => {
  it('rejects circular content without fabricating a successful text result', () => {
    const content: Record<string, unknown> = {}; content.self = content
    expect(() => toolResultMessage({ content }, { name: 'read_file', callId: 'circular' })).toThrow(TypeError)
  })

  it('stores a large canonical result once, pages across progress and final text, and retains exact same-ID versions after restart', async () => {
    vi.useFakeTimers()
    const h = fixture(), content = 'start:' + 'result中'.repeat(100_000) + ':end', progress = 'Dispatched.\n'
    const artifact = { bytes: new Uint8Array([1, 7, 255]), format: 'binary' }
    let finish!: () => void
    const pending = new Promise<void>(resolve => { finish = resolve })
    try {
      const thread = h.owner.createThread(), run = h.createRun(thread.id, 'large-tool-run')
      const native = defineTool({ name: 'read_file', description: 'Read', inputSchema: z.object({}), execute: async () => {
        currentToolExecution()!.output('stdout', progress); await pending; return { content, artifact }
      } })
      const wrapped = createManagedToolRuntime(native, { results: h.results, service: h.service, threadId: thread.id, runId: run.id, allowBackground: true })
      const invocation = invokeCapability(wrapped, {}, { callId: 'large-call' })
      await vi.advanceTimersByTimeAsync(10_000)
      const handle = JSON.parse(String((await invocation).content)) as { call_id: string }
      finish(); await vi.advanceTimersByTimeAsync(1); await h.service.waitForIdle()
      const call = h.database.getManagedCall(handle.call_id, thread.id)!, restored = (await h.service.readResult(call.id, thread.id))!
      expect(call.result!.length).toBeLessThan(256); expect(call.outputChars).toBe(progress.length)
      expect(restored).toMatchObject({ kind: 'tool', resultFor: 'large-call', resultStatus: 'success', content, artifact })
      expect(restored.id).toBeTruthy(); expect(restored).not.toHaveProperty('getType')
      const sharedOwner = createCall(h, 'shared', thread.id, run.id), sharedReference = await h.results.save(restored, sharedOwner)
      h.database.finishManagedCall({ callId: sharedOwner.managedCallId, threadId: thread.id, status: 'completed', result: sharedReference, outcome: { result_format: 'conversation' } })
      expect(sharedReference).toBe(call.result)
      expect(counts(h.sql)).toEqual({ bodies: 1, owners: 2 })
      expect(h.sql.prepare('SELECT sum(length(text)) AS count FROM agent_managed_call_output').get()).toEqual({ count: progress.length })
      expect(JSON.parse(h.service.readOutput({ callId: call.id, threadId: thread.id, offset: progress.length - 3, length: 9 }))).toMatchObject({
        output_chars_total: progress.length + content.length, output: [{ text: progress.slice(-3) }, { text: content.slice(0, 6) }], has_before: true, has_after: true
      })
      expect(JSON.parse(h.service.readOutput({ callId: call.id, threadId: thread.id, offset: -4, length: 10 }))).toMatchObject({ output: [{ text: ':end' }], has_after: false })
      expect(JSON.parse(h.service.readOutput({ callId: call.id, threadId: thread.id, offset: Number.MAX_SAFE_INTEGER, length: 10 }))).toMatchObject({ output: [], has_after: false })
      await expect(h.results.read(call.result!, 'another-thread')).rejects.toThrow('Invalid persisted')
      expect(() => h.results.readSync(call.result!, 'another-thread')).toThrow('Invalid persisted')
      const shortenedOwner = createCall(h, 'shortened', thread.id, run.id)
      const shortened = await h.results.save({ ...restored, content: 'A shortened context result.' }, shortenedOwner)
      h.database.finishManagedCall({ callId: shortenedOwner.managedCallId, threadId: thread.id, status: 'completed', result: shortened, outcome: { result_format: 'conversation' } })
      expect(counts(h.sql)).toEqual({ bodies: 2, owners: 3 })
      await h.reopen()
      expect((await h.service.readResult(call.id, thread.id))).toEqual(restored)
      expect(h.results.readSync(shortened, thread.id).content).toBe('A shortened context result.')
      expect(JSON.parse(h.service.readOutput({ callId: call.id, threadId: thread.id, offset: -4, length: 10 }))).toMatchObject({ output: [{ text: ':end' }] })
      expect(h.database.deleteManagedCall(call.id, thread.id)).toBe(true)
      expect(h.sql.transaction(() => collectNativeMessageBodies(h.sql, thread.id))()).toBe(0)
      expect(h.results.readSync(sharedReference, thread.id)).toEqual(restored)
      expect(h.database.deleteManagedCall(sharedOwner.managedCallId, thread.id)).toBe(true)
      expect(h.sql.transaction(() => collectNativeMessageBodies(h.sql, thread.id))()).toBe(1)
      expect(() => h.results.readSync(sharedReference, thread.id)).toThrow()
      expect(h.results.readSync(shortened, thread.id).content).toBe('A shortened context result.')
    } finally { finish(); await h.service.waitForIdle(); vi.useRealTimers(); await h.dispose() }
  })

  it('uses the actual managed service and native body storage for dispatch, output paging and restart', async () => {
    vi.useFakeTimers()
    const h = fixture()
    try {
      const thread = h.owner.createThread(), run = h.createRun(thread.id, 'native-service')
      const created = vi.spyOn(h.database, 'createManagedCall')
      let finish!: () => void
      const completion = new Promise<void>(resolve => { finish = resolve })
      const execute = vi.fn(async () => { beginToolEffect(); await completion; return { content: 'saved result text', artifact: message().artifact } })
      const dispatch = createManagedToolRuntime(defineTool({ name: 'write_file', description: 'Isolated write fixture', inputSchema: z.object({}), execute }), {
        results: h.results, service: h.service, threadId: thread.id, runId: run.id, allowBackground: true,
        providerCallId: () => 'provider'
      })
      const pending = invokeCapability(dispatch, {}, { callId: 'application-call' })
      await vi.advanceTimersByTimeAsync(10_000)
      const handle = await pending
      expect(JSON.parse(String(handle.content))).toMatchObject({ status: 'running' })
      finish(); await vi.advanceTimersByTimeAsync(0)
      const call = h.database.getManagedCall(created.mock.results[0].value.id, thread.id)!
      const result = await h.service.readResult(call.id, thread.id)
      expect(result).toMatchObject({ kind: 'tool', resultFor: 'provider', content: 'saved result text', artifact: message().artifact })
      expect(call).toMatchObject({ status: 'completed', outcome: { result_format: 'conversation', result_output_chars: 17 } })
      expect(counts(h.sql)).toEqual({ bodies: 1, owners: 1 })
      expect(h.sql.prepare("SELECT name FROM sqlite_schema WHERE name='message_bodies'").all()).toEqual([])
      expect(await h.service.readResult(call.id, thread.id)).toEqual(result)
      expect(JSON.parse(h.service.readOutput({ callId: call.id, threadId: thread.id, offset: 6, length: 6 })))
        .toMatchObject({ output_chars_total: 17, output: [{ text: 'result' }] })
      await h.reopen()
      expect(await h.service.readResult(call.id, thread.id)).toEqual(result)
      expect(execute).toHaveBeenCalledOnce()
      expect(h.sql.transaction(() => collectNativeMessageBodies(h.sql, thread.id))()).toBe(0)
      expect(h.database.deleteManagedCall(call.id, thread.id)).toBe(true)
      expect(counts(h.sql)).toEqual({ bodies: 1, owners: 0 })
      expect(h.sql.transaction(() => collectNativeMessageBodies(h.sql, thread.id))()).toBe(1)
      expect(counts(h.sql)).toEqual({ bodies: 0, owners: 0 })
    } finally { vi.useRealTimers(); await h.dispose() }
  })

  it('retains exact same-ID versions and binary snapshots for separate calls and conversations', async () => {
    const h = fixture()
    try {
      const first = createCall(h, 'first'), second = createCall(h, 'second', first.threadId, first.runId), other = createCall(h, 'other')
      const original = message('first'), saved = structuredClone(original)
      const firstSaving = h.results.save(original, first)
      original.content = 'changed while awaiting save'; (original.artifact as { bytes: Uint8Array }).bytes[0] = 99
      const a = await firstSaving, b = await h.results.save(message('second'), second), c = await h.results.save(message('other'), other)
      expect(a).not.toBe(b)
      expect(await h.results.save(saved, first)).toBe(a)
      await expect(h.results.save(message('conflict'), first)).rejects.toThrow('different result')
      await expect(h.results.save(message(), { ...first, runId: other.runId })).rejects.toThrow('does not own')
      expect(() => h.results.readSync(c, first.threadId)).toThrow('Invalid persisted tool result reference')
      for (const [owner, reference] of [[first, a], [second, b], [other, c]] as const) {
        h.database.finishManagedCall({ callId: owner.managedCallId, threadId: owner.threadId, status: 'completed', result: reference, outcome: { result_format: 'conversation' } })
      }
      await h.reopen()
      expect(h.results.readSync(a, first.threadId)).toMatchObject(saved)
      expect(h.results.readSync(b, first.threadId).content).toBe('second')
      expect(h.database.deleteManagedCall(first.managedCallId, first.threadId)).toBe(true)
      expect(counts(h.sql)).toEqual({ bodies: 3, owners: 2 })
      expect(h.results.readSync(b, first.threadId).content).toBe('second')
      await expect(h.results.save(message(), first)).rejects.toThrow('does not own')
    } finally { await h.dispose() }
  })

  it('validates terminal ownership atomically and allows detached results after the parent run ends', async () => {
    const h = fixture()
    try {
      const first = createCall(h, 'first'), second = createCall(h, 'second', first.threadId, first.runId)
      const reference = await h.results.save(message(), first)
      expect(() => h.database.finishManagedCall({ callId: first.managedCallId, threadId: first.threadId, status: 'completed', result: reference,
        outcome: { result_format: 'langchain' } })).toThrow('native conversation format')
      expect(h.database.getManagedCall(first.managedCallId, first.threadId)!.status).toBe('preparing')
      expect(() => h.database.finishManagedCall({ callId: second.managedCallId, threadId: second.threadId, status: 'completed', result: reference,
        outcome: { result_format: 'conversation' } })).toThrow('not retained by this call')
      expect(h.database.getManagedCall(second.managedCallId, second.threadId)!.status).toBe('preparing')
      h.database.markManagedCallRunning(second.managedCallId, second.threadId)
      h.database.markManagedCallDetached(second.managedCallId, second.threadId)
      const identity = { threadId: second.threadId, runId: second.runId }
      await h.owner.enter('input', identity)
      const scope = () => ({ ...identity, expectedRevisionId: h.owner.store.load(second.threadId)!.revisionId })
      h.owner.store.acceptModel(scope(), { id: 'answer', value: { id: 'answer', kind: 'assistant', content: 'Finished parent' } }, [], { modelCalls: 1, todos: [] })
      h.owner.store.finish(scope(), 'completed')
      h.createRun(second.threadId, 'next-parent-run')
      const late = await h.results.save(message('late background result'), second)
      h.database.finishManagedCall({ callId: second.managedCallId, threadId: second.threadId, status: 'completed', result: late,
        outcome: { result_format: 'conversation' } })
      await h.reopen()
      expect((await h.service.readResult(second.managedCallId, second.threadId))?.content).toBe('late background result')
    } finally { await h.dispose() }
  })

  it('rolls back body insertion on failed ownership retention and rejects corrupted committed bodies', async () => {
    const h = fixture()
    try {
      const owner = createCall(h, 'failure')
      h.sql.exec("CREATE TRIGGER fail_native_result BEFORE INSERT ON execution_managed_results BEGIN SELECT RAISE(ABORT,'retention failed'); END")
      await expect(h.results.save(message(), owner)).rejects.toThrow('retention failed')
      expect(counts(h.sql)).toEqual({ bodies: 0, owners: 0 })
      h.sql.exec('DROP TRIGGER fail_native_result')
      const reference = await h.results.save(message(), owner)
      h.sql.prepare('UPDATE execution_message_bodies SET value=?').run(Buffer.from('corrupted'))
      expect(() => h.results.readSync(reference, owner.threadId)).toThrow('content identity')
      expect(() => h.database.finishManagedCall({ callId: owner.managedCallId, threadId: owner.threadId, status: 'completed', result: reference,
        outcome: { result_format: 'conversation' } })).toThrow('content identity')
      expect(h.database.getManagedCall(owner.managedCallId, owner.threadId)!.status).toBe('preparing')
    } finally { await h.dispose() }
  })
  it('shares one exact large body between managed ownership, effect recovery and accepted history', async () => {
    const h = fixture()
    try {
      const thread = h.owner.createThread(), run = h.createRun(thread.id, 'canonical-effects')
      await h.owner.enter('input', { threadId: thread.id, runId: run.id })
      const store = h.owner.store, scope = () => ({ threadId: thread.id, runId: run.id, expectedRevisionId: store.load(thread.id)!.revisionId })
      const call = { id: 'call', providerCallId: 'provider', name: 'http_request', args: { method: 'POST', url: 'https://fixture.invalid' },
        artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
      store.acceptModel(scope(), { id: 'model', value: { kind: 'assistant', content: '', calls: [{ id: 'provider', name: call.name, args: call.args }] } }, [call], { modelCalls: 1, todos: [] })
      store.prepareTools(scope(), [{ callId: call.id, args: call.args }])
      const key = { threadId: thread.id, runId: run.id, callId: call.id }, owner = createCall(h, 'managed', thread.id, run.id)
      const value: ConversationMessage = { id: 'exact-result', kind: 'tool', name: 'http_request', resultFor: 'provider', resultStatus: 'error', content: '结果'.repeat(300000),
        artifact: { bytes: new Uint8Array([4, 5, 6]), statusCode: 409, body: { reason: 'duplicate', retryable: false } },
        resultMetadata: { effectAttempt: 2, source: 'journal-test' }, source: { extras: { providerField: { nested: true } }, metadata: { requestId: 'request-41' } } }
      const before = counts(h.sql).bodies, reference = await h.results.save(value, owner)
      const canonical = h.results.readSync(reference, thread.id)
      expect(canonical).toMatchObject(value)
      expect(canonical.context).toMatchObject({ runId: run.id, createdAt: expect.any(String) })
      h.database.finishManagedCall({ callId: owner.managedCallId, threadId: thread.id, status: 'completed', result: reference, outcome: { result_format: 'conversation' } })
      store.prepareEffect(key, 'confirm'); store.armEffect(key, { kind: 'http_mutation', target: call.args })
      const saved = store.saveEffectResult(key, { id: canonical.id!, value: canonical })
      expect(reference.length).toBeLessThan(256); expect(counts(h.sql).bodies).toBe(before + 1)
      expect(() => store.saveEffectResult(key, { id: canonical.id!, value: { ...canonical, content: 'conflicting result' } })).toThrow('cannot be replaced')
      expect(counts(h.sql).bodies).toBe(before + 1)
      store.settleCall(scope(), call.id, saved.result!); store.finishBatch(scope())
      expect(counts(h.sql).bodies).toBe(before + 1)
      await h.reopen()
      expect(h.owner.store.loadEffect(key)?.result?.value).toEqual(canonical)
      expect(h.results.readSync(reference, thread.id)).toEqual(canonical)
      expect(h.owner.store.readHistory(thread.id)!.messages.at(-1)?.value).toEqual(canonical)
      expect(counts(h.sql).bodies).toBe(before + 1)
    } finally { await h.dispose() }
  })
it('retains complete managed call output and reads arbitrary ranges', async () => {
    const h = fixture(), database = h.database
    try {
      const thread = h.owner.createThread()
      const run = h.createRun(thread.id, 'managed-output-run')
      database.createManagedCall({
        id: 'managed-output-call',
        threadId: thread.id,
        runId: run.id,
        kind: 'shell',
        summary: 'stream output'
      })
      database.markManagedCallRunning('managed-output-call', thread.id)

      expect(database.appendManagedCallOutputBatch({
        callId: 'managed-output-call',
        threadId: thread.id,
        chunks: [
          { stream: 'stdout', text: 'ab' },
          { stream: 'stderr', text: 'cd' },
          { stream: 'stdout', text: '😀😀😀' },
          { stream: 'progress', text: 'stored' }
        ]
      })).toEqual([
        { sequence: 1, stream: 'stdout', startOffset: 0, endOffset: 2, text: 'ab' },
        { sequence: 2, stream: 'stderr', startOffset: 2, endOffset: 4, text: 'cd' },
        { sequence: 3, stream: 'stdout', startOffset: 4, endOffset: 10, text: '😀😀😀' },
        { sequence: 4, stream: 'progress', startOffset: 10, endOffset: 16, text: 'stored' }
      ])
      expect(database.appendManagedCallOutput({
        callId: 'managed-output-call',
        threadId: thread.id,
        stream: 'stderr',
        text: 'tail'
      })).toEqual({
        sequence: 5,
        stream: 'stderr',
        startOffset: 16,
        endOffset: 20,
        text: 'tail'
      })

      expect(database.getManagedCall('managed-output-call', thread.id)).toMatchObject({
        outputChars: 20
      })
      expect(database.readManagedCallOutputRange(
        'managed-output-call',
        thread.id,
        -8,
        8
      )).toEqual({
        chunks: [
          { sequence: 4, stream: 'progress', startOffset: 12, endOffset: 16, text: 'ored' },
          { sequence: 5, stream: 'stderr', startOffset: 16, endOffset: 20, text: 'tail' }
        ],
        startOffset: 12,
        endOffset: 20,
        totalChars: 20,
        hasBefore: true,
        hasAfter: false
      })
      expect(database.readManagedCallOutputRange(
        'managed-output-call',
        thread.id,
        -100,
        100
      )).toMatchObject({
        startOffset: 0,
        endOffset: 20,
        totalChars: 20,
        hasBefore: false,
        hasAfter: false
      })
    } finally {
      await h.dispose()
    }
  })

it('retains managed call results for as long as their conversation exists', async () => {
    const h = fixture(), database = h.database
    try {
      const thread = h.owner.createThread()
      const run = h.createRun(thread.id, 'managed-retention-run')
      for (let index = 0; index < 102; index += 1) {
        const callId = `managed-retention-call-${index}`
        database.createManagedCall({
          id: callId,
          threadId: thread.id,
          runId: run.id,
          kind: 'http',
          summary: `request ${index}`
        })
        database.finishManagedCall({
          callId,
          threadId: thread.id,
          status: 'completed',
          result: `result ${index}`
        })
      }

      expect(database.getManagedCall('managed-retention-call-0', thread.id)).toMatchObject({
        status: 'completed',
        result: 'result 0'
      })
      expect(database.getManagedCall('managed-retention-call-101', thread.id)).toMatchObject({
        status: 'completed',
        result: 'result 101'
      })
    } finally {
      await h.dispose()
    }
  })

it('tracks detached managed calls until their terminal state is observed', async () => {
    const h = fixture(), database = h.database
    try {
      const thread = h.owner.createThread()
      const run = h.createRun(thread.id, 'managed-resolution-run')
      for (const callId of ['managed-active-call', 'managed-terminal-call']) {
        database.createManagedCall({
          id: callId,
          threadId: thread.id,
          runId: run.id,
          kind: 'http',
          summary: callId
        })
        database.markManagedCallDetached(callId, thread.id)
      }
      database.createManagedCall({
        id: 'managed-inline-call',
        threadId: thread.id,
        runId: run.id,
        kind: 'http',
        summary: 'completed without returning a handle'
      })
      database.finishManagedCall({
        callId: 'managed-inline-call',
        threadId: thread.id,
        status: 'completed',
        result: 'inline result'
      })
      database.markManagedCallRunning('managed-active-call', thread.id)
      database.finishManagedCall({
        callId: 'managed-terminal-call',
        threadId: thread.id,
        status: 'completed',
        result: 'done'
      })
      const otherThread = h.owner.createThread()
      const otherRun = h.createRun(otherThread.id, 'managed-resolution-other-run')
      database.createManagedCall({
        id: 'managed-other-thread-call',
        threadId: otherThread.id,
        runId: otherRun.id,
        kind: 'shell',
        summary: 'other conversation'
      })
      database.markManagedCallDetached('managed-other-thread-call', otherThread.id)

      expect(() => database.resolveManagedCall('managed-active-call', thread.id, run.id)).toThrow(
        'Managed call managed-active-call is still running.'
      )
      expect(() => database.resolveManagedCall('managed-inline-call', thread.id, run.id)).toThrow(
        'Managed call managed-inline-call has not returned a background handle.'
      )
      expect(database.listUnresolvedManagedCalls(run.id).map((call) => call.id)).toEqual([
        'managed-active-call',
        'managed-terminal-call'
      ])
      expect(database.listUnresolvedManagedCallsForThread(thread.id).map((call) => call.id)).toEqual([
        'managed-active-call',
        'managed-terminal-call'
      ])
      expect(database.listUnresolvedManagedCallsForThread(thread.id, 1).map((call) => call.id)).toEqual([
        'managed-active-call'
      ])
      expect(database.listUnresolvedManagedCallsForThread(thread.id)).toHaveLength(2)

      expect(() => database.resolveManagedCall(
        'managed-terminal-call',
        thread.id,
        otherRun.id
      )).toThrow(`Run ${otherRun.id} does not belong to thread ${thread.id}.`)
      const resolved = database.resolveManagedCall('managed-terminal-call', thread.id, run.id)
      expect(resolved).toMatchObject({
        id: 'managed-terminal-call',
        status: 'completed',
        detachedAt: expect.any(String)
      })
      expect(database.listUnresolvedManagedCalls(run.id).map((call) => call.id)).toEqual([
        'managed-active-call'
      ])
      expect(database.listUnresolvedManagedCallsForThread(thread.id).map((call) => call.id)).toEqual([
        'managed-active-call'
      ])
      database.finishManagedCall({
        callId: 'managed-active-call',
        threadId: thread.id,
        status: 'cancelled'
      })
      database.resolveManagedCall('managed-active-call', thread.id, run.id)
      expect(database.listUnresolvedManagedCallsForThread(thread.id)).toEqual([])
    } finally {
      await h.dispose()
    }
  })

it('persists detached terminal observations across two native database reopens', async () => {
  const h = fixture()
  try {
    const thread = h.owner.createThread(), run = h.createRun(thread.id, 'observation-run')
    const owner = createCall(h, 'observation', thread.id, run.id)
    const value = message('Persisted terminal result'), reference = await h.results.save(value, owner)
    const saved = h.results.readSync(reference, thread.id)
    expect(saved).toMatchObject(value)
    h.database.markManagedCallDetached(owner.managedCallId, thread.id)
    h.database.finishManagedCall({ callId: owner.managedCallId, threadId: thread.id, status: 'completed', result: reference,
      outcome: { result_format: 'conversation' } })
    await h.reopen()
    expect(h.database.listUnresolvedManagedCalls(run.id)).toEqual([expect.objectContaining({
      id: owner.managedCallId, detachedAt: expect.any(String), result: reference
    })])
    expect(h.results.readSync(reference, thread.id)).toEqual(saved)
    h.database.resolveManagedCall(owner.managedCallId, thread.id, run.id)
    await h.reopen()
    expect(h.database.listUnresolvedManagedCalls(run.id)).toEqual([])
    expect(h.database.listUnresolvedManagedCallsForThread(thread.id)).toEqual([])
    expect(h.database.getManagedCall(owner.managedCallId, thread.id)).toMatchObject({ status: 'completed' })
    expect(h.results.readSync(reference, thread.id)).toEqual(saved)
  } finally { await h.dispose() }
})

})
