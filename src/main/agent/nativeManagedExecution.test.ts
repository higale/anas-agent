import { defineContentTool, defineTool, type ToolDefinition } from '../../runtime/toolDefinition'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v3'
import { z as z4 } from 'zod/v4'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { invokeCapability } from '../../runtime/toolInvocation'
import { nativeCapabilityFixture } from '../../test/nativeCapabilityFixture'
import { createManagedToolRuntime } from './managedToolRuntime'
import { armCurrentAgentToolEffect } from './toolEffectScope'
import { currentToolExecution } from './toolExecutionContext'
import { runtimeToolDefinitions } from '../llm/runtimeTools'
import { commandShellMetadata } from '@shared/commandShell'
import { runPreparedProcess } from '../shellRuntime'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
function harness(allowBackground = true) {
  const h = nativeCapabilityFixture()
  return { ...h, threadId: h.thread.id, runId: h.run.id, allowBackground }
}
function managedTool(definition: ToolDefinition, h: ReturnType<typeof harness> & { signal?: AbortSignal }) {
  return createManagedToolRuntime(definition, { results: h.database.results, service: h.service, threadId: h.threadId,
    runId: h.runId, allowBackground: h.allowBackground, signal: h.signal })
}
function invoke(tool: ToolDefinition<ConversationMessage>, id: string, args: Record<string, unknown> = {}) {
  return invokeCapability(tool, args, { callId: id })
}
afterEach(() => vi.useRealTimers())

describe('native managed execution lifecycle', () => {
  it('returns a background handle while retaining resources until the actual executor settles', async () => {
    vi.useFakeTimers()
    const h = harness(), finish = deferred<string>()
    let entered = false, held = false
    const definition = defineContentTool({ name: 'mcp_inspect', description: '', metadata: { annotations: { readOnlyHint: true } }, inputSchema: z.object({}),
      execute: () => { entered = true; return finish.promise } })
    const tool = createManagedToolRuntime(definition, { results: h.database.results, service: h.service,
      threadId: h.threadId, runId: h.runId, allowBackground: true,
      withResources: async (_args, operation) => { held = true; try { return await operation() } finally { held = false } } })
    try {
      const pending = invoke(tool, 'background-call')
      for (let index = 0; index < 20 && !entered; index++) await vi.advanceTimersByTimeAsync(0)
      expect(entered).toBe(true)
      await vi.advanceTimersByTimeAsync(10_000)
      const result = await pending, handle = JSON.parse(String(result.content))
      expect(result.resultStatus).toBe('success')
      expect(handle).toMatchObject({ status: 'running', call_id: expect.any(String) })
      expect(held).toBe(true)
      finish.resolve('late actual result')
      await vi.advanceTimersByTimeAsync(1)
      expect((await h.service.readResult(handle.call_id, h.threadId))?.content).toBe('late actual result')
      expect(held).toBe(false)
    } finally { finish.resolve('done'); await h.service.waitForIdle(); await h.close() }
  })

  it.each([false, true])('executes a native batch larger than capacity without tool errors (background: %s)', async background => {
    vi.useFakeTimers()
    const h = harness(background), release = deferred<void>()
    let active = 0, peak = 0
    const executed: number[] = []
    const definition = defineContentTool({ name: 'mcp_inspect', description: '', inputSchema: z.object({ index: z.number() }),
      metadata: { annotations: { readOnlyHint: true } }, execute: async ({ index }) => {
        active++; peak = Math.max(peak, active); executed.push(index)
        await release.promise
        active--
        return 'file ' + index
      } })
    const pending = h.executeCalls([definition], [Array.from({ length: 9 }, (_, index) => ({ id: 'call-' + index, name: definition.name, args: { index } }))], background)
    const settled = pending.catch(() => {})
    try {
      for (let index = 0; index < 40 && executed.length < 8; index++) await vi.advanceTimersByTimeAsync(0)
      expect(executed).toHaveLength(8)
      release.resolve()
      const history = await pending, results = history.messages.filter(message => message.value.kind === 'tool').map(message => message.value)
      expect(results).toHaveLength(9)
      expect(results.every(result => result.resultStatus === 'success' && String(result.content).startsWith('file '))).toBe(true)
      expect(peak).toBe(8); expect(new Set(executed).size).toBe(9)
    } finally { release.resolve(); await settled; await h.close() }
  })

  it.each([
    ['Zod 3', (transform: (input: { count: number }) => { count: number }) => z.object({ count: z.number().default(0) }).transform(transform)],
    ['Zod 4', (transform: (input: { count: number }) => { count: number }) => z4.object({ count: z4.number().default(0) }).transform(transform)]
  ] as const)('applies %s defaults and transformations once before native execution', async (_name, schema) => {
    const h = harness(false), transformed = vi.fn((input: { count: number }) => ({ count: input.count + 1 }))
    const execute = vi.fn(async (input: Record<string, unknown>) => input)
    const native = defineContentTool({ name: 'read_file', description: 'Read',
      inputSchema: schema(transformed), execute })
    const raw = Object.freeze({})
    try {
      const managed = managedTool(native, h)
      const result = await invoke(managed, 'transform-once', raw)
      expect(JSON.parse(String(result.content))).toEqual({ count: 1 })
      expect(execute).toHaveBeenCalledOnce()
      expect(execute.mock.calls[0][0]).toEqual({ count: 1 })
      expect(transformed).toHaveBeenCalledOnce()
      expect(raw).toEqual({})
    } finally { await h.service.shutdown(); await h.close() }
  })

  it.each([false, true])('keeps sleep inline without occupying a managed call (background: %s)', async (background) => {
    vi.useFakeTimers()
    const h = harness(background)
    const start = vi.spyOn(h.service, 'start')
    try {
      const native = (await runtimeToolDefinitions({ enabled: true, primaryFolder: process.cwd(), memory: false,
        network: false, shell: false, mcp: false, backgroundTools: background, toolNames: ['sleep'] }))[0]
      const sleep = managedTool(native, h)
      let completed = false
      const pending = invoke(sleep, 'sleep-call', { seconds: 15 })
        .then(result => { completed = true; return result })
      await vi.advanceTimersByTimeAsync(10_001)
      expect(completed).toBe(false)
      expect(start).not.toHaveBeenCalled()
      expect(h.service.unresolvedForThread(h.threadId)).toEqual([])
      await vi.advanceTimersByTimeAsync(4999)
      expect(JSON.parse(String((await pending).content))).toEqual({ status: 'completed', elapsed_seconds: 15 })
    } finally { await h.service.shutdown(); await h.close() }
  })

  it.each([
    { kind: 'builtin', name: 'read_file', metadata: {} },
    { kind: 'shell', name: 'pwsh', metadata: commandShellMetadata() },
    { kind: 'http', name: 'http_request', metadata: {} },
    { kind: 'custom', name: 'custom_query', metadata: { anasCustomToolId: 'query' } },
    { kind: 'mcp', name: 'mcp_server_query', metadata: { annotations: { readOnlyHint: true } } }
  ].flatMap(entry => [false, true].map(background => ({ ...entry, background }))))(
    'passes ok:false content through $kind results without changing status (background: $background)', async ({ name, metadata, background }) => {
      vi.useFakeTimers()
      const h = harness(background)
      const finish = deferred<string>()
      const content = '{"ok":false,"error":"具体原因"}'
      const native = defineContentTool({ name, description: 'Return file contents.', metadata, inputSchema: z.object({}), execute: () => {
        currentToolExecution()!.markRunning()
        return finish.promise
      } })
      try {
        const pending = invoke(managedTool(native, h), 'file-content')
        let callId: string | undefined
        if (background) {
          await vi.advanceTimersByTimeAsync(10_000)
          callId = JSON.parse(String((await pending).content)).call_id as string
        }
        finish.resolve(content)
        await vi.advanceTimersByTimeAsync(1)
        const result = callId ? await h.service.readResult(callId, h.threadId) : (await pending)
        expect(result?.content).toBe(content)
        expect(result?.resultStatus).toBe('success')
        if (callId) {
          const status = JSON.parse(h.service.read({ threadId: h.threadId, callId }))
          expect(status).toMatchObject({ status: 'completed', outcome: { ok: true } })
          expect(status).not.toHaveProperty('error')
          expect(status.outcome).not.toHaveProperty('error')
        }
      } finally { await h.service.shutdown(); await h.close() }
    }
  )

  it('stops an unlimited inline Shell and its child when background tools are disabled', async () => {
    const h = harness(false)
    const controller = new AbortController()
    let pids: number[] = []
    let stdout = ''
    const native = defineContentTool({ name: 'pwsh', description: 'Shell', metadata: commandShellMetadata(), inputSchema: z.object({}), execute: async () => {
      const control = currentToolExecution()!
      return runPreparedProcess({
        command: 'inline cancellation fixture', workingDir: process.cwd(), timeoutSec: 0,
        invocation: { executable: process.execPath, windowsHide: true, env: { ELECTRON_RUN_AS_NODE: '1' }, args: ['-e', [
          "const child = require('node:child_process').spawn(process.execPath, ['-e', \"process.send('ready'); setInterval(() => {}, 1000)\"], {stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {...process.env, ELECTRON_RUN_AS_NODE: '1'}})",
          "child.once('message', () => console.log('READY:' + process.pid + ':' + child.pid))",
          'setInterval(() => {}, 1000)'
        ].join(';')] },
        logScope: 'test', successMessage: 'Finished.', failureMessage: 'Failed.',
        abortBeforeStartError: 'Cancelled before dispatch.', abortError: 'Cancelled.', timeoutError: 'Timed out.'
      }, control.signal, {
        onDispatched: control.markRunning, onOutcomeUncertain: control.markUncertain,
        onOutput: (_stream, text) => {
          stdout += text
          const match = stdout.match(/READY:(\d+):(\d+)/)
          if (match) pids = [Number(match[1]), Number(match[2])]
        },
        onResult: (result) => control.setOutcome({ ok: result.ok, aborted: result.aborted, timed_out: result.timedOut })
      })
    } })
    const pending = invoke(managedTool(native, { ...h, signal: controller.signal }), 'inline-shell-stop')
    try {
      await expect.poll(() => pids.length, { timeout: 5000 }).toBe(2)
      controller.abort(new Error('User stopped the run.'))
      const result = await pending
      expect(JSON.parse(String(result.content))).toMatchObject({ ok: false, aborted: true, timedOut: false })
      await expect.poll(() => pids.every((pid) => { try { process.kill(pid, 0); return false } catch { return true } }), { timeout: 5000 }).toBe(true)
      expect(h.service.unresolvedForThread(h.threadId)).toHaveLength(0)
    } finally {
      controller.abort()
      await pending.catch(() => {})
      await h.service.shutdown()
      await h.close()
    }
  }, 15_000)
  it('reports uncertainty inline without stranding disabled background supervision', async () => {
    const h = harness(false)
    try {
      const native = defineContentTool({ name: 'mcp_remote_write', description: 'Write', inputSchema: z.object({}), execute: async () => {
        armCurrentAgentToolEffect({ kind: 'mcp_call', target: 'remote' })
        throw new Error('Connection lost after dispatch')
      } })
      const result = await invoke(managedTool(native, h), 'uncertain')
      expect(result.resultStatus).toBe('error')
      expect(JSON.parse(String(result.content))).toMatchObject({ ok: false, outcome_uncertain: true })
      expect(h.service.unresolvedForThread(h.threadId)).toHaveLength(0)
    } finally { await h.close() }
  })

  it('returns a preparing handle for the ninth call and starts it automatically', async () => {
    vi.useFakeTimers()
    const h = harness()
    const finish = deferred<string>()
    let executed = 0
    const native = defineContentTool({ name: 'read_file', description: 'Read', inputSchema: z.object({}), execute: () => { executed++; return finish.promise } })
    try {
      const managed = managedTool(native, h)
      const starts = Array.from({ length: 9 }, (_, index) => invoke(managed, String(index)))
      await vi.advanceTimersByTimeAsync(10_000)
      const results = await Promise.all(starts)
      const ninth = JSON.parse(String(results[8].content))
      expect(results.every(result => result.resultStatus === 'success')).toBe(true)
      expect(ninth).toMatchObject({ ok: true, status: 'preparing', call_id: expect.any(String) })
      expect(executed).toBe(8)
      finish.resolve('done')
      await vi.advanceTimersByTimeAsync(1)
      expect(executed).toBe(9)
      expect((await h.service.readResult(ninth.call_id, h.threadId))?.content).toBe('done')
    } finally { finish.resolve('done'); await h.service.waitForIdle(); await h.close() }
  })

  it.each([
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
    { type: 'image', mimeType: 'image/png', data: 'AA==' }
  ])('preserves fast native text, $type, metadata and artifact results', async (image) => {
    const h = harness()
    try {
      const content = [{ type: 'text', text: 'answer' }, image]
      const artifact = [{ type: 'mcp_structured_content', structuredContent: { answer: 42 } }]
      const native = defineTool({ name: 'mcp_server_query', description: 'Query', inputSchema: z.object({}),
        metadata: { annotations: { readOnlyHint: true } }, execute: async () => ({ content, artifact }) })
      const managed = managedTool(native, h)
      expect(managed.inputSchema).toBe(native.inputSchema)
      const result = await invoke(managed, 'original-id')
      expect(result.content).toEqual(content)
      expect(result.artifact).toEqual(artifact)
      expect(result.resultFor).toBe('original-id')
    } finally { await h.close() }
  })

  it('yields at ten seconds, keeps identical invocations separate and retrieves late artifacts', async () => {
    vi.useFakeTimers()
    const h = harness()
    const finishes = [deferred<string>(), deferred<string>()]
    let index = 0
    const native = defineTool({ name: 'mcp_server_query', description: 'Query', inputSchema: z.object({}), metadata: { annotations: { readOnlyHint: true } }, execute: async () => {
      const text = await finishes[index++].promise
      return { content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }], artifact: { text } }
    } })
    try {
      const managed = managedTool(native, h)
      let returned = false
      const first = invoke(managed, 'first').then((value) => { returned = true; return value })
      const second = invoke(managed, 'second')
      await vi.advanceTimersByTimeAsync(9_999)
      expect(returned).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      const a = JSON.parse(String((await first).content)).call_id as string
      const b = JSON.parse(String((await second).content)).call_id as string
      expect(a).not.toBe(b)
      finishes[1].resolve('second result')
      await vi.advanceTimersByTimeAsync(1)
      expect(JSON.parse(h.service.read({ threadId: h.threadId, callId: a })).status).toBe('running')
      expect((await h.service.readResult(b, h.threadId))?.resultFor).toBe('second')
      const controls = await runtimeToolDefinitions({ enabled: true, primaryFolder: process.cwd(), shell: false,
        network: false, memory: false, mcp: false, backgroundTools: true,
        threadId: h.threadId, managedCalls: h.service })
      const read = managedTool(controls.find((entry) => entry.name === 'read_call_output')!, h)
      const output = await invoke(read, 'read-result', { call_id: b, output_offset: 0, output_length: 100 })
      expect(output.artifact).toEqual({ text: 'second result' })
      expect(output.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'image_url' })]))
      finishes[0].resolve('first result')
      await vi.advanceTimersByTimeAsync(1)
    } finally { await h.close() }
  })

  it('waits inline when disabled and leaves an existing background call intact', async () => {
    vi.useFakeTimers()
    const h = harness()
    const finishes = [deferred<string>(), deferred<string>()]
    let index = 0
    const native = defineContentTool({ name: 'read_file', description: 'Read', inputSchema: z.object({}), execute: () => finishes[index++].promise })
    try {
      const first = invoke(managedTool(native, h), 'first')
      await vi.advanceTimersByTimeAsync(10_000)
      const id = JSON.parse(String((await first).content)).call_id as string
      let returned = false
      const second = invoke(managedTool(native, { ...h, allowBackground: false }), 'second')
        .then((result) => { returned = true; return result })
      await vi.advanceTimersByTimeAsync(30_000)
      expect(returned).toBe(false)
      expect(JSON.parse(h.service.read({ threadId: h.threadId, callId: id })).status).toBe('running')
      finishes[1].resolve('inline')
      expect((await second).content).toBe('inline')
      finishes[0].resolve('background')
      await vi.advanceTimersByTimeAsync(1)
    } finally { await h.close() }
  })

  it('keeps orchestration and planning tools outside managed execution', async () => {
    const h = harness()
    const start = vi.spyOn(h.service, 'start')
    try {
      for (const name of ['wait_call', 'read_call', 'read_call_output', 'cancel_call', 'write_call', 'write_todos', 'start_subagent', 'wait_subagent']) {
        const native = defineContentTool({ name, description: name, inputSchema: z.object({}), execute: async () => 'ok' })
        expect((await invoke(managedTool(native, h), 'inline-control')).content).toBe('ok')
        expect(start).not.toHaveBeenCalled()
      }
    } finally { await h.close() }
  })

  it('finishes a dispatched local commit truthfully when cancellation races it', async () => {
    vi.useFakeTimers()
    const h = harness()
    const finish = deferred<string>()
    const native = defineContentTool({ name: 'apply_patch', description: 'Write', inputSchema: z.object({}), execute: async () => {
      armCurrentAgentToolEffect({ kind: 'file_patch', target: 'test' })
      return finish.promise
    } })
    try {
      const started = invoke(managedTool(native, h), 'write')
      await vi.advanceTimersByTimeAsync(10_000)
      const id = JSON.parse(String((await started).content)).call_id as string
      const cancellation = h.service.cancel(id, h.threadId)
      finish.resolve('done')
      await vi.advanceTimersByTimeAsync(1)
      expect(JSON.parse(await cancellation).status).toBe('completed')
    } finally { await h.close() }
  })

  it.each([false, true])('preserves confirmed Shell cancellation (uncertain termination: %s)', async (uncertain) => {
    vi.useFakeTimers()
    const h = harness()
    const native = defineContentTool({ name: 'pwsh', description: 'Shell', metadata: commandShellMetadata(), inputSchema: z.object({}), execute: async () => {
      const control = currentToolExecution()!
      armCurrentAgentToolEffect({ kind: 'shell', target: 'long command' })
      await new Promise<void>((resolve) => control.signal.addEventListener('abort', () => resolve(), { once: true }))
      if (uncertain) control.markUncertain('The supervisor could not confirm termination.')
      const result = { ok: false, aborted: true, exit_code: 1, error: 'Command cancelled.' }
      control.setOutcome(result)
      return JSON.stringify(result)
    } })
    try {
      const started = invoke(managedTool(native, h), 'shell-cancel')
      await vi.advanceTimersByTimeAsync(10_000)
      const id = JSON.parse(String((await started).content)).call_id as string
      const result = JSON.parse(await h.service.cancel(id, h.threadId))
      expect(result).toMatchObject({
        status: uncertain ? 'uncertain' : 'cancelled',
        executor_lingering: false,
        outcome_uncertain: uncertain
      })
      expect(h.database.managed.getManagedCall(id, h.threadId)?.outcome).toMatchObject({ aborted: true, exit_code: 1 })
    } finally { await h.close() }
  })

  it('keeps dispatched MCP cancellation uncertain when the remote outcome is not confirmed', async () => {
    vi.useFakeTimers()
    const h = harness()
    const native = defineContentTool({ name: 'mcp_remote_write', description: 'Write', inputSchema: z.object({}), execute: async () => {
      const control = currentToolExecution()!
      armCurrentAgentToolEffect({ kind: 'mcp_call', target: 'remote mutation' })
      await new Promise<void>((_resolve, reject) => control.signal.addEventListener('abort', () => reject(control.signal.reason), { once: true }))
      return 'unreachable'
    } })
    try {
      const started = invoke(managedTool(native, h), 'mcp-cancel')
      await vi.advanceTimersByTimeAsync(10_000)
      const id = JSON.parse(String((await started).content)).call_id as string
      expect(JSON.parse(await h.service.cancel(id, h.threadId))).toMatchObject({
        status: 'uncertain', executor_lingering: false, outcome_uncertain: true
      })
    } finally { await h.close() }
  })

  it.each([true, false])('retains the real local commit result after cancellation has waited five seconds (ok: %s)', async (ok) => {
    vi.useFakeTimers()
    const h = harness()
    const finish = deferred<string>()
    const native = defineContentTool({ name: 'apply_patch', description: 'Write', inputSchema: z.object({}), execute: async () => {
      armCurrentAgentToolEffect({ kind: 'file_patch', target: 'test' })
      const result = await finish.promise
      currentToolExecution()!.setOutcome({ ok })
      return result
    } })
    try {
      const started = invoke(managedTool(native, h), 'slow-local-commit')
      await vi.advanceTimersByTimeAsync(10_000)
      const id = JSON.parse(String((await started).content)).call_id as string
      const cancellation = h.service.cancel(id, h.threadId)
      await vi.advanceTimersByTimeAsync(5_000)
      expect(JSON.parse(await cancellation)).toMatchObject({
        status: 'running', executor_lingering: true, outcome_uncertain: false
      })
      expect(JSON.parse(h.service.read({ threadId: h.threadId, callId: id }))).toMatchObject({ status: 'running', terminal: false })
      expect(h.service.unresolvedForThread(h.threadId)).toEqual([expect.objectContaining({ id, status: 'running' })])
      expect(() => h.service.resolveObservedCall(id, h.threadId, h.runId)).toThrow('is still running')
      expect(h.database.managed.deleteManagedCall(id, h.threadId)).toBe(false)
      let waitReturned = false
      const waiting = h.service.wait({ callId: id, threadId: h.threadId }).then((value) => { waitReturned = true; return value })
      await vi.advanceTimersByTimeAsync(5_000)
      expect(waitReturned).toBe(false)
      const content = JSON.stringify({ ok, ...(ok ? { saved: true } : { error: 'Commit failed with a confirmed result.' }) })
      finish.resolve(content)
      await vi.advanceTimersByTimeAsync(1)
      expect(JSON.parse(await waiting)).toMatchObject({ status: ok ? 'completed' : 'failed', terminal: true })
      expect((await h.service.readResult(id, h.threadId))?.content).toBe(content)
      expect(JSON.parse(h.service.readOutput({ callId: id, threadId: h.threadId, offset: 0, length: 1_000 }))).toMatchObject({
        output_chars_total: content.length,
        output: [expect.objectContaining({ text: content })]
      })
      expect(h.service.activeCallIds()).not.toContain(id)
    } finally { await h.close() }
  })

  it('preserves executor failure outcomes and fractional progress', async () => {
    vi.useFakeTimers()
    const h = harness()
    const finish = deferred<string>()
    const native = defineContentTool({ name: 'read_file', description: 'Read', inputSchema: z.object({}), execute: async () => {
      const control = currentToolExecution()!
      control.progress(0.5, 'steps', 2.5)
      control.setOutcome({ ok: false, error: 'executor failure' })
      return finish.promise
    } })
    try {
      const started = invoke(managedTool(native, h), 'failure')
      await vi.advanceTimersByTimeAsync(10_000)
      const id = JSON.parse(String((await started).content)).call_id as string
      expect(h.database.managed.getManagedCall(id, h.threadId)?.progressCurrent).toBe(0.5)
      finish.resolve('failure details')
      await vi.advanceTimersByTimeAsync(1)
      expect(h.database.managed.getManagedCall(id, h.threadId)?.status).toBe('failed')
    } finally { await h.close() }
  })
})
