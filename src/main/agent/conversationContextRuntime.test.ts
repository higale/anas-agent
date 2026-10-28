import type { ConversationMessage } from '../../runtime/conversationMessage'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedModelConfig } from '@shared/types'
import { ModelSelectionError } from '../../runtime/errors'
import { createConversationContextRuntime, type ConversationContextSource } from './conversationContextRuntime'
import { conversationSummaryTranscript, projectConversationToolHistory, simpleConversationHistory } from './conversationHistoryProjection'
import { projectConversationInput } from './conversationContext'

const mocks = vi.hoisted(() => ({ generate: vi.fn(), selected: vi.fn() }))
vi.mock('./compressionModel', () => ({ createCompressionModel: (model: ResolvedModelConfig, options: { beforeRequest?: () => Promise<void> }) => {
  mocks.selected(model)
  return async (prompt: string, signal: AbortSignal) => { await options.beforeRequest?.(); return mocks.generate(prompt, signal) }
} }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))

const model: ResolvedModelConfig = {
  id: 'fixture', displayName: '', providerId: 'provider', providerName: 'Fixture', protocol: 'openai_chat_completions',
  baseUrl: 'https://fixture.invalid/v1', model: 'fixture', parameters: {}, parameterPresetMode: 'none',
  capabilities: { vision: true, toolUse: true }, stream: false, maxContextTokens: 10000, maxOutputTokens: 1000,
  contextCompressionThreshold: 0.8, contextCompressionEnabled: true
}
const options = () => ({ resolveModel: async () => model, outputLanguage: { code: 'zh-CN', name: '简体中文' },
  systemPrompt: () => 'Instructions', tools: () => [], requestId: 'run' })
const source = (): ConversationContextSource => ({ messages: [
  { id: 'user', kind: 'user', content: 'Keep the whole request' }, { id: 'assistant', kind: 'assistant', content: 'Previous answer' }
] })
beforeEach(() => { vi.clearAllMocks(); mocks.generate.mockResolvedValue({ text: 'Summary' }) })

describe('native context status and manual compression', () => {
  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'preserves %s context totals, sections and existing summary boundaries', async protocol => {
      const selected = { ...model, protocol }, config = { ...options(), resolveModel: async () => selected,
        systemPrompt: () => ({ text: 'Profile\nInstructions', sections: [
          { kind: 'profile' as const, content: 'Profile' }, { kind: 'system_instruction' as const, content: 'Instructions' }
        ] }) }
      const messages: ConversationMessage[] = [
        { kind: 'user', id: 'old', content: 'Old history' },
        { kind: 'assistant', id: 'old-response', content: 'Old answer' },
        { kind: 'user', id: 'user', content: 'Current question' },
        { kind: 'assistant', id: 'answer', content: 'Answer', usage: { input_tokens: 20, output_tokens: 2, total_tokens: 22 } }
      ]
      const summary: ConversationMessage = { kind: 'user', content: 'Summary', context: { summary: true } }
      const native = createConversationContextRuntime(config)
      const status = await native.status({ messages })
      // Observable totals recorded against the legacy runtime before removing its test dependency.
      expect(status).toEqual({
        runId: 'run', modelConfigId: 'fixture', modelContextKey: expect.any(String), includeProjectRules: false,
        estimatedInputTokens: 17, currentContextTokens: 17, maxContextTokens: 10000, maxOutputTokens: 1000,
        inputCapacityTokens: 9000, compressionEnabled: true, compressionThreshold: 0.8,
        compressionThresholdTokens: 7200, compressionApplied: false, manualCompressionAvailable: true,
        breakdown: { profileTokens: 2, systemInstructionTokens: 3, runtimeContextTokens: 0, workspaceTokens: 0,
          memoryTokens: 0, skillTokens: 0, toolDefinitionTokens: 0, messageTokens: 12, attachmentTokens: 0 }
      })
      expect(await native.projectedStatus({ messages, summary: { cutoffIndex: 2, message: summary } }))
        .toEqual({ ...status, estimatedInputTokens: 13, currentContextTokens: 13, compressionApplied: true,
          breakdown: { ...status.breakdown, messageTokens: 8 } })
    })

  it('maps repeated manual compression to raw history and preserves pending image transactions', async () => {
    const state = source()
    state.messages.push({ id: 'next', kind: 'user', content: 'Inspect this' },
      { id: 'call-message', kind: 'assistant', content: '', calls: [{ id: 'image', name: 'view_image', args: {} }] },
      { id: 'result', kind: 'tool', resultFor: 'image', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] })
    state.summary = { cutoffIndex: 2, message: { kind: 'user', content: 'Earlier summary', context: { summary: true } } }
    const before = structuredClone(state)
    const result = await createConversationContextRuntime(options()).compress(state, new AbortController().signal)
    expect(result).toMatchObject({ summaryText: 'Summary', cutoffIndex: 3, activatedAfterMessageIndex: 4,
      coveredThroughMessageId: 'next', firstPreservedMessageId: 'call-message' })
    expect(mocks.generate.mock.calls[0][0]).toContain('Earlier summary')
    expect(mocks.generate.mock.calls[0][0]).toContain('Inspect this')
    expect(mocks.generate.mock.calls[0][0]).not.toContain('YQ==')
    expect(state).toEqual(before)
  })

  it('rejects summary-only and wholly pending image history instead of replacing it', async () => {
    const runtime = createConversationContextRuntime(options())
    await expect(runtime.compress({ messages: [], summary: { cutoffIndex: 0, message: { kind: 'user', content: 'Summary', context: { summary: true } } } },
      new AbortController().signal)).rejects.toThrow('no new conversation history')
    await expect(runtime.compress({ messages: [{ kind: 'assistant', content: '', calls: [{ id: 'image', name: 'view_image', args: {} }] },
      { kind: 'tool', resultFor: 'image', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } }] }] },
    new AbortController().signal)).rejects.toThrow('before the pending tool images')
    expect(mocks.generate).not.toHaveBeenCalled()
  })

  it('refreshes settings after attachment preparation but retains an in-flight completed summary', async () => {
    let selected = model
    const larger = { ...model, model: 'larger', maxContextTokens: 20000 }
    const runtime = createConversationContextRuntime({ ...options(), resolveModel: async () => selected,
      projectMessages: async messages => { selected = larger; return messages } })
    const result = await runtime.compress(source(), new AbortController().signal)
    expect(result.summaryText).toBe('Summary')
    expect(mocks.selected).toHaveBeenCalledOnce()
    expect(mocks.selected).toHaveBeenCalledWith(larger)
    mocks.generate.mockImplementationOnce(async () => { selected = model; return { text: 'Completed on larger' } })
    const completed = await runtime.compress(source(), new AbortController().signal)
    expect(completed.summaryText).toBe('Completed on larger')
    expect(mocks.generate).toHaveBeenCalledTimes(2)
  })

  it('counts attachment and recalled memory separately and never trims oversized source history', async () => {
    const runtime = createConversationContextRuntime({ ...options(), projectMessages: async messages => messages.map(message => message.kind === 'user'
      ? { ...message, content: `${message.content}\nAttachment content` } : message),
    projectSystemMessage: async system => ({ ...system, content: `${system.content}\nRecalled memory` }) })
    const status = await runtime.projectedStatus(source())
    expect(status.breakdown.attachmentTokens).toBeGreaterThan(0)
    expect(status.breakdown.systemInstructionTokens).toBeGreaterThan(3)
    const oversized = { messages: [{ kind: 'user' as const, content: 'Do not drop this goal '.repeat(5000) }] }
    await expect(runtime.compress(oversized, new AbortController().signal)).rejects.toBeInstanceOf(ModelSelectionError)
    expect(mocks.generate).not.toHaveBeenCalled()
    expect(oversized.messages[0].content).toHaveLength('Do not drop this goal '.length * 5000)
  })

  it('projects plain chat and missing results without modifying durable history', () => {
    const native: ConversationMessage[] = [
      { kind: 'user', content: '/skill\nexpanded context', context: { displayText: '/skill' } },
      { kind: 'assistant', content: 'Inspecting', calls: [{ id: 'call', name: 'read', args: { path: 'fixture' } }] },
      { kind: 'tool', resultFor: 'call', content: 'Tool result' }, { kind: 'assistant', content: 'Answer' }
    ]
    const before = structuredClone(native)
    for (const protocol of ['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const) {
      expect(projectConversationInput(simpleConversationHistory(native), protocol)).toEqual({ messages: [
        { role: 'user', content: '/skill' }, { role: 'assistant', content: 'Inspecting' }, { role: 'assistant', content: 'Answer' }
      ].map(message => protocol === 'openai_responses' ? { type: 'message', ...message } : message) })
    }
    expect(conversationSummaryTranscript(native)).toBe("Human: /skill\nexpanded context\nAI: Inspecting[{\"id\":\"call\",\"name\":\"read\",\"args\":{\"path\":\"fixture\"}}]\nTool: Tool result\nAI: Answer")
    const missing = projectConversationToolHistory(native.slice(0, 2))
    expect(missing.at(-1)).toMatchObject({ kind: 'tool', resultFor: 'call', resultStatus: 'error', context: { unrecordedResult: true } })
    expect(missing.at(-1)?.content).toContain('outcome is unknown')
    expect(native).toEqual(before)
  })

  it('rejects a corrupt summary boundary explicitly', async () => {
    const state = source()
    state.summary = { cutoffIndex: 3, message: { kind: 'user', content: 'Summary', context: { summary: true } } }
    await expect(createConversationContextRuntime(options()).status(state)).rejects.toThrow('summary boundary')
  })
})
