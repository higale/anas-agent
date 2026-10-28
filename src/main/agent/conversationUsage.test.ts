import type { ConversationMessage } from '../../runtime/conversationMessage'
import { describe, expect, it } from 'vitest'
import { conversationRequestKey as requestKey, conversationContextTokens as windowTokens, conversationUsageSnapshot, projectConversationSkills, countConversationTokens } from './conversationContext'

import { defineContentTool } from '../../runtime/toolDefinition'
import { modelToolDeclaration } from './modelToolDeclarations'
import { z } from 'zod'

describe('compression input calibration', () => {
  const system: ConversationMessage = { kind: 'system', content: 'System' }
  function answer(inputTokens = 80, outputTokens = 20, content = 'answer'): ConversationMessage {
    return { kind: 'assistant', content, context: { modelContextKey: 'test-model',
      requestKey: contextRequestKey({ systemMessage: system, tools: [] }) },
      usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }
  }

  it('calibrates earlier input and adds the actual response when no new context follows it', () => {
    const messages = [answer()]
    expect(currentContextWindowTokens({ messages, systemMessage: system, tools: [] })).toBe(80 + countConversationTokens(messages))
  })

  it('does not let old provider usage hide new instructions and tool schemas', () => {
    const messages = [answer()], systemMessage: ConversationMessage = { kind: 'system', content: 'New instructions '.repeat(500) }
    const tools = [{ type: 'function', function: { name: 'report', description: 'New schema '.repeat(500), parameters: { type: 'object', properties: {} } } }]
    const current = currentContextWindowTokens({ messages, systemMessage, tools })
    expect(current).toBe(countConversationTokens([systemMessage, ...messages], tools))
    expect(current).toBeGreaterThan(100)
  })

  it('adds user and tool context after a server snapshot', () => {
    const messages: ConversationMessage[] = [answer(), { kind: 'user', content: 'follow-up ' + 'x'.repeat(400) },
      { kind: 'tool', content: 'result ' + 'y'.repeat(400), resultFor: 'call-1' }]
    expect(currentContextWindowTokens({ messages, systemMessage: system, tools: [] })).toBe(80 + countConversationTokens(messages, [], { protocol: 'openai_chat_completions' }))
  })

  it('ignores a stale server snapshot after context reconstruction', () => {
    const messages = [answer(8000, 2000, 'answer ' + 'x'.repeat(400))]
    expect(currentContextWindowTokens({ messages, systemMessage: undefined, tools: [] })).toBe(countConversationTokens(messages))
  })
})

function contextRequestKey(options: Omit<Parameters<typeof requestKey>[0], 'messages' | 'protocol'> & Partial<Pick<Parameters<typeof requestKey>[0], 'messages' | 'protocol'>>) {
  return requestKey({ messages: [], protocol: 'openai_chat_completions', ...options })
}

function currentContextWindowTokens(options: Omit<Parameters<typeof windowTokens>[0], 'protocol'> & Partial<Pick<Parameters<typeof windowTokens>[0], 'protocol'>>) {
  return windowTokens({ protocol: 'openai_chat_completions', ...options })
}

function serverMessage(options: {
  id: string
  input: number
  output: number
  total: number
}): ConversationMessage & { context: NonNullable<ConversationMessage['context']> } {
  return { kind: 'assistant' as const,
    id: options.id,
    content: 'Answer',
    context: { requestKey: contextRequestKey({ systemMessage: undefined, tools: [] }) },
    usage: {
      input_tokens: options.input,
      output_tokens: options.output,
      total_tokens: options.total
    }
   }
}

describe('server token usage', () => {
  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('binds %s usage to the replayed input while allowing new messages and metadata', (protocol) => {
    const systemMessage = { kind: 'system' as const, content: 'System' }
    const original = { kind: 'user' as const,  id: 'input', content: 'Read this exact content'  }
    const options = { systemMessage, tools: [], protocol }
    const response = serverMessage({ id: 'response', input: 9000, output: 3, total: 9003 })
    response.context.requestKey = contextRequestKey({ ...options, messages: [original] })
    const tail = { kind: 'user' as const, content: 'Continue' }
    const calibrated = (messages: ConversationMessage[]) => currentContextWindowTokens({ ...options, messages })
    const expected = 9000 + countConversationTokens([response, tail], [], { protocol })
    expect(calibrated([original, response, tail])).toBe(expected)
    const restored = { kind: 'user' as const,  id: 'restored-id', content: original.content, context: { runId: 'new-run' }  }
    expect(calibrated([restored, response, tail])).toBe(expected)
    for (const content of ['Read this changed content', '', 'Read this exact content plus attachment']) {
      expect(calibrated([{ kind: 'user' as const, content: content }, response, tail])).toBeLessThan(9000)
    }
    expect(calibrated([response, tail])).toBeLessThan(9000)
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('reconstructs request-only Skill expansion for %s usage', (protocol) => {
    const input = { kind: 'user' as const, id: 'skill', content: '/review\n\n<skill>\nReview carefully.\n</skill>', context: { displayText: '/review' } }
    const options = { systemMessage: { kind: 'system' as const, content: 'System' }, tools: [], protocol }
    const response = serverMessage({ id: 'response', input: 9000, output: 3, total: 9003 })
    response.context.requestKey = contextRequestKey({ ...options, messages: projectConversationSkills([input]) })
    expect(currentContextWindowTokens({ ...options, messages: [input, response] })).toBeGreaterThan(9000)
    expect(contextRequestKey({ ...options, messages: [input] })).toBe(response.context.requestKey)
  })

  it('normalizes instruction content and executable tools while preserving native tool definitions', () => {
    const lookup = defineContentTool({ name: 'lookup', description: 'Search', inputSchema: z.object({ query: z.string() }), execute: async () => 'result' })
    const native = { type: 'web_search', filters: { allowed_domains: ['example.com'] } }
    const first = contextRequestKey({ systemMessage: { kind: 'system' as const,  id: 'first', content: 'Instructions'  }, tools: [lookup, native] })
    const restored = contextRequestKey({
      systemMessage: { kind: 'system' as const,  id: 'restored', content: [{ type: 'text', text: 'Instructions' }]  },
      tools: [{ filters: { allowed_domains: ['example.com'] }, type: 'web_search' }, modelToolDeclaration(lookup, 'openai_chat_completions')]
    })
    expect(restored).toBe(first)
    expect(contextRequestKey({ systemMessage: { kind: 'system' as const, content: 'Instructions' }, tools: [lookup,
      { ...native, filters: { allowed_domains: ['other.example'] } }] })).not.toBe(first)
  })

  it('invalidates earlier provider input after recalled instructions or tools are removed', () => {
    const previousRequest = { systemMessage: { kind: 'system' as const, content: 'Recalled memory '.repeat(400) }, tools: [
      { type: 'function', function: { name: 'lookup', description: 'Search', parameters: { type: 'object', properties: {} } } }
    ] }
    const response = serverMessage({ id: 'previous', input: 9000, output: 5, total: 9005 })
    response.context.requestKey = contextRequestKey(previousRequest)
    const messages = [response, { kind: 'user' as const, content: 'Continue' }]
    const count = (request: typeof previousRequest) => currentContextWindowTokens({ ...request, messages })
    expect(count(previousRequest)).toBeGreaterThan(9000)
    for (const request of [{ ...previousRequest, systemMessage: { kind: 'system' as const, content: 'Base' } }, { ...previousRequest, tools: [] }]) {
      expect(count(request)).toBe(countConversationTokens([request.systemMessage, ...messages], request.tools))
    }
    delete response.context.requestKey
    expect(count(previousRequest)).toBe(countConversationTokens([previousRequest.systemMessage, ...messages], previousRequest.tools))
  })

  it('counts Responses instructions once in a full estimate and never again in the usage increment', () => {
    const context = { systemMessage: { kind: 'system' as const, content: 'Base' }, tools: [], protocol: 'openai_responses' as const }
    const response = serverMessage({ id: 'previous', input: 1000, output: 5, total: 1005 })
    response.context.requestKey = contextRequestKey(context)
    const messages = [response, { kind: 'user' as const, content: 'Continue' }]
    const options = { ...context, messages, protocol: 'openai_responses' as const, parameters: { instructions: 'i'.repeat(2000) } }
    expect(currentContextWindowTokens({ ...options }))
      .toBe(1000 + countConversationTokens(messages, [], { protocol: options.protocol }))
  })

  it('uses only usage produced after the currently active summary boundary', () => {
    const summary = { kind: 'user' as const,  content: 'Condensed history', context: {
      summary: true, summaryId: 'first-summary'
    }  }
    const old = serverMessage({ id: 'old', input: 9000, output: 1000, total: 10000 })
    const context = { systemMessage: undefined, tools: [] }
    expect(currentContextWindowTokens({ ...context, messages: [old] })).toBeGreaterThan(9000)
    expect(currentContextWindowTokens({ ...context, messages: [summary, old] })).toBeLessThan(10000)
    const fresh = serverMessage({ id: 'fresh', input: 1500, output: 100, total: 1600 })
    fresh.context.requestKey = contextRequestKey({ ...context, messages: [summary, old] })
    const tail = { kind: 'user' as const, content: 'Continue after the summarized request' }
    expect(currentContextWindowTokens({ ...context, messages: [summary, old, fresh, tail] }))
      .toBe(1500 + countConversationTokens([fresh, tail]))
    const replaced = { kind: 'user' as const,  content: summary.content, context: {
      summary: true, summaryId: 'second-summary'
    }  }
    expect(currentContextWindowTokens({ ...context, messages: [replaced, fresh, tail] })).toBeLessThan(1600)
  })

  it('adds pending images and protocol transport text to a valid provider snapshot', () => {
    const pending = { kind: 'tool' as const,  resultFor: 'image-call', name: 'view_image', content: [
      { type: 'text', text: 'Captured a screenshot.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
    ]  }
    const previous = serverMessage({ id: 'previous', input: 9000, output: 1000, total: 10000 })
    const encodedIncrement = countConversationTokens([pending], [], { protocol: 'openai_chat_completions' })
    const context = { systemMessage: undefined, tools: [],
      protocol: 'openai_chat_completions' as const }
    expect(encodedIncrement).toBeGreaterThan(1024)
    expect(currentContextWindowTokens({ ...context, messages: [previous, pending] })).toBe(9000
      + countConversationTokens([previous, pending], [], { protocol: context.protocol }))
    const observed = serverMessage({ id: 'observed', input: 10000 + encodedIncrement, output: 100, total: 10100 + encodedIncrement })
    observed.context.requestKey = contextRequestKey({ ...context, messages: [previous, pending] })
    expect(currentContextWindowTokens({ ...context, messages: [previous, pending, observed] })).toBeLessThan(1024)
  })

  it('adds only the replayed response to calibrated input instead of billed hidden reasoning', () => {
    const response = { kind: 'assistant' as const,  content: 'Visible answer', context: { modelContextKey: 'current', requestKey: contextRequestKey({ systemMessage: undefined, tools: [] }) },
      usage: { input_tokens: 1000, output_tokens: 8000, total_tokens: 9000,
        output_token_details: { reasoning: 7996 } }  }
    const followup = { kind: 'user' as const, content: 'Continue' }
    const messages = [response, followup]
    expect(currentContextWindowTokens({ messages, systemMessage: undefined, tools: [],
      modelContextKey: 'current', protocol: 'openai_chat_completions' }))
      .toBe(1000 + countConversationTokens(messages, [], { protocol: 'openai_chat_completions' }))
    expect(conversationUsageSnapshot(messages, 'current')?.usage?.totalTokens).toBe(9000)
  })

  it('does not reuse another model configuration usage or search past the newest response', () => {
    const old = serverMessage({ id: 'old', input: 8000, output: 1000, total: 9000 })
    old.context.modelContextKey = 'current'
    const newest = serverMessage({ id: 'new', input: 9000, output: 1000, total: 10000 })
    newest.context.modelContextKey = 'previous-parameters'
    const messages = [old, newest]
    expect(conversationUsageSnapshot(messages, 'current')?.usage).toBeUndefined()
    expect(conversationUsageSnapshot(messages, 'previous-parameters')?.usage?.totalTokens).toBe(10000)
    expect(currentContextWindowTokens({ messages, systemMessage: undefined, tools: [],
      modelContextKey: 'current' })).toBeLessThan(9000)
  })

  it('uses the latest response total as a snapshot instead of accumulating responses', () => {
    const usage = conversationUsageSnapshot([
      serverMessage({ id: 'first', input: 80, output: 20, total: 100 }),
      { kind: 'user' as const, content: 'Follow-up' },
      serverMessage({ id: 'second', input: 120, output: 30, total: 150 }),
      { kind: 'tool' as const,  content: 'Tool result', resultFor: 'call-1'  }
    ])?.usage

    expect(usage).toMatchObject({
      inputTokens: 120,
      outputTokens: 30,
      totalTokens: 150
    })
  })

  it('keeps the standard cache, reasoning, and modality details', () => {
    const usage = conversationUsageSnapshot([{ kind: 'assistant' as const,
      content: 'Answer',
    context: { requestKey: contextRequestKey({ systemMessage: undefined, tools: [] }) },
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        total_tokens: 150,
        input_token_details: {
          text: 80,
          image: 20,
          cache_read: 60,
          cache_creation: 10
        },
        output_token_details: {
          text: 20,
          reasoning: 30
        }
      }
     }])?.usage

    expect(usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
      inputTokenDetails: {
        textTokens: 80,
        imageTokens: 20,
        cacheReadTokens: 60,
        cacheCreationTokens: 10
      },
      outputTokenDetails: {
        textTokens: 20,
        reasoningTokens: 30
      }
    })
  })

  it('does not reuse an older snapshot when the latest response has no usage', () => {
    expect(conversationUsageSnapshot([
      serverMessage({ id: 'reported', input: 80, output: 20, total: 100 }),
      { kind: 'user' as const, content: 'Follow-up' },
      { kind: 'assistant' as const,  id: 'unreported', content: 'Answer without usage'  }
    ])?.usage).toBeUndefined()
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'keeps %s provider usage before a synthetic review report and counts its complete suffix', (protocol) => {
      const input = { kind: 'user' as const, content: 'Review the captured changes.' }
      const context = { systemMessage: { kind: 'system' as const, content: 'Review instructions' }, tools: [], protocol }
      const response = serverMessage({ id: 'provider-review', input: 8000, output: 50, total: 8050 })
      response.calls = [{ id: 'review-call', name: 'review_report', args: { summary: 'Done' } }]
      response.context.modelContextKey = 'current'
      response.context.requestKey = contextRequestKey({ ...context, messages: [input] })
      const toolResult = { kind: 'tool' as const,  resultFor: 'review-call', content: '{"summary":"Done"}'  }
      const report = { kind: 'assistant' as const,  content: 'The rendered review report.', context: {
        reviewReport: { report: { summary: 'Done' } }
      }  }
      const messages = [input, response, toolResult, report, { kind: 'user' as const, content: 'Explain the review.' }]

      expect(conversationUsageSnapshot(messages, 'current')).toEqual({
        messageIndex: 1, usage: { inputTokens: 8000, outputTokens: 50, totalTokens: 8050 }
      })
      expect(currentContextWindowTokens({ ...context, messages, modelContextKey: 'current' }))
        .toBe(8000 + countConversationTokens(messages.slice(1), [], { protocol }))
      expect(conversationUsageSnapshot(messages, 'different-model')?.usage).toBeUndefined()
      expect(conversationUsageSnapshot([...messages, { kind: 'assistant' as const,  content: 'An unreported provider response',
        context: { modelContextKey: 'current' }  }, report], 'current')?.usage).toBeUndefined()
    }
  )

  it('rejects zero totals emitted for missing provider usage', () => {
    expect(conversationUsageSnapshot([
      serverMessage({ id: 'empty', input: 0, output: 0, total: 0 })
    ])?.usage).toBeUndefined()
  })
})
