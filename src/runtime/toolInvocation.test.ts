import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod/v4'
import { defineContentTool, defineTool } from './toolDefinition'
import { toolResultMessage } from './toolResultMessage'
import { invokeCapability } from './toolInvocation'
import { ToolRunScope } from './toolEvents'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}

describe('native capability invocation', () => {
  it.each([0, 250])('preserves an explicit timeout of %s and the call identity', async timeoutMs => {
    const execute = vi.fn(async () => 'done')
    const capability = defineContentTool({ name: 'timeout_test', description: 'Capture deadline', inputSchema: { type: 'object' }, execute })
    await invokeCapability(capability, {}, { timeoutMs, callId: 'call' })
    expect(execute.mock.calls[0]).toEqual([{}, { timeoutMs, callId: 'call' }])
  })

  it.each([z.object({}), { type: 'object' }])('preserves explicit content, artifacts and result identity with schema %j', async inputSchema => {
    const content = [{ type: 'text', text: 'An image' }, { type: 'image', mimeType: 'image/png', data: 'AA==' }]
    const artifact = { reference: 'resource-1', structuredContent: { count: 0, enabled: false } }
    const capability = defineTool({ name: 'artifact_test', description: 'Return artifact', inputSchema, execute: () => ({ content, artifact }) })
    const result = await invokeCapability(capability, {}, { callId: 'artifact-call' })
    expect(toolResultMessage(result, { name: capability.name, callId: 'artifact-call' }))
      .toMatchObject({ kind: 'tool', resultFor: 'artifact-call', name: capability.name, content, artifact })
  })

  it('keeps ordinary JSON opaque even when it contains content and artifact fields', async () => {
    const output = { content: 'ordinary data', artifact: { count: 0 } }
    const capability = defineContentTool({ name: 'json_test', description: 'Return JSON', inputSchema: z.object({}), execute: () => output })
    const message = toolResultMessage(await invokeCapability(capability, {}, {}), { name: capability.name, callId: 'json-call' })
    expect(JSON.parse(String(message.content))).toEqual(output)
    expect(message.artifact).toBeUndefined()
  })

  it('applies defaults, stripping and async transforms exactly once without changing raw intent', async () => {
    const transform = vi.fn(async (value: string) => value.toUpperCase()), execute = vi.fn(value => value)
    const tool = defineContentTool({ name: 'inspect', description: 'Inspect',
      inputSchema: z.object({ label: z.string().transform(transform), enabled: z.boolean().default(false), count: z.number().default(0) }), execute })
    const input = Object.freeze({ label: 'test', extra: true }), started = vi.fn()
    expect(await invokeCapability(tool, input, {}, started)).toEqual({ content: { label: 'TEST', enabled: false, count: 0 } })
    expect(transform).toHaveBeenCalledOnce()
    expect(execute).toHaveBeenCalledOnce()
    expect(started).toHaveBeenCalledOnce()
    expect(input).toEqual({ label: 'test', extra: true })
  })

  it('never enters a capability when cancelled during asynchronous input parsing', async () => {
    const parsing = deferred(), release = deferred(), controller = new AbortController(), execute = vi.fn(), started = vi.fn()
    const tool = defineContentTool({ name: 'inspect', description: 'Inspect', inputSchema: z.object({ value: z.string()
      .transform(async value => { parsing.resolve(); await release.promise; return value }) }), execute })
    const task = invokeCapability(tool, { value: 'raw' }, { signal: controller.signal }, started)
    await parsing.promise
    controller.abort(new Error('stopped before dispatch'))
    const rejected = expect(task).rejects.toThrow('stopped before dispatch')
    release.resolve()
    await rejected
    expect(execute).not.toHaveBeenCalled()
    expect(started).not.toHaveBeenCalled()
  })

  it.each([false, true])('awaits cleanup after cancellation and preserves a confirmed result (%s)', async confirms => {
    const entered = deferred(), cleanup = deferred(), controller = new AbortController()
    const tool = defineContentTool({ name: 'wait', description: 'Wait', inputSchema: { type: 'object' },
      execute: async (_input, context) => {
        entered.resolve()
        await cleanup.promise
        if (!confirms) context.signal?.throwIfAborted()
        return 'confirmed'
      } })
    let finished = false
    const task = invokeCapability(tool, {}, { signal: controller.signal }).finally(() => { finished = true })
    await entered.promise
    controller.abort(new Error('stopped'))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(finished).toBe(false)
    const checked = confirms ? expect(task).resolves.toEqual({ content: 'confirmed' }) : expect(task).rejects.toThrow('stopped')
    cleanup.resolve()
    await checked
  })

  it('reports invalid input before publishing a start or entering the handler', async () => {
    const execute = vi.fn(), started = vi.fn()
    const tool = defineContentTool({ name: 'inspect', description: 'Inspect', inputSchema: z.object({ count: z.number().int().min(1) }).strict(), execute })
    await expect(invokeCapability(tool, { count: 0 }, {}, started)).rejects.toThrow()
    await expect(invokeCapability(tool, { count: 1, extra: true }, {}, started)).rejects.toThrow()
    expect(started).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps observation failures bounded and scopes subscriptions to one run', () => {
    const channel = new ToolRunScope(), failure = new Error('display failed')
    const observe = vi.fn(() => { throw failure }), subscription = channel.connect(observe)
    const event = { kind: 'started' as const, call: { id: 'call', name: 'inspect', args: {} } }
    channel.publish(event)
    channel.publish(event)
    expect(observe).toHaveBeenCalledTimes(2)
    expect(subscription.errors).toEqual([failure])
    expect(() => channel.connect(vi.fn())).toThrow('already connected')
    subscription.disconnect()
    channel.publish(event)
    expect(observe).toHaveBeenCalledTimes(2)
    const next = vi.fn(), later = channel.connect(next)
    subscription.disconnect()
    channel.publish(event)
    expect(next).toHaveBeenCalledWith(event)
    later.disconnect()
  })
})
