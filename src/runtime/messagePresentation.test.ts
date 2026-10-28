import { describe, expect, it } from 'vitest'
import { presentMessage, presentUserInput, skillMessageParts, userMessageContent } from './messagePresentation'
import { codeReviewSnapshotId } from './codeReviewReport'
import type { CodeReviewSnapshot } from '../shared/codeReview'

describe('native message presentation', () => {
  it('presents user input and media directly while retaining the expanded Skill prompt', () => {
    const input = { id: 'input', runId: 'run', createdAt: 'created', text: 'Expanded prompt', displayText: '/guide request',
      directionAfterToolCallIds: ['call'], content: [{ type: 'image' as const, mimeType: 'image/png', data: 'AA==' }] }
    const before = structuredClone(input)
    expect(presentUserInput(input)).toMatchObject({ id: 'input', role: 'user', runId: 'run', createdAt: 'created',
      directionAfterToolCallIds: ['call'], skillInvocation: { promptText: 'Expanded prompt' },
      content: [{ type: 'text', text: '/guide request' }, { type: 'image', mimeType: 'image/png', data: 'AA==' }] })
    expect(input).toEqual(before)
  })

  it('does not invent Skill context from identical display text and preserves empty input', () => {
    const source = { id: 'input', runId: 'run', createdAt: 'created', text: '/guide request', displayText: '/guide request' }
    expect(presentUserInput(source).skillInvocation).toBeUndefined()
    expect(presentUserInput({ ...source, text: '', displayText: '' }).content).toEqual([])
    expect(presentUserInput({ ...source, text: 'review prompt' }, {}).content).toEqual([{ type: 'text', text: 'review prompt' }])
  })
  it('keeps binary attachments, reasoning summaries, unknown data and tool correlation without mutating the source', () => {
    const blocks = [
      { type: 'image', mimeType: 'image/png', data: Uint8Array.of(1, 2, 3) },
      { type: 'file', mimeType: 'text/plain', metadata: { filename: 'note.txt' }, data: Uint8Array.of(97) },
      { type: 'reasoning', reasoning: 'Detailed', summary: [{ text: 'Summary' }] },
      { type: 'non_standard', value: { custom: 0 } }, { type: 'tool_call', args: { hidden: true } }
    ]
    const before = structuredClone(blocks)
    const mapped = presentMessage({ role: 'tool', id: 'result', name: 'inspect', resultFor: 'call', text: '', blocks,
      runId: 'run', createdAt: '2026-10-27', directionAfterToolCallIds: ['call', '', 0] }, 'fallback')
    expect(mapped).toMatchObject({ id: 'result', toolCallId: 'call', runId: 'run', directionAfterToolCallIds: ['call'],
      content: [
        { type: 'image', mimeType: 'image/png', data: 'AQID' },
        { type: 'file', name: 'note.txt', mimeType: 'text/plain', data: 'YQ==' },
        { type: 'reasoning', text: 'Detailed', summary: 'Summary' },
        { type: 'json', value: { custom: 0 } }
      ] })
    expect(blocks).toEqual(before)
  })

  it('shows a Skill shortcut while retaining its full prompt and keeps review scope text intact', () => {
    const source = { role: 'user' as const, blocks: [{ type: 'text', text: 'Expanded instructions' }], text: 'Expanded instructions', displayText: '/inspect args' }
    expect(presentMessage(source, 'user')).toMatchObject({ content: [{ type: 'text', text: '/inspect args' }],
      skillInvocation: { name: 'inspect', args: 'args', promptText: 'Expanded instructions' } })
    expect(presentMessage({ ...source, reviewScope: {} }, 'user')).toMatchObject({ content: source.blocks })
    expect(presentMessage({ ...source, reviewScope: {} }, 'user').skillInvocation).toBeUndefined()
  })

  it('splits only the exact shortcut expansion and leaves attachments and literal Skill tags intact', () => {
    const display = '/inspect literal <skill>', skill = '<skill>\nBody contains <skill>literal</skill>\n</skill>'
    const attachment = { type: 'image_url', image_url: { url: 'image' } }
    const content = [{ type: 'text', text: `${display}\n\n${skill}` }, attachment]
    const parts = skillMessageParts(content, display)!
    expect(parts).toEqual({ userContent: [{ type: 'text', text: display }, attachment], skillContent: skill })
    expect((parts.userContent as unknown[])[1]).toBe(attachment)
    expect(skillMessageParts(content, '/different')).toBeUndefined()
    expect(skillMessageParts(content, display, false)).toBeUndefined()
    expect(skillMessageParts(`unrelated prefix ${display}\n\n${skill}`, display)).toBeUndefined()
  })

  it('preserves input ordering, duplicate text semantics and media fallback behavior', () => {
    expect(userMessageContent('hello')).toBe('hello')
    expect(userMessageContent('hello', [{ type: 'text', text: 'hello' },
      { type: 'image', url: 'https://example.invalid/image', data: 'unused' },
      { type: 'file', name: 'note.txt' }, { type: 'json', value: { enabled: false } }])).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'image_url', image_url: { url: 'https://example.invalid/image', detail: 'auto' } },
      { type: 'text', text: '[Attached file: note.txt]' }, { type: 'text', text: '{"enabled":false}' }
    ])
  })

  it('validates stored review identity and scope before presenting a report', () => {
    const content: Omit<CodeReviewSnapshot, 'id'> = {
      request: { kind: 'recorded', threadId: 'thread', runId: 'run', version: 'a'.repeat(64), target: 'recorded' },
      projectId: 'project', capturedAt: '2026-10-27T00:00:00.000Z', description: 'Fixed scope',
      files: [{ id: 'file-1', path: 'file.ts', patch: '+new', before: [], after: [{ start: 1, end: 1 }] }], limitations: []
    }
    const snapshot = { ...content, id: codeReviewSnapshotId(content) }
    const report = { scope_id: snapshot.id, summary: 'No findings', findings: [], limitations: [] }
    const source = { role: 'assistant' as const, text: 'report', blocks: [{ type: 'text', text: 'report' }], review: { snapshot, report } }
    expect(presentMessage(source, 'message').codeReview).toMatchObject({ snapshot, report, locations: [] })
    expect(() => presentMessage({ ...source, review: { snapshot: { ...snapshot, description: 'Changed' }, report } }, 'message')).toThrow('identity')
    expect(() => presentMessage({ ...source, review: { snapshot, report: { ...report, scope_id: 'b'.repeat(64) } } }, 'message')).toThrow('does not match')
  })
})
