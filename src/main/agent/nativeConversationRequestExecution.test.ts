import Database from 'better-sqlite3'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ModelProtocol, ResolvedModelConfig } from '@shared/types'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import type { RunObserver } from '../../runtime/runExecution'
import { invokeCapability } from '../../runtime/toolInvocation'
import { defineTool } from '../../runtime/toolDefinition'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'
import { createConversationModelPreparation } from './conversationModelExecution'
import { createConversationAttachmentProjector } from './conversationAttachments'
import { createConversationMemoryProjector } from './conversationMemory'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn() }))
vi.mock('../gitChanges', () => ({ queryGitChanges: vi.fn() }))

describe('native request, model, loop and SQLite integration', () => {
  it.each((['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as ModelProtocol[])
    .flatMap(protocol => [false, true].map(withDirection => ({ protocol, withDirection }))))(
    'continues a durable tool conversation through the $protocol SDK (queued direction=$withDirection)', async ({ protocol, withDirection }) => {
      const scratch = join(process.cwd(), 'tmp')
      await mkdir(scratch, { recursive: true })
      const root = await mkdtemp(join(scratch, 'native-context-execution-'))
      const database = new Database(':memory:')
      try {
        database.pragma('foreign_keys = ON')
        database.exec(nativeExecutionSchema)
        const store = new NativeExecutionStore(database)
        const model: ResolvedModelConfig = { id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol,
          baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none',
          capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
          contextCompressionThreshold: 0.8, contextCompressionEnabled: true }
        const requests: Record<string, unknown>[] = [], invocation = vi.fn(() => ({ content: 'file contents' }))
        const tool = defineTool({ name: 'read', description: 'Read', inputSchema: z.object({ path: z.string() }), execute: invocation })
        const attachmentPath = join(root, 'context.txt')
        await writeFile(attachmentPath, 'Archived attachment content', 'utf8')
        const attachments = createConversationAttachmentProjector({ currentRunId: 'run', textMaxChars: 1000, textOverflow: 'truncate', artifacts: [{
          id: 'attachment', threadId: 'thread', messageId: 'user', runId: 'run', name: 'context.txt', path: attachmentPath,
          mimeType: 'text/plain', size: 27, kind: 'text', available: true, textTruncated: false, contextPolicy: 'one_turn', createdAt: '2026-10-27T00:00:00.000Z'
        }] })
        const recall = vi.fn(async () => [{ id: 'memory', scope: 'project' as const, projectId: 'project', kind: 'fact' as const,
          content: 'Remember <project> conventions.', keywords: ['project'], importance: 5, origin: 'user' as const,
          createdAt: '2026-10-27T00:00:00.000Z', updatedAt: '2026-10-27T00:00:00.000Z' }])
        const memory = createConversationMemoryProjector({ enabled: true, projectId: 'project', store: { relevantMemories: recall } })
        const fetch: typeof globalThis.fetch = async (_url, init) => {
          const body = JSON.parse(String(init?.body))
          requests.push(body)
          const first = requests.length === 1, id = `provider-response-${requests.length}`
          if (protocol === 'anthropic_messages') return Response.json({ id, type: 'message', role: 'assistant', model: 'fixture',
            content: first ? [{ type: 'tool_use', id: 'provider-call', name: 'read', input: { path: 'fixture.txt' } }] : [{ type: 'text', text: 'done' }],
            stop_reason: first ? 'tool_use' : 'end_turn', usage: { input_tokens: 10, output_tokens: 2 } })
          if (protocol === 'openai_responses') return Response.json({ id, object: 'response', status: 'completed', model: 'fixture',
            output: first ? [{ type: 'function_call', id: 'provider-item', call_id: 'provider-call', name: 'read', arguments: '{"path":"fixture.txt"}', status: 'completed' }]
              : [{ type: 'message', id: 'provider-message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'done', annotations: [] }] }],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } })
          return Response.json({ id, object: 'chat.completion', model: 'fixture', created: 1, choices: [{ index: 0, finish_reason: first ? 'tool_calls' : 'stop',
            message: { role: 'assistant', content: first ? '' : 'done', tool_calls: first ? [{ type: 'function', id: 'provider-call', function: { name: 'read', arguments: '{"path":"fixture.txt"}' } }] : [] } }],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
        }
        const observer: RunObserver = { started: vi.fn(), startModel: vi.fn(() => 'observation'), discardModel: vi.fn(),
          model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
        const services: ConversationExecutionServices = {
          store, enter: async command => {
            if (command === 'input') store.start({ threadId: 'thread', runId: 'run', context: { modelCalls: 0, todos: [] },
              messages: [{ id: 'user', value: { kind: 'user', content: 'Read the fixture' } }] })
          },
          prepareModel: createConversationModelPreparation({ store, resolveModel: async () => model, systemPrompt: () => 'Instructions',
            tools: () => [tool], requiresTools: () => true, maxModelCalls: 0, providerFetch: fetch, attachments, memory,
            outputLanguage: { code: 'en', name: 'English' }, compressionTracking: {}, saveToolResult: async () => { throw new Error('Unexpected overflow') } }),
          afterModel: async () => ({ kind: 'complete' }),
          prepareTools: async state => ({ calls: state.calls.map(call => ({ callId: call.id, args: call.args })) }),
          executeTool: async (call, _state, request) => {
            // Read-only fixture capability; no external effect or journal mock.
            const result = await invokeCapability(tool, call.args, { callId: call.id, signal: request.signal })
            return { kind: 'result', message: { id: `${call.id}:result`, value: { kind: 'tool', content: String(result.content), resultFor: call.providerCallId } } }
          },
          directions: async () => withDirection ? [{ id: 'direction', value: { kind: 'user', content: 'Then explain it' } }] : [],
          drain: vi.fn(async () => {}), retry: { maxRetries: 0 }
        }
        const request = { threadId: 'thread', runId: 'run', signal: new AbortController().signal }
        const execution = conversationExecution(services)
        expect((await execution.execute('input', request, observer)).result.status).toBe('fulfilled')
        const state = store.load('thread')!
        expect(state.phase).toBe('completed')
        expect(state.context.modelCalls).toBe(2)
        expect(state.messages.map(message => message.value.kind)).toEqual(withDirection
          ? ['user', 'assistant', 'tool', 'user', 'assistant'] : ['user', 'assistant', 'tool', 'assistant'])
        expect(state.messages[0].id).toBe('user')
        if (withDirection) expect(state.messages[3].id).toBe('direction')
        expect(new Set(state.messages.map(message => message.id)).size).toBe(withDirection ? 5 : 4)
        expect(state.context.threadModelCalls).toBe(2)
        expect(state.messages[1].value.context).toMatchObject({ runId: 'run', requestKey: expect.any(String) })
        expect(state.messages.at(-1)?.value.content).toEqual(protocol === 'openai_responses' ? [{ type: 'text', text: 'done', annotations: [] }] : 'done')
        expect(JSON.stringify(requests[1])).toContain('file contents')
        if (withDirection) expect(JSON.stringify(requests[1])).toContain('Then explain it')
        expect(JSON.stringify(requests[1])).toContain('provider-call')
        expect(JSON.stringify(requests[1])).not.toContain(state.messages[2].id.replace(/:result$/, ''))
        expect(observer.model).toHaveBeenCalledWith(expect.objectContaining({ kind: 'completed', calls: [expect.objectContaining({ id: store.readModelCallIds('thread', state.messages[1].recordId)[0], name: 'read' })] }))
        expect(requests.every(body => JSON.stringify(body).includes('Archived attachment content'))).toBe(true)
        expect(requests.every(body => JSON.stringify(body).includes('Remember &lt;project&gt; conventions.'))).toBe(true)
        expect(recall).toHaveBeenCalledTimes(withDirection ? 2 : 1)
        expect(recall).toHaveBeenNthCalledWith(1, expect.stringContaining('Archived attachment content'), 'project', undefined)
        if (withDirection) expect(recall).toHaveBeenNthCalledWith(2, 'Then explain it', 'project', undefined)
        expect(state.messages[0].value.content).toBe('Read the fixture')
        expect(state.messages[0].value.context?.attachmentProjection).toBeUndefined()
        expect(invocation).toHaveBeenCalledOnce()
        expect((await execution.execute('continue', request, observer)).result.status).toBe('fulfilled')
        expect(requests).toHaveLength(2)
        expect(invocation).toHaveBeenCalledOnce()
      } finally { database.close(); await rm(root, { recursive: true, force: true }) }
    })
})
