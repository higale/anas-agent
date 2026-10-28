import type OpenAI from 'openai'
import { describe, expect, it } from 'vitest'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { contentText } from '../../runtime/inputContent'
import { conversationContentBlocks } from '../../providers/conversationInput'
import { projectConversationInput } from './conversationContext'
import { openAiResponsesConversationResponse } from '../../providers/conversationOutput'
import { streamResponsesConversation } from '../../providers/conversationStream'
import { simpleConversationHistory } from './conversationHistoryProjection'

const user = (content: string): ConversationMessage => ({ kind: 'user', content })
const tool = (resultFor: string): ConversationMessage => ({ kind: 'tool', resultFor, content: 'Tool result' })
const reasoningItem = (id: string) => ({ type: 'reasoning', id,
  summary: [{ type: 'summary_text', text: `Useful reasoning ${id}` }], encrypted_content: `encrypted-${id}` })
const callItem = { type: 'function_call', id: 'fc_history', call_id: 'call_history', name: 'read_file',
  arguments: '{"path":"notes.txt"}', status: 'completed' }
const textItem = { type: 'message', id: 'msg_history', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text: 'Visible answer', annotations: [] }] }
const serverItem = { type: 'web_search_call', id: 'search_history', status: 'completed', action: { type: 'search', query: 'Reference' } }

async function responsesMessage(output: unknown[], stream: boolean): Promise<ConversationMessage> {
  const response = { id: 'resp_history', object: 'response', created_at: 1, status: 'completed', model: 'reasoning-model',
    output, usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } as OpenAI.Responses.Response
  if (!stream) return openAiResponsesConversationResponse(response).message
  async function *events(): AsyncGenerator<OpenAI.Responses.ResponseStreamEvent> {
    let sequence_number = 0
    yield { type: 'response.created', sequence_number: sequence_number++, response: { ...response, status: 'in_progress', output: [] } }
    for (let output_index = 0; output_index < response.output.length; output_index++) {
      const item = response.output[output_index]
      yield { type: 'response.output_item.added', sequence_number: sequence_number++, output_index, item }
      if (item.type === 'message') {
        for (let content_index = 0; content_index < item.content.length; content_index++) {
          const part = item.content[content_index]
          if (part.type === 'output_text') yield { type: 'response.output_text.delta', sequence_number: sequence_number++,
            output_index, content_index, item_id: item.id, delta: part.text, logprobs: [] }
        }
      }
      yield { type: 'response.output_item.done', sequence_number: sequence_number++, output_index, item }
    }
    yield { type: 'response.completed', sequence_number: sequence_number++, response }
  }
  return (await streamResponsesConversation(events(), () => {})).message
}

describe('simple chat history boundary', () => {
  it.each([false, true].flatMap(stream => [false, true].map(text => ({ stream, text }))))(
    'detaches reasoning from removed Responses client calls (stream=$stream, visible text=$text)', async ({ stream, text }) => {
      const source = await responsesMessage([reasoningItem('rs_client'), callItem, ...(text ? [textItem] : [])], stream)
      const original = structuredClone(source)
      const projected = simpleConversationHistory([user('Read the notes'), source, tool('call_history'), user('Continue in plain chat')])
      const wire = projectConversationInput(projected, 'openai_responses').messages
      expect(wire).toContainEqual({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Useful reasoning rs_client' }],
        encrypted_content: 'encrypted-rs_client' })
      expect(wire.some(item => typeof item === 'object' && item !== null && 'id' in item && item.id === 'rs_client')).toBe(false)
      expect(JSON.stringify(wire)).not.toContain('call_history')
      expect(JSON.stringify(wire)).not.toContain('Tool result')
      expect(wire).toHaveLength(text ? 4 : 3)
      if (text) expect(wire).toContainEqual(textItem)
      const assistant = projected.find(message => message.kind === 'assistant')!
      expect(conversationContentBlocks(assistant).filter(block => block.type === 'reasoning').every(block => !('id' in block))).toBe(true)
      if (assistant.source?.extras.reasoning) expect(assistant.source.extras.reasoning).not.toHaveProperty('id')
      expect(source).toEqual(original)
    }
  )

  it.each([false, true])('retains reasoning IDs paired with surviving provider output (stream=%s)', async stream => {
    const source = await responsesMessage([reasoningItem('rs_server'), serverItem, reasoningItem('rs_text'), textItem,
      reasoningItem('rs_client'), callItem], stream)
    const wire = projectConversationInput(simpleConversationHistory([user('Inspect'), source, user('Continue')]), 'openai_responses').messages
    expect(wire).toEqual([expect.objectContaining({ role: 'user' }), reasoningItem('rs_server'), serverItem,
      reasoningItem('rs_text'), textItem, expect.objectContaining({ type: 'reasoning', encrypted_content: 'encrypted-rs_client' }),
      expect.objectContaining({ role: 'user' })])
    expect(wire[5]).not.toHaveProperty('id')
  })

  it.each([false, true])('preserves unchanged Responses reasoning replay (stream=%s)', async stream => {
    const source = await responsesMessage([reasoningItem('rs_text'), textItem], stream)
    const messages = [user('Inspect'), source, user('Continue')]
    expect(projectConversationInput(simpleConversationHistory(messages), 'openai_responses').messages)
      .toEqual(projectConversationInput(messages, 'openai_responses').messages)
  })

  it.each(['standard', 'non-standard', 'metadata'] as const)('detaches reasoning in the %s representation without raw output', format => {
    const reason = reasoningItem('rs_client')
    const call = { id: 'call_history', name: 'read_file', args: { path: 'notes.txt' } }
    const source: ConversationMessage = { kind: 'assistant', content: format === 'metadata' ? [] : format === 'standard'
      ? [{ ...reason, reasoning: 'Useful reasoning rs_client' }, { type: 'tool_call', ...call }]
      : [{ type: 'non_standard', value: reason }, { type: 'non_standard', value: callItem }], calls: [call],
      source: { provider: 'openai', ...(format !== 'metadata' ? { contentFormat: 'portable' } : {}),
        metadata: {}, extras: format === 'metadata' ? { reasoning: reason } : {} } }
    const wire = projectConversationInput(simpleConversationHistory([source]), 'openai_responses').messages
    expect(wire).toHaveLength(1)
    expect(wire[0]).toMatchObject({ type: 'reasoning', summary: [{ type: 'summary_text', text: 'Useful reasoning rs_client' }] })
    expect(wire[0]).not.toHaveProperty('id')
  })

  it.each((['openai_responses', 'anthropic_messages'] as const).flatMap(protocol => ['native', 'standard'].map(format => ({ protocol, format }))))(
    'removes client calls from actual $protocol/$format replay while retaining text and provider context', ({ protocol, format }) => {
      const call = { id: 'call_1', name: 'read_file', args: { path: 'file.txt' } }
      const output = [{ type: 'function_call', id: 'fc_1', call_id: call.id, name: call.name, arguments: JSON.stringify(call.args), status: 'completed' },
        { type: 'reasoning', id: 'reasoning_1', summary: [{ type: 'summary_text', text: 'Reasoned' }] },
        { type: 'web_search_call', id: 'search_1', status: 'completed' },
        { type: 'message', id: 'message_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Reading', annotations: [] }] }]
      const content = format === 'standard' ? [{ type: 'text', text: 'Reading' }, { type: 'tool_call', ...call }]
        : protocol === 'anthropic_messages' ? [{ type: 'text', text: 'Reading' }, { type: 'thinking', thinking: 'Reasoned', signature: 'signed' },
          { type: 'tool_use', id: call.id, name: call.name, input: call.args }] : 'Reading'
      const message: ConversationMessage = { kind: 'assistant', content, calls: [call],
        source: { provider: protocol === 'anthropic_messages' ? 'anthropic' : 'openai', extras: {},
          metadata: protocol === 'openai_responses' && format === 'native' ? { output } : {} } }
      const wire = JSON.stringify(projectConversationInput(simpleConversationHistory([user('Inspect'), message, tool(call.id), user('Explain')]), protocol))
      expect(wire).not.toContain('call_1')
      expect(wire).not.toContain('read_file')
      expect(wire).not.toContain('Tool result')
      expect(wire).toContain('Reading')
      expect(wire).toContain('Explain')
      if (format === 'native') expect(wire).toContain('Reasoned')
      if (format === 'native' && protocol === 'openai_responses') expect(wire).toContain('web_search_call')
      if (format === 'native' && protocol === 'anthropic_messages') expect(wire).toContain('signed')
    }
  )

  it.each(['openai_responses', 'anthropic_messages'] as const)('omits a client-call-only assistant from %s plain history', protocol => {
    const call = { id: 'call_1', name: 'read_file', args: {} }
    const message: ConversationMessage = { kind: 'assistant', calls: [call],
      content: protocol === 'anthropic_messages' ? [{ type: 'tool_use', id: call.id, name: call.name, input: {} }] : '',
      source: { provider: protocol === 'anthropic_messages' ? 'anthropic' : 'openai', extras: {},
        metadata: protocol === 'openai_responses' ? { output: [{ type: 'function_call', id: 'fc_1', call_id: call.id,
          name: call.name, arguments: '{}', status: 'completed' }] } : {} } }
    const messages = simpleConversationHistory([user('Inspect'), message, tool(call.id), user('Explain')])
    expect(messages.every(message => message.kind === 'user')).toBe(true)
    expect(JSON.stringify(projectConversationInput(messages, protocol))).not.toContain('assistant')
  })

  it('keeps conversation, summaries and attachments while removing tool execution state', () => {
    const messages = simpleConversationHistory([
      { kind: 'system', content: 'Injected system context' },
      { id: 'user-1', kind: 'user', content: [{ type: 'text', text: 'Expanded skill instructions' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }], context: { displayText: '/summarize report', runId: 'run-1' } },
      { id: 'assistant-1', kind: 'assistant', content: 'Calling a tool.', calls: [{ id: 'call-1', name: 'read_memory', args: {} }],
        source: { extras: { reasoning: { id: 'rs_1', type: 'reasoning', summary: [] } },
          metadata: { output: [{ id: 'rs_1', type: 'reasoning', summary: [] }] } } },
      { kind: 'tool', content: 'Private memory content', resultFor: 'call-1' },
      { kind: 'user', content: 'Summary containing old tool output.', context: { summary: true } }
    ])
    expect(messages).toHaveLength(3)
    expect(messages[0].content).toEqual([{ type: 'text', text: '/summarize report' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }])
    expect(messages[1].calls).toEqual([])
    expect(messages[1].source?.extras.reasoning).toEqual({ type: 'reasoning', summary: [] })
    expect(messages[1].source?.metadata.output).toEqual([{ type: 'reasoning', summary: [] }])
    const text = messages.map(message => contentText(conversationContentBlocks(message))).join('\n')
    expect(text).not.toContain('Private memory content')
    expect(text).toContain('Summary containing old tool output')
  })
})
