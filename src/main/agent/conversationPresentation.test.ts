import boundarySamples from './fixtures/conversation-presentation.json'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { conversationSummaryTranscript } from './conversationHistoryProjection'
import { describe, expect, it } from 'vitest'
import { presentConversationMessage } from './conversationPresentation'
import { projectConversationSkills } from './conversationContext'
import { userMessageContent } from '../../runtime/messagePresentation'
import { contentText } from '../../runtime/inputContent'
import { conversationContentBlocks } from '../../providers/conversationInput'

describe('agent message mapping', () => {
  it('sends the original request and exact Skill context as separate user messages without moving attachments', () => {
    const request = '/demo 用户需求 <skill> $0'
    const skill = '<skill>\n<name>demo</name>\n<path>/skills/demo/SKILL.md</path>\n---\nname: demo\n---\n$ARGUMENTS <skill>literal</skill>\n</skill>'
    const text = `${request}\n\n${skill}`
    const message = { kind: 'user' as const, content: userMessageContent(text, [{ type: 'image', mimeType: 'image/png', data: 'abc' }]), id: 'user-1', context: { displayText: request } }
    const [user, context] = projectConversationSkills([message])
    expect(user.kind).toBe('user')
    expect(context.kind).toBe('user')
    expect(user.content).toEqual([
      { type: 'text', text: request },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'auto' } }
    ])
    expect(context.content).toBe(skill)
    expect(presentConversationMessage(message, 'fallback').skillInvocation?.promptText).toBe(`${contentText(conversationContentBlocks(user))}\n\n${contentText(conversationContentBlocks(context))}`)
    expect(projectConversationSkills([user, context])).toEqual([user, context])
    expect(message.content).toEqual([
      { type: 'text', text },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,abc', detail: 'auto' } }
    ])
    const plain = { kind: 'user' as const, content: text }
    expect(projectConversationSkills([plain])).toEqual([plain])
  })

  it('preserves message ids and tool calls', () => {
    const message = { kind: 'assistant' as const, id: 'assistant-1', content: [{ type: 'text', text: 'Checking.' }], calls: [{ id: 'call-1', name: 'read_file', args: { path: '/projects/anas/a.ts' } }] }

    expect(presentConversationMessage(message, 'fallback')).toEqual({
      id: 'assistant-1',
      role: 'assistant',
      content: [{ type: 'text', text: 'Checking.' }],
      name: undefined,
      toolCalls: [{
        id: 'call-1',
        name: 'read_file',
        args: { path: '/projects/anas/a.ts' }
      }]
    })
  })

  it('maps tool correlation ids', () => {
    const message = { kind: 'tool' as const, id: 'tool-1', content: 'done', resultFor: 'call-1' }
    expect(presentConversationMessage(message, 'fallback')).toMatchObject({
      id: 'tool-1',
      role: 'tool',
      toolCallId: 'call-1',
      content: [{ type: 'text', text: 'done' }]
    })
  })

  it('preserves a Responses reasoning summary for activity presentation', () => {
    const message = { kind: 'assistant' as const, id: 'assistant-reasoning', content: [{
        type: 'reasoning',
        reasoning: 'Detailed reasoning',
        summary: [{ type: 'summary_text', text: 'Short summary' }]
      }] }

    expect(presentConversationMessage(message, 'fallback')).toMatchObject({
      content: [{
        type: 'reasoning',
        text: 'Detailed reasoning',
        summary: 'Short summary'
      }]
    })
  })

  it('creates native human messages with multimodal content', () => {
    const message = { kind: 'user' as const, content: userMessageContent('Describe this', [{
      type: 'image',
      mimeType: 'image/png',
      data: 'abc'
    }]) }
    expect(message.kind).toBe('user')
    expect(message.content).toEqual([
      { type: 'text', text: 'Describe this' },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,abc',
          detail: 'auto'
        }
      }
    ])
    expect(presentConversationMessage(message, 'human-image')).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'Describe this' },
        { type: 'image', mimeType: 'image/png', data: 'abc' }
      ]
    })
  })

  it('keeps expanded skill text for the model and the slash command for the UI', () => {
    const message = { kind: 'user' as const, content: userMessageContent('Expanded skill instructions', undefined), context: { displayText: '/summarize report' } }
    expect(contentText(conversationContentBlocks(message))).toBe('Expanded skill instructions')
    expect(presentConversationMessage(message, 'human-skill')).toMatchObject({
      role: 'user',
      content: [{ type: 'text', text: '/summarize report' }],
      skillInvocation: {
        name: 'summarize',
        args: 'report',
        promptText: 'Expanded skill instructions'
      }
    })
  })

  it('preserves the tool boundary used to place a queued direction in the timeline', () => {
    const message = { kind: 'user' as const, content: userMessageContent('Use the tool result differently.', undefined), id: 'direction-1', context: { runId: 'run-1', createdAt: '2026-08-29T12:00:00.000Z', directionAfterCallIds: ['tool-1', 'tool-2'] } }

    expect(presentConversationMessage(message, 'fallback')).toMatchObject({
      id: 'direction-1',
      role: 'user',
      runId: 'run-1',
      createdAt: '2026-08-29T12:00:00.000Z',
      directionAfterToolCallIds: ['tool-1', 'tool-2']
    })
  })
})

describe('existing summary prompt boundary', () => {
  it('preserves the imported transcript for roles, names, tools and multimodal content', () => {
    const messages = [{ kind: 'system' as const, content: 'rules' }, { kind: 'user' as const, name: 'user', content: [
      { type: 'text', text: 'inspect' }, { type: 'text-plain' },
      { type: 'image', data: 'IMAGE_DATA' }, { type: 'input_audio', data: 'AUDIO_DATA' },
      { type: 'video', data: 'VIDEO_DATA' }, { type: 'file', data: 'FILE_DATA' }
    ] }, { kind: 'assistant' as const, content: [
      { type: 'reasoning', reasoning: 'PRIVATE_REASONING' }, { type: 'text', text: 'read' },
      { type: 'non_standard', value: 'METADATA' }, { type: 'custom_kind', data: 'CUSTOM_BYTES' }
    ], calls: [{ id: 'call', name: 'read', args: { path: 'a' } }] },
    { kind: 'tool' as const, resultFor: 'call', name: 'read', content: 'result' },
    { kind: 'custom' as const, role: 'custom-role', content: 'custom text' },
    { kind: 'assistant' as const, content: 'legacy', source: { metadata: {}, extras: { function_call: { name: 'legacy', arguments: '{}' } } } }]
    const before = JSON.stringify(messages)
    expect(conversationSummaryTranscript(messages)).toBe("System: rules\nHuman: user, inspect[text-plain file][image][audio][video][file]\nAI: read[custom_kind][{\"id\":\"call\",\"name\":\"read\",\"args\":{\"path\":\"a\"}}]\nTool: read, result\ncustom-role: custom text\nAI: legacy{\"name\":\"legacy\",\"arguments\":\"{}\"}")
    expect(conversationSummaryTranscript(messages)).not.toMatch(/IMAGE_DATA|AUDIO_DATA|VIDEO_DATA|FILE_DATA|PRIVATE_REASONING|METADATA|CUSTOM_BYTES/)
    expect(JSON.stringify(messages)).toBe(before)
  })

  it('keeps unsupported legacy message roles explicit instead of silently dropping history', () => {
    const messages = [{ kind: 'function' as const, name: 'legacy', content: 'result' }]
    expect(() => conversationSummaryTranscript(messages)).toThrow('unsupported message type')
  })
})

describe('frozen imported presentation samples', () => {
  it.each(boundarySamples)('preserves message presentation for $message.kind', ({ message, expected }) => {
    const before = structuredClone(message)
    expect(presentConversationMessage(message as ConversationMessage, 'fallback')).toEqual(expected)
    expect(message).toEqual(before)
  })
})
