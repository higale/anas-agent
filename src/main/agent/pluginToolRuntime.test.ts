import { nativeCapabilityFixture } from '../../test/nativeCapabilityFixture'
import { invokeCapability } from '../../runtime/toolInvocation'
import { conversationChatInput } from '../../providers/conversationInput'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { pluginToolDefinitions } from './pluginToolRuntime'
import { classifyAgentToolEffect } from './toolEffectClassification'
import { invokePluginTool } from '../plugins/pluginRuntime'
import type { ResolvedPluginTool } from '@shared/pluginTools'
import { PluginCallError } from '../plugins/pluginBackend'

vi.mock('../plugins/pluginRuntime', () => ({ invokePluginTool: vi.fn() }))
const definition: ResolvedPluginTool = { id: 'echo', pluginId: 'example', name: 'plugin__example__echo', handler: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }, timeoutSeconds: 30, effect: 'confirm' }
beforeEach(() => { vi.mocked(invokePluginTool).mockReset() })

function harness(effect = definition.effect) {
  const h = nativeCapabilityFixture('plugin-run')
  const native = pluginToolDefinitions([{ ...definition, effect }], { preview: false })[0], wrapped = h.managed(native)
  return { ...h, native,
    invoke: (callId: string, args: Record<string, unknown>) => invokeCapability(wrapped, args, { callId }),
    modelCall: () => h.executeCalls([native], [[{ id: 'plugin-call', name: native.name, args: { text: 'hello' } }]]) }

}

describe('model plugin tool execution', () => {
  it('runs a tool from a model call, preserves its result and writes a durable effect before dispatch', async () => {
    const h = harness()
    const prepare = vi.spyOn(h.database.runs.store, 'prepareEffect')
    const stored = vi.spyOn(h.database.runs.store, 'saveEffectResult')
    vi.mocked(invokePluginTool).mockImplementation(async (_definition, params, options) => {
      expect(Object.keys(options).sort()).toEqual(['onDispatch', 'signal'])
      options.onDispatch()
      expect(h.database.runs.store.loadEffect(prepare.mock.calls[0][0])).toMatchObject({ state: 'intent', recoveryMode: 'confirm' })
      return params
    })
    try {
      const result = await h.modelCall()
      expect(result.messages.filter(message => message.value.kind === 'tool').at(-1)?.value.content).toBe('{"text":"hello"}')
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
      const message = await h.invoke('lost', { text: 'hello' })
      expect(JSON.parse(String(message.content))).toMatchObject({ ok: false, outcome_uncertain: true })
      expect(invokePluginTool).toHaveBeenCalledOnce()
    } finally { await h.close() }
  })
  it('validates inputs before entering plugin code', async () => {
    const h = harness('read')
    try {
      await expect(h.invoke('bad', { text: 1 })).rejects.toThrow()
      expect(invokePluginTool).not.toHaveBeenCalled()
    } finally { await h.close() }
  })

  it('returns image content to the native runtime and model instead of JSON-encoding it as text', async () => {
    const h = harness('read')
    const blocks = [{ type: 'text', text: 'Desktop' }, { type: 'image', mimeType: 'image/png',
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=' }]
    vi.mocked(invokePluginTool).mockResolvedValue(blocks)
    try {
      const message = await h.invoke('image', { text: 'hello' })
      expect(message.content).toEqual(blocks)
      const encoded = conversationChatInput([message])
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
      const message = await h.invoke('invalid-image', { text: 'hello' })
      expect(message.resultStatus).toBe('error')
      expect(JSON.parse(String(message.content))).toMatchObject({ execution_completed: true, result_error: 'Invalid image' })
      expect(String(message.content)).not.toContain('outcome_uncertain')
    } finally { await h.close() }
  })

  it('does not label a completed write as unknown when storing its image message fails', async () => {
    const h = harness('confirm')
    vi.mocked(invokePluginTool).mockImplementation(async (_definition, _params, options) => { options.onDispatch(); return 'completed' })
    vi.spyOn(h.database.results, 'save').mockRejectedValueOnce(new Error('disk full'))
    const finish = vi.spyOn(h.database.managed, 'finishManagedCall')
    try {
      await h.invoke('disk-full', { text: 'hello' })
      expect(finish).toHaveBeenCalledWith(expect.objectContaining({ status: 'failed', outcome: expect.objectContaining({ remote_result_confirmed: true }), error: 'disk full' }))
      expect(invokePluginTool).toHaveBeenCalledOnce()
    } finally { await h.close() }
  })
})
