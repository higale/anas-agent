import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { z as z3 } from 'zod/v3'
import { toolJsonSchema } from '../../runtime/toolSchema'
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
    const tools = [
      z3.object({ path: z3.string(), flag: z3.boolean().default(false) }),
      z.object({ path: z.string(), flag: z.boolean().default(false) })
    ].map((inputSchema, index) => ({ name: `read_${index}`, description: 'Read a file', inputSchema, extras: { defer_loading: true } }))
    const externalSchema = { $schema: 'https://json-schema.org/draft/2019-09/schema', type: 'object',
      properties: { value: { type: 'string' } }, additionalProperties: false }
    const external = { name: 'external', inputSchema: externalSchema }
    const model = createConversationModel({ id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol,
      baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture', parameters: {}, parameterPresetMode: 'none',
      capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
      contextCompressionThreshold: 0.8, contextCompressionEnabled: true }, { providerFetch: fetch })
    await model.invoke({ messages: [{ kind: 'user', content: 'Read' }], tools: [...tools, external], signal: new AbortController().signal })
    const declarations = [...tools, external].map(tool => modelToolDeclaration(tool, protocol))
    expect(request.tools).toEqual(declarations)
    const schemaPath = protocol === 'openai_chat_completions' ? 'function.parameters'
      : protocol === 'anthropic_messages' ? 'input_schema' : 'parameters'
    for (const [index, tool] of tools.entries()) {
      const declaration = declarations[index]
      expect(declaration).not.toHaveProperty(`${schemaPath}.$schema`)
      expect(declaration).toHaveProperty(`${schemaPath}.additionalProperties`, false)
      expect(declaration).toHaveProperty(`${schemaPath}.required`, ['path'])
      expect(declaration).toHaveProperty(`${schemaPath}.properties.flag.default`, false)
      expect(toolJsonSchema(tool.inputSchema)).toHaveProperty('$schema')
      expect(countConversationTokens([], [tool], { protocol })).toBe(Math.ceil(JSON.stringify(declaration).length / 4))
      expect(declaration).toHaveProperty('defer_loading', true)
    }
    expect(declarations.at(-1)).toHaveProperty(schemaPath, externalSchema)
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

it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('requires approval metadata only in smart JSON declarations for %s', protocol => {
  const tool = { name: 'apply_patch', inputSchema: z.object({ patch: z.string() }).strict(), metadata: { codexApplyPatch: true } }
  const normal = modelToolDeclaration(tool, protocol)
  const smart = modelToolDeclaration({ ...tool, metadata: { ...tool.metadata, smartApproval: true } }, protocol)
  if (protocol === 'openai_responses') { expect(smart).toEqual(normal); expect(smart.type).toBe('custom'); return }
  const path = protocol === 'openai_chat_completions' ? 'function.parameters' : 'input_schema'
  expect(normal).not.toHaveProperty(`${path}.properties.needs_approval`)
  expect(smart).toHaveProperty(`${path}.properties.needs_approval.default`, true)
  expect(smart).toHaveProperty(`${path}.required`, ['patch', 'needs_approval'])
  expect(smart).toHaveProperty(`${path}.additionalProperties`, false)
  expect(modelToolDeclaration(tool, protocol)).toEqual(normal)
  expect(countConversationTokens([], [{ ...tool, metadata: { ...tool.metadata, smartApproval: true } }], { protocol })).toBe(Math.ceil(JSON.stringify(smart).length / 4))
})

it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('retains mixed historical approval arguments while changing current declarations in %s', async protocol => {
  const requests: Record<string, any>[] = []
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    requests.push(JSON.parse(String(init?.body)))
    return Response.json(protocol === 'anthropic_messages'
      ? { id: 'm', type: 'message', role: 'assistant', model: 'fixture', content: [], stop_reason: 'end_turn' }
      : protocol === 'openai_responses' ? { id: 'r', object: 'response', model: 'fixture', output: [], status: 'completed' }
        : { id: 'c', object: 'chat.completion', model: 'fixture', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: '' } }] })
  }
  const model = createConversationModel({ id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol,
    baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture', parameters: {}, parameterPresetMode: 'none',
    capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
    contextCompressionThreshold: 0.8, contextCompressionEnabled: true }, { providerFetch: fetch })
  const messages = [{ kind: 'user' as const, content: 'Create files' }, ...[{}, { needs_approval: false }, { needs_approval: true }].flatMap((flag, index) => [
    { kind: 'assistant' as const, content: '', calls: [{ id: `call-${index}`, name: 'write_file', args: { path: `${index}.txt`, ...flag } }] },
    { kind: 'tool' as const, content: 'Written', resultFor: `call-${index}` }
  ]), { kind: 'user' as const, content: 'Continue' }]
  const original = structuredClone(messages)
  for (const smartApproval of [true, false, true, false]) {
    await model.invoke({ messages, tools: [{ name: 'write_file', inputSchema: z.object({ path: z.string() }).strict(), metadata: { smartApproval } }], signal: new AbortController().signal })
    const request = requests.at(-1)!
    const schema = protocol === 'openai_chat_completions' ? request.tools[0].function.parameters
      : protocol === 'openai_responses' ? request.tools[0].parameters : request.tools[0].input_schema
    expect(Boolean(schema.properties.needs_approval)).toBe(smartApproval)
    expect(schema.required).toEqual(smartApproval ? ['path', 'needs_approval'] : ['path'])
    const history = protocol === 'openai_responses' ? request.input : request.messages
    expect(JSON.stringify(history)).toContain('needs_approval')
    if (requests.length > 1) expect(history).toEqual(protocol === 'openai_responses' ? requests[0].input : requests[0].messages)
  }
  expect(messages).toEqual(original)
})
