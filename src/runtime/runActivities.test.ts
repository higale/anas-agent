import { describe, expect, it } from 'vitest'
import type { AgentMessage, AgentRunActivity, AgentToolCall } from '../shared/agentTypes'
import { normalizeRootActivityProjection, rootActivityEvidence, type CanonicalChildActivityEvidence } from './runActivities'

const call: AgentToolCall = { id: 'call', name: 'read_file', args: { path: 'current.txt' } }
const noChildren: CanonicalChildActivityEvidence = { subagentIds: new Set(), modelIds: new Set(), tools: new Map() }
function assistant(id = 'message', runId = 'run', calls = [call]): AgentMessage {
  return { id, runId, role: 'assistant', content: [{ type: 'text', text: 'Saved response' }], toolCalls: calls }
}
function result(id = 'result', text = 'Saved result'): AgentMessage {
  return { id, role: 'tool', toolCallId: call.id, content: [{ type: 'text', text }] }
}
function activity(): AgentRunActivity {
  return { runId: 'run', operation: 'agent', status: 'running', createdAt: 'start', updatedAt: 'now', subagents: [],
    models: [{ id: 'model', messageId: 'message', sequence: 1, status: 'running', text: 'Transient response', reasoning: '', toolCallIds: [] }],
    tools: [{ call, sequence: 2, status: 'completed', output: 'Transient result', completedAt: 'earlier' }] }
}

describe('activity evidence from saved messages', () => {
  it('does not reuse an earlier result after the same call ID starts another ownership interval', () => {
    const earlier = assistant('previous-message', 'previous-run', [{ ...call, args: { path: 'old.txt' } }])
    const messages = [earlier, result('old-result', 'Old content'), assistant()]
    expect(rootActivityEvidence(messages, 'run')).toMatchObject({ models: [{ messageId: 'message' }], tools: [] })
    const current = rootActivityEvidence([...messages, result()], 'run')
    expect(current.tools).toMatchObject([{ call, output: 'Saved result' }])
  })

  it('uses the requesting model ownership and ignores orphan or duplicate result messages', () => {
    const orphan = { ...result('orphan'), toolCallId: 'unknown', runId: 'run' }
    const evidence = rootActivityEvidence([orphan, assistant('old', 'other'), { ...result(), runId: 'run' }], 'run')
    expect(evidence).toEqual({ models: [], tools: [] })
    const once = rootActivityEvidence([assistant(), result(), result('duplicate', 'Unexpected replacement')], 'run')
    expect(once.tools).toHaveLength(1)
    expect(once.tools[0].output).toBe('Saved result')
  })

  it('keeps ordinary JSON content opaque and reads subagent identity from its own saved result', () => {
    const start = { ...call, name: 'start_subagent', args: { agent: 'reviewer' } }
    const output = { content: 'Ordinary content', subagent_id: 'child' }
    const saved: AgentMessage = { ...result(), content: [{ type: 'json', value: output }] }
    expect(rootActivityEvidence([assistant('message', 'run', [start]), saved], 'run').tools)
      .toEqual([{ call: start, output, subagentId: 'child', subagentName: 'reviewer' }])
  })
})

describe('activity projection against durable evidence', () => {
  it('rebuilds completed values without mutating the earlier activity snapshot', () => {
    const source = activity(), before = structuredClone(source)
    const projected = normalizeRootActivityProjection(source, rootActivityEvidence([assistant(), result()], 'run'), false, noChildren)
    expect(projected.models).toMatchObject([{ status: 'completed', text: 'Saved response', toolCallIds: ['call'] }])
    expect(projected.tools).toMatchObject([{ status: 'completed', output: 'Saved result', call }])
    expect(source).toEqual(before)
  })

  it('does not show a premature tool result while its durable call is still awaiting a result', () => {
    const source = activity()
    const projected = normalizeRootActivityProjection(source, rootActivityEvidence([assistant()], 'run'), false, noChildren)
    expect(projected.tools).toMatchObject([{ call, status: 'running', output: undefined, completedAt: undefined }])
  })

  it.each([false, true])('retains uncommitted display only while execution is active: %s', retain => {
    const source = activity()
    const projected = normalizeRootActivityProjection(source, { models: [], tools: [] }, retain, noChildren)
    if (!retain) expect(projected).toMatchObject({ models: [], tools: [], subagents: [] })
    else {
      expect(projected.models).toMatchObject([{ messageId: undefined, status: 'running', toolCallIds: [], completedAt: undefined }])
      expect(projected.tools).toMatchObject([{ status: 'running', output: undefined, completedAt: undefined }])
    }
  })

  it('does not attach two model activities to the same committed response', () => {
    const source = activity()
    source.models.push({ ...source.models[0], id: 'duplicate-model', sequence: 3 })
    const projected = normalizeRootActivityProjection(source, rootActivityEvidence([assistant()], 'run'), false, noChildren)
    expect(projected.models).toHaveLength(1)
    expect(projected.models[0].id).toBe('model')
  })

  it('keeps independently committed child work even before a root result, and drops unsupported child progress', () => {
    const source = activity()
    source.subagents = [
      { id: 'child', name: 'reviewer', sequence: 3, status: 'running' },
      { id: 'unrelated', name: 'other', sequence: 4, status: 'running' }
    ]
    source.models = [
      { ...source.models[0], id: 'saved-child-model', subagentId: 'child' },
      { ...source.models[0], id: 'unsaved-child-model', subagentId: 'child' }
    ]
    source.tools = [{ ...source.tools[0], subagentId: 'child' }]
    const children: CanonicalChildActivityEvidence = { subagentIds: new Set(['child']),
      modelIds: new Set(['saved-child-model']), tools: new Map([[JSON.stringify(['child', call.id]), { completed: false }]]) }
    const projected = normalizeRootActivityProjection(source, { models: [], tools: [] }, false, children)
    expect(projected.subagents.map(child => child.id)).toEqual(['child'])
    expect(projected.models.map(model => model.id)).toEqual(['saved-child-model'])
    expect(projected.tools).toMatchObject([{ subagentId: 'child', status: 'running', output: undefined }])
  })

  it.each(['running', 'interrupted'] as const)('keeps a pending approval only on an interrupted activity: %s', status => {
    const source = activity()
    source.status = status
    source.tools[0].approval = { status: 'pending_approval', interruptId: 'approval', actionIndex: 0 }
    const projected = normalizeRootActivityProjection(source, rootActivityEvidence([assistant()], 'run'), false, noChildren)
    expect(projected.tools[0].approval).toEqual(status === 'interrupted' ? source.tools[0].approval : undefined)
  })
})
