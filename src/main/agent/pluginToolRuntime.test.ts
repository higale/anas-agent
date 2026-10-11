import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgent, FakeToolCallingModel } from 'langchain'
import { ToolMessage } from '@langchain/core/messages'
import { AgentDatabase } from './agentDatabase'
import { ManagedCallService } from './managedCallService'
import { createPluginTools } from './pluginToolRuntime'
import { withManagedToolExecution } from './managedToolExecution'
import { createAgentToolEffectMiddleware } from './toolEffectMiddleware'
import { classifyAgentToolEffect } from './toolEffectClassification'
import { invokePluginTool } from '../plugins/pluginRuntime'
import type { ResolvedPluginTool } from '@shared/pluginTools'
import { PluginCallError } from '../plugins/pluginBackend'
import { encodeOpenAiToolImages } from './toolImageTransport'

vi.mock('../plugins/pluginRuntime', () => ({ invokePluginTool: vi.fn() }))
const definition: ResolvedPluginTool = { id: 'echo', pluginId: 'example', name: 'plugin__example__echo', handler: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, timeoutSeconds: 30, effect: 'confirm' }
beforeEach(() => { vi.mocked(invokePluginTool).mockReset() })

function harness(effect = definition.effect) {
  const database = AgentDatabase.open(':memory:')
  const thread = database.createThread({ title: 'Plugin tools' })
  const run = database.createRun(thread.id, 'plugin-run')
  const service = new ManagedCallService(database)
  const native = createPluginTools([{ ...definition, effect }], { preview: false })[0]
  const wrapped = withManagedToolExecution(native, { database, service, threadId: thread.id, runId: run.id, allowBackground: false })
  return { database, thread, run, service, native, wrapped, close: async () => { await service.shutdown(); database.close() } }
}

describe('model plugin tool execution', () => {
  it('runs a tool from a model call, preserves its result and writes a durable effect before dispatch', async () => {
    const h = harness()
    const prepare = vi.spyOn(h.database, 'prepareToolEffect')
    const stored = vi.spyOn(h.database, 'storeToolEffectResult')
    vi.mocked(invokePluginTool).mockImplementation(async (_definition, params, options) => {
      expect(Object.keys(options).sort()).toEqual(['onDispatch', 'signal'])
      options.onDispatch()
      expect(h.database.loadToolEffect(prepare.mock.calls[0][0])).toMatchObject({ state: 'intent', recoveryMode: 'confirm' })
      return params
    })
    try {
      const tools = [h.wrapped]
      const agent = createAgent({ model: new FakeToolCallingModel({ toolCalls: [[{ id: 'plugin-call', name: definition.name, args: { text: 'hello' } }], []] }), tools,
        checkpointer: h.database.checkpointer, middleware: [createAgentToolEffectMiddleware({ database: h.database, runId: h.run.id, threadId: h.thread.id, tools })] })
      const result = await agent.invoke({ messages: [{ role: 'user', content: 'Echo hello.' }] }, { configurable: { thread_id: h.thread.id }, durability: 'sync' })
      expect(result.messages.filter(ToolMessage.isInstance).at(-1)?.content).toBe('{"text":"hello"}')
      expect(invokePluginTool).toHaveBeenCalledOnce()
      expect(stored).toHaveBeenCalled()
    } finally { await h.close() }
  })
  it.each(['read', 'idempotent', 'confirm'] as const)('uses the declared %s recovery policy', async effect => {
    const h = harness(effect)
    try { expect(classifyAgentToolEffect(h.native.name, {}, h.native)).toEqual(effect === 'read' ? undefined : { recoveryMode: effect }) }
    finally { await h.close() }
  })
  it('does not claim a failed write was never executed', async () => {
    const h = harness()
    vi.mocked(invokePluginTool).mockImplementation(async (_definition, _params, options) => { options.onDispatch(); throw new Error('receipt lost') })
    try {
      const message = await h.wrapped.invoke({ type: 'tool_call', id: 'lost', name: definition.name, args: { text: 'hello' } }) as ToolMessage
      expect(JSON.parse(String(message.content))).toMatchObject({ ok: false, outcome_uncertain: true })
      expect(invokePluginTool).toHaveBeenCalledOnce()
    } finally { await h.close() }
  })
  it('validates inputs before entering plugin code', async () => {
    const h = harness('read')
    try {
      await expect(h.wrapped.invoke({ type: 'tool_call', id: 'bad', name: definition.name, args: { text: 1 } })).rejects.toThrow()
      expect(invokePluginTool).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('returns image content to the framework and model instead of JSON-encoding it as text', async () => {
    const h = harness('read')
    const blocks = [{ type: 'text', text: 'Desktop' }, { type: 'image', mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }]
    vi.mocked(invokePluginTool).mockResolvedValue(blocks)
    try {
      const message = await h.wrapped.invoke({ type: 'tool_call', id: 'image', name: definition.name, args: { text: 'hello' } }) as ToolMessage
      expect(message.content).toEqual(blocks)
      const encoded = encodeOpenAiToolImages([message], false)
      expect(encoded.at(-1)?.content).toContainEqual({ type: 'image_url', image_url: { url: `data:image/png;base64,${blocks[1].data}` } })
    } finally { await h.close() }
  })

  it('retains confirmed execution when a plugin image result is invalid', async () => {
    const h = harness('confirm')
    vi.mocked(invokePluginTool).mockImplementation(async (_definition, _params, options) => {
      options.onDispatch()
      throw new PluginCallError('Invalid image', 'result_error', true)
    })
    try {
      const message = await h.wrapped.invoke({ type: 'tool_call', id: 'invalid-image', name: definition.name, args: { text: 'hello' } }) as ToolMessage
      expect(message.status).toBe('error')
      expect(JSON.parse(String(message.content))).toMatchObject({ execution_completed: true, result_error: 'Invalid image' })
      expect(String(message.content)).not.toContain('outcome_uncertain')
    } finally { await h.close() }
  })

  it('does not label a completed write as unknown when storing its image message fails', async () => {
    const h = harness('confirm')
    vi.mocked(invokePluginTool).mockImplementation(async (_definition, _params, options) => { options.onDispatch(); return 'completed' })
    vi.spyOn(h.database, 'persistManagedToolResult').mockRejectedValueOnce(new Error('disk full'))
    const finish = vi.spyOn(h.database, 'finishManagedCall')
    try {
      await h.wrapped.invoke({ type: 'tool_call', id: 'disk-full', name: definition.name, args: { text: 'hello' } })
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', outcome: expect.objectContaining({ remote_result_confirmed: true }), error: 'disk full' }))
      expect(invokePluginTool).toHaveBeenCalledOnce()
    } finally { await h.close() }
  })
})
