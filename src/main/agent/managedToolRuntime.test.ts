import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { nativeCapabilityFixture } from '../../test/nativeCapabilityFixture'
import { defineTool } from '../../runtime/toolDefinition'
import { invokeCapability } from '../../runtime/toolInvocation'
import { toolResultMessage, toolResultText } from '../../runtime/toolResultMessage'
import { AgentStorage } from './agentStorage'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { encodeConversationMessage, decodeConversationMessage } from '../../runtime/conversationStorage'
import { ManagedCallService } from './managedCallService'
import { createManagedToolRuntime } from './managedToolRuntime'
import { beginToolEffect } from './toolExecutionContext'
import { armCurrentAgentToolEffect } from './toolEffectScope'

function fixture(runId: string) {
  const root = mkdtempSync(join(tmpdir(), 'anas-managed-capability-')), storage = AgentStorage.openNative(root)
  const thread = storage.createThread(), database = storage.conversationForThread(thread.id)
  const run = database.runs.createRun({ threadId: thread.id, runId, operation: 'agent', message: {
    id: runId + ':input', value: { id: runId + ':input', kind: 'user', content: 'Run capability', context: { runId } }
  } })
  const service = new ManagedCallService(database.managed, database.results)
  return { database, service, thread, run,
    async close() { await service.shutdown(); storage.close(); rmSync(root, { recursive: true, force: true }) } }
}

describe('native managed capability with the current owning service', () => {
  it('queues one native batch call and retains its canonical identity, original input and artifact in history', async () => {
    const h = nativeCapabilityFixture()
    try {
      const queued = vi.spyOn(h.service, 'start'), created = vi.spyOn(h.database.managed, 'createManagedCall'), transform = vi.fn(async (value: string) => value.toUpperCase())
      const execute = vi.fn((input: { label: string; count: number }) => ({ content: input, artifact: { bytes: new Uint8Array([3, 4]) } }))
      const definition = defineTool({ name: 'mcp_inspect', description: '',
        inputSchema: z.object({ label: z.string().transform(transform), count: z.number().default(0) }), execute })
      const history = await h.executeCalls([definition], [[{ id: 'managed-call', name: definition.name, args: { label: 'raw', extra: true } }]])
      expect(queued).toHaveBeenCalledOnce(); expect(execute).toHaveBeenCalledOnce()
      expect(execute.mock.calls[0][0]).toEqual({ label: 'RAW', count: 0 })
      expect(transform.mock.calls.map(call => call[0])).toEqual(['raw', 'raw'])
      const messages = history.messages.map(message => message.value), result = messages.find(message => message.kind === 'tool')!
      expect(messages[1].calls?.[0].args).toEqual({ label: 'raw', extra: true })
      expect(result).toMatchObject({ resultFor: 'managed-call', resultStatus: 'success', artifact: { bytes: new Uint8Array([3, 4]) } })
      expect(JSON.parse(String(result.content))).toEqual({ label: 'RAW', count: 0 })
      expect(result.id).toBeTruthy()
      expect(h.database.execution.store.readHistory(h.thread.id)!.messages.find(message => message.value.kind === 'tool')!.value).toEqual(result)
      expect(h.database.execution.store.load(h.thread.id)!.phase).toBe('completed')
      expect(created).toHaveBeenCalledOnce()
      expect(h.database.managed.getManagedCall(created.mock.results[0].value.id, h.thread.id)).toBeUndefined()
    } finally { await h.close() }
  })

  it('executes a new effect even when an older accepted result has the same provider call ID', async () => {
    const h = nativeCapabilityFixture()
    try {
      const read = vi.fn(() => ({ content: 'Older read result' })), write = vi.fn(() => {
        armCurrentAgentToolEffect({ kind: 'mcp_call', target: { resource: 'new' } })
        return { content: 'New effect result' }
      })
      const definitions = [defineTool({ name: 'mcp_read', description: '', inputSchema: z.object({}), metadata: { annotations: { readOnlyHint: true } }, execute: read }),
        defineTool({ name: 'mcp_write', description: '', inputSchema: z.object({}), execute: write })]
      const history = await h.executeCalls(definitions, definitions.map(tool => [{ id: 'reused-provider-id', name: tool.name, args: {} }]))
      expect(read).toHaveBeenCalledOnce(); expect(write).toHaveBeenCalledOnce()
      const results = history.messages.filter(message => message.value.kind === 'tool')
      expect(results.map(message => message.value.content)).toEqual(['Older read result', 'New effect result'])
      expect(results.map(message => message.value.resultFor)).toEqual(['reused-provider-id', 'reused-provider-id'])
      expect(new Set(results.map(message => message.id)).size).toBe(2)
    } finally { await h.close() }
  })

  it.each(['write_file', 'mcp_remote_write'])('retains uncertainty when %s takes effect but saving its result rejects', async name => {
    const h = fixture('failed-result-save'), { database, service, thread, run } = h
    try {
      const created = vi.spyOn(database.managed, 'createManagedCall')
      const execute = vi.fn(async () => { beginToolEffect(); return { content: 'Effect applied.' } })
      const save = vi.fn(async () => { await Promise.resolve(); throw new Error('Result storage unavailable') })
      const dispatch = createManagedToolRuntime(defineTool({ name, description: 'Effect fixture', inputSchema: z.object({}), execute }), {
        service, threadId: thread.id, runId: run.id, allowBackground: false,
        results: { format: 'conversation', save,
          read: async () => { throw new Error('No result was saved') } }
      })
      const message = await invokeCapability(dispatch, {}, { callId: 'failed-save' })
      expect(JSON.parse(String(message.content))).toMatchObject({ ok: false, outcome_uncertain: true })
      const call = database.managed.getManagedCall(created.mock.results[0].value.id, thread.id)!
      expect(call).toMatchObject({ status: 'uncertain', error: 'Result storage unavailable' })
      expect(JSON.parse(await service.wait({ callId: call.id, threadId: thread.id }))).toMatchObject({ status: 'uncertain' })
      expect(execute).toHaveBeenCalledOnce()
      expect(save).toHaveBeenCalledOnce()
    } finally { await h.close() }
  })

  it('returns application messages with provider identity and full artifacts through actual SQLite result storage', async () => {
    const h = fixture('native-managed'), { database, service, thread, run } = h
    try {
      const execute = vi.fn(async (input: { count: number }) => ({ content: [{ type: 'text', text: `value ${input.count}` }],
        artifact: { bytes: new Uint8Array([0, 255]), values: new Map([['entry', new Set([0, false])]]) } }))
      const definition = defineTool({ name: 'read_file', description: 'Read fixture', metadata: { source: 'fixture' },
        inputSchema: z.object({ count: z.number().default(0) }).transform(input => ({ count: input.count + 1 })), execute })
      const dispatch = createManagedToolRuntime(definition, { service, threadId: thread.id, runId: run.id, allowBackground: false,
        providerCallId: callId => { expect(callId).toBe('application-call'); return 'provider-call' },
        results: database.results
      })
      const raw = {}, message = await invokeCapability(dispatch, raw, { callId: 'application-call' })
      expect(message).toMatchObject({ kind: 'tool', name: 'read_file', resultFor: 'provider-call', resultStatus: 'success',
        content: [{ type: 'text', text: 'value 1' }], resultMetadata: definition.metadata,
        artifact: { bytes: new Uint8Array([0, 255]), values: new Map([['entry', new Set([0, false])]]) } })
      expect(message).not.toHaveProperty('getType')
      expect(message.id).toBeTruthy()
      expect(raw).toEqual({})
      expect(execute).toHaveBeenCalledOnce()
      expect(execute.mock.calls[0][0]).toEqual({ count: 1 })
    } finally { await h.close() }
  })

  it('preserves recorded metadata through the native storage boundary and rejects unserializable content', () => {
    const circular: unknown[] = []; circular.push(circular)
    expect(() => toolResultMessage({ content: circular }, { name: 'fixture', callId: 'call' })).toThrow()
    const original: ConversationMessage = { id: 'result', kind: 'tool', resultFor: 'call', resultStatus: 'error', name: 'fixture',
      content: [{ type: 'text', text: 'text' }, { type: 'image', data: 'payload' }], artifact: new Uint8Array([1, 9]),
      resultMetadata: { scope: 'custom' }, context: { runId: 'run', createdAt: 'time', unrecordedResult: true },
      source: { metadata: { original: 42 }, extras: { opaque: false }, provider: 'fixture', contentFormat: 'portable' } }
    const native = decodeConversationMessage(encodeConversationMessage(original))
    expect(native).toEqual(original)
    expect(toolResultText(native)).toBe('text')
  })
})

it('rechecks a queued call using its own authorization context after the previous call releases capacity', async () => {
  const { withToolAuthorization, toolAuthorizationDiagnostic } = await import('./toolAuthorizationRuntime')
  const h = fixture('queued-mode-switch')
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve }), gate = new Promise<void>(resolve => { release = resolve })
  let mode: 'smart_approval' | 'strict_approval' = 'smart_approval'
  const write = vi.fn(async (args: { path: string }) => { if (args.path === 'first') { entered(); await gate }; return { content: 'done' } })
  const definition = defineTool({ name: 'create_directory', description: '', inputSchema: z.object({ path: z.string() }), execute: write })
  const dispatch = createManagedToolRuntime(definition, { service: h.service, threadId: h.thread.id, runId: h.run.id,
    allowBackground: false, results: h.database.results })
  try {
    const first = withToolAuthorization(async () => {}, () => invokeCapability(dispatch, { path: 'first' }, { callId: 'first' }))
    await started
    const call = { id: 'second', name: 'create_directory', args: { path: join(process.cwd(), 'outside-task'), needs_approval: false } }
    const options = { runId: h.run.id, primaryFolder: process.cwd(), folders: [], accessMode: () => mode }
    expect(await toolAuthorizationDiagnostic(call, options)).toBeUndefined()
    const verify = vi.fn(async () => { const error = await toolAuthorizationDiagnostic(call, options); if (error) throw new Error(error) })
    const second = withToolAuthorization(verify, () => invokeCapability(dispatch, call.args, { callId: call.id }))
    mode = 'strict_approval'; release(); await first
    const result = await second
    expect(verify).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledTimes(1)
    expect(result.resultStatus).toBe('error')
    expect(String(result.content)).toContain('now requires approval')
  } finally { release?.(); await h.close() }
})
