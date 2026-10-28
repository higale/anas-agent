import { defaultCapabilities, } from '@shared/agentCapabilities'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { modelContextKey } from '@shared/modelConfig'
import type { ResolvedModelConfig } from '@shared/types'
import { createConversationContextRuntime as createConversationContextRuntimeBase } from './conversationContextRuntime'
import { countConversationTokens, projectConversationToolImages, conversationRequestKey as requestKey } from './conversationContext'
import { contextStatusForModel } from '@shared/contextWindow'
import { ModelRequestChangedError, ModelSelectionError } from '../../runtime/errors'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConversationAttachmentProjector } from './conversationAttachments'

import { projectRulesText } from '../../runtime/projectRules'

function contextRequestKey(options: Omit<Parameters<typeof requestKey>[0], 'messages' | 'protocol'> & Partial<Pick<Parameters<typeof requestKey>[0], 'messages' | 'protocol'>>) {
  return requestKey({ messages: [], protocol: 'openai_chat_completions', ...options })
}

const { createCompressionModelMock, invokeMock } = vi.hoisted(() => {
  const invoke = vi.fn()
  return {
    createCompressionModelMock: vi.fn((_model: ResolvedModelConfig, options: { beforeRequest?: () => Promise<void> }) => async (...args: unknown[]) => {
      await options.beforeRequest?.()
      return invoke(...args)
    }),
    invokeMock: invoke
  }
})

vi.mock('./compressionModel', () => ({
  createCompressionModel: createCompressionModelMock
}))

const model: ResolvedModelConfig = {
  id: 'test',
  displayName: '',
  providerId: 'provider-test',
  providerName: 'Test',
  protocol: 'openai_chat_completions',
  baseUrl: '',
  model: 'test-model',
  parameters: {},
  parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true },
  stream: true,
  maxContextTokens: 10_000,
  maxOutputTokens: 1_000,
  contextCompressionThreshold: 0.8,
  contextCompressionEnabled: true
}

const outputLanguage = {
  code: 'zh-CN',
  name: '简体中文'
}

function createConversationContextRuntime(
  options: Omit<Parameters<typeof createConversationContextRuntimeBase>[0], 'outputLanguage' | 'resolveModel' | 'tools' | 'systemPrompt'> & {
    model: ResolvedModelConfig
    tools: ReturnType<Parameters<typeof createConversationContextRuntimeBase>[0]['tools']>
    systemPrompt: ReturnType<Parameters<typeof createConversationContextRuntimeBase>[0]['systemPrompt']>
  }
) {
  const { model: selectedModel, tools, systemPrompt, ...rest } = options
  return createConversationContextRuntimeBase({ ...rest, resolveModel: async () => selectedModel, tools: () => tools,
    systemPrompt: () => systemPrompt, outputLanguage })
}

describe('ConversationContextRuntime', () => {
  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('invalidates %s usage when attachment text changes, is truncated, or leaves the request', async (protocol) => {
    const directory = await mkdtemp(join(tmpdir(), 'anas-context-attachment-usage-'))
    try {
      const path = join(directory, 'context.txt')
      await writeFile(path, 'Original attachment '.repeat(100))
      const selected = { ...model, protocol }
      const source = { kind: 'user' as const, id: 'input', content: 'Read attachment' }
      const artifact = { id: 'file', threadId: 'thread', messageId: source.id!, runId: 'first', name: 'context.txt',
        mimeType: 'text/plain', size: 2000, kind: 'text' as const, path, available: true, textTruncated: false,
        contextPolicy: 'one_turn' as const, createdAt: '' }
      const projector = (currentRunId = 'first', textMaxChars = 10000) => createConversationAttachmentProjector({
        artifacts: [artifact], currentRunId, textMaxChars, textOverflow: 'truncate'
      })
      const original = projector()
      const systemMessage = { kind: 'system' as const, content: 'System' }
      const response = { kind: 'assistant' as const, content: 'Read it', context: {
        modelContextKey: modelContextKey(selected), requestKey: contextRequestKey({
          protocol, systemMessage, tools: [], messages: await original.project([source], true)
        })
      }, usage: { input_tokens: 8000, output_tokens: 3, total_tokens: 8003 } }
      const messages = [source, response, { kind: 'user' as const, content: 'Continue' }]
      const status = (project: ReturnType<typeof projector>) => createConversationContextRuntime({ model: selected,
        systemPrompt: 'System', tools: [], projectMessages: items => project.project(items, true)
      }).projectedStatus({ messages })
      expect((await status(original)).currentContextTokens).toBeGreaterThan(8000)
      expect((await status(projector())).currentContextTokens).toBeGreaterThan(8000)
      for (const project of [projector('second'), projector('first', 100)]) {
        const changed = await status(project)
        expect(changed.currentContextTokens).toBe(changed.estimatedInputTokens)
      }
      await writeFile(path, 'Changed attachment')
      const changed = await status(projector())
      expect(changed.currentContextTokens).toBe(changed.estimatedInputTokens)
      expect(changed.currentContextTokens).toBeLessThan(100)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('uses the shared system projection for stored history estimates and manual compression budgets', async () => {
    const system = { kind: 'system' as const, content: 'Base instructions\n\nRecalled memory ' + 'm'.repeat(400) }
    const projectSystemMessage = vi.fn(async (_system: ConversationMessage, _messages: ConversationMessage[]) => system)
    const runtime = createConversationContextRuntime({ model, systemPrompt: 'Base instructions', tools: [], projectSystemMessage })
    const messages = [{ kind: 'user' as const, content: 'Original request' }, { kind: 'assistant' as const, content: 'Original response' }]
    const projected = await runtime.projectedStatus({ messages })
    expect(projected.estimatedInputTokens).toBe(runtime.statusFromMessages(messages, model, { systemMessage: system, tools: [] }).estimatedInputTokens)
    const compressed = await runtime.compress({ messages }, new AbortController().signal)
    expect(compressed.inputTokensBefore).toBe(projected.estimatedInputTokens)
    expect(compressed.inputTokensAfter).toBe(runtime.statusFromMessages([{ kind: 'user' as const, content: compressed.modelContent }], model,
      { systemMessage: system, tools: [] }).estimatedInputTokens)
    for (const [, source] of projectSystemMessage.mock.calls) {
      expect(source).toEqual(messages)
    }
  })

  it('keeps the pre-summary recall query while projecting only effective attachments', async () => {
    const hidden = { kind: 'user' as const, id: 'hidden', content: 'Original user question now summarized' }
    const visible = { kind: 'user' as const, id: 'visible', content: 'Current user question' }
    const attachment = { ...visible, content: 'Current user question with attachment text' }
    const summary = { kind: 'user' as const, content: 'Summary', context: { summary: true } }
    const projectSystemMessage = vi.fn(async (_system: ConversationMessage, _messages: ConversationMessage[]): Promise<ConversationMessage> => ({ kind: 'system', content: 'Recalled memory' }))
    const projectMessages = vi.fn(async (messages: ConversationMessage[]) => messages.map(message => message.id === 'visible' ? attachment : message))
    const runtime = createConversationContextRuntime({ model, systemPrompt: '', tools: [], projectMessages, projectSystemMessage })
    await runtime.projectedStatus({ messages: [hidden, visible], summary: { cutoffIndex: 1, message: summary } })
    expect(projectMessages).toHaveBeenCalledWith([summary, visible], model)
    expect(projectSystemMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'system' }), [hidden, attachment])
    await runtime.projectedStatus({ messages: [hidden], summary: { cutoffIndex: 1, message: summary } })
    expect(projectSystemMessage.mock.calls.at(-1)?.[1]).toEqual([hidden])
  })

  it('rejects a manual summary whose required projected system context exceeds capacity', async () => {
    const runtime = createConversationContextRuntime({ model, systemPrompt: '', tools: [],
      projectSystemMessage: async () => ({ kind: 'system', content: 'Required memory '.repeat(4000) }) })
    await expect(runtime.compress({ messages: [{ kind: 'user' as const, content: 'Question' }, { kind: 'assistant' as const, content: 'Answer' }] },
      new AbortController().signal)).rejects.toThrow('required instructions still exceed')
  })

  it('counts Responses instructions once in status and manual compression statistics', async () => {
    const selected = { ...model, protocol: 'openai_responses' as const, parameters: { instructions: 'Persistent model instructions '.repeat(80) } }
    const runtime = createConversationContextRuntime({ model: selected, systemPrompt: 'System', tools: [] })
    const messages = [{ kind: 'user' as const, content: 'Question' }, { kind: 'assistant' as const, content: 'Answer' }]
    const status = await runtime.projectedStatus({ messages })
    const expected = countConversationTokens([{ kind: 'system' as const, content: 'System' }, ...messages], [],
      { protocol: selected.protocol, parameters: selected.parameters })
    expect(status.estimatedInputTokens).toBe(expected)
    expect(status.currentContextTokens).toBe(expected)
    expect(Object.values(status.breakdown).reduce((sum, tokens) => sum + tokens, 0)).toBe(expected)
    const result = await runtime.compress({ messages }, new AbortController().signal)
    expect(result.inputTokensBefore).toBe(expected)
    expect(result.inputTokensAfter).toBe(countConversationTokens([{ kind: 'system' as const, content: 'System' }, { kind: 'user' as const, content: result.modelContent }], [],
      { protocol: selected.protocol, parameters: selected.parameters }))
  })

  it('rejects manual summary before sending when Responses instructions consume source capacity', async () => {
    const selected = { ...model, protocol: 'openai_responses' as const, maxContextTokens: 2000, maxOutputTokens: 500,
      parameters: { instructions: 'i'.repeat(5000) } }
    const runtime = createConversationContextRuntime({ model: selected, systemPrompt: '', tools: [] })
    await expect(runtime.compress({ messages: [{ kind: 'user' as const, content: 'Small source' }] }, new AbortController().signal))
      .rejects.toThrow('without dropping source context')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('restores provider usage after a summarized request has completed', async () => {
    const summary = { kind: 'user' as const, content: 'Condensed history', context: {
      summary: true, summaryId: 'summary'
    } }
    const response = { kind: 'assistant' as const, content: 'Continued with the summary', context: {
      modelContextKey: modelContextKey(model), requestKey: contextRequestKey({ messages: [summary], systemMessage: { kind: 'system' as const, content: '' }, tools: [] })
    }, usage: { input_tokens: 1500, output_tokens: 100, total_tokens: 1600 } }
    const runtime = createConversationContextRuntime({ model, systemPrompt: '', tools: [], projectMessages: async (messages) => [...messages] })
    const values = { messages: [{ kind: 'user' as const, content: 'Old request' }, { kind: 'assistant' as const, content: 'Old answer' }, response],
      summary: { cutoffIndex: 2, message: summary } }
    const expected = 1500 + countConversationTokens([response], [], { protocol: model.protocol })
    expect((await runtime.status(values)).currentContextTokens).toBe(expected)
    expect((await runtime.projectedStatus(values)).currentContextTokens).toBe(expected)
  })

  it('counts projected attachment files as 1024 tokens each until their messages are summarized', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'anas-context-image-tokens-'))
    try {
      const imagePath = join(directory, 'image.png')
      await writeFile(imagePath, Buffer.from('image fixture'))
      const projector = createConversationAttachmentProjector({ currentRunId: 'run', textMaxChars: 1000, textOverflow: 'truncate',
        artifacts: ['first.png', 'second.png'].map(name => ({
          id: name, threadId: 'thread', messageId: 'image-input', runId: 'run', name,
          mimeType: 'image/png', size: 13, kind: 'image' as const, path: imagePath,
          available: true, textTruncated: false, contextPolicy: 'conversation' as const, createdAt: '2026-09-24T00:00:00.000Z'
        })) })
      const runtime = createConversationContextRuntime({ model, systemPrompt: '', tools: [],
        projectMessages: (messages, selected) => projector.project(messages, selected.capabilities.vision) })
      const messages = [{ kind: 'user' as const, id: 'image-input', content: 'Compare the two images.' }]
      const projected = await projector.project(messages, true)
      const labelsOnly = projected.map(message => ({ kind: 'user' as const,
        content: Array.isArray(message.content) ? message.content.filter(block => typeof block === 'object' && block !== null && 'type' in block && block.type === 'text') : message.content
      }))
      const status = await runtime.projectedStatus({ messages })
      expect(status.estimatedInputTokens).toBe(countConversationTokens(labelsOnly) + 2048)
      expect(status.currentContextTokens).toBe(status.estimatedInputTokens)
      expect(status.breakdown.attachmentTokens).toBe(status.estimatedInputTokens - countConversationTokens(messages))
      expect(status.breakdown.attachmentTokens).toBeGreaterThan(2048)
      const summary = { kind: 'user' as const, content: 'Image comparison summary.', context: { summary: true } }
      const summarized = await runtime.projectedStatus({ messages, summary: { cutoffIndex: 1, message: summary } })
      expect(summarized.estimatedInputTokens).toBe(countConversationTokens([summary]))
      expect(summarized.breakdown.attachmentTokens).toBe(0)
    } finally { await rm(directory, { recursive: true, force: true }) }
  })

  it('counts the active protocol tool-image payload and drops image tokens once only its placeholder remains', async () => {
    let selected = model
    const runtime = createConversationContextRuntimeBase({ resolveModel: async () => selected, outputLanguage,
      systemPrompt: () => '', tools: () => [] })
    const messages: ConversationMessage[] = [{ kind: 'user' as const, content: 'Inspect the screenshot.' }, { kind: 'assistant' as const, content: '', calls: [
      { id: 'image-call', name: 'view_image', args: {} }
    ] }, { kind: 'tool' as const, resultFor: 'image-call', name: 'view_image', content: [
      { type: 'text', text: 'Captured screenshot details.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
    ] }]
    const chat = await runtime.status({ messages })
    expect(chat.estimatedInputTokens).toBe(countConversationTokens(messages, [], { protocol: 'openai_chat_completions' }))
    expect(chat.currentContextTokens).toBe(chat.estimatedInputTokens)
    expect(chat.breakdown.messageTokens).toBe(chat.estimatedInputTokens)
    expect(chat.breakdown.attachmentTokens).toBe(0)
    selected = { ...model, protocol: 'anthropic_messages' }
    const anthropic = await runtime.status({ messages })
    expect(anthropic.estimatedInputTokens).toBe(countConversationTokens(messages, [], { protocol: 'anthropic_messages' }))
    expect(chat.estimatedInputTokens).toBeGreaterThan(anthropic.estimatedInputTokens)
    messages.push({ kind: 'assistant' as const, content: 'I have inspected the screenshot.' })
    const observed = await runtime.status({ messages })
    expect(observed.estimatedInputTokens).toBe(countConversationTokens(projectConversationToolImages(messages), [], { protocol: 'anthropic_messages' }))
    expect(observed.estimatedInputTokens).toBeLessThan(1024)
  })

  it('counts prepared instructions and tools without reusing that estimate for another model', () => {
    const runtime = createConversationContextRuntime({ model, systemPrompt: '', tools: [] })
    const messages = [{ kind: 'user' as const, content: 'Plan this task' }]
    const request = { systemMessage: { kind: 'system' as const, content: 'Required request instructions '.repeat(60) }, tools: [
      { type: 'function', function: { name: 'write_todos', description: 'Record the task plan',
        parameters: { type: 'object', properties: { todos: { type: 'array', items: { type: 'string' } } } } } }
    ] }
    const status = runtime.statusFromMessages(messages, model, request)
    expect(status.estimatedInputTokens).toBe(countConversationTokens([request.systemMessage, ...messages], request.tools))
    expect(status.breakdown.toolDefinitionTokens).toBeGreaterThan(0)
    expect(status.breakdown.systemInstructionTokens).toBeGreaterThan(0)
    expect(Object.values(status.breakdown).reduce((sum, tokens) => sum + tokens, 0)).toBe(status.estimatedInputTokens)
    expect(contextStatusForModel(status, { ...model, id: 'other', model: 'other-model', baseUrl: 'https://example.test' })).toBeUndefined()
  })

  it('resolves model-specific system instructions in previews without reusing the previous model prompt', async () => {
    let current = model
    const runtime = createConversationContextRuntimeBase({ resolveModel: async () => current, outputLanguage,
      systemPrompt: (selected) => selected.id === model.id ? '' : 'New model instructions '.repeat(60), tools: () => [] })
    const before = await runtime.status({ messages: [] })
    current = { ...model, id: 'other' }
    const after = await runtime.projectedStatus({ messages: [] })
    expect(after.breakdown.systemInstructionTokens).toBeGreaterThan(before.breakdown.systemInstructionTokens)
    expect(after.estimatedInputTokens).toBe(Object.values(after.breakdown).reduce((sum, tokens) => sum + tokens, 0))
  })

  it('resolves current parameters for status and manual compression without recreating the runtime', async () => {
    let currentModel = model
    const runtime = createConversationContextRuntimeBase({
      resolveModel: async () => currentModel,
      outputLanguage,
      systemPrompt: () => '',
      tools: () => []
    })
    const messages = [{ kind: 'user' as const, content: 'Summarize this history' }, { kind: 'assistant' as const,
      content: 'Earlier response',
      context: { modelContextKey: modelContextKey(model), requestKey: contextRequestKey({ messages: [{ kind: 'user' as const, content: 'Summarize this history' }], systemMessage: { kind: 'system' as const, content: '' }, tools: [] }) },
      usage: { input_tokens: 4000, output_tokens: 1000, total_tokens: 5000 }
    }]
    expect((await runtime.status({ messages })).currentContextTokens).toBe(4000
      + countConversationTokens(messages.slice(1), [], { protocol: model.protocol }))
    currentModel = { ...model, parameters: { temperature: 0.4 }, maxContextTokens: 20_000,
      maxOutputTokens: 2000, contextCompressionThreshold: 0.6 }
    const status = await runtime.projectedStatus({ messages })
    expect(status).toMatchObject({ maxContextTokens: 20_000, maxOutputTokens: 2000,
      inputCapacityTokens: 18_000, compressionThresholdTokens: 10_800 })
    expect(status.serverUsage).toBeUndefined()
    expect(status.currentContextTokens).toBeLessThan(5000)
    await runtime.compress({ messages }, new AbortController().signal)
    expect(createCompressionModelMock.mock.calls.at(-1)?.[0]).toEqual(currentModel)
  })

  it('surfaces a deleted selection for status and compression instead of using its earlier model', async () => {
    const resolveModel = vi.fn().mockResolvedValueOnce(model).mockRejectedValue(new Error('Selected model was deleted'))
    const runtime = createConversationContextRuntimeBase({ resolveModel, outputLanguage, systemPrompt: () => '', tools: () => [] })
    await runtime.status({ messages: [] })
    await expect(runtime.projectedStatus({ messages: [] })).rejects.toThrow('Selected model was deleted')
    await expect(runtime.compress({ messages: [{ kind: 'user' as const, content: 'Continue' }] }, new AbortController().signal))
      .rejects.toThrow('Selected model was deleted')
    expect(createCompressionModelMock).not.toHaveBeenCalled()
  })

  it('refuses to replace history if a generated summary cannot fit the current model', async () => {
    const runtime = createConversationContextRuntime({ model: { ...model, maxContextTokens: 2000, maxOutputTokens: 1000 },
      systemPrompt: 'Required instructions', tools: [] })
    invokeMock.mockResolvedValueOnce({ text: 'Oversized summary '.repeat(1000) })
    await expect(runtime.compress({ messages: [{ kind: 'user' as const, content: 'Summarize' }] }, new AbortController().signal))
      .rejects.toThrow('still exceed the selected model')
  })

  it.each(['selection', 'parameters', 'displayName'] as const)('reprepares manual compression after a valid %s change before sending', async (change) => {
    let currentModel = model
    let changed = false
    const projectedModels: ResolvedModelConfig[] = []
    const runtime = createConversationContextRuntimeBase({ resolveModel: async () => currentModel,
      outputLanguage, systemPrompt: () => '', tools: () => [],
      projectMessages: async (messages, selected) => {
        projectedModels.push(selected)
        if (!changed) {
          changed = true
          currentModel = change === 'selection' ? { ...model, id: 'another', model: 'another-model' }
            : change === 'parameters' ? { ...model, parameters: { temperature: 0.7 }, maxContextTokens: 20_000 }
              : { ...model, displayName: 'Renamed model' }
        }
        return messages
      }
    })
    const messages = [{ kind: 'user' as const, id: 'source', content: 'Summarize this history' }]
    const result = await runtime.compress({ messages }, new AbortController().signal)
    expect(projectedModels[0]).toBe(model)
    expect(projectedModels[1]).toBe(currentModel)
    expect(createCompressionModelMock.mock.calls.at(-1)?.[0]).toEqual(currentModel)
    expect(invokeMock).toHaveBeenCalledOnce()
    expect(result.summaryText).toBe('Condensed history')
    expect(result.coveredThroughMessageId).toBe('source')
    expect(messages[0].content).toBe('Summarize this history')
  })

  it('rejects a newly insufficient manual-compression budget before sending or replacing history', async () => {
    let currentModel = model
    const messages = [{ kind: 'user' as const, id: 'source', content: 'Required coding history '.repeat(300) }]
    const runtime = createConversationContextRuntimeBase({ resolveModel: async () => currentModel,
      outputLanguage, codingMode: true, systemPrompt: () => '', tools: () => [],
      projectMessages: async (items) => {
        currentModel = { ...model, maxContextTokens: 2000, maxOutputTokens: 1000 }
        return items
      }
    })
    await expect(runtime.compress({ messages }, new AbortController().signal)).rejects.toThrow('cannot be summarized within this model’s input capacity')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(messages[0].content).toBe('Required coding history '.repeat(300))
  })

  it('uses an increased budget before rejecting projected history against the obsolete limit', async () => {
    let currentModel = { ...model, maxContextTokens: 2000, maxOutputTokens: 1000 }
    const messages = [{ kind: 'user' as const, content: 'Required coding history '.repeat(300) }]
    const runtime = createConversationContextRuntimeBase({ resolveModel: async () => currentModel,
      outputLanguage, codingMode: true, systemPrompt: () => '', tools: () => [],
      projectMessages: async (items) => { currentModel = model; return items }
    })
    const result = await runtime.compress({ messages }, new AbortController().signal)
    expect(createCompressionModelMock.mock.calls.at(-1)?.[0]).toBe(model)
    expect(invokeMock).toHaveBeenCalledOnce()
    expect(result.summaryText).toBe('Condensed history')
  })

  it('terminates manual compression when its selected model disappears during preparation', async () => {
    let removed = false
    const runtime = createConversationContextRuntimeBase({ resolveModel: async () => {
      if (removed) throw new ModelSelectionError('Selected model was deleted')
      return model
    }, outputLanguage, systemPrompt: () => '', tools: () => [],
    projectMessages: async (messages) => { removed = true; return messages } })
    await expect(runtime.compress({ messages: [{ kind: 'user' as const, content: 'Summarize' }] }, new AbortController().signal))
      .rejects.toThrow('Selected model was deleted')
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('bounds repeated manual-compression preparation changes without sending stale parameters', async () => {
    let currentModel = model
    let revision = 0
    const runtime = createConversationContextRuntimeBase({ resolveModel: async () => currentModel,
      outputLanguage, systemPrompt: () => '', tools: () => [],
      projectMessages: async (messages) => {
        currentModel = { ...model, displayName: `Revision ${++revision}` }
        return messages
      }
    })
    await expect(runtime.compress({ messages: [{ kind: 'user' as const, content: 'Summarize' }] }, new AbortController().signal))
      .rejects.toBeInstanceOf(ModelRequestChangedError)
    expect(revision).toBe(3)
    expect(invokeMock).not.toHaveBeenCalled()
  })

  it('does not retry exhausted provider failures at the manual preparation boundary', async () => {
    const exhausted = Object.assign(new Error('Temporarily unavailable'), { status: 503 })
    invokeMock.mockRejectedValueOnce(exhausted)
    const runtime = createConversationContextRuntime({ model, systemPrompt: '', tools: [] })
    await expect(runtime.compress({ messages: [{ kind: 'user' as const, content: 'Summarize' }] }, new AbortController().signal))
      .rejects.toBe(exhausted)
    expect(invokeMock).toHaveBeenCalledOnce()
  })

  it('keeps the completed in-flight manual summary when model settings change after sending', async () => {
    let currentModel = model
    invokeMock.mockImplementationOnce(async () => {
      currentModel = { ...model, parameters: { temperature: 0.7 } }
      return { text: 'Completed with the original request settings' }
    })
    const runtime = createConversationContextRuntimeBase({ resolveModel: async () => currentModel,
      outputLanguage, systemPrompt: () => '', tools: () => [] })
    const result = await runtime.compress({ messages: [{ kind: 'user' as const, content: 'Summarize' }] }, new AbortController().signal)
    expect(result.summaryText).toBe('Completed with the original request settings')
    expect(invokeMock).toHaveBeenCalledOnce()
  })

  it('projects observed images for status and manual compression while preserving pending tool transactions', async () => {
    const image = { type: 'image', source_type: 'base64', data: 'SECRET_IMAGE_BYTES', mime_type: 'image/png' }
    const old = { kind: 'tool' as const, id: 'old-result', resultFor: 'old', content: [{ type: 'text', text: 'Window title' }, image] }
    const pendingCall = { kind: 'assistant' as const, id: 'new-call', content: '', calls: [{ id: 'new', name: 'capture', args: {} }] }
    const pending = { kind: 'tool' as const, id: 'new-result', resultFor: 'new', content: [image] }
    const messages = [{ kind: 'user' as const, content: 'Inspect' }, old, { kind: 'assistant' as const, content: 'Saw first image', context: { modelContextKey: modelContextKey(model), requestKey: contextRequestKey({ systemMessage: { kind: 'system' as const, content: 'System' }, tools: [] }) }, usage: {
      input_tokens: 9000, output_tokens: 100, total_tokens: 9100
    } }, pendingCall, pending, { kind: 'user' as const, content: 'Continue inspecting' }]
    const runtime = createConversationContextRuntime({ model, systemPrompt: 'System', tools: [] })
    // The latest request had already omitted the older image; its snapshot is absent here.
    expect((await runtime.status({ messages })).currentContextTokens).toBeLessThan(9100)
    expect(await runtime.projectedStatus!({ messages })).toEqual((await runtime.status({ messages })))
    invokeMock.mockResolvedValueOnce({ text: 'First screen showed window title' })
    const compressed = await runtime.compress({ messages }, new AbortController().signal)
    expect((invokeMock.mock.calls[0][0] as string)).not.toContain('SECRET_IMAGE_BYTES')
    expect(compressed.cutoffIndex).toBe(3)
    expect(compressed.firstPreservedMessageId).toBe('new-call')
    expect(messages[1].content).toContain(image)
    expect(messages[4].content).toEqual([image])
  })

  it('does not summarize a pending image when there is no earlier history', async () => {
    const runtime = createConversationContextRuntime({ model, systemPrompt: '', tools: [] })
    await expect(runtime.compress({ messages: [
      { kind: 'assistant' as const, content: '', calls: [{ id: 'capture', name: 'capture', args: {} }] },
      { kind: 'tool' as const, resultFor: 'capture', content: [{ type: 'image', data: 'PENDING' }] }
    ] }, new AbortController().signal)).rejects.toThrow('pending tool images')
    expect(invokeMock).not.toHaveBeenCalled()
  })
  it('identifies the owning run in request and persisted context status', async () => {
    const runtime = createConversationContextRuntime({ model, systemPrompt: 'System', tools: [], requestId: 'run-2' })
    const messages = [{ kind: 'user' as const, content: 'New input' }]
    expect(runtime.statusFromMessages(messages, model).runId).toBe('run-2')
    expect((await runtime.status({ messages })).runId).toBe('run-2')
    expect((await runtime.projectedStatus!({ messages })).runId).toBe('run-2')
  })

  it('reports current context including messages added after the last provider snapshot', async () => {
    const runtime = createConversationContextRuntime({ model, systemPrompt: 'System', tools: [] })
    const response = { kind: 'assistant' as const, content: 'Answer', context: { modelContextKey: modelContextKey(model), requestKey: contextRequestKey({ systemMessage: { kind: 'system' as const, content: 'System' }, tools: [] }) }, usage: {
      input_tokens: 4000, output_tokens: 1000, total_tokens: 5000
    } }
    const before = (await runtime.status({ messages: [response] }))
    const after = (await runtime.status({ messages: [response, { kind: 'user' as const, content: 'New content '.repeat(300) }] }))
    expect(before.currentContextTokens).toBe(4000
      + countConversationTokens([response], [], { protocol: model.protocol }))
    expect(after.currentContextTokens).toBeGreaterThan(before.currentContextTokens)
    expect(after.serverUsage?.totalTokens).toBe(5000)
  })

  it('does not reuse a provider snapshot for a compressed or reprojected context', async () => {
    const response = { kind: 'assistant' as const, content: 'Answer', context: { modelContextKey: modelContextKey(model), requestKey: contextRequestKey({ systemMessage: { kind: 'system' as const, content: 'System' }, tools: [] }) }, usage: {
      input_tokens: 8000, output_tokens: 1000, total_tokens: 9000
    } }
    const summary = { kind: 'user' as const, content: 'Short summary', context: { summary: true } }
    const runtime = createConversationContextRuntime({ model, systemPrompt: 'System', tools: [],
      projectMessages: async (messages) => [summary, ...messages] })
    const projected = await runtime.projectedStatus!({ messages: [response] })
    expect(projected.currentContextTokens).toBeLessThan(9000)
    const compressed = (await runtime.status({ messages: [{ kind: 'user' as const, content: 'Old' }, response],
      summary: { cutoffIndex: 1, message: summary } }))
    expect(compressed.currentContextTokens).toBeLessThan(9000)
  })
  it('uses the project custom template and includes complete history during manual compression', async () => {
    const runtime = createConversationContextRuntime({ model: { ...model, maxContextTokens: 20_000 }, codingMode: true,
      compressionPrompt: 'Keep research citations: {conversation}', systemPrompt: '', tools: [] })
    invokeMock.mockResolvedValueOnce({ text: 'Retained citations' })
    await runtime.compress({ messages: [{ kind: 'user' as const, content: 'SOURCE-42' }, { kind: 'assistant' as const, content: 'Notes '.repeat(400) }, { kind: 'user' as const, content: 'Continue' }] }, new AbortController().signal)
    const prompt = (invokeMock.mock.calls[0][0] as string)
    expect(prompt).toContain('Keep research citations:')
    expect(prompt).toContain('SOURCE-42')
    expect(prompt).not.toContain('Coding continuation handoff')
    expect(prompt).not.toContain('{conversation}')
  })

  it('uses the selected coding template for manual compression and retains supplied continuation evidence', async () => {
    const runtime = createConversationContextRuntime({ model: { ...model, maxContextTokens: 20_000 }, codingMode: true, systemPrompt: 'Rules remain separate', tools: [] })
    const evidence = 'Goal: fix src/parser.ts. Preserve user changes in README.md. npm test failed: missing token. Build NOT RUN. Next: add regression test. Background call call-7 UNKNOWN.'
    invokeMock.mockResolvedValueOnce({ text: evidence })
    const result = await runtime.compress({ messages: [{ kind: 'user' as const, content: 'Fix parsing without changing README.md' },
      { kind: 'assistant' as const, content: 'Investigated parser\n' + 'log detail '.repeat(400) }, { kind: 'user' as const, content: evidence }] }, new AbortController().signal)
    const prompt = (invokeMock.mock.calls[0][0] as string)
    expect(prompt).toContain('Coding continuation handoff')
    expect(prompt).toContain('Preserve user changes in README.md')
    expect(prompt).toContain('npm test failed: missing token')
    expect(result.modelContent).toContain(evidence)
  })
  it('does not silently trim the original coding goal when summary input cannot fit', async () => {
    const runtime = createConversationContextRuntime({ model: { ...model, maxContextTokens: 4096, maxOutputTokens: 1024 }, codingMode: true, systemPrompt: '', tools: [] })
    await expect(runtime.compress({ messages: [{ kind: 'user' as const, content: 'ORIGINAL_GOAL: preserve user edits' },
      { kind: 'assistant' as const, content: 'Long result '.repeat(4000) }, { kind: 'user' as const, content: 'Continue' }] }, new AbortController().signal)).rejects.toThrow('without dropping source context')
    expect(invokeMock).not.toHaveBeenCalled()
  })
  it('starts compression before the coding request guard on small context windows', async () => {
    const smallModel = { ...model, maxContextTokens: 4096, maxOutputTokens: 1024, contextCompressionThreshold: 0.95 }
    const coding = createConversationContextRuntime({ model: smallModel, tools: [], systemPrompt: '', includeProjectRules: true })
    const ordinary = createConversationContextRuntime({ model: smallModel, tools: [], systemPrompt: '' })
    expect((await coding.status({ messages: [] })).compressionThresholdTokens).toBe(2816)
    expect((await ordinary.status({ messages: [] })).compressionThresholdTokens).toBe(2918)
  })
  it('counts projected rules only when coding mode is active, ignoring prior-mode stored rules', async () => {
    const values = { messages: [], projectRules: {
      runId: 'run', trustedFolders: ['/project'], roots: [{ folder: '/project', boundary: '/project' }],
      initialScopes: ['/project'], blockedCalls: [], rejectedCalls: [], checkedWrites: [], blockedReason: '', fatalError: '',
      documents: [{ id: 'rule', path: '/project/AGENTS.md', content: 'PROJECT RULE' }],
      directories: [{ path: '/project', documentId: 'rule' }], activeScopes: ['/project']
    } }
    const ordinary = createConversationContextRuntime({ model, tools: [], systemPrompt: 'BASE', includeProjectRules: false })
    const coding = createConversationContextRuntime({ model, tools: [], systemPrompt: 'BASE', includeProjectRules: true })
    expect((await ordinary.status(values))).toEqual((await ordinary.status({ messages: [] })))
    const delta = (await coding.status(values)).estimatedInputTokens - (await ordinary.status(values)).estimatedInputTokens
    expect(delta).toBeGreaterThan(0)
    expect((await coding.status(values)).breakdown.systemInstructionTokens - (await ordinary.status(values)).breakdown.systemInstructionTokens).toBe(delta)
    expect((await coding.status(values)).currentContextTokens - (await ordinary.status(values)).currentContextTokens).toBe(delta)
  })

  it.each([false, true])('uses matching full rule projections for usage calibration and manual statistics (memory=%s)', async (memory) => {
    const rules = { runId: 'run', trustedFolders: ['/project'], roots: [{ folder: '/project', boundary: '/project' }],
      initialScopes: ['/project'], blockedCalls: [], rejectedCalls: [], checkedWrites: [], blockedReason: '', fatalError: '',
      documents: [{ id: 'rule', path: '/project/AGENTS.md', content: 'PROJECT RULE' }],
      directories: [{ path: '/project', documentId: 'rule' }], activeScopes: ['/project'] }
    const projectedSystem = { kind: 'system' as const, content: (memory ? 'BASE\n\nRECALLED MEMORY' : 'BASE') + `\n\n${projectRulesText(rules)}` }
    const response = { kind: 'assistant' as const, content: 'Answer', context: {
      modelContextKey: modelContextKey(model), requestKey: contextRequestKey({ messages: [{ kind: 'user' as const, content: 'Question' }], systemMessage: projectedSystem, tools: [] })
    }, usage: { input_tokens: 4000, output_tokens: 10, total_tokens: 4010 } }
    const values = { messages: [{ kind: 'user' as const, content: 'Question' }, response], projectRules: rules }
    const runtime = createConversationContextRuntime({ model, tools: [], systemPrompt: 'BASE', includeProjectRules: true,
      ...(memory ? { projectSystemMessage: async (system: ConversationMessage) => ({ ...system, content: `${system.content}\n\nRECALLED MEMORY` }) } : {}) })
    const expected = 4000 + countConversationTokens([response], [], { protocol: model.protocol })
    const projected = await runtime.projectedStatus(values)
    expect(projected.currentContextTokens).toBe(expected)
    if (!memory) expect((await runtime.status(values)).currentContextTokens).toBe(expected)
    expect(projected.estimatedInputTokens).toBe(countConversationTokens([projectedSystem, ...values.messages]))
    const withoutRules = await runtime.projectedStatus({ messages: values.messages })
    expect(withoutRules.currentContextTokens).toBe(withoutRules.estimatedInputTokens)
    const result = await runtime.compress(values, new AbortController().signal)
    expect(result.inputTokensBefore).toBe(projected.estimatedInputTokens)
    expect(result.inputTokensAfter).toBe(countConversationTokens([projectedSystem, { kind: 'user' as const, content: result.modelContent }]))
  })
  it('counts the coding section as system instructions instead of losing its tokens', async () => {
    const content = '<coding_instruction>Inspect the project and verify edits.</coding_instruction>'
    const runtime = createConversationContextRuntime({ model, tools: [], systemPrompt: {
      text: content, sections: [{ kind: 'coding_instruction', content }]
    } })
    const status = (await runtime.status({ messages: [] }))
    expect(status.breakdown.systemInstructionTokens).toBeGreaterThan(0)
    expect(status.estimatedInputTokens).toBe(status.breakdown.systemInstructionTokens)
  })

  beforeEach(() => {
    createCompressionModelMock.mockClear()
    invokeMock.mockReset()
    invokeMock.mockResolvedValue({ text: 'Condensed history' })
  })

  it('reports structured system sections and keeps the input total additive', async () => {
    const systemPrompt = {
      text: [
        '<profile>Assistant profile</profile>',
        'Follow the current instructions.',
        'Additional project instructions.',
        '<coding_instruction>Inspect, edit and verify.</coding_instruction>',
        '<environment>Windows</environment>',
        'Workspace: C:\\project',
        '<memory>Remember this.</memory>',
        '<skills>Search skill.</skills>'
      ].join('\n\n'),
      sections: [
        { kind: 'profile' as const, content: '<profile>Assistant profile</profile>' },
        { kind: 'system_instruction' as const, content: 'Follow the current instructions.' },
        { kind: 'project_instruction' as const, content: 'Additional project instructions.' },
        { kind: 'coding_instruction' as const, content: '<coding_instruction>Inspect, edit and verify.</coding_instruction>' },
        { kind: 'runtime_context' as const, content: '<environment>Windows</environment>' },
        {
 capabilities: structuredClone(defaultCapabilities), restrictSubagents: false, advancedSettings: true, prompt: '', kind: 'workspace' as const, content: 'Workspace: C:\\project' },
        { kind: 'memory' as const, content: '<memory>Remember this.</memory>' },
        { kind: 'skills' as const, content: '<skills>Search skill.</skills>' }
      ]
    }
    const runtime = createConversationContextRuntime({
      model,
      systemPrompt,
      tools: [],
      projectMessages: async (messages) => [
        ...messages,
        { kind: 'user', content: 'Projected attachment body with additional context.' }
      ]
    })
    const rawStatus = (await runtime.status({
      messages: [{ kind: 'user' as const, content: 'Question' }]
    }))
    const projectedStatus = await runtime.projectedStatus?.({
      messages: [{ kind: 'user' as const, content: 'Question' }]
    })

    expect(rawStatus.breakdown).toMatchObject({
      profileTokens: expect.any(Number),
      systemInstructionTokens: expect.any(Number),
      runtimeContextTokens: expect.any(Number),
      workspaceTokens: expect.any(Number),
      memoryTokens: expect.any(Number),
      skillTokens: expect.any(Number),
      attachmentTokens: 0
    })
    expect(rawStatus.breakdown.profileTokens).toBeGreaterThan(0)
    expect(Object.values(rawStatus.breakdown).reduce((sum, value) => sum + value, 0))
      .toBe(rawStatus.estimatedInputTokens)
    expect(projectedStatus?.breakdown.attachmentTokens).toBeGreaterThan(0)
    expect(Object.values(projectedStatus?.breakdown ?? {}).reduce(
      (sum, value) => sum + value,
      0
    )).toBe(projectedStatus?.estimatedInputTokens)
  })

  it('reports the effective context after an existing summary', async () => {
    const runtime = createConversationContextRuntime({
      model,
      systemPrompt: 'System instructions',
      tools: []
    })
    const rawMessages = [
      { kind: 'user' as const, content: 'Old question that is already summarized' },
      { kind: 'assistant' as const,
        content: 'Old answer that is already summarized',
        context: { modelContextKey: modelContextKey(model), requestKey: contextRequestKey({ systemMessage: { kind: 'system' as const, content: 'System' }, tools: [] }) }, usage: {
          input_tokens: 4_000,
          output_tokens: 1_000,
          total_tokens: 5_000
        }
      },
      { kind: 'user' as const, content: 'Preserved recent question' }
    ]
    const withoutSummary = (await runtime.status({ messages: rawMessages }))
    const withSummary = (await runtime.status({
      messages: rawMessages,
      summary: {
        cutoffIndex: 3,
        message: { kind: 'user' as const,
          content: 'Short prior summary',
          context: { summary: true }
        }
      }
    }))

    expect(withSummary.compressionApplied).toBe(true)
    expect(withoutSummary.serverUsage?.totalTokens).toBe(5_000)
    expect(withSummary.serverUsage).toBeUndefined()
    expect(withSummary.estimatedInputTokens).toBeLessThan(withoutSummary.estimatedInputTokens)
    expect(withSummary.inputCapacityTokens).toBe(9_000)
    expect(withSummary.compressionThresholdTokens).toBe(7_200)
    expect(withSummary.manualCompressionAvailable).toBe(false)
  })

  it('includes replayed Responses output in the message window estimate', async () => {
    const runtime = createConversationContextRuntime({
      model: { ...model, protocol: 'openai_responses' },
      systemPrompt: 'System instructions',
      tools: []
    })
    const ordinary = (await runtime.status({
      messages: [{ kind: 'assistant' as const, content: 'Visible answer' }]
    }))
    const responses = (await runtime.status({
      messages: [{ kind: 'assistant' as const,
        content: 'Visible answer',
        source: { extras: {}, metadata: {
          output: [{
            id: 'rs_1',
            type: 'reasoning',
            encrypted_content: 'x'.repeat(4_000),
            summary: []
          }]
        } }
      }]
    }))

    expect(responses.breakdown.messageTokens)
      .toBeGreaterThan(ordinary.breakdown.messageTokens + 900)
  })

  it('exposes the latest server total separately from the local estimate', async () => {
    const runtime = createConversationContextRuntime({
      model,
      systemPrompt: 'System instructions',
      tools: []
    })
    const status = (await runtime.status({
      messages: [
        { kind: 'user' as const, content: 'Question' },
        { kind: 'assistant' as const,
          content: 'Answer',
          context: { modelContextKey: modelContextKey(model), requestKey: contextRequestKey({ systemMessage: { kind: 'system' as const, content: 'System' }, tools: [] }) }, usage: {
            input_tokens: 4_000,
            output_tokens: 1_000,
            total_tokens: 5_000
          }
        }
      ]
    }))

    expect(status.serverUsage).toEqual({
      inputTokens: 4_000,
      outputTokens: 1_000,
      totalTokens: 5_000
    })
    expect(status.estimatedInputTokens).not.toBe(5_000)
  })

  it('creates a manual summary with an activation anchor at the last existing message', async () => {
    const runtime = createConversationContextRuntime({
      model: {
        ...model,
        maxContextTokens: 6_000,
        maxOutputTokens: 1_000
      },
      systemPrompt: 'System instructions',
      tools: []
    })
    const messages = [
      { kind: 'user' as const,
        id: 'message-1',
        content: 'First detailed request with enough context to summarize safely.'
      },
      { kind: 'assistant' as const,
        id: 'message-2',
        content: 'First detailed answer with decisions and implementation notes.'
      },
      { kind: 'user' as const,
        id: 'message-3',
        content: 'Second detailed request that should remain in recent context.'
      }
    ]

    const result = await runtime.compress(
      { messages },
      new AbortController().signal
    )

    expect(invokeMock).toHaveBeenCalledOnce()
    const prompt = invokeMock.mock.calls[0][0] as string
    expect(invokeMock.mock.calls[0][1]).toBeInstanceOf(AbortSignal)
    expect(prompt).toContain(
      'If it has a clear primary language, write the summary in that language.'
    )
    expect(prompt).toContain(
      'use the configured default language:\n简体中文 (zh-CN)'
    )
    expect(createCompressionModelMock)
      .toHaveBeenCalledWith(
        expect.objectContaining({ stream: true }),
        expect.objectContaining({ requestRole: 'manual-compression' })
      )
    expect(result.summaryText).toBe('Condensed history')
    expect(result.activatedAfterMessageIndex).toBe(2)
    expect(result.cutoffIndex).toBeGreaterThan(0)
    expect(result.modelContent).toBe('Here is a summary of the conversation to date:\n\nCondensed history')
    expect(result.inputTokensAfter).toBeLessThan(result.inputTokensBefore)
  })

  it('compresses all current history without applying the automatic keep budget', async () => {
    const runtime = createConversationContextRuntime({
      model: {
        ...model,
        maxContextTokens: 256_000,
        maxOutputTokens: 16_000
      },
      systemPrompt: 'System instructions',
      tools: []
    })
    const messages = [
      { kind: 'user' as const, id: 'short-1', content: 'First question' },
      { kind: 'assistant' as const, id: 'short-2', content: 'First answer' },
      { kind: 'user' as const, id: 'short-3', content: 'Latest question' },
      { kind: 'assistant' as const, id: 'short-4', content: 'Latest answer' }
    ]

    expect((await runtime.status({ messages })).manualCompressionAvailable).toBe(true)
    const result = await runtime.compress({ messages }, new AbortController().signal)

    expect(result.cutoffIndex).toBe(messages.length)
    expect(result.coveredThroughMessageId).toBe('short-4')
    expect(result.firstPreservedMessageId).toBeUndefined()
  })

  it('offers forced compression for one complete turn', async () => {
    const runtime = createConversationContextRuntime({
      model,
      systemPrompt: 'System instructions',
      tools: []
    })

    expect((await runtime.status({
      messages: [
        { kind: 'user' as const, content: 'Only question' },
        { kind: 'assistant' as const, content: 'Only answer' }
      ]
    })).manualCompressionAvailable).toBe(true)
  })

  it('does not recompress a summary when no new raw history exists', async () => {
    const runtime = createConversationContextRuntime({
      model,
      systemPrompt: 'System instructions',
      tools: []
    })
    const messages = [
      { kind: 'user' as const, content: 'Already summarized question' },
      { kind: 'assistant' as const, content: 'Only preserved answer' }
    ]

    expect((await runtime.status({
      messages,
      summary: {
        cutoffIndex: 2,
        message: { kind: 'user' as const,
          content: 'Existing summary',
          context: { summary: true }
        }
      }
    })).manualCompressionAvailable).toBe(false)
  })

  it('rejects manual compression without trimming an oversized source message', async () => {
    const runtime = createConversationContextRuntime({
      model,
      systemPrompt: 'System instructions',
      tools: []
    })
    const messages = [
      { kind: 'user' as const,
        id: 'oversized-source',
        content: `${'x'.repeat(40_000)}TAIL_MARKER`
      },
      { kind: 'assistant' as const,
        id: 'latest-answer',
        content: 'Keep the latest answer outside the summary.'
      }
    ]

    expect((await runtime.status({ messages })).manualCompressionAvailable).toBe(true)
    await expect(runtime.compress({ messages }, new AbortController().signal)).rejects.toThrow('without dropping source context')
    expect(invokeMock).not.toHaveBeenCalled()
    expect(messages[0].content).toBe(`${'x'.repeat(40_000)}TAIL_MARKER`)
  })

  it('does not trim a 40k-token history for a 240k-token input capacity', async () => {
    const runtime = createConversationContextRuntime({
      model: {
        ...model,
        maxContextTokens: 256_000,
        maxOutputTokens: 16_000
      },
      systemPrompt: 'System instructions',
      tools: []
    })
    const messages = [
      { kind: 'user' as const,
        id: 'large-source',
        content: `HEAD_MARKER${'x'.repeat(160_000)}TAIL_MARKER`
      },
      { kind: 'assistant' as const,
        id: 'large-answer',
        content: 'Completed answer'
      }
    ]

    await runtime.compress({ messages }, new AbortController().signal)
    const prompt = invokeMock.mock.calls[0][0] as string

    expect(prompt).toContain('HEAD_MARKER')
    expect(prompt).toContain('TAIL_MARKER')
  })

  it('maps a repeated compression cutoff back to the raw message history', async () => {
    const runtime = createConversationContextRuntime({
      model,
      systemPrompt: 'System instructions',
      tools: []
    })
    const messages = [
      { kind: 'user' as const, id: 'raw-1', content: 'Old question already covered by the first summary.' },
      { kind: 'assistant' as const, id: 'raw-2', content: 'Old answer already covered by the first summary.' },
      { kind: 'user' as const, id: 'raw-3', content: 'Preserved question with substantial follow-up context.' },
      { kind: 'assistant' as const, id: 'raw-4', content: 'Preserved answer with implementation details and decisions.' },
      { kind: 'user' as const, id: 'raw-5', content: 'Newest question that must remain available after compression.' }
    ]

    const result = await runtime.compress({
      messages,
      summary: {
        cutoffIndex: 2,
        message: { kind: 'user' as const,
          content: 'First summary',
          context: { summary: true }
        }
      }
    }, new AbortController().signal)
    const prompt = invokeMock.mock.calls[0][0] as string

    expect(prompt).toContain('First summary')
    expect(prompt).toContain('Preserved question')
    expect(prompt).not.toContain('Old question already covered')
    expect(prompt).not.toContain('Old answer already covered')
    expect(result.cutoffIndex).toBe(messages.length)
    expect(result.activatedAfterMessageIndex).toBe(messages.length - 1)
    expect(result.coveredThroughMessageId).toBe(messages[result.cutoffIndex - 1].id)
    expect(result.firstPreservedMessageId).toBeUndefined()
  })

})
