import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ModelProtocol, ResolvedModelConfig } from '../../shared/types'
import { nativeCapabilityFixture } from '../../test/nativeCapabilityFixture'
import { conversationExecution } from '../../runtime/conversationExecution'
import { defineTool } from '../../runtime/toolDefinition'
import { ToolInputError } from '../../runtime/errors'
import { ToolRunScope } from '../../runtime/toolEvents'
import type { AgentRuntimeEvent } from '../../shared/agentTypes'
import { createConversationModelPreparation } from './conversationModelExecution'
import { prepareConversationToolBatch } from './conversationToolPreparation'
import { createManagedToolRuntime } from './managedToolRuntime'
import { createConversationToolExecutor } from './conversationToolExecution'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn() }))
vi.mock('../gitChanges', () => ({ queryGitChanges: vi.fn() }))

const protocols: ModelProtocol[] = ['openai_chat_completions', 'openai_responses', 'anthropic_messages']
// JSON number overflow is syntactically valid on the wire; JSON.stringify
// would silently turn the parsed Infinity into null and hide this boundary.
function overflowJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item === Infinity ? '__test_numeric_overflow__' : item)
    .replaceAll('"__test_numeric_overflow__"', '1e400')
}
describe.each(protocols)('native parameter correction through %s', protocol => {
  it.each([...([null, [], 'wrong', '{', 1, false].map(args => ({ args, diagnostic: 'JSON object', overflow: false }))),
    { args: Infinity, diagnostic: 'JSON object', overflow: true },
    { args: { target: 'available', extra: { limit: Infinity } }, diagnostic: '/extra/limit', overflow: true }
  ])('saves invalid input $args and lets the model correct it without executing that input', async ({ args, diagnostic, overflow }) => {
    const h = nativeCapabilityFixture(), operations = new ToolRunScope()
    try {
      const model: ResolvedModelConfig = { id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol,
        baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none',
        capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
        contextCompressionThreshold: 0.8, contextCompressionEnabled: true }
      const execute = vi.fn((_args: { target: string }) => ({ content: 'Read complete' }))
      const tool = defineTool({ name: 'read_target', description: 'Read fixture', inputSchema: z.object({ target: z.string() }), execute })
      const requests: unknown[] = [], events: AgentRuntimeEvent[] = [], completedAtRequest: string[][] = []
      const fetch: typeof globalThis.fetch = async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)))
        completedAtRequest.push(events.flatMap(event => event.type === 'tool_completed' ? [event.call.id] : []))
        const calling = requests.length <= 2, input = requests.length === 1 ? args : { target: 'available' }
        const callId = requests.length === 1 ? 'invalid' : 'corrected', id = 'response-' + requests.length
        if (protocol === 'anthropic_messages') return new Response(overflowJson({ id, type: 'message', role: 'assistant', model: 'fixture',
          content: calling ? [{ type: 'tool_use', id: callId, name: tool.name, input }] : [{ type: 'text', text: 'Done' }],
          stop_reason: calling ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } }), { headers: { 'content-type': 'application/json' } })
        if (protocol === 'openai_responses') return Response.json({ id, object: 'response', status: 'completed', model: 'fixture',
          output: calling ? [{ type: 'function_call', id: 'item-' + callId, call_id: callId, name: tool.name, arguments: overflowJson(input), status: 'completed' }]
            : [{ type: 'message', id: 'final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Done', annotations: [] }] }],
          usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } })
        return Response.json({ id, object: 'chat.completion', model: 'fixture', created: 1, choices: [{ index: 0, finish_reason: calling ? 'tool_calls' : 'stop',
          message: { role: 'assistant', content: calling ? '' : 'Done', tool_calls: calling ? [{ type: 'function', id: callId, function: { name: tool.name, arguments: overflowJson(input) } }] : [] } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
      }
      const owner = h.database.execution, preparation = { runId: h.run.id, primaryFolder: process.cwd(), folders: [],
        accessMode: () => 'full_access' as const, includeRules: false, definitions: [tool] }
      const observer = h.database.activityProjection.observer(h.run.id, h.thread.id, { push: event => events.push(event) })
      const execution = conversationExecution({ store: owner.store, enter: owner.enter,
        prepareModel: createConversationModelPreparation({ store: owner.store, resolveModel: async () => model,
          systemPrompt: () => 'Inspect the fixture', tools: () => [tool], requiresTools: () => true, maxModelCalls: 3,
          providerFetch: fetch, outputLanguage: { code: 'en', name: 'English' }, compressionTracking: {},
          saveToolResult: async () => { throw new Error('Unexpected overflow') } }),
        afterModel: async () => ({ kind: 'complete' }), prepareTools: state => prepareConversationToolBatch(state, preparation),
        executeTool: createConversationToolExecutor({ store: owner.store, definitions: [createManagedToolRuntime(tool, { results: h.database.results, service: h.service, threadId: h.thread.id, runId: h.run.id, allowBackground: false,
            providerCallId: id => owner.store.load(h.thread.id)!.calls.find(call => call.id === id)!.providerCallId! })], preparation,
          operations, planning: false, managed: owner.managed, persistFileChange: owner.persistFileChange }),
        directions: owner.directions, drain: () => operations.drain(), retry: { maxRetries: 0 } })
      const outcome = await execution.execute('input', { threadId: h.thread.id, runId: h.run.id, signal: new AbortController().signal }, observer)
      if (outcome.result.status === 'rejected') throw outcome.result.reason
      expect(outcome.result.status).toBe('fulfilled')
      const state = owner.store.load(h.thread.id)!, results = state.messages.filter(message => message.value.kind === 'tool')
      expect(state.phase).toBe('completed'); expect(state.context.modelCalls).toBe(3)
      expect(state.messages[1].value.calls?.[0].args).toEqual(args)
      expect(results.map(message => message.value)).toMatchObject([
        { resultFor: 'invalid', resultStatus: 'error', content: expect.stringContaining(diagnostic) },
        { resultFor: 'corrected', resultStatus: 'success', content: 'Read complete' }
      ])
      expect(JSON.stringify(requests[1])).toContain('Correct the arguments')
      if (!overflow && protocol === 'anthropic_messages') expect(requests[1]).toMatchObject({ messages: expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', content: expect.arrayContaining([expect.objectContaining({ type: 'tool_use', id: 'invalid', input: args })]) })
      ]) })
      else if (!overflow && protocol === 'openai_responses') expect(requests[1]).toMatchObject({ input: expect.arrayContaining([
        expect.objectContaining({ type: 'function_call', call_id: 'invalid', arguments: JSON.stringify(args) })
      ]) })
      else if (!overflow) expect(requests[1]).toMatchObject({ messages: expect.arrayContaining([
        expect.objectContaining({ role: 'assistant', tool_calls: expect.arrayContaining([expect.objectContaining({ id: 'invalid', function: expect.objectContaining({ arguments: JSON.stringify(args) }) })]) })
      ]) })
      expect(execute).toHaveBeenCalledOnce(); expect(execute.mock.calls[0][0]).toEqual({ target: 'available' })
      expect(h.database.readSnapshot(h.thread.id).activities[0].tools).toHaveLength(2)
      const callIds = state.messages.filter(record => record.value.calls?.length)
        .flatMap(record => h.database.execution.store.readModelCallIds(h.thread.id, record.recordId))
      expect(completedAtRequest).toEqual([[], [callIds[0]], callIds])
      expect(events.filter(event => event.type === 'tool_completed').map(event => event.call.id)).toEqual(callIds)
      expect(events.filter(event => event.type === 'model_started')).toHaveLength(3)
    } finally { await operations.drain(); await h.close() }
  })
})

describe('native tool input diagnostics', () => {
  it.each(['schema', 'preflight', 'tool'] as const)('continues after a %s correction while retaining the original input', async source => {
    const h = nativeCapabilityFixture()
    try {
      const failure = new ToolInputError('Target missing does not exist. Use available.')
      failure.stack = 'private-source/tools.ts:114'
      const execute = vi.fn(({ target }: { target: string }) => {
        if (source === 'tool' && target === 'missing') throw failure
        return { content: 'Read ' + target }
      })
      const inputSchema = z.object({ target: z.string() }).superRefine(async (input, context) => {
        if (source === 'preflight' && input.target === 'missing') context.addIssue({ code: 'custom', path: ['target'], message: failure.message })
      })
      const definition = defineTool({ name: 'read_target', description: '', inputSchema, execute })
      const original = { target: source === 'schema' ? 7 : 'missing' }
      const history = await h.executeCalls([definition], [
        [{ id: 'invalid', name: definition.name, args: original }],
        [{ id: 'corrected', name: definition.name, args: { target: 'available' } }]
      ])
      const messages = history.messages.map(message => message.value), results = messages.filter(message => message.kind === 'tool')
      expect(results).toMatchObject([
        { resultFor: 'invalid', resultStatus: 'error', content: expect.stringContaining('Correct the arguments') },
        { resultFor: 'corrected', resultStatus: 'success', content: 'Read available' }
      ])
      expect(results[0].content).toContain(source === 'schema' ? 'target' : failure.message)
      expect(results[0].content).not.toContain('private-source')
      expect(messages[1].calls?.[0].args).toEqual(original)
      expect(execute).toHaveBeenCalledTimes(source === 'tool' ? 2 : 1)
      expect(execute.mock.calls.at(-1)?.[0]).toEqual({ target: 'available' })
      expect(h.database.execution.store.load(h.thread.id)!.context.modelCalls).toBe(3)
    } finally { await h.close() }
  })
})
