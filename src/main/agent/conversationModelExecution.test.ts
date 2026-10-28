import Database from 'better-sqlite3'
import { AgentStorage } from './agentStorage'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedModelConfig } from '@shared/types'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import type { RunObserver } from '../../runtime/runExecution'
import { createConversationModelPreparation, type ConversationModelExecutionOptions } from './conversationModelExecution'
import { NativeExecutionStore, nativeExecutionSchema, type NativeExecutionCommit } from './nativeExecutionStore'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn() }))
vi.mock('../gitChanges', () => ({ queryGitChanges: vi.fn() }))

const databases: Database.Database[] = [], roots: string[] = []
afterEach(async () => { for (const db of databases.splice(0)) db.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const model: ResolvedModelConfig = { id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol: 'openai_chat_completions',
  baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
  contextCompressionThreshold: 0.8, contextCompressionEnabled: true }
const request = () => ({ threadId: 'thread', runId: 'run', signal: new AbortController().signal })
function response(message: Record<string, unknown> = { content: 'done' }) {
  return Response.json({ id: 'repeated-provider-id', object: 'chat.completion', model: 'fixture', created: 1,
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
}
function fixture(onCommit?: (commit: NativeExecutionCommit) => void, suppliedStore?: NativeExecutionStore) {
  let store = suppliedStore
  if (!store) {
    const db = new Database(':memory:'); databases.push(db); db.pragma('foreign_keys=ON'); db.exec(nativeExecutionSchema)
    store = new NativeExecutionStore(db, onCommit)
  }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response())
  const options: ConversationModelExecutionOptions = { store, resolveModel: vi.fn(async () => model), systemPrompt: () => 'Instructions',
    tools: () => [], requiresTools: () => false, maxModelCalls: 0, providerFetch: fetch, outputLanguage: { code: 'en', name: 'English' },
    compressionTracking: {}, saveToolResult: vi.fn(async () => { throw new Error('Unexpected overflow') }) }
  const observer: RunObserver = { started: vi.fn(), startModel: vi.fn(() => 'observation'), discardModel: vi.fn(),
    model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
  const begin = (messages: ConversationMessage[] = [{ id: 'user', kind: 'user', content: 'task' }], count = 0) => {
    store.start({ threadId: 'thread', runId: 'run', context: { modelCalls: count, threadModelCalls: 7, todos: [] },
      messages: messages.map(value => ({ id: value.id!, value })) })
  }
  const services = (): ConversationExecutionServices => ({ store, enter: async () => {}, prepareModel: createConversationModelPreparation(options),
    afterModel: async () => ({ kind: 'complete' }), prepareTools: async () => { throw new Error('Unexpected tool batch') },
    executeTool: async () => { throw new Error('Unexpected tool invocation') }, directions: async () => [], drain: async () => {},
    retry: { maxRetries: 1, initialDelayMs: 0 } })
  return { store, options, observer, fetch, begin, services }
}

describe('native model preparation in the durable conversation loop', () => {
  it('commits a frozen rule snapshot before the SDK sees the request', async () => {
    await mkdir(join(process.cwd(), 'tmp'), { recursive: true })
    const root = await mkdtemp(join(process.cwd(), 'tmp', 'native-model-assembly-')); roots.push(root)
    await writeFile(join(root, '.git'), 'fixture')
    await writeFile(join(root, 'AGENTS.md'), 'Original rule')
    const h = fixture(), bodies: string[] = []
    h.options.rules = { runId: 'run', primaryFolder: root, folders: [root], accessMode: () => 'full_access' }
    h.fetch.mockImplementation(async (_url, init) => {
      expect(h.store.load('thread')!.context.rulePreparation?.initialized).toBe(true)
      bodies.push(String(init?.body)); return response()
    })
    h.begin()
    const prepare = createConversationModelPreparation(h.options), state = h.store.load('thread')!
    const step = await prepare(state, request(), h.observer)
    if (step.kind !== 'context') throw new Error('Expected durable context preparation')
    expect(h.fetch).not.toHaveBeenCalled()
    h.store.prepareContext({ ...request(), expectedRevisionId: state.revisionId }, step.context)
    await writeFile(join(root, 'AGENTS.md'), 'Changed after snapshot')
    expect((await conversationExecution(h.services()).execute('continue', request(), h.observer)).result.status).toBe('fulfilled')
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toContain('Original rule')
    expect(bodies[0]).not.toContain('Changed after snapshot')
    expect(h.store.load('thread')!.messages.at(-1)!.value.context?.projectRulesReceipt).toMatchObject({ runId: 'run' })
  })

  it.each([0, 1])('uses durable counters with limit %i, retaining zero as unlimited', async limit => {
    const h = fixture(); h.options.maxModelCalls = limit; h.begin(undefined, 1)
    const result = await conversationExecution(h.services()).execute('continue', request(), h.observer)
    expect(result.result.status).toBe(limit ? 'rejected' : 'fulfilled')
    expect(h.fetch).toHaveBeenCalledTimes(limit ? 0 : 1)
    expect(h.store.load('thread')!.context).toMatchObject({ modelCalls: limit ? 1 : 2, threadModelCalls: limit ? 7 : 8 })
  })

  it('reprepares after configuration changes and does not discard the completed response when an observer fails', async () => {
    const h = fixture(); let selected = model, changed = false
    h.options.resolveModel = async () => selected
    h.options.memory = async system => {
      if (!changed) { changed = true; selected = { ...model, model: 'replacement' } }
      return system
    }
    h.observer.model = vi.fn(() => { throw new Error('display failed') })
    h.begin()
    const result = await conversationExecution(h.services()).execute('continue', request(), h.observer)
    expect(result.result.status).toBe('fulfilled')
    expect(result.observationErrors).toHaveLength(1)
    expect(h.fetch).toHaveBeenCalledOnce()
    expect(JSON.parse(String(h.fetch.mock.calls[0][1]?.body)).model).toBe('replacement')
    const state = h.store.load('thread')!
    expect(state.context).toMatchObject({ modelCalls: 1, threadModelCalls: 8 })
    expect(state.messages).toHaveLength(2)
    expect(state.messages[1].id).not.toBe('repeated-provider-id')
    expect(state.messages[1].value.source?.metadata.id).toBe('repeated-provider-id')
  })

  it('keeps simple-chat tool history out of the request without deleting the original conversation', async () => {
    const h = fixture(); h.options.simpleChat = true
    h.options.tools = () => [{ name: 'read_file', description: 'Read', parameters: { type: 'object', properties: {} } }]
    const original: ConversationMessage[] = [{ id: 'user', kind: 'user', content: 'task' },
      { id: 'call', kind: 'assistant', content: 'Visible answer', calls: [{ id: 'provider-call', name: 'read_file', args: { path: 'file' } }] },
      { id: 'result', kind: 'tool', resultFor: 'provider-call', content: 'Internal tool result' },
      { id: 'next', kind: 'user', content: 'Continue' }]
    h.begin(original)
    expect((await conversationExecution(h.services()).execute('continue', request(), h.observer)).result.status).toBe('fulfilled')
    const body = JSON.parse(String(h.fetch.mock.calls[0][1]?.body))
    expect(body.tools ?? []).toEqual([])
    expect(JSON.stringify(body)).not.toContain('Internal tool result')
    expect(JSON.stringify(body)).toContain('Visible answer')
    expect(h.store.load('thread')!.messages.slice(0, 4).map(message => message.value)).toEqual(original)
  })

  it('commits a manual summary through the same entry without preparing a normal model call', async () => {
    const h = fixture(), compress = vi.fn(async () => ({ summaryText: 'Summary', modelContent: 'Summary context', cutoffIndex: 2,
      activatedAfterMessageIndex: 1, coveredThroughMessageId: 'answer', inputTokensBefore: 20, inputTokensAfter: 5 }))
    h.options.manualCompression = { compress }
    h.options.compressionTracking = { onCompressionStart: () => 'summary', onCompressionCompleted: vi.fn() }
    h.begin([{ id: 'user', kind: 'user', content: 'task' }, { id: 'answer', kind: 'assistant', content: 'answer' }])
    expect((await conversationExecution(h.services()).execute('continue', request(), h.observer)).result.status).toBe('fulfilled')
    const state = h.store.load('thread')!
    expect(state.phase).toBe('completed')
    expect(state.context).toMatchObject({ modelCalls: 0, summary: { id: 'summary', cutoffIndex: 2 } })
    expect(state.messages).toHaveLength(2)
    expect(compress).toHaveBeenCalledOnce()
    expect(h.options.resolveModel).not.toHaveBeenCalled()
    expect(h.fetch).not.toHaveBeenCalled()
  })

  it('does not commit or execute malformed provider tool arguments', async () => {
    const h = fixture(); h.fetch.mockImplementation(async () => response({ content: '',
      tool_calls: [{ type: 'function', id: 'bad-call', function: { name: 'write_file', arguments: '{bad json' } }] }))
    h.begin()
    const result = await conversationExecution(h.services()).execute('continue', request(), h.observer)
    expect(result.result.status).toBe('rejected')
    if (result.result.status === 'rejected') expect(result.result.reason.message).toBe('Model returned an invalid tool call.')
    expect(h.store.load('thread')!.messages).toHaveLength(1)
    expect(h.store.load('thread')!.context.modelCalls).toBe(0)
    expect(h.fetch).toHaveBeenCalledOnce()
  })

  it.each([false, true])('projects argument counts without executing partial calls and clears progress (failure=%s)', async fail => {
    const h = fixture(); h.options.streaming = true
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const frame = (delta: Record<string, unknown>, finish_reason: string | null = null) => new TextEncoder().encode(
      `data: ${JSON.stringify({ id: 'stream', object: 'chat.completion.chunk', model: 'fixture', created: 1, choices: [{ index: 0, delta, finish_reason }] })}\n\n`)
    h.fetch.mockImplementation(async () => new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(frame({ role: 'assistant', content: 'Hello', tool_calls: [{ index: 0, id: 'provider-call', type: 'function', function: { name: 'read', arguments: '{"path":' } }] }))
        await gate
        if (fail) { controller.error(new Error('Provider disconnected')); return }
        controller.enqueue(frame({ content: ' world', tool_calls: [{ index: 0, function: { arguments: '"file"}' } }] }))
        controller.enqueue(frame({}, 'tool_calls'))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); controller.close()
      }
    }), { headers: { 'content-type': 'text/event-stream' } }))
    h.begin()
    const prepared = await createConversationModelPreparation(h.options)(h.store.load('thread')!, request(), h.observer)
    if (prepared.kind !== 'model') throw new Error('Expected model')
    const invoking = prepared.invoke().then(result => ({ result }), error => ({ error }))
    try {
      await vi.waitFor(() => expect(h.observer.model).toHaveBeenCalledWith(expect.objectContaining({
        kind: 'tool_input', progress: [expect.objectContaining({ characterCount: '{"path":'.length, complete: false })]
      })))
      expect(h.store.load('thread')!.calls).toEqual([])
      expect(h.store.load('thread')!.context.modelCalls).toBe(0)
      expect(h.observer.model).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'completed' }))
    } finally { release() }
    const outcome = await invoking
    expect(h.observer.model).toHaveBeenCalledWith(expect.objectContaining({ kind: 'delta', channel: 'text', text: 'Hello' }))
    if (fail) {
      expect(outcome).toMatchObject({ error: expect.any(Error) })
      expect(h.observer.model).toHaveBeenCalledWith(expect.objectContaining({ kind: 'incomplete' }))
      expect(h.observer.model).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 'completed' }))
    } else {
      if (!('result' in outcome)) throw outcome.error
      expect(outcome.result.calls).toEqual([expect.objectContaining({ providerCallId: 'provider-call', name: 'read', args: { path: 'file' } })])
      expect(h.observer.model).toHaveBeenCalledWith(expect.objectContaining({ kind: 'completed', streamedText: 'Hello world', calls: [expect.objectContaining({ id: outcome.result.calls[0].id })] }))
    }
    for (const [event] of vi.mocked(h.observer.model).mock.calls) if (event.kind === 'tool_input') {
      for (const progress of event.progress) { expect(progress).not.toHaveProperty('text'); expect(progress).not.toHaveProperty('args') }
    }
    expect(h.observer.model).toHaveBeenLastCalledWith(expect.objectContaining({ kind: 'tool_input', progress: [] }))
    expect(h.store.load('thread')!.calls).toEqual([])
    expect(h.store.load('thread')!.context.modelCalls).toBe(0)
  })

  it('acknowledges terminal background reads from full history even when the request uses a summary', async () => {
    const h = fixture(), id = '11111111-1111-4111-8111-111111111111'; let unresolved = true
    const resolve = vi.fn(() => { unresolved = false })
    h.options.supervision = { managed: { resolve, unresolved: () => unresolved
      ? [{ id, kind: 'mcp', status: 'completed', summary: 'remote' }] : [] } }
    h.begin([{ id: 'call', kind: 'assistant', content: '', calls: [{ id: 'read', name: 'read_call', args: { call_id: id } }] },
      { id: 'result', kind: 'tool', name: 'read_call', resultFor: 'read', content: JSON.stringify({ ok: true, terminal: true, call_id: id, status: 'completed', output_chars_total: 0 }) },
      { id: 'user', kind: 'user', content: 'Continue' }])
    h.store.commitSummary({ ...request(), expectedRevisionId: h.store.load('thread')!.revisionId }, { id: 'summary', summaryText: 'Earlier work',
      modelContent: 'Summary of earlier work', cutoffIndex: 2, activatedAfterMessageIndex: 1, coveredThroughMessageId: 'result',
      firstPreservedMessageId: 'user', inputTokensBefore: 40, inputTokensAfter: 10 })
    expect((await conversationExecution(h.services()).execute('continue', request(), h.observer)).result.status).toBe('fulfilled')
    expect(resolve).toHaveBeenCalledWith(id)
    expect(resolve).toHaveBeenCalledOnce()
    const body = String(h.fetch.mock.calls[0][1]?.body)
    expect(body).toContain('Summary of earlier work')
    expect(body).not.toContain('<background_call_supervision>')
    expect(body).not.toContain(id)
    expect(h.store.load('thread')!.messages[1].value.content).toContain(id)
  })
})

describe('native model budgets for consecutive user turns', () => {
  it.each([0, 1])('starts a fresh per-run budget and preserves the conversation count with limit %i', async limit => {
    await mkdir(join(process.cwd(), 'tmp'), { recursive: true })
    const root = await mkdtemp(join(process.cwd(), 'tmp', 'native-turn-budget-')); roots.push(root)
    let storage = AgentStorage.openNative(root)
    const threadId = storage.createThread().id
    try {
      for (let turn = 1; turn <= 3; turn++) {
        const product = storage.conversationForThread(threadId), owner = product.execution, h = fixture(undefined, owner.store)
        const runId = 'turn-' + turn, input = { id: runId + ':input', value: { id: runId + ':input', kind: 'user' as const, content: 'Turn ' + turn, context: { runId } } }
        product.runs.createRun({ threadId, runId, operation: 'agent', message: input })
        h.options.maxModelCalls = limit
        h.fetch.mockImplementation(async () => {
          const context = owner.store.load(threadId)!.context
          expect(context.modelCalls).toBe(0)
          expect(context.threadModelCalls ?? 0).toBe(turn - 1)
          return response()
        })
        const services = { ...h.services(), enter: owner.enter, directions: owner.directions }
        const result = await conversationExecution(services).execute('input', { threadId, runId, signal: new AbortController().signal }, h.observer)
        if (result.result.status === 'rejected') throw result.result.reason
        expect(h.fetch).toHaveBeenCalledOnce()
        expect(owner.store.load(threadId)).toMatchObject({ phase: 'completed', context: { modelCalls: 1, threadModelCalls: turn } })
        expect(owner.store.load(threadId)!.messages).toHaveLength(turn * 2)
        storage.close(); storage = AgentStorage.openNative(root)
      }
    } finally { storage.close() }
  })
})
