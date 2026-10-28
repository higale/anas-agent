import { describe, expect, it, vi } from 'vitest'
import type { ResolvedModelConfig } from '@shared/types'
import type { CodeReviewSnapshot } from '@shared/codeReview'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { modelContextKey } from '@shared/modelConfig'
import { codeReviewToolDeclaration } from '../../runtime/codeReviewReport'
import { ModelContextOverflowError, ModelRequestChangedError, ModelSelectionError } from '../../runtime/errors'
import { prepareConversationModelCall, type PreparedConversationContext } from './conversationRequest'
import { conversationContextTokens, conversationRequestKey, countConversationTokens, projectConversationSkills } from './conversationContext'
import { codeReviewPrompt } from './codeReview'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../projectStore', () => ({ getProject: vi.fn() }))
vi.mock('../gitChanges', () => ({ queryGitChanges: vi.fn() }))

const model: ResolvedModelConfig = {
  id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol: 'openai_chat_completions',
  baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
  contextCompressionThreshold: 0.8, contextCompressionEnabled: true
}
const context = (): PreparedConversationContext => ({ messages: [{ id: 'user', kind: 'user', content: 'hello' }],
  systemMessage: { kind: 'system', content: 'Instructions' }, tools: [], requiresTools: false })
const response = (calls: unknown[] = []) => Response.json({ id: 'response', object: 'chat.completion', model: 'fixture', created: 1,
  choices: [{ index: 0, finish_reason: calls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: 'Answer', tool_calls: calls } }],
  usage: { prompt_tokens: 9000, completion_tokens: 2, total_tokens: 9002 } })
const options = () => ({ runId: 'run', signal: new AbortController().signal, resolveModel: async () => model,
  now: () => '2026-10-27T00:00:00.000Z', providerFetch: vi.fn(async () => response()) })
const review: CodeReviewSnapshot = { id: 'a'.repeat(64), projectId: 'project', capturedAt: '2026-10-27T00:00:00.000Z',
  request: { kind: 'recorded', threadId: 'thread', runId: 'source', version: 'b'.repeat(64), target: 'recorded' },
  description: 'Fixture change', limitations: [], files: [{ id: 'file', path: 'a.ts', patch: '-old\n+new', before: [{ start: 1, end: 1 }], after: [{ start: 1, end: 1 }] }] }

describe('native prepared conversation request', () => {
  it('sends the expanded Skill context and binds reported usage to the exact request', async () => {
    const source = context(), requests: Record<string, unknown>[] = []
    source.messages = [{ id: 'skill', kind: 'user', content: '/review\n\n<skill>\nReview carefully.\n</skill>', context: { displayText: '/review' } }]
    const before = structuredClone(source)
    const call = await prepareConversationModelCall(model, source, { ...options(), providerFetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return response()
    } })
    const result = await call.invoke()
    expect(requests[0].messages).toEqual([
      { role: 'system', content: 'Instructions' }, { role: 'user', content: '/review' }, { role: 'user', content: '<skill>\nReview carefully.\n</skill>' }
    ])
    expect(result.message.context).toEqual({ runId: 'run', createdAt: '2026-10-27T00:00:00.000Z', modelContextKey: modelContextKey(model), requestKey: call.requestKey })
    expect(conversationContextTokens({ ...source, messages: [...source.messages, result.message], protocol: model.protocol, modelContextKey: modelContextKey(model) }))
      .toBe(9000 + countConversationTokens([result.message], [], { protocol: model.protocol }))
    expect(conversationRequestKey({ ...source, messages: projectConversationSkills(source.messages), protocol: model.protocol })).toBe(call.requestKey)
    expect(source).toEqual(before)
  })

  it('does not send a request after model settings change during preparation or before dispatch', async () => {
    const current = options(), changed = { ...model, model: 'changed' }
    await expect(prepareConversationModelCall(model, context(), { ...current, resolveModel: async () => changed })).rejects.toBeInstanceOf(ModelRequestChangedError)
    let selected = model
    const call = await prepareConversationModelCall(model, context(), { ...current, resolveModel: async () => selected })
    selected = changed
    await expect(call.invoke()).rejects.toBeInstanceOf(ModelRequestChangedError)
    expect(current.providerFetch).not.toHaveBeenCalled()
  })

  it('retains an already returned response when model selection changes during transport', async () => {
    let selected = model
    const call = await prepareConversationModelCall(model, context(), { ...options(), resolveModel: async () => selected,
      providerFetch: async () => { selected = { ...model, model: 'next' }; return response() } })
    const result = await call.invoke()
    expect(result.text).toBe('Answer')
    expect(result.message.context?.modelContextKey).toBe(modelContextKey(model))
  })

  it.each(['default', 'configured', 'empty'] as const)('preserves Anthropic %s cache behavior', async mode => {
    const parameters = mode === 'configured' ? { cache_control: { type: 'ephemeral', ttl: '1h' } } : {}
    const selected = { ...model, protocol: 'anthropic_messages' as const, parameters }
    const source = context(), requests: Record<string, unknown>[] = []
    if (mode === 'empty') { source.messages = []; source.systemMessage = { kind: 'system', content: '' } }
    const before = structuredClone(source)
    const call = await prepareConversationModelCall(selected, source, { ...options(), resolveModel: async () => selected, providerFetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return Response.json({ id: 'response', type: 'message', role: 'assistant', model: 'fixture', content: [{ type: 'text', text: 'Answer' }], stop_reason: 'end_turn' })
    } })
    await call.invoke()
    if (mode === 'empty') expect(requests[0].cache_control).toBeUndefined()
    else {
      expect(requests[0].cache_control).toEqual({ type: 'ephemeral', ttl: mode === 'configured' ? '1h' : '5m' })
      expect(requests[0].system).toEqual([{ type: 'text', text: 'Instructions', cache_control: { type: 'ephemeral' } }])
    }
    expect(source).toEqual(before)
  })

  it('reinstates the fixed review scope once and requires an investigation or report tool', async () => {
    const source = { ...context(), review }, requests: Record<string, unknown>[] = []
    const declaration = codeReviewToolDeclaration(review.id)
    source.tools = [declaration]
    source.messages = [{ kind: 'user', content: codeReviewPrompt(review) }]
    const call = await prepareConversationModelCall(model, source, { ...options(), providerFetch: async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)))
      return response([{ type: 'function', id: 'call', function: { name: declaration.function.name, arguments: '{}' } }])
    } })
    expect((await call.invoke()).message.calls?.[0].name).toBe(declaration.function.name)
    expect(requests[0].tool_choice).toBe('required')
    expect(requests[0].tools).toHaveLength(1)
    expect(requests[0].messages).toHaveLength(2)
    const incomplete = await prepareConversationModelCall(model, { ...context(), review }, options())
    await expect(incomplete.invoke()).rejects.toThrow('required structured report')
  })

  it('stops unsupported tools, images and excessive context before transport', async () => {
    const current = options()
    const noTools = { ...model, capabilities: { ...model.capabilities, toolUse: false } }
    await expect(prepareConversationModelCall(noTools, { ...context(), requiresTools: true }, { ...current, resolveModel: async () => noTools })).rejects.toBeInstanceOf(ModelSelectionError)
    const noImages = { ...model, capabilities: { ...model.capabilities, vision: false } }
    await expect(prepareConversationModelCall(noImages, { ...context(), messages: [{ kind: 'user', content: [{ type: 'image_url', image_url: { url: 'https://fixture.invalid/image.png' } }] }] },
      { ...current, resolveModel: async () => noImages })).rejects.toBeInstanceOf(ModelSelectionError)
    const small = { ...model, maxContextTokens: 100, maxOutputTokens: 10 }
    await expect(prepareConversationModelCall(small, { ...context(), messages: [{ kind: 'user', content: 'Required history '.repeat(200) }] },
      { ...current, resolveModel: async () => small })).rejects.toBeInstanceOf(ModelContextOverflowError)
    await expect(prepareConversationModelCall(small, { ...context(), review }, { ...current, resolveModel: async () => small })).rejects.toThrow('captured review is too large')
    expect(current.providerFetch).not.toHaveBeenCalled()
  })

  it('does not calibrate against usage whose original image input is now consumed', () => {
    const messages: ConversationMessage[] = [
      { kind: 'assistant', content: '', calls: [{ id: 'image', name: 'view_image', args: {} }] },
      { kind: 'tool', resultFor: 'image', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }
    ]
    const key = conversationRequestKey({ messages, tools: [], protocol: model.protocol })
    messages.push({ kind: 'assistant', content: 'Saw it', usage: { input_tokens: 50000, output_tokens: 1, total_tokens: 50001 }, context: { requestKey: key } })
    expect(conversationContextTokens({ messages, tools: [], protocol: model.protocol })).toBeLessThan(1000)
    expect(messages[1].content).toEqual([{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }])
  })
})
