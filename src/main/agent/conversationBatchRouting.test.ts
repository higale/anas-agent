import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { ResolvedModelConfig } from '@shared/types'
import type { ConversationMessage, ConversationToolCall } from '../../runtime/conversationMessage'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import type { RunObserver } from '../../runtime/runExecution'
import { planningToolSpec } from '../../runtime/planning'
import type { ToolDefinition } from '../../runtime/toolDefinition'
import { ToolRunScope } from '../../runtime/toolEvents'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'
import { createConversationModelPreparation } from './conversationModelExecution'
import { prepareConversationToolBatch, resolveConversationToolApprovals } from './conversationToolPreparation'
import { createConversationToolExecutor } from './conversationToolExecution'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn() }))
vi.mock('../gitChanges', () => ({ queryGitChanges: vi.fn() }))

const model: ResolvedModelConfig = { id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol: 'openai_chat_completions',
  baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
  contextCompressionThreshold: 0.8, contextCompressionEnabled: true }
const request = { threadId: 'thread', runId: 'run', signal: new AbortController().signal }

function paired(messages: readonly ConversationMessage[]) {
  let pending: string[] = []
  for (const message of messages) {
    if (message.kind === 'tool') {
      expect(pending).toContain(message.resultFor)
      pending = pending.filter(id => id !== message.resultFor)
    } else {
      expect(pending).toEqual([])
      pending = message.calls?.map(call => call.id!) ?? []
    }
  }
  expect(pending).toEqual([])
}

function fixture(rounds: ConversationToolCall[][], maxModelCalls = 3, history: ConversationMessage[] = [], file = ':memory:') {
  let db = new Database(file); db.pragma('foreign_keys=ON'); db.exec(nativeExecutionSchema)
  let store = new NativeExecutionStore(db)
  const requests: string[] = [], executed = vi.fn((value: unknown) => String(value))
  const definitions: ToolDefinition<ConversationMessage>[] = ['operate', 'update_config'].map(name => ({ name, description: 'Fixture operation',
    inputSchema: z.object({ value: z.string() }), execute: (args, context) => ({ kind: 'tool', name,
      resultFor: store.load('thread')!.calls.find(call => call.id === context.callId)!.providerCallId,
      content: executed(args.value), resultStatus: 'success' }) }))
  const preparation = { runId: 'run', primaryFolder: process.cwd(), folders: [process.cwd()], accessMode: () => 'strict_approval' as const,
    includeRules: false, definitions: [...definitions, planningToolSpec] }
  const operations = new ToolRunScope(), observer: RunObserver = { started: vi.fn(), startModel: vi.fn(() => 'model'), discardModel: vi.fn(),
    model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
  const services = (): ConversationExecutionServices => ({ store, enter: async () => {},
    prepareModel: createConversationModelPreparation({ store, resolveModel: async () => model, systemPrompt: () => 'Work', tools: () => preparation.definitions,
      requiresTools: () => true, maxModelCalls, outputLanguage: { code: 'en', name: 'English' }, compressionTracking: {},
      saveToolResult: async () => { throw new Error('Unexpected overflow') }, providerFetch: async (_url, init) => {
        paired(store.load('thread')!.messages.map(record => record.value))
        requests.push(String(init?.body))
        const calls = rounds[requests.length - 1] ?? []
        return Response.json({ id: 'response-' + requests.length, object: 'chat.completion', model: 'fixture', created: 1,
          choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: calls.length ? '' : 'done',
            tool_calls: calls.map(call => ({ type: 'function', id: call.id, function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }] })
      } }), afterModel: async () => ({ kind: 'complete' }), prepareTools: state => prepareConversationToolBatch(state, preparation),
    executeTool: createConversationToolExecutor({ store, definitions, preparation, operations, planning: true, persistFileChange: () => {} }),
    directions: async () => [], drain: () => operations.drain(), retry: { maxRetries: 0 } })
  store.start({ threadId: 'thread', runId: 'run', context: { modelCalls: 0, todos: [] },
    messages: [...history, { kind: 'user' as const, content: 'Work' }].map((value, index) => ({ id: 'input-' + index, value })) })
  return { get db() { return db }, get store() { return store }, requests, executed,
    reopen() { db.close(); db = new Database(file); db.pragma('foreign_keys=ON'); store = new NativeExecutionStore(db) },
    execute: () => conversationExecution(services()).execute('continue', request, observer) }
}

describe('native complete tool batch routing', () => {
  it('executes a reused provider call ID in the current round without borrowing an older result', async () => {
    const call = { id: 'reused', name: 'operate', args: { value: 'New result' } }
    const h = fixture([[call]], 2, [{ kind: 'assistant', content: '', calls: [{ ...call, args: { value: 'Old result' } }] },
      { kind: 'tool', resultFor: 'reused', content: 'Old result' }])
    try {
      expect((await h.execute()).result.status).toBe('fulfilled')
      expect(h.executed).toHaveBeenCalledExactlyOnceWith('New result')
      const messages = h.store.load('thread')!.messages.map(record => record.value)
      paired(messages)
      expect(messages.filter(message => message.kind === 'tool').map(message => message.content)).toEqual(['Old result', 'New result'])
    } finally { h.db.close() }
  })

  it.each([['invalid', 'valid'], ['valid', 'valid'], ['invalid', 'invalid'], ['invalid', 'valid', 'valid']]
    .flatMap(kinds => [1, 3].map(maxCalls => ({ kinds, maxCalls }))))('pairs plan corrections for $kinds with budget $maxCalls', async ({ kinds, maxCalls }) => {
    const calls = kinds.map((kind, index) => ({ id: 'todo-' + index, name: 'write_todos', args: {
      todos: kind === 'invalid' ? 'wrong' : [{ content: 'Plan ' + index, status: 'pending' }] } }))
    const todos = [{ content: 'Corrected plan', status: 'completed' }]
    const h = fixture([calls, [{ id: 'corrected', name: 'write_todos', args: { todos } }]], maxCalls)
    try {
      const outcome = await h.execute(), state = h.store.load('thread')!
      expect(h.requests).toHaveLength(maxCalls)
      expect(state.context.modelCalls).toBe(maxCalls)
      expect(outcome.result.status).toBe(maxCalls === 1 ? 'rejected' : 'fulfilled')
      if (maxCalls === 1 && outcome.result.status === 'rejected') expect(String(outcome.result.reason)).toContain('Model call limits exceeded')
      if (maxCalls === 3) expect(state.context.todos).toEqual(todos)
      const messages = state.messages.map(record => record.value); paired(messages)
      const results = messages.filter(message => message.kind === 'tool')
      expect(results).toHaveLength(calls.length + (maxCalls === 3 ? 1 : 0))
      for (const [index, kind] of kinds.entries()) {
        const result = results.find(message => message.resultFor === 'todo-' + index)!
        if (kind === 'valid' && kinds.filter(value => value === 'valid').length === 1) {
          expect(result.resultStatus).not.toBe('error'); expect(result.content).toContain('Plan ' + index)
        } else expect(result.resultStatus).toBe('error')
      }
    } finally { h.db.close() }
  })

  it.each(['approve', 'reject'] as const)('preserves every call and result after a mixed %s batch', async decision => {
    const calls = [{ id: 'review-one', name: 'update_config', args: { value: 'review-one' } },
      { id: 'invalid', name: 'operate', args: { value: 4 } }, { id: 'automatic', name: 'operate', args: { value: 'automatic' } },
      { id: 'review-two', name: 'update_config', args: { value: 'review-two' } }]
    const h = fixture([calls], 2)
    try {
      expect((await h.execute()).result.status).toBe('fulfilled')
      const state = h.store.load('thread')!, approval = state.approvals[0]
      expect(state.phase).toBe('waiting'); expect(h.executed).not.toHaveBeenCalled()
      expect(approval.request.actionRequests.map(action => action.args)).toEqual([calls[0].args, calls[3].args])
      const scope = { threadId: 'thread', runId: 'run', expectedRevisionId: state.revisionId }
      expect(() => resolveConversationToolApprovals(h.store, scope, [{ id: approval.id, generation: approval.generation,
        response: { decisions: [{ type: 'edit', editedAction: { name: 'update_config', args: { value: 'edited' } } }, { type: 'reject' }] } }])).toThrow('Unexpected human decision')
      expect(h.store.load('thread')).toEqual(state)
      resolveConversationToolApprovals(h.store, scope, [{ id: approval.id, generation: approval.generation,
        response: { decisions: [{ type: 'approve' }, { type: decision, message: 'Skip this batch.' }] } }])
      expect((await h.execute()).result.status).toBe('fulfilled')
      expect(h.requests).toHaveLength(2)
      expect(h.executed).toHaveBeenCalledTimes(decision === 'approve' ? 3 : 0)
      const messages = h.store.load('thread')!.messages.map(record => record.value); paired(messages)
      expect(messages.find(message => message.calls?.length)?.calls?.map(({ id, name, args }) => ({ id, name, args }))).toEqual(calls)
      const results = messages.filter(message => message.kind === 'tool')
      expect(results.map(message => message.resultFor)).toEqual(calls.map(call => call.id))
      expect(results.find(message => message.resultFor === 'invalid')?.resultStatus).toBe('error')
      if (decision === 'reject') expect(results.every(message => message.resultStatus === 'error')).toBe(true)
    } finally { h.db.close() }
  })
})

describe('native model budget after durable approval', () => {
  it('executes an approved tool once after reopen without resetting an exhausted model budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-budget-'))
    const h = fixture([[{ id: 'operation', name: 'update_config', args: { value: 'done' } }]], 1, [], join(root, 'state.sqlite'))
    try {
      expect((await h.execute()).result.status).toBe('fulfilled')
      expect(h.store.load('thread')).toMatchObject({ phase: 'waiting', context: { modelCalls: 1 } })
      expect(h.executed).not.toHaveBeenCalled()
      h.reopen()
      const state = h.store.load('thread')!, approval = state.approvals[0]
      resolveConversationToolApprovals(h.store, { ...request, expectedRevisionId: state.revisionId }, [
        { id: approval.id, generation: approval.generation, response: { decisions: [{ type: 'approve' }] } }
      ])
      for (let attempt = 0; attempt < 2; attempt++) {
        const outcome = await h.execute()
        expect(outcome.result.status).toBe('rejected')
        if (outcome.result.status === 'rejected') expect(String(outcome.result.reason)).toContain(attempt === 0 ? 'Model call limits exceeded' : 'already failed')
        expect(h.store.load('thread')!.phase).toBe('failed')
        expect(h.requests).toHaveLength(1)
        expect(h.executed).toHaveBeenCalledExactlyOnceWith('done')
        expect(h.store.load('thread')!.context.modelCalls).toBe(1)
        paired(h.store.load('thread')!.messages.map(message => message.value))
        h.reopen()
      }
    } finally { h.db.close(); rmSync(root, { recursive: true, force: true }) }
  })
})
