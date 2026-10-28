import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import type { ResolvedModelConfig } from '../../shared/types'
import type { AgentRuntimeEvent } from '../../shared/agentTypes'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import { createConversationModelPreparation } from './conversationModelExecution'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeRunHost } from './nativeRunHost'
import { ManagedCallService } from './managedCallService'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { runtimeLog } from '../runtimeLogger'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn() }))
vi.mock('../gitChanges', () => ({ queryGitChanges: vi.fn() }))
const model: ResolvedModelConfig = { id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol: 'openai_chat_completions',
  baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true }, stream: true, maxContextTokens: 128000, maxOutputTokens: 16000,
  contextCompressionThreshold: 0.8, contextCompressionEnabled: true }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
function stream(message: Record<string, unknown>, tool = false) {
  const frames = [
    { choices: [{ index: 0, delta: { role: 'assistant', ...message }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }] },
    { choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }
  ].map(frame => `data: ${JSON.stringify({ id: 'reused-provider-message', object: 'chat.completion.chunk', created: 1, model: 'fixture', ...frame })}\n\n`)
  return new Response(frames.join('') + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })
}

it.each(['completed', 'failed', 'cancelled'] as const)('publishes native chat, memory, plan and tool activity through a %s second model turn', async outcome => {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-live-conversation-')), global = new Database(':memory:')
  const file = join(root, 'conversation.sqlite'), options = { attachmentRoot: join(root, 'attachments'), memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) }
  let database = NativeConversationDatabase.open(file, options)
  let reopened = false
  const owner = { threadId: randomUUID(), runId: randomUUID() }, inputId = `${owner.runId}:input`, events: AgentRuntimeEvent[] = []
  const host = new NativeRunHost(database, new ManagedCallService(database.managed, database.results), { push: event => events.push(event) })
  const secondRequest = deferred(), release = deferred(), todos = [{ content: 'Finish task', status: 'in_progress' as const }]
  const recall = { query: 'Build preferences', promptText: '<relevant_memories>Use npm run build</relevant_memories>', memoryCount: 1 }
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    if (fetch.mock.calls.length === 1) return stream({ content: 'Working', reasoning_content: 'Check the plan', tool_calls: [
      { index: 0, id: 'plan-call', type: 'function', function: { name: 'write_todos', arguments: JSON.stringify({ todos }) } }
    ] }, true)
    secondRequest.resolve(); await release.promise
    if (outcome === 'failed') throw new Error('Provider disconnected')
    return stream({ content: 'Final answer', reasoning_content: 'Checked the result' })
  })
  database.runs.createThreadAndRun({ ...owner, thread: {}, submissionId: randomUUID(), message: { id: inputId,
    value: { id: inputId, kind: 'user', content: 'Help with task', context: { runId: owner.runId } } } })
  const prepare = createConversationModelPreparation({ store: database.runs.store, resolveModel: async () => model,
    systemPrompt: () => 'Instructions', tools: () => [], requiresTools: () => false, maxModelCalls: 0, providerFetch: fetch,
    streaming: true, outputLanguage: { code: 'en', name: 'English' }, compressionTracking: {},
    saveToolResult: async () => { throw new Error('Unexpected overflow') } })
  const executed = vi.fn<ConversationExecutionServices['executeTool']>(async (call, _state, _request, observer) => {
    const observed = { id: call.id, name: call.name, args: { todos } }
    observer.tool({ kind: 'started', call: observed })
    observer.tool({ kind: 'settled', call: observed, succeeded: true, output: { status: 'success' } })
    return { kind: 'result', message: { id: 'plan-result', value: { kind: 'tool', resultFor: call.providerCallId, content: 'Plan saved' } }, update: { todos } }
  })
  try {
    const handle = host.start(owner, 'input', async callbacks => {
      const services: ConversationExecutionServices = { store: database.runs.store, enter: database.execution.enter,
        prepareModel: async (state, request, observer) => {
          if (!state.context.modelCalls) callbacks.onMemoryRecall(recall)
          return prepare(state, request, observer)
        }, afterModel: async () => ({ kind: 'complete' }), prepareTools: async state => ({ calls: state.calls.map(call => ({ callId: call.id, args: call.args })) }),
        executeTool: executed, directions: async () => [], drain: async () => {}, retry: { maxRetries: 0 } }
      return { execution: conversationExecution(services), dispose: async () => {} }
    })
    await secondRequest.promise
    const types = events.map(event => event.type), starts = events.filter(event => event.type === 'model_started')
    expect(starts).toHaveLength(2)
    expect(types.indexOf('run_started')).toBeLessThan(types.indexOf('memory_recalled'))
    expect(types.indexOf('memory_recalled')).toBeLessThan(types.indexOf('model_started'))
    expect(types.indexOf('tool_completed')).toBeLessThan(types.lastIndexOf('model_started'))
    expect(events).toContainEqual(expect.objectContaining({ type: 'todos_updated', todos }))
    const live = host.readSnapshot(owner.threadId)
    expect(live.todos).toEqual(todos)
    expect(live.activities[0].memoryRecalls).toMatchObject([recall])
    expect(live.activities[0].models.at(-1)).toMatchObject({ status: 'running', text: '' })
    expect(live.activities[0].tools).toMatchObject([{ status: 'completed', output: 'Plan saved' }])
    if (outcome === 'cancelled') expect(host.cancel(owner)).toBe(true)
    release.resolve()
    expect((await handle.completed).status).toBe(outcome); await handle.drained
    expect(fetch).toHaveBeenCalledTimes(2); expect(executed).toHaveBeenCalledTimes(1)
    expect(events.filter(event => event.type === 'tool_completed')).toHaveLength(1)
    expect(events.filter(event => event.type === 'run_started')).toHaveLength(1)
    expect(events.filter(event => event.type === `run_${outcome}`)).toHaveLength(1)
    expect(events).toContainEqual(expect.objectContaining({ type: 'model_delta', delta: { type: 'reasoning', text: 'Check the plan' } }))
    expect(runtimeLog).toHaveBeenCalledWith('debug', 'agent', 'Model response metadata.', expect.objectContaining({
      ...owner, usage: expect.objectContaining({ input_tokens: 10, output_tokens: 5, total_tokens: 15 }),
      responseMetadata: expect.objectContaining({ model_name: 'fixture', finish_reason: 'tool_calls' })
    }))
    const snapshot = host.readSnapshot(owner.threadId)
    expect(snapshot.activities[0].models).toHaveLength(outcome === 'completed' ? 2 : 1)
    expect(snapshot.activities[0].models[0]).toMatchObject({ text: 'Working', reasoning: 'Check the plan' })
    expect(snapshot.activities[0].models.every(item => !item.toolCallProgress?.length)).toBe(true)
    expect(snapshot.messages.filter(message => message.role === 'assistant')).toHaveLength(outcome === 'completed' ? 1 : 0)
    if (outcome === 'completed') {
      expect(snapshot.messages.at(-1)?.content).toEqual([{ type: 'reasoning', text: 'Checked the result' }, { type: 'text', text: 'Final answer' }])
      expect(events.filter(event => event.type === 'model_completed')).toHaveLength(2)
    }
    await host.waitForIdle(); database.close(); database = NativeConversationDatabase.open(file, options); reopened = true
    expect(database.readSnapshot(owner.threadId)).toEqual(snapshot)
    database.validate()
  } finally { release.resolve(); if (!reopened) await host.waitForIdle(); database.close(); global.close(); rmSync(root, { recursive: true, force: true }) }
})
