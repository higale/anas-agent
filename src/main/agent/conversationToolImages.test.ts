import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { ResolvedModelConfig } from '@shared/types'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { RunObserver } from '../../runtime/runExecution'
import { isToolImageBlock } from '../../runtime/conversationHistory'
import { conversationRequestKey, conversationContextTokens, countConversationTokens, projectConversationToolImages } from './conversationContext'
import { conversationPendingImageStart } from './conversationHistoryProjection'
import { NativeExecutionStore, nativeExecutionSchema } from './nativeExecutionStore'
import { createConversationModelPreparation } from './conversationModelExecution'

vi.mock('../config/apiKeys', () => ({ resolveModelApiKey: (model: ResolvedModelConfig) => model.apiKey }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
function hasToolImages(message: ConversationMessage) {
  return message.kind === 'tool' && Array.isArray(message.content) && message.content.some(isToolImageBlock)
}

const image = { type: 'image', source_type: 'base64', data: 'SCREENSHOT_BASE64', mime_type: 'image/png' }
function result(id = 'capture') {
  return { kind: 'tool' as const, id: `${id}-result`, name: 'capture', resultFor: id,
    content: [{ type: 'text', text: 'Captured window 123' }, image,
      { type: 'image_url', image_url: { url: 'data:image/png;base64,SECOND_IMAGE' } }],
    artifact: { original: image }, resultMetadata: { provenance: 'mcp' }, resultStatus: 'success' as const }
}
function call(id = 'capture') {
  return { kind: 'assistant' as const, content: '', calls: [{ name: 'capture', args: {}, id }] }
}

describe('tool image request lifetime', () => {
  it('preserves every pending image and removes only observed tool images without mutating history', () => {
    const old = result('old'), fresh = result('fresh')
    const attachment = { kind: 'user' as const, content: [image] }
    const messages = [attachment, call('old'), old, call('fresh'), fresh]
    const before = JSON.stringify(messages)
    const projected = projectConversationToolImages(messages)
    expect(hasToolImages(projected[2])).toBe(false)
    expect(projected[2]).toMatchObject({ id: old.id, name: old.name, resultFor: 'old', artifact: old.artifact,
      resultStatus: 'success', resultMetadata: { provenance: 'mcp' } })
    expect(JSON.stringify(projected[2].content)).toContain('Captured window 123')
    expect(projected[4]).toBe(fresh)
    expect(projected[0]).toBe(attachment)
    expect(JSON.stringify(messages)).toBe(before)
    expect(projectConversationToolImages(projected)).toEqual(projected)
    expect(conversationPendingImageStart(projected)).toBe(3)
  })

  it('does not interpret a compression response or another agent response as consuming images', () => {
    const parent = [call(), result()]
    const child = [call('child'), result('child'), { kind: 'assistant' as const, content: 'Child observed image' }]
    expect(hasToolImages(projectConversationToolImages(child)[1])).toBe(false)
    expect(projectConversationToolImages(parent)).toEqual(parent)
    const compression = { kind: 'assistant' as const, content: 'Summary', context: { summary: true } }
    expect(projectConversationToolImages([...parent, compression])[1]).toBe(parent[1])
    expect(projectConversationToolImages([...parent, { kind: 'user' as const, content: 'Queued direction' }])[1]).toBe(parent[1])
  })

  it('leaves arbitrary base64 text and non-image blocks intact', () => {
    const text = { kind: 'tool' as const, resultFor: 'text', content: JSON.stringify(image) }
    const audio = { kind: 'tool' as const, resultFor: 'audio', content: [{ type: 'audio', data: 'AUDIO' }] }
    const messages = [text, audio, { kind: 'assistant' as const, content: 'Read' }]
    expect(projectConversationToolImages(messages)).toEqual(messages)
  })

  it('retains every image in a parallel batch until the next response', () => {
    const ids = Array.from({ length: 6 }, (_, index) => `parallel-${index}`)
    const request = { kind: 'assistant' as const, content: '', calls: ids.map((id) => ({ id, name: 'capture', args: {} })) }
    const messages = [request, ...ids.map(result)]
    expect(projectConversationToolImages(messages)).toEqual(messages)
    expect(projectConversationToolImages([...messages, { kind: 'assistant' as const, content: 'Compared all screens' }]).filter(hasToolImages)).toHaveLength(0)
    expect(messages.filter(hasToolImages)).toHaveLength(6)
  })

  it('invalidates only the usage snapshot that included the newly omitted images', () => {
    const response = (input: ConversationMessage[]) => ({ kind: 'assistant' as const, content: 'Observed',
      context: { requestKey: conversationRequestKey({ messages: input, systemMessage: { kind: 'system', content: '' }, tools: [], protocol: 'openai_chat_completions' }) }, usage: {
      input_tokens: 9000, output_tokens: 100, total_tokens: 9100
    } })
    const input = [call(), result()]
    const messages = [...input, response(input)]
    expect(conversationContextTokens({ messages, systemMessage: { kind: 'system', content: '' }, tools: [], protocol: 'openai_chat_completions' })).toBeLessThan(9100)
    const nextInput = projectConversationToolImages([...messages, { kind: 'user' as const, content: 'Continue' }])
    const next = [...nextInput, response(nextInput)]
    expect(conversationContextTokens({ messages: next, systemMessage: { kind: 'system', content: '' }, tools: [], protocol: 'openai_chat_completions' }))
      .toBe(9000 + countConversationTokens(next.slice(-1), [], { protocol: 'openai_chat_completions' }))
  })


  it('keeps images across a failed request and SQLite restart, then omits them after a committed response', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-tool-images-'))
    const path = join(root, 'state.sqlite')
    let database = new Database(path)
    database.pragma('foreign_keys=ON')
    database.exec(nativeExecutionSchema)
    let store = new NativeExecutionStore(database)
    const model: ResolvedModelConfig = {
      id: 'fixture', displayName: '', providerId: 'fixture', providerName: 'Fixture', protocol: 'openai_chat_completions',
      baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'fixture-key', parameters: {}, parameterPresetMode: 'none',
      capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 128000, maxOutputTokens: 16000,
      contextCompressionThreshold: 0.8, contextCompressionEnabled: true
    }
    const inputs: unknown[] = []
    let fail = true
    const fetch: typeof globalThis.fetch = async (_url, init) => {
      inputs.push(JSON.parse(String(init?.body)))
      if (fail) return Response.json({ error: { message: 'Model request failed after receiving the image' } }, { status: 400 })
      return Response.json({ id: 'response-' + inputs.length, object: 'chat.completion', model: 'fixture', created: 1,
        choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Image processed' } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } })
    }
    const observer: RunObserver = { started: vi.fn(), startModel: vi.fn(() => 'model'), discardModel: vi.fn(),
      model: vi.fn(), tool: vi.fn(), approval: vi.fn(), committed: vi.fn(async () => {}) }
    const invoke = async () => {
      const state = store.load('thread')!
      const preparation = createConversationModelPreparation({ store, resolveModel: async () => model,
        systemPrompt: () => 'Inspect images', tools: () => [], requiresTools: () => true, maxModelCalls: 0,
        providerFetch: fetch, outputLanguage: { code: 'en', name: 'English' }, compressionTracking: {},
        saveToolResult: async () => { throw new Error('Unexpected oversized result') } })
      const prepared = await preparation(state, { threadId: 'thread', runId: state.runId, signal: new AbortController().signal }, observer)
      if (prepared.kind !== 'model') throw new Error('Expected a model request')
      return prepared.invoke()
    }
    const scope = () => ({ threadId: 'thread', runId: store.load('thread')!.runId, expectedRevisionId: store.load('thread')!.revisionId })
    try {
      const original = result()
      store.start({ threadId: 'thread', runId: 'run', context: { modelCalls: 1, todos: [] }, messages: [
        { id: 'input', value: { kind: 'user', content: 'Capture' } },
        { id: 'call', value: call() }, { id: 'capture-result', value: original }
      ] })
      await expect(invoke()).rejects.toThrow('Model request failed')
      expect(JSON.stringify(inputs.at(-1))).toContain('SCREENSHOT_BASE64')
      expect(store.load('thread')!.phase).toBe('prepare_model')
      database.close()
      database = new Database(path)
      database.pragma('foreign_keys=ON')
      store = new NativeExecutionStore(database)
      fail = false
      const response = await invoke()
      expect(JSON.stringify(inputs.at(-1))).toContain('SCREENSHOT_BASE64')
      store.acceptModel(scope(), response.message, response.calls, response.context)
      store.finish(scope(), 'completed')
      store.start({ ...scope(), runId: 'next-run', context: { modelCalls: 0, todos: [] },
        messages: [{ id: 'next-input', value: { kind: 'user', content: 'Continue' } }] })
      await invoke()
      expect(inputs).toHaveLength(3)
      expect(JSON.stringify(inputs.at(-1))).not.toContain('SCREENSHOT_BASE64')
      expect(JSON.stringify(inputs.at(-1))).not.toContain('SECOND_IMAGE')
      const stored = store.load('thread')!.messages.find(message => hasToolImages(message.value))
      expect(stored?.value).toEqual(original)
    } finally {
      database.close()
      rmSync(root, { recursive: true, force: true })
    }
  })
})
