import { describe, expect, it } from 'vitest'
import { ModelContextOverflowError } from '../../runtime/errors'
import { modelContextKey } from '@shared/modelConfig'
import type { ResolvedModelConfig } from '@shared/types'
import { assertConversationFits, assertConversationSupported, countConversationTokens, conversationRequestKey, conversationContextTokens, projectConversationToolImages } from './conversationContext'
import { isModelSelectionError } from '../../runtime/errors'
import { effectiveConversationHistory } from './conversationHistoryProjection'

const model: ResolvedModelConfig = {
  id: 'test', displayName: 'Test', providerId: 'provider', providerName: 'Provider',
  protocol: 'openai_chat_completions', baseUrl: 'https://example.com/v1', model: 'test',
  parameters: {}, parameterPresetMode: 'none', capabilities: { toolUse: true, vision: true },
  stream: true, maxContextTokens: 4096, maxOutputTokens: 1024,
  contextCompressionEnabled: true, contextCompressionThreshold: 0.8
}

describe('model request compatibility', () => {
  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'enforces calibrated %s usage after shrinking the window and disabling compression', (protocol) => {
      const original = { ...model, protocol, maxContextTokens: 100_000 }
      const systemMessage = { kind: 'system' as const, content: 'Preserve the project constraints.' }
      const user = { kind: 'user' as const, content: '分析：' + '中'.repeat(6000) }
      const tools = [{ type: 'function', function: { name: 'lookup', description: 'Find context', parameters: { type: 'object', properties: {} } } }]
      const response = { kind: 'assistant' as const,  content: 'Done',
        usage: { input_tokens: 8000, output_tokens: 1, total_tokens: 8001 },
        context: {
          modelContextKey: modelContextKey(original),
          requestKey: conversationRequestKey({ messages: [user], systemMessage, tools, protocol })
        }
       }
      const messages = [user, response, { kind: 'user' as const, content: 'Continue' }]
      const preparedMessages = [systemMessage, ...messages]
      expect(() => assertConversationFits(original, preparedMessages, tools)).not.toThrow()
      const bounded = { ...original, maxContextTokens: 7000, contextCompressionEnabled: false }
      const calibrated = conversationContextTokens({ messages, systemMessage, tools, protocol,
        modelContextKey: modelContextKey(bounded), parameters: bounded.parameters })
      expect(calibrated).toBeGreaterThan(8000)
      expect(countConversationTokens(preparedMessages, tools, { protocol })).toBeLessThan(3000)
      expect(() => assertConversationFits(bounded, preparedMessages, tools))
        .toThrow(`prepared conversation needs approximately ${calibrated}`)
      expect(() => assertConversationFits({ ...bounded, maxContextTokens: calibrated + bounded.maxOutputTokens }, preparedMessages, tools)).not.toThrow()

      // A changed provider, model, parameter set, or actual input invalidates the
      // old usage. The remaining request fits under its current local estimate.
      for (const changed of [
        { ...bounded, providerId: 'another-provider' },
        { ...bounded, model: 'another-model' },
        { ...bounded, parameters: { temperature: 0.5 } }
      ]) expect(() => assertConversationFits(changed, preparedMessages, tools)).not.toThrow()
      expect(() => assertConversationFits(bounded, [{ kind: 'system' as const, content: 'Changed constraints.' }, ...messages], tools)).not.toThrow()
      expect(() => assertConversationFits(bounded, [systemMessage, { kind: 'user' as const, content: 'Revised input' }, response, messages[2]], tools)).not.toThrow()
      expect(() => assertConversationFits(bounded, preparedMessages, [])).not.toThrow()
      expect(() => assertConversationFits(bounded, [systemMessage, user, { kind: 'assistant' as const, content: 'No usage' }, messages[2]], tools)).not.toThrow()
    }
  )

  it('includes Responses instruction parameters in the final input capacity boundary', () => {
    const selected = { ...model, protocol: 'openai_responses' as const, parameters: { instructions: 'x'.repeat(20_000) } }
    const messages = [{ kind: 'user' as const, content: 'Hi' }]
    expect(() => assertConversationFits(selected, messages, [])).toThrow('prepared conversation needs approximately 5001')
    expect(() => assertConversationFits({ ...selected, parameters: { instructions: 'Short instructions' } }, messages, []))
      .not.toThrow()
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)('includes %s structured-output schemas in the final input capacity boundary', (protocol) => {
    const schema = { type: 'object', description: 'x'.repeat(20_000), properties: { answer: { type: 'string' } } }
    const parameters = protocol === 'anthropic_messages' ? { output_config: { format: { type: 'json_schema', schema } } }
      : protocol === 'openai_responses' ? { text: { format: { type: 'json_schema', name: 'answer', schema } } }
        : { response_format: { type: 'json_schema', json_schema: { name: 'answer', schema } } }
    expect(() => assertConversationFits({ ...model, protocol, parameters }, [{ kind: 'user' as const, content: 'Hi' }], []))
      .toThrow('input capacity of 3072')
  })

  it('reserves 1024 tokens for each image at the final input capacity boundary', () => {
    const messages = [{ kind: 'user' as const,  content: [
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } },
      { type: 'image_url', image_url: { url: 'https://example.test/second.png' } }
    ]  }]
    expect(() => assertConversationFits({ ...model, maxContextTokens: 3072, maxOutputTokens: 1024 }, messages, [])).not.toThrow()
    expect(() => assertConversationFits({ ...model, maxContextTokens: 3071, maxOutputTokens: 1024 }, messages, []))
      .toThrow('prepared conversation needs approximately 2048')
  })

  it('uses a fixed image budget for Responses generated-image history at the input boundary', () => {
    const messages = [{ kind: 'assistant' as const,  content: '', source: { extras: {}, metadata: { output: [{
      type: 'image_generation_call', id: 'ig_generated', status: 'completed', result: 'A'.repeat(100_000)
    }] } }  }]
    const selected = { ...model, protocol: 'openai_responses' as const }
    const tokens = countConversationTokens(messages, [], { protocol: selected.protocol })
    expect(tokens).toBeGreaterThanOrEqual(1024)
    expect(tokens).toBeLessThan(1100)
    expect(() => assertConversationFits({ ...selected, maxContextTokens: tokens + selected.maxOutputTokens }, messages, []))
      .not.toThrow()
    expect(() => assertConversationFits({ ...selected, maxContextTokens: tokens + selected.maxOutputTokens - 1 }, messages, []))
      .toThrow('required context does not fit')
    expect(() => assertConversationSupported({ ...selected, capabilities: { ...selected.capabilities, vision: false } }, messages, false))
      .toThrow('images required')
  })

  it('includes Chat Completions tool-image transport text before allowing a request', () => {
    const messages = [{ kind: 'tool' as const,  resultFor: 'image-call', name: 'view_image', content: [
      { type: 'text', text: 'Loaded screenshot.' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }
    ]  }]
    const rawBudget = countConversationTokens(messages, [], { protocol: 'anthropic_messages' })
    const bounded = { ...model, maxContextTokens: rawBudget + 1000, maxOutputTokens: 1000 }
    expect(() => assertConversationFits({ ...bounded, protocol: 'anthropic_messages' }, messages, [])).not.toThrow()
    expect(() => assertConversationFits(bounded, messages, [])).toThrow('required context does not fit')
  })

  it('rejects unsupported tool history and required supervision, but allows ordinary text', () => {
    const textOnly = { ...model, capabilities: { ...model.capabilities, toolUse: false } }
    expect(() => assertConversationSupported(textOnly, [{ kind: 'user' as const, content: 'Hi' }], false)).not.toThrow()
    expect(() => assertConversationSupported(textOnly, [], true)).toThrow('tool context required')
    expect(() => assertConversationSupported(textOnly, [{ kind: 'assistant' as const,  content: '', calls: [
      { id: 'call', name: 'read_file', args: {} }
    ]  }, { kind: 'tool' as const,  content: 'file content', resultFor: 'call'  }], false)).toThrow('run was stopped')
  })

  it('rejects a vision downgrade without mutating necessary image content', () => {
    const messages = [{ kind: 'user' as const,  content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]  }]
    expect(() => assertConversationSupported({ ...model, capabilities: { ...model.capabilities, vision: false } }, messages, false)).toThrow('images required')
    expect(messages[0].content).toHaveLength(1)
    expect(() => assertConversationSupported(model, messages, false)).not.toThrow()
  })

  it('checks native images only when the selected protocol replays them and the summary retains them', () => {
    const selected = { ...model, protocol: 'openai_responses' as const, capabilities: { ...model.capabilities, vision: false } }
    const output = { type: 'code_interpreter_call', id: 'chart', code: 'plot()', status: 'completed', container_id: 'container',
      outputs: [{ type: 'logs', logs: 'Chart ready' }, { type: 'image', url: 'https://example.test/chart.png' }] }
    const messages = [{ kind: 'user' as const, content: 'Plot the chart' }, { kind: 'assistant' as const,  content: '', source: { extras: {}, metadata: { output: [output] } }  },
      { kind: 'user' as const, content: 'Continue' }]
    expect(() => assertConversationSupported(selected, messages, false)).toThrow('images required')
    expect(() => assertConversationSupported(selected, [{ kind: 'assistant' as const,  content: '', source: { extras: {}, metadata: {
      output: [{ ...output, outputs: [{ type: 'logs', logs: 'No chart was generated' }] }]
    } }  }], false)).not.toThrow()
    for (const protocol of ['openai_chat_completions', 'anthropic_messages'] as const) {
      expect(() => assertConversationSupported({ ...selected, protocol }, messages, false)).not.toThrow()
    }
    const summary = { kind: 'user' as const,  content: 'The chart was inspected.', context: { summary: true }  }
    const projected = effectiveConversationHistory(projectConversationToolImages(messages), { cutoffIndex: 2, message: summary })
    expect(() => assertConversationSupported(selected, projected, false)).not.toThrow()
    expect(messages[1].source?.metadata).toMatchObject({ output: [output] })
  })

  it.each(['openai_chat_completions', 'openai_responses', 'anthropic_messages'] as const)(
    'allows %s text-shaped image data and already-consumed tool images on a text-only model', protocol => {
      const selected = { ...model, protocol, capabilities: { ...model.capabilities, vision: false } }
      const imageJson = { type: 'code_interpreter_call', outputs: [{ type: 'image', url: 'https://example.test/chart.png' }] }
      const jsonMessages = [{ kind: 'assistant' as const,  content: '', calls: [{ id: 'json', name: 'write_json', args: imageJson }]  },
        { kind: 'tool' as const,  resultFor: 'json', content: JSON.stringify(imageJson)  }]
      expect(() => assertConversationSupported(selected, jsonMessages, false)).not.toThrow()
      const imageMessages = [{ kind: 'assistant' as const,  content: '', calls: [{ id: 'image', name: 'view_image', args: {} }]  },
        { kind: 'tool' as const,  resultFor: 'image', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }]  }]
      expect(() => assertConversationSupported(selected, imageMessages, false)).toThrow('images required')
      expect(() => assertConversationSupported(selected,
        projectConversationToolImages([...imageMessages, { kind: 'assistant' as const, content: 'The chart shows an increase.' }]), false)).not.toThrow()
    }
  )

  it('uses the output reserve in the final input limit and never truncates history', () => {
    const messages = [{ kind: 'user' as const, content: 'Required context. '.repeat(2000) }]
    expect(() => assertConversationFits(model, messages, [])).toThrow('input capacity of 3072')
    expect(messages[0].content).toBe('Required context. '.repeat(2000))
    expect(() => assertConversationFits({ ...model, maxContextTokens: 100_000 }, messages, [])).not.toThrow()
    try { assertConversationFits(model, messages, []) } catch (error) {
      expect(error).toBeInstanceOf(ModelContextOverflowError)
      expect(isModelSelectionError(error)).toBe(true)
    }
  })
})
