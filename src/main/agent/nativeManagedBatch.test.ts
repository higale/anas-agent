import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { defineContentTool } from '../../runtime/toolDefinition'
import { nativeCapabilityFixture } from '../../test/nativeCapabilityFixture'
import { armCurrentAgentToolEffect } from './toolEffectScope'
import { fileToolDefinitions } from '../llm/fileTools'
import { runtimeToolDefinitions } from '../llm/runtimeTools'
import { userInputService } from './userInputService'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
afterEach(() => vi.useRealTimers())

describe('native managed batches and durable effects', () => {
  it('dispatches a previously queued real file write while the owner waits for user input', async () => {
    const h = nativeCapabilityFixture(), capacity = deferred<string>()
    vi.useFakeTimers()
    const blocker = defineContentTool({ name: 'mcp_inspect', description: '', inputSchema: z.object({}),
      metadata: { annotations: { readOnlyHint: true } }, execute: () => capacity.promise })
    const write = fileToolDefinitions({ primaryFolder: h.root, requestId: h.run.id, fileEditStore: h.database.resources.fileEditStore,
      fileChanges: h.database.resources.fileChanges, maxReadBytes: 1_000_000, toolNames: ['write_file'] })[0]
    const ask = (await runtimeToolDefinitions({ enabled: true, primaryFolder: h.root, threadId: h.thread.id, runId: h.run.id,
      userInputSource: async () => ({ projectName: 'Fixture', threadTitle: 'Queued write' }),
      memory: false, network: false, shell: false, mcp: false, toolNames: ['request_user_input'] }))[0]
    const pending = h.executeCalls([blocker, write, ask], [[
      ...Array.from({ length: 8 }, (_, index) => ({ id: 'block-' + index, name: blocker.name, args: {} })),
      { id: 'queued-file', name: write.name, args: { path: 'created.txt', content: 'created once', summary: 'Create a file' } }
    ], [{ id: 'ask', name: ask.name, args: { questions: [{ id: 'continue', question: 'Continue?', options: [{ label: 'Yes' }] }], require_response: true } }]], true)
    let finished = false
    const settled = pending.finally(() => { finished = true }).catch(() => {})
    try {
      await vi.waitFor(() => {
        const state = h.database.execution.store.load(h.thread.id)!
        if (state.phase === 'failed') throw new Error('Run failed before capacity was occupied')
        expect(h.service.activeCallIds()).toHaveLength(9)
      }, { timeout: 5000 })
      const store = h.database.execution.store, call = store.load(h.thread.id)!.calls.find(call => call.providerCallId === 'queued-file')!
      const key = { threadId: h.thread.id, runId: h.run.id, callId: call.id }
      await vi.advanceTimersByTimeAsync(10_000)
      const queued = store.load(h.thread.id)!.messages.find(message => message.value.resultFor === 'queued-file')!.value
      const handle = JSON.parse(String(queued.content))
      expect(handle.status).toBe('preparing')
      expect(store.loadEffect(key)).toMatchObject({ state: 'prepared', effectAttempt: 0 })
      const question = userInputService.snapshot().requests[0]
      expect(question.threadId).toBe(h.thread.id); userInputService.shown(question.id)
      capacity.resolve('read'); await h.service.waitForIdle()
      expect(finished).toBe(false)
      expect(await readFile(join(h.root, 'created.txt'), 'utf8')).toBe('created once')
      expect(h.database.managed.getManagedCall(handle.call_id, h.thread.id)?.status).toBe('completed')
      expect(store.loadEffect(key)).toMatchObject({ state: 'intent', effectAttempt: 1 })
      userInputService.respond(question.id, { status: 'answered', answers: [{ question_id: 'continue', selected_options: ['Yes'], other: '' }] })
      await pending
      expect(await readFile(join(h.root, 'created.txt'), 'utf8')).toBe('created once')
      expect(h.database.resources.fileChanges.query({ runId: h.run.id }, h.root).operationCount).toBe(1)
    } finally {
      capacity.resolve('read')
      if (!finished) h.host.cancel({ threadId: h.thread.id, runId: h.run.id })
      await settled; vi.useRealTimers(); await h.close()
    }
  })

  it.each(['cancelled', 'failed'] as const)('preserves queued cancellation and a late local commit when the owner is %s', async status => {
    const h = nativeCapabilityFixture(), capacity = deferred<string>(), commit = deferred<string>(), entered = deferred<string>(), foreground = deferred<void>()
    vi.useFakeTimers()
    const blocker = defineContentTool({ name: 'mcp_inspect', description: '', inputSchema: z.object({}),
      metadata: { annotations: { readOnlyHint: true } }, execute: () => capacity.promise })
    const write = defineContentTool({ name: 'write_file', description: '', inputSchema: z.object({ path: z.string(), content: z.string() }), execute: async ({ path }) => {
      armCurrentAgentToolEffect({ kind: 'file_patch', target: path }); entered.resolve(path)
      return commit.promise
    } })
    const ask = defineContentTool({ name: 'request_user_input', description: '', inputSchema: z.object({}), execute: async () => {
      await foreground.promise
      if (status === 'failed') throw new Error('Foreground failed')
      return 'answered'
    } })
    const pending = h.executeCalls([blocker, write, ask], [[
      ...Array.from({ length: 8 }, (_, index) => ({ id: 'block-' + index, name: blocker.name, args: {} })),
      { id: 'late-write', name: write.name, args: { path: 'first.txt', content: 'first' } },
      { id: 'queued-write', name: write.name, args: { path: 'second.txt', content: 'second' } }
    ], [{ id: 'ask', name: ask.name, args: {} }]], true)
    const settled = pending.catch(error => error)
    try {
      await vi.waitFor(() => {
        const state = h.database.execution.store.load(h.thread.id)!
        if (state.phase === 'failed') throw new Error('Run failed before capacity was occupied')
        expect(h.service.activeCallIds()).toHaveLength(10)
      }, { timeout: 5000 })
      await vi.advanceTimersByTimeAsync(10_000)
      const state = h.database.execution.store.load(h.thread.id)!
      const handles = ['late-write', 'queued-write'].map(id => JSON.parse(String(state.messages.find(message => message.value.resultFor === id)!.value.content)))
      expect(handles.map(handle => handle.status)).toEqual(['preparing', 'preparing'])
      capacity.resolve('read')
      const startedPath = basename(await entered.promise)
      expect(['first.txt', 'second.txt']).toContain(startedPath)
      const startedIndex = startedPath === 'first.txt' ? 0 : 1, queuedIndex = 1 - startedIndex
      if (status === 'cancelled') h.host.cancel({ threadId: h.thread.id, runId: h.run.id })
      foreground.resolve()
      await vi.waitFor(() => expect(h.database.execution.store.load(h.thread.id)!.phase).toBe(status))
      commit.resolve('committed once')
      expect(await settled).toBeInstanceOf(Error)
      expect(h.database.managed.getManagedCall(handles[startedIndex].call_id, h.thread.id)).toMatchObject({ status: 'completed', outcome: { local_commit_completed: true } })
      expect((await h.service.readResult(handles[startedIndex].call_id, h.thread.id))?.content).toBe('committed once')
      expect(h.database.managed.getManagedCall(handles[queuedIndex].call_id, h.thread.id)?.status).toBe('cancelled')
    } finally {
      capacity.resolve('read'); foreground.resolve(); commit.resolve('done')
      await settled; vi.useRealTimers(); await h.close()
    }
  })

  it.each(['complete', 'cancel'] as const)('keeps a queued side effect unarmed and persists its later %s outcome', async outcome => {
    const h = nativeCapabilityFixture(), releases = Array.from({ length: 9 }, () => deferred<string>()), answer = deferred<string>()
    vi.useFakeTimers()
    const executed: number[] = []
    const mutation = defineContentTool({ name: 'mcp_remote_mutation', description: '', inputSchema: z.object({ index: z.number() }), execute: async ({ index }) => {
      armCurrentAgentToolEffect({ kind: 'mcp_call', target: { index } })
      executed.push(index)
      return releases[index].promise
    } })
    const ask = defineContentTool({ name: 'request_user_input', description: '', inputSchema: z.object({}), execute: () => answer.promise })
    const pending = h.executeCalls([mutation, ask], [
      Array.from({ length: 9 }, (_, index) => ({ id: 'mutation-' + index, name: mutation.name, args: { index } })),
      [{ id: 'ask', name: ask.name, args: {} }]
    ], true)
    const settled = pending.catch(() => {})
    try {
      for (let index = 0; index < 80 && executed.length < 8; index++) await vi.advanceTimersByTimeAsync(0)
      expect(executed).toHaveLength(8)
      const store = h.database.execution.store, call = store.load(h.thread.id)!.calls.find(call => call.providerCallId === 'mutation-8')!
      const key = { threadId: h.thread.id, runId: h.run.id, callId: call.id }
      await vi.advanceTimersByTimeAsync(10_000)
      const state = store.load(h.thread.id)!, queued = state.messages.find(message => message.value.resultFor === 'mutation-8')!.value
      expect(state.phase).toBe('tools')
      const handle = JSON.parse(String(queued.content))
      expect(handle.status).toBe('preparing')
      expect(store.loadEffect(key)).toMatchObject({ state: 'prepared', effectAttempt: 0 })
      if (outcome === 'cancel') {
        expect(JSON.parse(await h.service.cancel(handle.call_id, h.thread.id))).toMatchObject({ status: 'cancelled' })
        expect(store.loadEffect(key)).toMatchObject({ state: 'prepared', effectAttempt: 0 })
        expect(executed).toHaveLength(8)
      } else {
        releases[0].resolve('first')
        await vi.advanceTimersByTimeAsync(1)
        expect(executed).toHaveLength(9)
        expect(store.loadEffect(key)).toMatchObject({ state: 'intent', effectAttempt: 1 })
        releases.forEach(release => release.resolve('done'))
        await h.service.waitForIdle()
        expect(store.loadEffect(key)).toMatchObject({ state: 'intent', effectAttempt: 1 })
        expect((await h.service.readResult(handle.call_id, h.thread.id))?.content).toBe('done')
      }
      releases.forEach(release => release.resolve('done')); await h.service.waitForIdle()
      answer.resolve('yes'); await pending
      expect(store.load(h.thread.id)!.phase).toBe('completed')
    } finally {
      releases.forEach(release => release.resolve('done')); answer.resolve('yes')
      await settled; vi.useRealTimers(); await h.close()
    }
  })
})
