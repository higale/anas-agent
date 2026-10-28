import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { saveToolResultFile } from './toolResultFile'
import { createConversationMemoryProjector } from './conversationMemory'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedModelConfig } from '@shared/types'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { ModelContextOverflowError, ModelRequestChangedError } from '../../runtime/errors'
import { invokeConversationWithCompression, type ConversationCompressionOptions } from './conversationCompression'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'
import * as compressionModel from './compressionModel'
import { countConversationTokens, conversationRequestKey, conversationContextTokens } from './conversationContext'
import { modelContextKey } from '../../shared/modelConfig'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn() }))
vi.mock('../gitChanges', () => ({ queryGitChanges: vi.fn() }))
afterEach(() => { vi.restoreAllMocks() })

const model: ResolvedModelConfig = {
  id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol: 'openai_chat_completions',
  baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 12000, maxOutputTokens: 1000,
  contextCompressionThreshold: 0.4, contextCompressionEnabled: true
}
function messages(): ConversationMessage[] { return [
  { id: 'old', kind: 'user', content: 'Original requirement '.repeat(1500) }, { id: 'answer', kind: 'assistant', content: 'Previous answer' },
  { id: 'current', kind: 'user', content: 'Keep this current goal' }
] }
function response(text: string) {
  return Response.json({ id: 'provider-response', object: 'chat.completion', model: 'fixture', created: 1,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: text } }],
    usage: { prompt_tokens: 100, completion_tokens: 2, total_tokens: 102 } })
}
function options(): ConversationCompressionOptions {
  return { runId: 'run', signal: new AbortController().signal, resolveModel: async () => model, outputLanguage: { code: 'en', name: 'English' },
    compressionTracking: { onCompressionStart: vi.fn(() => 'summary'), onCompressionCompleted: vi.fn(), onCompressionFailed: vi.fn() },
    saveToolResult: vi.fn(async () => '/fixture/full-result.txt') }
}
const context = (history = messages()) => ({ messages: history, systemMessage: { kind: 'system' as const, content: 'Instructions' }, tools: [], requiresTools: false })
function observeSummaryPrompts() {
  const prompts: string[] = [], original = compressionModel.createCompressionModel
  vi.spyOn(compressionModel, 'createCompressionModel').mockImplementation((selected, options) => {
    const generate = original(selected, options)
    return (prompt, signal, preparation) => { prompts.push(prompt); return generate(prompt, signal, preparation) }
  })
  return prompts
}
function toolTransaction(id: string, content: string): [ConversationMessage, ConversationMessage] {
  return [{ id: `${id}:request`, kind: 'assistant', content: '', calls: [{ id, name: 'search', args: { query: id } }] },
    { id: `${id}:result`, kind: 'tool', content, resultFor: id }]
}

describe('native automatic compression', () => {
  it('returns a provisional summary and commits it atomically with the complete response', async () => {
    const database = new Database(':memory:')
    try {
      database.pragma('foreign_keys = ON'); database.exec(nativeExecutionSchema)
      let failCommit = false
      const store = new NativeExecutionStore(database, () => { if (failCommit) throw new Error('owner commit failed') })
      const history = messages(), before = structuredClone(history), calls: Record<string, unknown>[] = []
      store.start({ threadId: 'thread', runId: 'run', messages: history.map(value => ({ id: value.id!, value })), context: { modelCalls: 0, todos: [] } })
      const config = options()
      config.observe = vi.fn()
      const preparedRequests: unknown[] = []
      config.onRequest = (_model, request) => { preparedRequests.push(structuredClone(request)) }
      config.providerFetch = async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return response(calls.length === 1 ? 'Saved history summary' : 'Continue') }
      const result = await invokeConversationWithCompression(model, context(history), config)
      expect(result.text).toBe('Continue')
      expect(result.summary).toMatchObject({ id: 'summary', cutoffIndex: 2, coveredThroughMessageId: 'answer', firstPreservedMessageId: 'current' })
      expect(calls).toHaveLength(2)
      expect(JSON.stringify(calls[0])).toContain('Original requirement')
      expect(JSON.stringify(calls[1])).not.toContain('Original requirement')
      expect(JSON.stringify(calls[1])).toContain('Keep this current goal')
      expect(preparedRequests).toHaveLength(1)
      expect(JSON.stringify(preparedRequests[0])).toContain('Saved history summary')
      expect(JSON.stringify(preparedRequests[0])).not.toContain('Original requirement')
      expect(store.load('thread')!.context.summary).toBeUndefined()
      expect(config.compressionTracking.onCompressionCompleted).toHaveBeenCalledOnce()
      expect(config.observe).not.toHaveBeenCalled()
      const state = store.load('thread')!, scope = { threadId: 'thread', runId: 'run', expectedRevisionId: state.revisionId }
      failCommit = true
      expect(() => store.acceptModel(scope, { id: result.message.id!, value: result.message }, [], { modelCalls: 1, todos: [] }, result.summary)).toThrow('owner commit failed')
      expect(store.load('thread')!.messages).toHaveLength(3)
      expect(store.load('thread')!.context.summary).toBeUndefined()
      failCommit = false
      store.acceptModel(scope, { id: result.message.id!, value: result.message }, [], { modelCalls: 1, todos: [] }, result.summary)
      const committed = store.load('thread')!
      expect(committed.phase).toBe('model_result')
      expect(committed.messages).toHaveLength(4)
      expect(JSON.stringify(committed.messages)).not.toContain('Saved history summary')
      expect(committed.context.summary).toMatchObject({ id: 'summary', cutoffIndex: 2 })
      expect(store.readMessageRecord('thread', committed.context.summary!.messageRecordId).value.content).toContain('Saved history summary')
      expect(history).toEqual(before)
    } finally { database.close() }
  })

  it('saves oversized retained results before compacting only the model request', async () => {
    const history = messages()
    history.push({ id: 'tool-call', kind: 'assistant', content: '', calls: [{ id: 'call', name: 'read', args: {} }] },
      { id: 'tool-result', kind: 'tool', resultFor: 'call', content: 'Complete result '.repeat(5000) })
    const before = structuredClone(history), requests: Record<string, unknown>[] = [], config = options()
    config.providerFetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return response(requests.length === 1 ? 'Summary' : 'Continue') }
    const result = await invokeConversationWithCompression(model, context(history), config)
    expect(config.saveToolResult).toHaveBeenCalledWith(history.at(-1)!.content)
    expect(result.summary?.cutoffIndex).toBe(3)
    expect(requests).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain('/fixture/full-result.txt')
    expect(JSON.stringify(requests[1])).toContain('do not rerun the operation')
    expect(JSON.stringify(requests[1])).toContain('Keep this current goal')
    expect(history).toEqual(before)
  })

  it.each(['code', 'message', 'local'] as const)('compresses once after a %s capacity failure below the local trigger', async kind => {
    const history = messages()
    history[0] = { ...history[0], content: 'Old source '.repeat(800) }
    const selected = { ...model, contextCompressionThreshold: 0.9 }, config = options(), requests: Record<string, unknown>[] = []
    config.resolveModel = async () => selected
    config.providerFetch = async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      if (requests.length !== 1) return response(requests.length === 2 ? 'Summary' : 'Continue')
      if (kind === 'local') throw new ModelContextOverflowError()
      return Response.json({ error: kind === 'code' ? { message: 'maximum context length exceeded', code: 'context_length_exceeded' }
        : { message: 'prompt is too long: 20000 tokens > 10000 maximum' } }, { status: 400 })
    }
    const result = await invokeConversationWithCompression(selected, context(history), config)
    expect(result.text).toBe('Continue')
    expect(requests).toHaveLength(3)
    expect(config.compressionTracking.onCompressionStart).toHaveBeenCalledOnce()
  })

  it('keeps the raw cutoff before a retained result omitted from the protocol request', async () => {
    const history: ConversationMessage[] = [{ id: 'old-user', kind: 'user', content: 'Earlier request '.repeat(500) },
      { id: 'old-answer', kind: 'assistant', content: 'Earlier answer '.repeat(500) },
      { id: 'retained-evidence', kind: 'tool', resultFor: 'unpaired', content: 'Recorded evidence' }]
    const before = structuredClone(history), selected = { ...model, maxContextTokens: 21000, contextCompressionThreshold: 0.005 }
    const config = options(), prompts = observeSummaryPrompts(), requests: Array<{ messages: unknown[] }> = []
    config.resolveModel = async () => selected
    config.providerFetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return response(requests.length === 1 ? 'Earlier conversation summary' : 'Continue') }
    const result = await invokeConversationWithCompression(selected, context(history), config)
    expect(result.summary?.cutoffIndex).toBe(2)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain('Recorded evidence')
    expect(requests[1].messages).toHaveLength(2)
    expect(JSON.stringify(requests[1])).toContain('Earlier conversation summary')
    expect(JSON.stringify(requests[1])).not.toContain('Recorded evidence')
    expect(history).toEqual(before)
  })

  it('does not repeat an oversized request when no history lies outside the retained unit', async () => {
    const config = options(), fetch = vi.fn(async () => Response.json({ error: { code: 'context_length_exceeded', message: 'maximum context length exceeded' } }, { status: 400 }))
    config.providerFetch = fetch
    await expect(invokeConversationWithCompression(model, context([{ kind: 'user', content: 'Current task' }]), config)).rejects.toThrow()
    expect(fetch).toHaveBeenCalledOnce()
    expect(config.compressionTracking.onCompressionStart).not.toHaveBeenCalled()
  })

  it('does not stage a summary after cancellation during the prepared model request', async () => {
    const config = options(), controller = new AbortController(), reason = new Error('Cancelled before summary activation')
    config.signal = controller.signal
    let requests = 0
    config.providerFetch = async () => {
      if (++requests === 2) controller.abort(reason)
      return response(requests === 1 ? 'Prepared summary' : 'Done')
    }
    await expect(invokeConversationWithCompression(model, context(), config)).rejects.toThrow()
    expect(requests).toBe(2)
    expect(config.compressionTracking.onCompressionCompleted).not.toHaveBeenCalled()
    expect(config.compressionTracking.onCompressionFailed).toHaveBeenCalledExactlyOnceWith('summary')
    expect(controller.signal.reason).toBe(reason)
  })

  it('uses the custom project template for automatic compression', async () => {
    const history: ConversationMessage[] = [{ id: 'source', kind: 'user', content: 'SOURCE-42' },
      { id: 'search', kind: 'assistant', content: '', calls: [{ id: 'research', name: 'search', args: { query: 'research' } }] },
      { id: 'evidence', kind: 'tool', resultFor: 'research', content: 'Source evidence '.repeat(350) },
      { id: 'notes', kind: 'assistant', content: 'Notes' }, { id: 'current', kind: 'user', content: 'Continue' }]
    const selected = { ...model, contextCompressionThreshold: 0.01 }, config = options(), prompts = observeSummaryPrompts()
    config.resolveModel = async () => selected
    config.codingMode = true; config.compressionPrompt = 'Keep research citations: {conversation}'
    config.providerFetch = async () => response('Saved research')
    await invokeConversationWithCompression(selected, context(history), config)
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Keep research citations:')
    expect(prompts[0]).toContain('SOURCE-42')
    expect(prompts[0]).not.toContain('Coding continuation handoff')
    expect(prompts[0]).not.toContain('{conversation}')
  })

  it.each([false, true])('rejects a smaller window without trimming the complete summary source (coding=%s)', async codingMode => {
    const history: ConversationMessage[] = [{ id: 'original', kind: 'user', content: 'ORIGINAL_USER_CONSTRAINT' },
      { id: 'old-answer', kind: 'assistant', content: 'IMPORTANT_PREVIOUS_ANSWER ' + 'd'.repeat(24000) },
      { id: 'current', kind: 'user', content: 'Continue' }]
    const before = structuredClone(history), selected = { ...model, maxContextTokens: 5000, contextCompressionThreshold: 0.5 }
    const config = options(), prompts = observeSummaryPrompts(), fetch = vi.fn(async () => response('Must not be requested'))
    config.resolveModel = async () => selected; config.codingMode = codingMode; config.providerFetch = fetch
    await expect(invokeConversationWithCompression(selected, context(history), config)).rejects.toThrow('complete summary input exceeds')
    expect(fetch).not.toHaveBeenCalled()
    expect(prompts[0]).toContain('ORIGINAL_USER_CONSTRAINT')
    expect(prompts[0]).toContain(String(history[1].content))
    expect(config.compressionTracking.onCompressionCompleted).not.toHaveBeenCalled()
    expect(history).toEqual(before)
  })

  it('includes model instructions in the complete automatic summary source budget', async () => {
    const selected = { ...model, protocol: 'openai_responses' as const, maxContextTokens: 2500,
      contextCompressionThreshold: 1 / 3, parameters: { instructions: 'i'.repeat(4000) } }
    const history: ConversationMessage[] = [{ kind: 'user', content: 'SOURCE_' + 'q'.repeat(1200) },
      { kind: 'assistant', content: 'a'.repeat(1200) }, { kind: 'user', content: 'Continue' }]
    const before = structuredClone(history), config = options(), prompts = observeSummaryPrompts(), fetch = vi.fn(async () => response('Must not be requested'))
    config.resolveModel = async () => selected; config.providerFetch = fetch
    await expect(invokeConversationWithCompression(selected, context(history), config)).rejects.toThrow('complete summary input exceeds')
    expect(fetch).not.toHaveBeenCalled()
    const input: ConversationMessage[] = [{ kind: 'user', content: prompts[0] }]
    expect(countConversationTokens(input, [], { protocol: selected.protocol })).toBeLessThan(1500 - 256)
    expect(countConversationTokens(input, [], { protocol: selected.protocol, parameters: selected.parameters })).toBeGreaterThan(1500 - 256)
    expect(history).toEqual(before)
  })

  it('preserves original history when the provider returns an empty automatic summary', async () => {
    const history: ConversationMessage[] = [{ kind: 'user', content: 'ORIGINAL_REQUIRED_CONSTRAINT ' + 'details '.repeat(1000) },
      { kind: 'assistant', content: 'Original answer' }, { kind: 'user', content: 'Continue' }]
    const before = structuredClone(history), selected = { ...model, maxContextTokens: 21000, contextCompressionThreshold: 0.03 }
    const config = options(), fetch = vi.fn(async () => response('   '))
    config.resolveModel = async () => selected; config.providerFetch = fetch
    await expect(invokeConversationWithCompression(selected, context(history), config)).rejects.toThrow('empty summary')
    expect(fetch).toHaveBeenCalledOnce()
    expect(history).toEqual(before)
    expect(config.compressionTracking.onCompressionCompleted).not.toHaveBeenCalled()
    expect(config.compressionTracking.onCompressionFailed).toHaveBeenCalledWith('summary')
  })

  it('keeps the saved summary projected when automatic compression is disabled', async () => {
    const selected = { ...model, contextCompressionEnabled: false }, config = options(), requests: unknown[] = []
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Old request' }, { kind: 'assistant', content: 'Old answer' },
      { kind: 'user', content: 'Continue' }]
    const summary: ConversationMessage = { kind: 'user', content: 'Preserved summary', context: { summary: true } }
    const prepared = vi.fn()
    config.resolveModel = async () => selected; config.onRequest = prepared
    config.providerFetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return response('Response') }
    const result = await invokeConversationWithCompression(selected, { ...context(history), summary: { cutoffIndex: 2, message: summary } }, config)
    expect(prepared.mock.lastCall![1].messages).toEqual([summary, history[2]])
    expect(requests).toHaveLength(1)
    expect(result.summary).toBeUndefined()
    expect(config.compressionTracking.onCompressionStart).not.toHaveBeenCalled()
  })

  it('does not report an ordinary main-model request as compression', async () => {
    const config = options(), fetch = vi.fn(async () => response('Normal response'))
    config.providerFetch = fetch
    const result = await invokeConversationWithCompression(model, context([{ kind: 'user', content: 'Ordinary request' }]), config)
    expect(result.text).toBe('Normal response')
    expect(result.summary).toBeUndefined()
    expect(fetch).toHaveBeenCalledOnce()
    expect(config.compressionTracking.onCompressionStart).not.toHaveBeenCalled()
  })

  it('uses the current model and threshold when compression is enabled between requests', async () => {
    let selected = { ...model, model: 'first', maxContextTokens: 9000, contextCompressionEnabled: false, contextCompressionThreshold: 0.875 }
    const config = options(), requests: Array<{ model: string; messages: unknown[] }> = []
    config.resolveModel = async () => selected
    config.providerFetch = async (_url, init) => {
      const body = JSON.parse(String(init?.body)); requests.push(body)
      return response(body.messages.length === 1 ? 'Current model summary' : 'Response')
    }
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Old request ' + 'history '.repeat(300) },
      { kind: 'assistant', content: 'Old answer ' + 'history '.repeat(300) }, { kind: 'user', content: 'Continue' }]
    await invokeConversationWithCompression(selected, context(history), config)
    expect(config.compressionTracking.onCompressionStart).not.toHaveBeenCalled()
    selected = { ...selected, model: 'second', maxContextTokens: 7000, contextCompressionEnabled: true, contextCompressionThreshold: 1 / 60 }
    const result = await invokeConversationWithCompression(selected, context(history), config)
    expect(requests.map(request => request.model)).toEqual(['first', 'second', 'second'])
    expect(result.summary?.summaryText).toBe('Current model summary')
    expect(config.compressionTracking.onCompressionStart).toHaveBeenCalledOnce()
  })

  it('triggers on pending image tokens and preserves the complete parallel image batch', async () => {
    const pending: ConversationMessage = { id: 'batch', kind: 'assistant', content: '', calls: [
      { id: 'first', name: 'capture', args: {} }, { id: 'second', name: 'capture', args: {} }
    ] }
    const images: ConversationMessage[] = ['first', 'second'].map(id => ({ id: `${id}-result`, kind: 'tool', resultFor: id,
      name: 'capture', content: [{ type: 'image', source_type: 'base64', data: 'AA==', mime_type: 'image/png' }] }))
    const queued: ConversationMessage = { kind: 'user', content: 'Also inspect the window title' }
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Earlier request' }, { kind: 'assistant', content: 'Earlier answer' }, pending, ...images, queued]
    expect(countConversationTokens(history.map(message => message.kind === 'tool' ? { ...message, content: '' } : message))).toBeLessThan(1800)
    const selected = { ...model, maxContextTokens: 9000, contextCompressionThreshold: 1800 / 8000 }, config = options()
    const prompts = observeSummaryPrompts(), prepared = vi.fn()
    config.resolveModel = async () => selected; config.onRequest = prepared; config.providerFetch = async () => response('Earlier observations')
    await invokeConversationWithCompression(selected, context(history), config)
    expect(prepared).toHaveBeenCalledOnce()
    expect(prepared.mock.lastCall![1].messages.slice(1)).toEqual([pending, ...images, queued])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Earlier request')
    expect(prompts[0]).not.toContain('AA==')
    expect(prompts[0]).not.toContain('Also inspect the window title')
  })

  it('includes Chat Completions image transport text in the compression trigger', async () => {
    const latest = toolTransaction('image', '')
    latest[1].content = [{ type: 'text', text: 'Image metadata '.repeat(80) },
      { type: 'image', source_type: 'base64', data: 'AA==', mime_type: 'image/png' }]
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Earlier request' }, { kind: 'assistant', content: 'Earlier answer' }, ...latest]
    const request = context(history), input = [request.systemMessage, ...history]
    const generic = countConversationTokens(input), encoded = countConversationTokens(input, [], { protocol: 'openai_chat_completions' })
    const threshold = Math.floor((generic + encoded) / 2)
    expect(generic).toBeLessThan(threshold)
    const selected = { ...model, maxContextTokens: 9000, contextCompressionThreshold: threshold / 8000 }, config = options()
    const prompts = observeSummaryPrompts(), prepared = vi.fn()
    config.resolveModel = async () => selected; config.onRequest = prepared; config.providerFetch = async () => response('Earlier observations')
    await invokeConversationWithCompression(selected, request, config)
    expect(prepared.mock.lastCall![1].messages.slice(1)).toEqual(latest)
    expect(prompts).toHaveLength(1)
  })

  it('excludes observed image bytes from summaries while retaining pending images and queued input', async () => {
    const old = toolTransaction('old-image', 'Old screenshot metadata'), latest = toolTransaction('latest-image', '')
    old[1].content = [{ type: 'text', text: 'Old screenshot metadata' }, { type: 'image', data: 'OLD_IMAGE_BYTES' }]
    latest[1].content = [{ type: 'text', text: 'Fresh screenshot metadata '.repeat(100) },
      { type: 'image', source_type: 'base64', data: 'FRESH_IMAGE_BYTES', mime_type: 'image/png' }]
    const queued: ConversationMessage = { kind: 'user', content: 'Also check the window title' }
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Inspect ' + 'old context '.repeat(300) }, ...old,
      { kind: 'assistant', content: 'Observed old screen' }, ...latest, queued]
    const selected = { ...model, maxContextTokens: 9000, contextCompressionThreshold: 200 / 8000 }, config = options()
    const prompts = observeSummaryPrompts(), prepared = vi.fn()
    config.resolveModel = async () => selected; config.onRequest = prepared; config.providerFetch = async () => response('Condensed screen observations')
    await invokeConversationWithCompression(selected, context(history), config)
    expect(prepared).toHaveBeenCalledOnce()
    expect(prepared.mock.lastCall![1].messages.slice(-3)).toEqual([...latest, queued])
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('Old screenshot metadata')
    expect(prompts[0]).not.toContain('OLD_IMAGE_BYTES')
    expect(prompts[0]).not.toContain('FRESH_IMAGE_BYTES')
    expect(JSON.stringify(old[1].content)).toContain('OLD_IMAGE_BYTES')
  })

  it('does not compress because earlier usage included now-consumed images', async () => {
    const selected = { ...model, maxContextTokens: 11000, contextCompressionThreshold: 0.02 }, config = options()
    const transaction = toolTransaction('capture', '')
    transaction[1].content = [{ type: 'image', data: 'LARGE_IMAGE'.repeat(1000) }]
    const prior: ConversationMessage[] = [{ kind: 'user', content: 'Inspect' }, ...transaction]
    const request = context(prior)
    const history: ConversationMessage[] = [...prior, { kind: 'assistant', content: 'Observed',
      context: { modelContextKey: modelContextKey(selected), requestKey: conversationRequestKey({ messages: prior,
        systemMessage: request.systemMessage, tools: [], protocol: selected.protocol }) },
      usage: { input_tokens: 9000, output_tokens: 50, total_tokens: 9050 } }]
    const bodies: unknown[] = []
    config.resolveModel = async () => selected
    config.providerFetch = async (_url, init) => { bodies.push(JSON.parse(String(init?.body))); return response('Continue') }
    const result = await invokeConversationWithCompression(selected, context(history), config)
    expect(bodies).toHaveLength(1)
    expect(JSON.stringify(bodies)).not.toContain('LARGE_IMAGE')
    expect(result.summary).toBeUndefined()
    expect(config.compressionTracking.onCompressionStart).not.toHaveBeenCalled()
    expect(JSON.stringify(transaction[1].content)).toContain('LARGE_IMAGE')
  })

  it('rejects image overflow without truncating or summarizing pending image data', async () => {
    const latest = toolTransaction('image', '')
    latest[1].content = [{ type: 'image', data: 'PENDING_IMAGE'.repeat(1000) }]
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Old context '.repeat(100) }, { kind: 'assistant', content: 'Old answer' }, ...latest]
    const before = structuredClone(history), selected = { ...model, maxContextTokens: 2000, contextCompressionThreshold: 0.1 }, config = options()
    const prompts = observeSummaryPrompts(), fetch = vi.fn(async () => response('Summary'))
    config.resolveModel = async () => selected; config.providerFetch = fetch
    await expect(invokeConversationWithCompression(selected, context(history), config)).rejects.toThrow('unit still exceeds')
    expect(fetch).toHaveBeenCalledOnce()
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).not.toContain('PENDING_IMAGE')
    expect(config.saveToolResult).not.toHaveBeenCalled()
    expect(config.compressionTracking.onCompressionCompleted).not.toHaveBeenCalled()
    expect(history).toEqual(before)
  })

  it('does not summarize after a new request removes memories included in earlier usage', async () => {
    const store = { relevantMemories: vi.fn(async (query: string) => query.startsWith('alpha')
      ? [0, 1].map(id => ({ id: String(id), scope: 'project' as const, kind: 'fact' as const, importance: 3, content: 'm'.repeat(8000),
        keywords: [], origin: 'user' as const, createdAt: '', updatedAt: '' })) : []) }
    const project = createConversationMemoryProjector({ enabled: true, store, projectId: 'project' })
    const system: ConversationMessage = { kind: 'system', content: 'Base' }, old: ConversationMessage = { kind: 'user', content: 'alpha ' + 'a'.repeat(2400) }
    const firstSystem = await project(system, [old]), selected = { ...model, maxContextTokens: 10000, contextCompressionThreshold: 4000 / 9000 }
    const previous: ConversationMessage = { kind: 'assistant', content: 'Done', usage: { input_tokens: 4700, output_tokens: 1, total_tokens: 4701 },
      context: { modelContextKey: modelContextKey(selected), requestKey: conversationRequestKey({ messages: [old], systemMessage: firstSystem, tools: [], protocol: selected.protocol }) } }
    const history: ConversationMessage[] = [old, previous, { kind: 'user', content: 'Unrelated small question' }]
    const systemMessage = await project(system, history), config = options(), prepared = vi.fn(), fetch = vi.fn(async () => response('Done'))
    config.resolveModel = async () => selected; config.providerFetch = fetch; config.onRequest = prepared
    expect(systemMessage).toEqual(system)
    expect(conversationContextTokens({ messages: history, systemMessage: firstSystem, tools: [], modelContextKey: modelContextKey(selected), protocol: selected.protocol })).toBeGreaterThan(4000)
    expect(conversationContextTokens({ messages: history, systemMessage, tools: [], modelContextKey: modelContextKey(selected), protocol: selected.protocol })).toBeLessThan(4000)
    const result = await invokeConversationWithCompression(selected, { ...context(history), systemMessage }, config)
    expect(result.summary).toBeUndefined(); expect(fetch).toHaveBeenCalledOnce()
    expect(config.compressionTracking.onCompressionStart).not.toHaveBeenCalled()
    expect(prepared.mock.lastCall![1].messages).toEqual(history)
  })

  it('reports repeated compression using effective history and request instructions', async () => {
    const selected = { ...model, maxContextTokens: 21000, contextCompressionThreshold: 600 / 20000 }, config = options(), prepared = vi.fn()
    const systemMessage: ConversationMessage = { kind: 'system', content: 'Required instructions '.repeat(20) }
    const history: ConversationMessage[] = [{ id: 'old', kind: 'user', content: 'Old source ' + 'x'.repeat(24000) },
      { id: 'answer', kind: 'assistant', content: 'Old answer' }, { id: 'current', kind: 'user', content: 'Continue first task' }]
    let summaries = 0
    config.compressionTracking.onCompressionStart = vi.fn(() => `summary-${++summaries}`)
    config.resolveModel = async () => selected; config.onRequest = prepared
    config.providerFetch = async (_url, init) => response(JSON.parse(String(init?.body)).messages.length === 1 ? `${summaries === 1 ? 'First' : 'Second'} summary` : 'Done')
    const first = await invokeConversationWithCompression(selected, { ...context(history), systemMessage }, config)
    const summary: ConversationMessage = { kind: 'user', content: first.summary!.modelContent, context: { summary: true, summaryId: first.summary!.id } }
    const next: ConversationMessage[] = [first.message, { id: 'next', kind: 'user', content: 'Second source ' + 'y'.repeat(3000) },
      { id: 'next-answer', kind: 'assistant', content: 'Second source answer' }, { id: 'last', kind: 'user', content: 'Continue again' }]
    const effective = [summary, ...history.slice(first.summary!.cutoffIndex), ...next]
    await invokeConversationWithCompression(selected, { ...context([...history, ...next]), systemMessage, summary: { cutoffIndex: first.summary!.cutoffIndex, message: summary } }, config)
    expect(config.compressionTracking.onCompressionCompleted).toHaveBeenCalledTimes(2)
    expect(vi.mocked(config.compressionTracking.onCompressionCompleted!).mock.calls[1][2]).toMatchObject({
      inputTokensBefore: countConversationTokens([systemMessage, ...effective], [], { protocol: selected.protocol }),
      inputTokensAfter: countConversationTokens([systemMessage, ...prepared.mock.lastCall![1].messages], [], { protocol: selected.protocol })
    })
  })

  it.each([2000, 1000])('compacts the final tool transaction at the actual %s-token guard and saves its complete content', async capacity => {
    const directory = await mkdtemp(join(tmpdir(), 'anas-native-compression-'))
    try {
      const latest = toolTransaction('large-result', 'TOOL_RESULT '.repeat(2000))
      const history: ConversationMessage[] = [{ id: 'old', kind: 'user', content: 'Earlier question' }, { id: 'answer', kind: 'assistant', content: 'Earlier answer' },
        { id: 'current', kind: 'user', content: 'Do the task' }, ...latest]
      const before = structuredClone(history), selected = { ...model, maxContextTokens: capacity + 1000, contextCompressionThreshold: 0.5 }, config = options(), prepared = vi.fn()
      config.resolveModel = async () => selected; config.onRequest = prepared
      config.saveToolResult = vi.fn(content => saveToolResultFile(content, directory))
      config.providerFetch = async () => response('Condensed history')
      const result = await invokeConversationWithCompression(selected, context(history), config)
      const sent = prepared.mock.lastCall![1].messages as ConversationMessage[]
      expect(prepared).toHaveBeenCalledOnce()
      expect(sent.at(-2)).toEqual(latest[0]); expect(sent.at(-1)?.id).toBe(latest[1].id)
      expect(sent.at(-1)?.content).toContain('Tool result compacted')
      const reference = String(sent.at(-1)!.content).match(/Full result \(\d+ characters\): ("(?:\\.|[^"\\])*")/)!
      expect(await readFile(JSON.parse(reference[1]), 'utf8')).toBe(latest[1].content)
      expect(config.saveToolResult).toHaveBeenCalledOnce()
      expect(result.summary?.inputTokensAfter).toBe(countConversationTokens([context().systemMessage, ...sent], [], { protocol: selected.protocol }))
      expect(result.summary?.cutoffIndex).toBe(3)
      expect(history).toEqual(before)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('preserves complete coding evidence and the supplied continuation handoff', async () => {
    const evidence = 'Goal: fix parser. Preserve README user edits. Changed src/parser.ts. npm test FAILED: missing token. Build NOT RUN. Next: regression test. call-7 UNKNOWN; recheck it.'
    const current: ConversationMessage = { id: 'current', kind: 'user', content: 'Continue without changing README.md' }
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Fix parser; README.md has my changes' },
      ...toolTransaction('tests', 'npm test FAILED: missing token\n' + 'diagnostic detail '.repeat(350)),
      { kind: 'assistant', content: 'Changed src/parser.ts. Build NOT RUN. Next: regression test. Background call call-7 is UNKNOWN.' }, current]
    const selected = { ...model, maxContextTokens: 13000, contextCompressionThreshold: 100 / 12000 }, config = options(), prompts = observeSummaryPrompts(), prepared = vi.fn()
    config.resolveModel = async () => selected; config.codingMode = true; config.onRequest = prepared; config.providerFetch = async () => response(evidence)
    const result = await invokeConversationWithCompression(selected, context(history), config)
    for (const text of ['Coding continuation handoff', 'README.md has my changes', 'npm test FAILED', 'Build NOT RUN', 'call-7 is UNKNOWN']) expect(prompts[0]).toContain(text)
    expect(prepared.mock.lastCall![1].messages.at(-1)).toEqual(current)
    expect(result.summary?.summaryText).toBe(evidence)
    expect(config.compressionTracking.onCompressionCompleted).toHaveBeenCalledWith('summary', evidence, expect.anything())
  })

  it('tracks summary and main requests separately while preserving the selected model, language and current turn', async () => {
    const selected = { ...model, maxContextTokens: 5000, contextCompressionThreshold: 0.005 }, config = options(), prompts = observeSummaryPrompts(), prepared = vi.fn(), requests: Record<string, unknown>[] = []
    const current: ConversationMessage = { id: 'current', kind: 'user', content: 'CURRENT_USER_TURN' }
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Old question ' + 'x'.repeat(1000) }, { kind: 'assistant', content: 'Old answer ' + 'y'.repeat(1000) }, current]
    config.resolveModel = async () => selected; config.outputLanguage = { code: 'zh-CN', name: '简体中文' }; config.onRequest = prepared
    config.providerFetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); expect(config.compressionTracking.onCompressionCompleted).not.toHaveBeenCalled(); return response(requests.length === 1 ? 'Condensed history' : 'Main response') }
    const result = await invokeConversationWithCompression(selected, context(history), config)
    expect(requests.map(request => request.model)).toEqual([selected.model, selected.model])
    expect(prompts[0]).toContain('use the configured default language:\n简体中文 (zh-CN)')
    expect(prepared.mock.lastCall![1].messages).toEqual([expect.objectContaining({ context: { summary: true, summaryId: 'summary' } }), current])
    expect(result.text).toBe('Main response'); expect(result.summary?.cutoffIndex).toBe(2)
    expect(config.compressionTracking.onCompressionStart).toHaveBeenCalledOnce()
    expect(config.compressionTracking.onCompressionCompleted).toHaveBeenCalledOnce()
    expect(config.compressionTracking.onCompressionFailed).not.toHaveBeenCalled()
  })

  it('compresses replayed Responses reasoning even when the visible answer is small', async () => {
    const selected = { ...model, protocol: 'openai_responses' as const, maxContextTokens: 11000, contextCompressionThreshold: 0.02 }, config = options(), prepared = vi.fn()
    const current: ConversationMessage = { kind: 'user', content: 'Current question' }
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Earlier question' }, { kind: 'assistant', content: 'Short visible answer',
      source: { extras: {}, metadata: { output: [{ id: 'rs_large', type: 'reasoning', encrypted_content: 'x'.repeat(4000), summary: [] }] } } }, current]
    config.resolveModel = async () => selected; config.onRequest = prepared
    const fetch = vi.fn(async () => Response.json({ id: 'resp', object: 'response', created_at: 1, model: selected.model, status: 'completed',
      output: [{ type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Condensed Responses history', annotations: [] }] }],
      usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } }))
    config.providerFetch = fetch
    const result = await invokeConversationWithCompression(selected, context(history), config)
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result.summary?.cutoffIndex).toBe(2)
    expect(prepared.mock.lastCall![1].messages).toEqual([expect.objectContaining({ context: { summary: true, summaryId: 'summary' } }), current])
  })

  it.each(['server-total', 'new-input'] as const)('uses calibrated usage to trigger automatic compression (%s)', async kind => {
    const added = kind === 'new-input', selected = { ...model, maxContextTokens: 5000, contextCompressionThreshold: 0.05 }, config = options(), prepared = vi.fn()
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Earlier question ' + 'x'.repeat(added ? 1000 : 120) },
      { kind: 'assistant', content: 'Earlier answer ' + 'y'.repeat(added ? 1000 : 120), usage: { input_tokens: added ? 80 : 250, output_tokens: added ? 20 : 50, total_tokens: added ? 100 : 300 } },
      { kind: 'user', content: 'Current question ' + 'z'.repeat(added ? 800 : 0) }]
    history[1].context = { modelContextKey: modelContextKey(selected), requestKey: conversationRequestKey({ messages: history.slice(0, 1), systemMessage: context().systemMessage, tools: [], protocol: selected.protocol }) }
    const local = countConversationTokens(history, [], { protocol: selected.protocol })
    if (added) expect(local).toBeGreaterThan(200); else expect(local).toBeLessThan(200)
    config.resolveModel = async () => selected; config.onRequest = prepared; config.providerFetch = async () => response('Condensed history')
    const result = await invokeConversationWithCompression(selected, context(history), config)
    expect(result.summary).toBeDefined()
    expect(prepared.mock.lastCall![1].messages).toEqual([expect.objectContaining({ context: { summary: true, summaryId: 'summary' } }), history[2]])
    expect(config.compressionTracking.onCompressionCompleted).toHaveBeenCalledOnce()
  })

  it('carries the active user request into the summary when only the newest tool transaction fits', async () => {
    const active: ConversationMessage = { id: 'active', kind: 'user', content: 'Finish the active investigation without changing its scope.' }
    const older = toolTransaction('old-call', 'older active result '.repeat(300)), newest = toolTransaction('new-call', 'newest active result '.repeat(40))
    const threshold = (countConversationTokens(newest, [], { protocol: model.protocol }) + 1) * 4
    const selected = { ...model, maxContextTokens: 11000, contextCompressionThreshold: threshold / 10000 }, config = options(), prepared = vi.fn()
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Earlier question ' + 'x'.repeat(1000) }, { kind: 'assistant', content: 'Earlier answer ' + 'y'.repeat(1000) }, active, ...older, ...newest]
    config.resolveModel = async () => selected; config.onRequest = prepared; config.providerFetch = async () => response('Condensed active work')
    const result = await invokeConversationWithCompression(selected, context(history), config)
    const text = ['Condensed active work', '<active_user_request>', active.content, '</active_user_request>'].join('\n\n')
    expect(config.compressionTracking.onCompressionCompleted).toHaveBeenCalledWith('summary', text, expect.objectContaining({ cutoffIndex: history.indexOf(newest[0]), firstPreservedMessageId: newest[0].id }))
    expect(result.summary?.summaryText).toBe(text)
    expect(prepared.mock.lastCall![1].messages).toEqual([expect.objectContaining({ content: expect.stringContaining(String(active.content)) }), ...newest])
  })

  it('fails without dropping an oversized latest user message or publishing a summary', async () => {
    const current: ConversationMessage = { id: 'oversized-user', kind: 'user', content: 'Oversized final user input '.repeat(1000) }
    const history: ConversationMessage[] = [{ kind: 'user', content: 'Old question ' + 'x'.repeat(400) }, { kind: 'assistant', content: 'Old answer ' + 'y'.repeat(400) }, current]
    const before = structuredClone(history), selected = { ...model, maxContextTokens: 2000, contextCompressionThreshold: 0.2 }, config = options(), fetch = vi.fn(async () => response('Condensed history'))
    config.resolveModel = async () => selected; config.providerFetch = fetch
    await expect(invokeConversationWithCompression(selected, context(history), config)).rejects.toThrow('latest complete conversation unit still exceeds')
    expect(fetch).toHaveBeenCalledOnce()
    expect(config.compressionTracking.onCompressionCompleted).not.toHaveBeenCalled()
    expect(config.compressionTracking.onCompressionFailed).toHaveBeenCalledWith('summary')
    expect(history).toEqual(before)
  })

  it('discards a provisional summary when settings change before the next request', async () => {
    let selected = model
    const config = options(), fetch = vi.fn(async () => { selected = { ...model, model: 'changed' }; return response('Summary') })
    config.resolveModel = async () => selected
    config.providerFetch = fetch
    await expect(invokeConversationWithCompression(model, context(), config)).rejects.toBeInstanceOf(ModelRequestChangedError)
    expect(fetch).toHaveBeenCalledOnce()
    expect(config.compressionTracking.onCompressionFailed).toHaveBeenCalledWith('summary')
    expect(config.compressionTracking.onCompressionCompleted).not.toHaveBeenCalled()
  })

  it('does not hide a final model failure or a failed full-result save behind a summary', async () => {
    const config = options()
    let requests = 0
    config.providerFetch = async () => ++requests === 1 ? response('Summary') : Response.json({ error: { message: 'bad request' } }, { status: 400 })
    await expect(invokeConversationWithCompression(model, context(), config)).rejects.toMatchObject({ status: 400 })
    expect(config.compressionTracking.onCompressionFailed).toHaveBeenCalledWith('summary')
    const history = messages()
    history.push({ kind: 'assistant', id: 'call-message', content: '', calls: [{ id: 'call', name: 'read', args: {} }] },
      { kind: 'tool', id: 'result', resultFor: 'call', content: 'result '.repeat(12000) })
    const failure = new Error('result archive unavailable'), failedSave = options()
    failedSave.providerFetch = async () => response('Summary')
    failedSave.saveToolResult = async () => { throw failure }
    await expect(invokeConversationWithCompression(model, context(history), failedSave)).rejects.toBe(failure)
    expect(failedSave.compressionTracking.onCompressionFailed).toHaveBeenCalledWith('summary')
  })
})
