import { z } from 'zod'
import { defineContentTool } from '../../runtime/toolDefinition'
import { encodeConversationMessage, decodeConversationMessage } from '../../runtime/conversationStorage'
import { isModelSelectionError } from '../../runtime/errors'
import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedModelConfig } from '@shared/types'
import type { CodeReviewSnapshot } from '@shared/codeReview'
import { codeReviewSnapshotId, codeReviewToolName } from '../../runtime/codeReviewReport'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import type { ExecutionState, ExecutionToolCall } from '../../runtime/executionState'
import type { RunObserver } from '../../runtime/runExecution'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { NativeExecutionStore, nativeExecutionSchema, type NativeExecutionCommit } from './nativeExecutionStore'
import { createConversationModelPreparation } from './conversationModelExecution'
import { prepareConversationToolBatch } from './conversationToolPreparation'
import { completeConversationReview, conversationReviewResults } from './conversationReview'
import { presentConversationMessage } from './conversationPresentation'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn() }))
vi.mock('../gitChanges', () => ({ queryGitChanges: vi.fn() }))

const captured: Omit<CodeReviewSnapshot, 'id'> = { projectId: 'project', capturedAt: '2026-10-27T00:00:00.000Z',
  request: { kind: 'recorded', threadId: 'thread', runId: 'source', version: 'b'.repeat(64), target: 'recorded' },
  description: 'Fixture change', limitations: [], files: [{ id: 'file', path: 'a.ts', patch: '-old\n+new', before: [{ start: 1, end: 1 }], after: [{ start: 1, end: 1 }] }] }
const snapshot = { ...captured, id: codeReviewSnapshotId(captured) }
const report = { scope_id: snapshot.id, summary: 'Review completed', findings: [], limitations: [] }
const model: ResolvedModelConfig = { id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol: 'openai_chat_completions',
  baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
  contextCompressionThreshold: 0.8, contextCompressionEnabled: true }
const request = { threadId: 'thread', runId: 'run', signal: new AbortController().signal }
const scope = (state: ExecutionState) => ({ ...request, expectedRevisionId: state.revisionId })
function fixture(onCommit?: (commit: NativeExecutionCommit) => void) {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.exec(nativeExecutionSchema)
  const store = new NativeExecutionStore(db, onCommit), observer: RunObserver = { started: vi.fn(), startModel: vi.fn(() => 'observation'),
    discardModel: vi.fn(), model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
  const options = { runId: 'run', primaryFolder: '/fixture', folders: ['/fixture'], accessMode: () => 'full_access' as const, includeRules: false, definitions: [], review: snapshot }
  const services: ConversationExecutionServices = { store, enter: async () => {},
    prepareModel: async () => { throw new Error('Must not call model again') }, afterModel: async () => ({ kind: 'complete' }),
    prepareTools: state => prepareConversationToolBatch(state, options),
    executeTool: vi.fn(async () => { throw new Error('Report must not invoke a capability') }), directions: vi.fn(async () => []),
    completeResponse: state => completeConversationReview(state, snapshot), drain: async () => {}, retry: { maxRetries: 0 } }
  store.start({ threadId: 'thread', runId: 'run', context: { modelCalls: 0, todos: [] }, messages: [{ id: 'user', value: { kind: 'user', content: 'Review changes' } }] })
  const accept = (args: Record<string, unknown> = report) => {
    const call: ExecutionToolCall = { id: 'application-report', providerCallId: 'provider-report', name: codeReviewToolName, args,
      artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
    store.acceptModel(scope(store.load('thread')!), { id: 'model', value: { kind: 'assistant', content: '',
      calls: [{ id: call.providerCallId, name: call.name, args }], usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 },
      context: { projectRulesReceipt: { runId: 'run', scopes: [] } } } }, [call], { modelCalls: 1, todos: [] })
  }
  return { db, store, observer, options, services, accept }
}

function modelPreparation(h: ReturnType<typeof fixture>, providerFetch: typeof fetch,
  options: { model?: ResolvedModelConfig; maxCalls?: number; review?: boolean } = {}) {
  return createConversationModelPreparation({ store: h.store, resolveModel: async () => options.model ?? model, systemPrompt: () => 'Review instructions',
    tools: () => [], requiresTools: () => options.review !== false, maxModelCalls: options.maxCalls ?? 2,
    review: options.review === false ? undefined : snapshot, providerFetch,
    outputLanguage: { code: 'en', name: 'English' }, compressionTracking: {}, saveToolResult: async () => { throw new Error('Unexpected overflow') } })
}

describe('native structured code review completion', () => {
  it.each((['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)
    .flatMap(protocol => ['arguments', 'identity'].map(failure => ({ protocol, failure }))))(
    'recovers malformed review calls with $protocol ($failure) before accepting a report', async ({ protocol, failure }) => {
      const h = fixture(), requests: string[] = []
      try {
        h.services.retry = { maxRetries: 2, initialDelayMs: 0 }
        const providerFetch: typeof fetch = async (_url, init) => {
          requests.push(String(init?.body))
          const valid = requests.length === 2, validInput = valid || failure !== 'arguments'
          const identity = valid || failure !== 'identity' ? { id: 'report' } : {}
          const args = validInput ? JSON.stringify(report) : '{'
          if (protocol === 'anthropic_messages') return Response.json({ id: 'provider', type: 'message', role: 'assistant', model: 'fixture',
            content: [{ type: 'tool_use', ...identity, name: codeReviewToolName, ...(validInput ? { input: report } : {}) }],
            stop_reason: 'tool_use', usage: { input_tokens: 10, output_tokens: 2 } })
          if (protocol === 'openai_responses') return Response.json({ id: 'provider', object: 'response', created_at: 1, model: 'fixture', status: 'completed',
            output: [{ id: 'item', type: 'function_call', call_id: identity.id, name: codeReviewToolName, arguments: args }],
            usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } })
          return Response.json({ id: 'provider', object: 'chat.completion', model: 'fixture', created: 1,
            choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '',
              tool_calls: [{ type: 'function', ...identity, function: { name: codeReviewToolName, arguments: args } }] } }] })
        }
        h.services.prepareModel = modelPreparation(h, providerFetch, { model: { ...model, protocol } })
        const outcome = await conversationExecution(h.services).execute('continue', request, h.observer)
        expect(outcome.result.status).toBe('fulfilled')
        expect(requests).toHaveLength(2)
        expect(requests[1]).toContain('Application recovery notice')
        expect(requests[1]).toContain('invalid tool call')
        const state = h.store.load('thread')!
        expect(state.phase).toBe('completed')
        expect(state.context.modelRecovery).toBeUndefined()
        expect(state.messages.at(-1)!.value.context?.reviewReport).toEqual({ snapshot, report })
        expect(state.messages.filter(message => message.value.kind === 'user')).toHaveLength(1)
        expect(state.messages.filter(message => message.value.kind === 'tool')).toHaveLength(1)
        expect(h.services.executeTool).not.toHaveBeenCalled()
      } finally { h.db.close() }
    })

  it('stops malformed review responses when the shared recovery budget is exhausted', async () => {
    const h = fixture()
    try {
      h.services.retry = { maxRetries: 2, initialDelayMs: 0 }
      const providerFetch = vi.fn(async () => Response.json({ id: 'provider', object: 'chat.completion', model: 'fixture', created: 1,
        choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '',
          tool_calls: [{ type: 'function', id: 'report', function: { name: codeReviewToolName, arguments: '{' } }] } }] }))
      h.services.prepareModel = modelPreparation(h, providerFetch)
      const outcome = await conversationExecution(h.services).execute('continue', request, h.observer)
      expect(outcome.result).toMatchObject({ status: 'rejected', reason: { code: 'MODEL_TOOL_CALL_INVALID' } })
      expect(providerFetch).toHaveBeenCalledTimes(3)
      expect(h.store.load('thread')).toMatchObject({ phase: 'failed', context: { modelRequestFailed: true, modelRecovery: { attempts: 2 } } })
      expect(h.store.load('thread')!.messages).toHaveLength(1)
      expect(h.services.executeTool).not.toHaveBeenCalled()
    } finally { h.db.close() }
  })

  it.each(['schema', 'scope', 'multiple'] as const)('corrects %s report errors without investigation and respects the model budget', async kind => {
    const bad = kind === 'multiple' ? ['one', 'two'].map(id => ({ id, name: codeReviewToolName, args: report }))
      : [{ id: 'bad', name: codeReviewToolName, args: kind === 'scope' ? { ...report, scope_id: 'a'.repeat(64) } : {} }]
    for (const maxCalls of [2, 1]) {
      const h = fixture(), requests: string[] = []
      try {
        const providerFetch: typeof fetch = async (_url, init) => {
          requests.push(String(init?.body))
          const calls = requests.length === 1 ? bad : [{ id: 'fixed', name: codeReviewToolName, args: report }]
          return Response.json({ id: 'provider', object: 'chat.completion', model: 'fixture', created: 1,
            choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: calls.map(call => ({ type: 'function', id: call.id,
              function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }] })
        }
        h.services.prepareModel = modelPreparation(h, providerFetch, { maxCalls })
        const outcome = await conversationExecution(h.services).execute('continue', request, h.observer)
        const state = h.store.load('thread')!
        expect(requests).toHaveLength(maxCalls)
        expect(state.context.modelCalls).toBe(maxCalls)
        expect(state.messages.filter(message => message.value.kind === 'tool' && message.value.resultStatus === 'error')
          .map(message => message.value.resultFor)).toEqual(bad.map(call => call.id))
        expect(h.services.executeTool).not.toHaveBeenCalled()
        if (maxCalls === 1) {
          expect(outcome.result).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining('Model call limits exceeded') }) })
          expect(state.phase).toBe('failed')
          continue
        }
        expect(outcome.result.status).toBe('fulfilled')
        expect(state.phase).toBe('completed')
        expect(requests.every(body => body.includes('-old\\n+new'))).toBe(true)
        expect(requests[1]).toContain(kind === 'multiple' ? 'Please provide a single structured output' : 'Failed to parse structured output')
        expect(state.messages.at(-1)!.value.context?.reviewReport).toEqual({ snapshot, report })
        expect(presentConversationMessage(state.messages.at(-1)!.value, 'fallback').codeReview).toEqual({ snapshot, report, locations: [] })
        expect(h.services.directions).toHaveBeenCalledOnce()
      } finally { h.db.close() }
    }
  })

  it.each(['raw', 'rejected'] as const)('resumes a saved invalid report from %s, investigates once and completes the correction', async phase => {
    const h = fixture(), requests: string[] = []
    const read = defineContentTool({ name: 'inspect_change', description: 'Read evidence', inputSchema: z.object({ path: z.string() }), execute: async () => 'evidence' })
    try {
      h.accept({})
      if (phase === 'rejected') {
        const before = h.store.load('thread')!, prepared = await prepareConversationToolBatch(before, h.options)
        if ('kind' in prepared) throw new Error('Unexpected approval')
        h.store.prepareTools(scope(before), prepared.calls, prepared.approvals, prepared.context)
        h.store.finishBatch(scope(h.store.load('thread')!))
      }
      const store = new NativeExecutionStore(h.db)
      h.services.store = store
      h.services.prepareTools = state => prepareConversationToolBatch(state, { ...h.options, definitions: [read] })
      h.services.executeTool = vi.fn<ConversationExecutionServices['executeTool']>(async call => {
        expect(call.name).toBe('inspect_change')
        expect(call.args).toEqual({ path: 'a.ts' })
        return { kind: 'result', message: { id: call.id + ':result', value: { kind: 'tool', resultFor: call.providerCallId, content: 'evidence' } } }
      })
      h.services.prepareModel = createConversationModelPreparation({ store, resolveModel: async () => model, systemPrompt: () => 'Review instructions',
        tools: () => [read], requiresTools: () => true, maxModelCalls: 3, review: snapshot,
        providerFetch: async (_url, init) => {
          requests.push(String(init?.body))
          const investigate = requests.length === 1
          return Response.json({ id: 'provider-' + requests.length, object: 'chat.completion', model: 'fixture', created: 1,
            choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: '', tool_calls: [{ type: 'function',
              id: investigate ? 'read' : 'fixed', function: { name: investigate ? read.name : codeReviewToolName,
                arguments: JSON.stringify(investigate ? { path: 'a.ts' } : report) } }] } }] })
        }, outputLanguage: { code: 'en', name: 'English' }, compressionTracking: {}, saveToolResult: async () => { throw new Error('Unexpected overflow') } })
      expect((await conversationExecution(h.services).execute('continue', request, h.observer)).result.status).toBe('fulfilled')
      expect(requests).toHaveLength(2)
      expect(requests[0]).toContain('Failed to parse structured output')
      expect(requests[1]).toContain('evidence')
      expect(h.services.executeTool).toHaveBeenCalledOnce()
      const state = store.load('thread')!
      expect(state.phase).toBe('completed')
      expect(state.context.modelCalls).toBe(3)
      expect(state.messages.filter(message => message.value.kind === 'tool').map(message => message.value.resultFor))
        .toEqual(['provider-report', 'read', 'fixed'])
      expect(state.messages.at(-1)?.value.context?.reviewReport).toEqual({ snapshot, report })
    } finally { h.db.close() }
  })

  it.each(['raw', 'preflight', 'presentation'] as const)('resumes a saved %s without calling the model or dispatching the report', async phase => {
    const h = fixture()
    try {
      h.accept()
      if (phase !== 'raw') {
        const before = h.store.load('thread')!, prepared = await prepareConversationToolBatch(before, h.options)
        if ('kind' in prepared) throw new Error('Unexpected approval')
        h.store.prepareTools(scope(before), prepared.calls, prepared.approvals, prepared.context)
      }
      if (phase === 'presentation') {
        const state = h.store.load('thread')!
        h.store.finishBatch(scope(state), [], completeConversationReview(state, snapshot))
      }
      h.services.store = new NativeExecutionStore(h.db)
      expect((await conversationExecution(h.services).execute('continue', request, h.observer)).result.status).toBe('fulfilled')
      const state = h.services.store.load('thread')!
      expect(state.messages.map(message => message.id)).toEqual(['user', 'model', 'application-report:result', 'run:review-report'])
      expect(state.messages.at(-1)!.value.context?.projectRulesReceipt).toEqual({ runId: 'run', scopes: [] })
      expect(state.messages.at(-1)!.value.usage).toBeUndefined()
      expect(h.services.executeTool).not.toHaveBeenCalled()
    } finally { h.db.close() }
  })

  it('rolls report presentation and batch acceptance back together before retry', async () => {
    let fail = false
    const h = fixture(commit => { if (fail && commit.phase === 'model_result') throw new Error('commit failed') })
    try {
      h.accept()
      const before = h.store.load('thread')!, prepared = await prepareConversationToolBatch(before, h.options)
      if ('kind' in prepared) throw new Error('Unexpected approval')
      h.store.prepareTools(scope(before), prepared.calls)
      const state = h.store.load('thread')!, message = completeConversationReview(state, snapshot)!
      fail = true
      expect(() => h.store.finishBatch(scope(state), [], message)).toThrow('commit failed')
      expect(h.store.load('thread')).toEqual(state)
      fail = false
      h.store.finishBatch(scope(state), [], message)
      expect(h.store.load('thread')!.phase).toBe('model_result')
      expect(h.store.load('thread')!.messages.at(-1)!.id).toBe(message.id)
    } finally { h.db.close() }
  })

  it('refuses a changed snapshot, a missing saved result, or a report mixed with investigation', async () => {
    const h = fixture()
    try {
      h.accept()
      const state = h.store.load('thread')!
      expect(() => conversationReviewResults(state, { ...snapshot, description: 'changed' })).toThrow('identity')
      expect(() => completeConversationReview(state, snapshot)).toThrow('matching durable')
      const mixed = structuredClone(state)
      mixed.response!.value.calls!.push({ id: 'read', name: 'read_file', args: { path: 'file' } })
      expect(() => conversationReviewResults(mixed, snapshot)).toThrow('separately from investigation')
      expect(h.store.load('thread')).toEqual(state)
    } finally { h.db.close() }
  })

  it('keeps the saved report readable as text blocks and later normal replies ordinary', async () => {
    const h = fixture(), review = { ...report, limitations: ['Tests not run.'] }
    try {
      h.accept(review)
      expect((await conversationExecution(h.services).execute('continue', request, h.observer)).result.status).toBe('fulfilled')
      const state = h.store.load('thread')!, final = state.messages.at(-1)!
      expect(presentConversationMessage(final.value, 'fallback')).toMatchObject({
        codeReview: { report: review }, content: [{ type: 'text', text: 'Review completed\n\nTests not run.' }]
      })
      const blocks = decodeConversationMessage(encodeConversationMessage({ ...final.value, content: [{ type: 'text', text: final.value.content }] }))
      expect(presentConversationMessage(blocks, 'fallback').codeReview?.report).toEqual(review)
      h.store.start({ threadId: 'thread', runId: 'next', expectedRevisionId: state.revisionId,
        context: { ...state.context, modelCalls: 0 }, messages: [{ id: 'next:input', value: { kind: 'user', content: 'Thanks' } }] })
      h.services.completeResponse = undefined
      h.services.prepareModel = modelPreparation(h, async () => Response.json({ id: 'next', object: 'chat.completion', model: 'fixture', created: 1,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'You are welcome.' } }] }), { review: false })
      expect((await conversationExecution(h.services).execute('continue', { ...request, runId: 'next' }, h.observer)).result.status).toBe('fulfilled')
      const next = h.store.load('thread')!
      expect(presentConversationMessage(next.messages.at(-1)!.value, 'next').codeReview).toBeUndefined()
      expect(next.messages.filter(message => message.id === final.id)).toHaveLength(1)
    } finally { h.db.close() }
  })

  it.each(['plain', 'mixed'] as const)('rejects a $mode answer without completing a structured review', async mode => {
    const h = fixture()
    try {
      h.services.prepareModel = modelPreparation(h, async () => Response.json({ id: 'plain', object: 'chat.completion', model: 'fixture', created: 1,
        choices: [{ index: 0, finish_reason: mode === 'plain' ? 'stop' : 'tool_calls', message: { role: 'assistant', content: 'Looks good.',
          ...(mode === 'mixed' ? { tool_calls: [
            { type: 'function', id: 'report', function: { name: codeReviewToolName, arguments: JSON.stringify(report) } },
            { type: 'function', id: 'investigate', function: { name: 'read_file', arguments: JSON.stringify({ path: '/repo/a' }) } }
          ] } : {}) } }] }))
      const result = await conversationExecution(h.services).execute('continue', request, h.observer)
      expect(result.result).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringContaining(mode === 'plain' ? 'required structured report' : 'separately from investigation') }) })
      expect(h.store.load('thread')!.messages.some(message => message.value.context?.reviewReport)).toBe(false)
      expect(h.services.executeTool).not.toHaveBeenCalled()
    } finally { h.db.close() }
  })

  it.each(['small-context', 'responses-instructions'] as const)('rejects %s before making a review model request', async mode => {
    const h = fixture(), providerFetch = vi.fn<typeof fetch>(async () => { throw new Error('Transport must not run') })
    try {
      const selected: ResolvedModelConfig = mode === 'small-context' ? { ...model, maxContextTokens: 20, maxOutputTokens: 1 }
        : { ...model, protocol: 'openai_responses', maxContextTokens: 100_000, parameters: { instructions: 'x'.repeat(260_000) } }
      h.services.prepareModel = modelPreparation(h, providerFetch, { model: selected })
      const outcome = (await conversationExecution(h.services).execute('continue', request, h.observer)).result
      expect(outcome.status).toBe('rejected')
      if (outcome.status !== 'rejected') throw new Error('Expected context rejection')
      expect(isModelSelectionError(outcome.reason)).toBe(true)
      expect(providerFetch).not.toHaveBeenCalled()
    } finally { h.db.close() }
  })

})
