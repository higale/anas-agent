import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { modelToolDeclaration } from './modelToolDeclarations'

import { createConversationModel } from './conversationModel'
import { countConversationTokens, conversationRequestKey } from './conversationContext'
import type { ResolvedModelConfig } from '../../shared/types'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

describe('shared model tool declaration', () => {
  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('sends and budgets the same declaration for %s', async protocol => {
    let request: Record<string, unknown> = {}
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      request = JSON.parse(String(init?.body))
      return Response.json(protocol === 'anthropic_messages'
        ? { id: 'm', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: 'end_turn' }
        : protocol === 'openai_responses' ? { id: 'r', object: 'response', model: 'fixture', output: [], status: 'completed' }
          : { id: 'c', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }] })
    }
    const tool = { name: 'read', description: 'Read a file', inputSchema: z.object({ path: z.string(), flag: z.boolean().default(false) }), extras: { defer_loading: true } }
    const model = createConversationModel({ id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol,
      baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture', parameters: {}, parameterPresetMode: 'none',
      capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
      contextCompressionThreshold: 0.8, contextCompressionEnabled: true }, { providerFetch: fetch })
    await model.invoke({ messages: [{ kind: 'user', content: 'Read' }], tools: [tool], signal: new AbortController().signal })
    const declaration = modelToolDeclaration(tool, protocol)
    expect(request.tools).toEqual([declaration])
    expect(countConversationTokens([], [tool], { protocol })).toBe(Math.ceil(JSON.stringify(declaration).length / 4))
    expect(declaration).toHaveProperty('defer_loading', true)
  })

  it('calibrates custom and provider tools against their actual public definitions', () => {
    const shared = { messages: [], systemMessage: undefined, protocol: 'openai_responses' as const }
    const first = { name: 'native', inputSchema: z.object({}), extras: { providerToolDefinition: { type: 'web_search', search_context_size: 'low' } } }
    const second = { ...first, extras: { providerToolDefinition: { type: 'web_search', search_context_size: 'high' } } }
    expect(conversationRequestKey({ ...shared, tools: [first] })).not.toBe(conversationRequestKey({ ...shared, tools: [second] }))
    const custom = { name: 'apply_patch', inputSchema: z.object({ patch: z.string() }), metadata: { codexApplyPatch: true } }
    expect(modelToolDeclaration(custom, 'openai_responses')).toMatchObject({ type: 'custom', name: 'apply_patch', format: { type: 'grammar' } })
    expect(modelToolDeclaration(custom, 'openai_chat_completions')).toMatchObject({ type: 'function', function: { name: 'apply_patch' } })
  })
})
