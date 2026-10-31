import Database from 'better-sqlite3'
import { AgentStorage } from './agentStorage'
import { createConversationContextRuntime } from './conversationContextRuntime'
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
function response(message: Record<string, unknown> = { content: 'done' }, finishReason = 'stop') {
  return Response.json({ id: 'repeated-provider-id', object: 'chat.completion', model: 'fixture', created: 1,
    choices: [{ index: 0, finish_reason: finishReason, message: { role: 'assistant', ...message } }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
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
    expect(h.fetch).toHaveBeenCalledTimes(2)
    expect(h.store.load('thread')!.context.modelRecovery?.attempts).toBe(1)
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


it('corrects malformed calls without discarding prior completed tool results', async () => {
  const h = fixture()
  const memory = vi.fn(async (system: ConversationMessage, _messages: readonly ConversationMessage[]) => system)
  h.options.memory = memory
  const history: ConversationMessage[] = [{ id: 'user', kind: 'user', content: 'task' },
    { id: 'call', kind: 'assistant', content: '', calls: [{ id: 'prior', name: 'read_file', args: { path: 'file' } }] },
    { id: 'result', kind: 'tool', resultFor: 'prior', content: 'retained tool output', resultStatus: 'success' }]
  h.begin(history)
  h.fetch.mockResolvedValueOnce(response({ content: '', tool_calls: [
    { type: 'function', id: 'bad', function: { name: 'write_file', arguments: '{' } }
  ] })).mockResolvedValueOnce(response())
  const services = h.services(); services.recoveryLog = vi.fn()
  expect((await conversationExecution(services).execute('continue', request(), h.observer)).result.status).toBe('fulfilled')
  expect(vi.mocked(services.recoveryLog).mock.calls.map(([event]) => event.event)).toEqual(['scheduled', 'attempt_started', 'response_accepted'])
  expect(services.recoveryLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'scheduled', threadId: 'thread', runId: 'run',
    recovery: expect.objectContaining({ attempts: 1, reason: 'invalid_tool_call' }), error: expect.any(Error) }))
  expect(services.recoveryLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'response_accepted', outcome: 'recovered' }))
  const body = JSON.parse(String(h.fetch.mock.calls[1][1]?.body))
  expect(JSON.stringify(body)).toContain('Application recovery notice')
  expect(JSON.stringify(body)).toContain('invalid tool call')
  expect(JSON.stringify(body)).toContain('retained tool output')
  expect(h.store.load('thread')!.messages.slice(0, 3).map(record => record.value)).toEqual(history)
  expect(h.store.load('thread')!.messages).toHaveLength(4)
  expect(h.store.load('thread')!.context.modelRecovery).toBeUndefined()
  expect(memory.mock.calls.map(call => call[1].filter(message => message.kind === 'user').map(message => message.content))).toEqual([['task'], ['task']])
})

it('shares two retries across server errors and malformed tool output', async () => {
  const h = fixture(); h.begin()
  h.fetch.mockResolvedValueOnce(Response.json({ error: { message: 'Unavailable' } }, { status: 503 }))
    .mockResolvedValueOnce(response({ tool_calls: [{ type: 'function', id: 'bad', function: { name: 'write_file', arguments: '{' } }] }))
    .mockResolvedValueOnce(Response.json({ error: { message: 'Unavailable' } }, { status: 503 }))
  const services = h.services(); services.retry = { initialDelayMs: 0, maxRetries: 2 }; services.recoveryLog = vi.fn()
  expect((await conversationExecution(services).execute('continue', request(), h.observer)).result.status).toBe('rejected')
  expect(h.fetch).toHaveBeenCalledTimes(3)
  expect(h.store.load('thread')!.context.modelRecovery?.attempts).toBe(2)
  expect(services.recoveryLog).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'exhausted',
    recovery: expect.objectContaining({ attempts: 2 }), maxRetries: 2, error: expect.any(Error) }))
  expect(h.store.load('thread')!.messages).toHaveLength(1)
  expect(JSON.stringify(JSON.parse(String(h.fetch.mock.calls[2][1]?.body)))).toContain('invalid tool call')
})

it('retries an unterminated stream without accepting its partial calls', async () => {
  const h = fixture(); h.begin(); h.options.streaming = true
  const chunk = (delta: unknown, finish_reason: string | null = null) => `data: ${JSON.stringify({
    id: 'stream', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }]
  })}\n\n`
  const stream = (text: string) => new Response(text, { headers: { 'content-type': 'text/event-stream' } })
  h.fetch.mockResolvedValueOnce(stream(chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'bad', type: 'function', function: { name: 'write_file', arguments: '{' } }] })))
    .mockResolvedValueOnce(stream(chunk({ role: 'assistant', content: 'Recovered' }) + chunk({}, 'stop') + 'data: [DONE]\n\n'))
  expect((await conversationExecution(h.services()).execute('continue', request(), h.observer)).result.status).toBe('fulfilled')
  expect(h.fetch).toHaveBeenCalledTimes(2)
  expect(h.store.load('thread')!.messages).toHaveLength(2)
  expect(h.store.load('thread')!.calls).toEqual([])
})

it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
  'continues length-limited text for %s while keeping the original prefix once', async protocol => {
    const h = fixture(); h.begin(); h.options.resolveModel = async () => ({ ...model, protocol })
    let count = 0
    h.fetch.mockImplementation(async () => {
      const limited = ++count === 1, text = limited ? 'Saved prefix.' : 'Remaining answer.'
      if (protocol === 'openai_chat_completions') return response({ content: text }, limited ? 'length' : 'stop')
      if (protocol === 'anthropic_messages') return Response.json({ id: `m${count}`, type: 'message', role: 'assistant', model: 'fixture',
        content: [{ type: 'text', text }], stop_reason: limited ? 'max_tokens' : 'end_turn', stop_sequence: null,
        usage: { input_tokens: 10, output_tokens: 2 } })
      return Response.json({ id: `r${count}`, object: 'response', created_at: 1, model: 'fixture', status: limited ? 'incomplete' : 'completed',
        incomplete_details: limited ? { reason: 'max_output_tokens' } : null, output: [{ id: `m${count}`, type: 'message', role: 'assistant',
          status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } })
    })
    expect((await conversationExecution(h.services()).execute('continue', request(), h.observer)).result.status).toBe('fulfilled')
    expect(h.fetch).toHaveBeenCalledTimes(2)
    const followup = String(h.fetch.mock.calls[1][1]?.body)
    expect(followup).toContain('Continue exactly where it ended')
    expect(followup.match(/Saved prefix\./g)).toHaveLength(1)
    const saved = h.store.load('thread')!
    expect(saved.messages.map(record => record.value.kind)).toEqual(['user', 'assistant', 'assistant'])
    expect(saved.context.modelRecovery).toBeUndefined()
  })

it('does not execute even syntactically complete tool calls in a length-limited response', async () => {
  const h = fixture(); h.begin()
  h.fetch.mockResolvedValueOnce(response({ content: '', tool_calls: [
    { type: 'function', id: 'call', function: { name: 'write_file', arguments: '{"path":"file","content":"partial"}' } }
  ] }, 'length')).mockResolvedValueOnce(response())
  expect((await conversationExecution(h.services()).execute('continue', request(), h.observer)).result.status).toBe('fulfilled')
  expect(String(h.fetch.mock.calls[1][1]?.body)).toContain('smaller tool batches')
  expect(h.store.load('thread')!.calls).toEqual([])
  expect(h.store.load('thread')!.messages).toHaveLength(2)
})

it('stops repeated text truncation and allows an explicit manual retry to continue the saved answer', async () => {
  const h = fixture(); h.begin()
  h.fetch.mockImplementation(async () => response({ content: 'Segment.' }, 'length'))
  const services = h.services(); services.retry = { initialDelayMs: 0, maxRetries: 2 }
  expect((await conversationExecution(services).execute('continue', request(), h.observer)).result.status).toBe('rejected')
  expect(h.fetch).toHaveBeenCalledTimes(3)
  const failed = h.store.load('thread')!
  expect(failed.messages).toHaveLength(4)
  expect(failed.context.modelRequestFailed).toBe(true)
  h.store.retryModel({ threadId: 'thread', runId: 'run', expectedRevisionId: failed.revisionId }, false)
  expect(h.store.load('thread')!.context.modelRecovery).toMatchObject({ attempts: 0, inFlight: false, feedback: 'text_continuation' })
  h.fetch.mockResolvedValue(response({ content: 'Finished.' }))
  expect((await conversationExecution(services).execute('continue', request(), h.observer)).result.status).toBe('fulfilled')
  expect(String(h.fetch.mock.lastCall![1]?.body)).toContain('Continue exactly where it ended')
  expect(h.store.load('thread')!.messages).toHaveLength(5)
})

it.each([1, 2])('retains a reserved retry across reopening the execution store (attempt %s)', async attempts => {
  const db = new Database(':memory:'); databases.push(db); db.exec(nativeExecutionSchema)
  const store = new NativeExecutionStore(db), h = fixture(undefined, store); h.begin()
  const state = store.load('thread')!
  store.prepareContext({ threadId: 'thread', runId: 'run', expectedRevisionId: state.revisionId }, { ...state.context,
    modelRecovery: { attempts, reason: 'incomplete', retryAt: 0, inFlight: true } })
  const resumed = fixture(undefined, new NativeExecutionStore(db)), services = resumed.services()
  services.retry = { initialDelayMs: 0, maxRetries: 2 }
  const result = await conversationExecution(services).execute('continue', request(), resumed.observer)
  expect(result.result.status).toBe(attempts === 2 ? 'rejected' : 'fulfilled')
  expect(resumed.fetch).toHaveBeenCalledTimes(attempts === 2 ? 0 : 1)
})

it('persists the retry deadline and cancels during Retry-After without another request', async () => {
  const h = fixture(); h.begin(); const controller = new AbortController()
  h.fetch.mockResolvedValue(Response.json({ error: { message: 'Busy' } }, { status: 429, headers: { 'retry-after': '30' } }))
  const services = h.services(); services.retry = { initialDelayMs: 0, maxRetries: 2 }
  const running = conversationExecution(services).execute('continue', { ...request(), signal: controller.signal }, h.observer)
  await vi.waitFor(() => expect(h.store.load('thread')!.context.modelRecovery?.attempts).toBe(1))
  expect(h.store.load('thread')!.context.modelRecovery!.retryAt - Date.now()).toBeGreaterThan(25_000)
  controller.abort()
  await running
  expect(h.fetch).toHaveBeenCalledOnce()
  expect(h.store.load('thread')!.phase).toBe('cancelled')
})


it('does not treat failure to persist a request boundary as a retryable model timeout', async () => {
  const h = fixture(); h.begin()
  const failure = new Error('database timeout while saving the request')
  const write = vi.spyOn(h.store, 'prepareContext').mockImplementation(() => { throw failure })
  const result = await conversationExecution(h.services()).execute('continue', request(), h.observer)
  expect(result.result).toEqual({ status: 'rejected', reason: failure })
  expect(write).toHaveBeenCalledOnce()
  expect(h.fetch).not.toHaveBeenCalled()
  expect(h.store.load('thread')!.context.modelRequestFailed).toBe(false)
})

it('does not turn an accepted answer into a recovering activity when later preparation fails', async () => {
  const h = fixture(); h.begin()
  h.fetch.mockResolvedValueOnce(response({ content: 'Saved prefix.' }, 'length'))
    .mockResolvedValueOnce(response({ content: 'Remaining answer.' }))
  const services = h.services(), prepare = services.prepareModel
  services.retry = { maxRetries: 2, initialDelayMs: 0 }
  services.prepareModel = vi.fn().mockImplementationOnce(prepare)
    .mockRejectedValueOnce(Object.assign(new Error('Preparation timed out'), { code: 'ETIMEDOUT' }))
    .mockImplementation(prepare)
  const result = await conversationExecution(services).execute('continue', request(), h.observer)
  expect(result.result.status).toBe('fulfilled')
  expect(h.fetch).toHaveBeenCalledTimes(2)
  expect(h.store.load('thread')!.messages.map(record => record.value.content)).toEqual(['task', 'Saved prefix.', 'Remaining answer.'])
  expect(vi.mocked(h.observer.model).mock.calls.filter(([event]) => event.kind === 'recovering')).toEqual([])
})

it('does not change recovery or discard a saved response when ordinary logging fails', async () => {
  const h = fixture(); h.begin()
  h.fetch.mockResolvedValueOnce(Response.json({ error: { message: 'Unavailable' } }, { status: 503 })).mockResolvedValueOnce(response())
  const services = h.services(); services.recoveryLog = vi.fn(() => { throw new Error('Log unavailable') })
  const result = await conversationExecution(services).execute('continue', request(), h.observer)
  expect(result.result.status).toBe('fulfilled')
  expect(result.observationErrors).toContainEqual(new Error('Log unavailable'))
  expect(h.fetch).toHaveBeenCalledTimes(2)
  expect(h.store.load('thread')!.phase).toBe('completed')
  expect(h.store.load('thread')!.messages).toHaveLength(2)
})

it.each(['server', 'text_continuation', 'observer_failure'] as const)('links the %s retry start to the new model activity', async reason => {
  const h = fixture(); h.begin()
  let sequence = 0
  h.observer.startModel = vi.fn(() => {
    if (reason === 'observer_failure') throw new Error('Display unavailable')
    return `activity-${++sequence}`
  })
  h.fetch.mockResolvedValueOnce(reason === 'text_continuation' ? response({ content: 'Prefix' }, 'length')
    : Response.json({ error: { message: 'Unavailable' } }, { status: 503 })).mockResolvedValueOnce(response())
  const services = h.services(); services.recoveryLog = vi.fn()
  expect((await conversationExecution(services).execute('continue', request(), h.observer)).result.status).toBe('fulfilled')
  const events = vi.mocked(services.recoveryLog).mock.calls.map(([event]) => event)
  const started = events.find(event => event.event === 'attempt_started')!
  const accepted = events.find(event => event.event === 'response_accepted')!
  expect(started.modelId).toBe(reason === 'observer_failure' ? 'run:unobserved-model:2' : 'activity-2')
  expect(accepted.modelId).toBe(started.modelId)
  expect(events.filter(event => event.event === 'attempt_started')).toHaveLength(1)
  expect(h.fetch).toHaveBeenCalledTimes(2)
})

function compressionFixture(manual = false, suppliedStore?: NativeExecutionStore) {
  const h = fixture(undefined, suppliedStore), selected = { ...model, maxContextTokens: 12000, maxOutputTokens: 1000, contextCompressionThreshold: 0.4 }
  h.options.resolveModel = async () => selected
  h.options.compressionTracking = { onCompressionStart: () => 'summary', onCompressionCompleted: vi.fn(), onCompressionFailed: vi.fn() }
  if (manual) h.options.manualCompression = createConversationContextRuntime({ retry: false, resolveModel: h.options.resolveModel,
    outputLanguage: h.options.outputLanguage, systemPrompt: () => 'Instructions', tools: () => [], providerFetch: h.fetch })
  const history: ConversationMessage[] = [{ id: 'old-user', kind: 'user', content: 'Original requirement '.repeat(1500) },
    { id: 'old-answer', kind: 'assistant', content: 'Previous answer' }, { id: 'user', kind: 'user', content: 'Continue task' }]
  if (!suppliedStore) h.begin(history)
  const services = h.services(); services.retry = { maxRetries: 2, initialDelayMs: 0 }; services.recoveryLog = vi.fn()
  return { ...h, services, history }
}

it.each([false, true])('limits failing compression to three requests and retains history (manual=%s)', async manual => {
  const h = compressionFixture(manual)
  h.fetch.mockImplementation(async () => Response.json({ error: { message: 'Unavailable' } }, { status: 503 }))
  expect((await conversationExecution(h.services).execute('continue', request(), h.observer)).result.status).toBe('rejected')
  expect(h.fetch).toHaveBeenCalledTimes(3)
  expect(h.store.load('thread')!.context.modelRecovery?.attempts).toBe(2)
  expect(h.store.load('thread')!.messages.map(message => message.value)).toEqual(h.history)
  expect(h.store.load('thread')!.context.summary).toBeUndefined()
  expect(h.options.compressionTracking.onCompressionCompleted).not.toHaveBeenCalled()
  expect(h.services.recoveryLog).toHaveBeenLastCalledWith(expect.objectContaining({ event: 'exhausted' }))
})

it('shares the recovery budget across failed compression and malformed final output', async () => {
  const h = compressionFixture()
  h.fetch.mockResolvedValueOnce(Response.json({ error: { message: 'Unavailable' } }, { status: 503 }))
    .mockResolvedValueOnce(response({ content: 'Summary' }))
    .mockResolvedValueOnce(response({ tool_calls: [{ type: 'function', id: 'bad', function: { name: 'write_file', arguments: '{' } }] }))
    .mockResolvedValueOnce(response({ content: 'Summary' }))
    .mockResolvedValueOnce(Response.json({ error: { message: 'Unavailable' } }, { status: 503 }))
  expect((await conversationExecution(h.services).execute('continue', request(), h.observer)).result.status).toBe('rejected')
  expect(h.fetch).toHaveBeenCalledTimes(5) // Three failed requests and two successfully generated summaries.
  expect(h.store.load('thread')!.context.modelRecovery?.attempts).toBe(2)
  expect(h.store.load('thread')!.messages.map(message => message.value)).toEqual(h.history)
  expect(h.store.load('thread')!.context.summary).toBeUndefined()
})

it.each([false, true])('commits the successful summary after a transient failure (manual=%s)', async manual => {
  const h = compressionFixture(manual)
  h.fetch.mockResolvedValueOnce(Response.json({ error: { message: 'Unavailable' } }, { status: 503 }))
    .mockImplementation(async () => response({ content: 'Summary and continued answer' }))
  expect((await conversationExecution(h.services).execute('continue', request(), h.observer)).result.status).toBe('fulfilled')
  expect(h.fetch).toHaveBeenCalledTimes(manual ? 2 : 3)
  expect(h.store.load('thread')!.phase).toBe('completed')
  expect(h.store.load('thread')!.context.summary?.id).toBe('summary')
  expect(h.store.load('thread')!.context.modelRecovery).toBeUndefined()
  expect(h.services.recoveryLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'attempt_started',
    recovery: expect.objectContaining({ attempts: 1, inFlight: true }) }))
  expect(h.services.recoveryLog).toHaveBeenCalledWith(expect.objectContaining({ event: 'response_accepted', outcome: 'recovered' }))
  expect(h.store.load('thread')!.messages.slice(0, h.history.length).map(message => message.value)).toEqual(h.history)
})

it.each([false, true])('retains the remaining compression budget after a crash during any request (manual=%s)', async manual => {
  const h = compressionFixture(manual), db = databases.at(-1)!, snapshots: Buffer[] = []
  h.fetch.mockImplementation(async () => {
    snapshots.push(db.serialize())
    return Response.json({ error: { message: 'Unavailable' } }, { status: 503 })
  })
  expect((await conversationExecution(h.services).execute('continue', request(), h.observer)).result.status).toBe('rejected')
  expect(snapshots).toHaveLength(3)
  for (const [index, snapshot] of snapshots.entries()) {
    const reopened = new Database(snapshot); databases.push(reopened)
    const resumed = compressionFixture(manual, new NativeExecutionStore(reopened))
    resumed.fetch.mockImplementation(async () => Response.json({ error: { message: 'Unavailable' } }, { status: 503 }))
    expect((await conversationExecution(resumed.services).execute('continue', request(), resumed.observer)).result.status).toBe('rejected')
    expect(resumed.fetch).toHaveBeenCalledTimes(2 - index)
    expect(resumed.store.load('thread')!.context.modelRecovery?.attempts).toBe(2)
    expect(resumed.store.load('thread')!.messages.map(message => message.value)).toEqual(h.history)
    expect(resumed.store.load('thread')!.context.summary).toBeUndefined()
  }
})

it('does not send manual compression when persisting its request boundary fails', async () => {
  const h = compressionFixture(true), failure = new Error('database timeout while saving compression')
  const write = vi.spyOn(h.store, 'prepareContext').mockImplementation(() => { throw failure })
  expect((await conversationExecution(h.services).execute('continue', request(), h.observer)).result).toEqual({ status: 'rejected', reason: failure })
  expect(write).toHaveBeenCalledOnce()
  expect(h.fetch).not.toHaveBeenCalled()
  expect(h.store.load('thread')!.context.modelRequestFailed).toBe(false)
  expect(h.store.load('thread')!.messages.map(message => message.value)).toEqual(h.history)
  expect(h.store.load('thread')!.context.summary).toBeUndefined()
})

it.each([false, true])('persists compression Retry-After in the shared budget and cancels without another request (manual=%s)', async manual => {
  const h = compressionFixture(manual), controller = new AbortController()
  h.fetch.mockImplementation(async () => Response.json({ error: { message: 'Busy' } }, { status: 429, headers: { 'retry-after': '30' } }))
  const running = conversationExecution(h.services).execute('continue', { ...request(), signal: controller.signal }, h.observer)
  try {
    await vi.waitFor(() => expect(h.store.load('thread')!.context.modelRecovery?.attempts).toBe(1))
    expect(h.store.load('thread')!.context.modelRecovery!.retryAt - Date.now()).toBeGreaterThan(25000)
  } finally { controller.abort(); await running }
  expect(h.fetch).toHaveBeenCalledOnce()
  expect(h.store.load('thread')!.phase).toBe('cancelled')
})
