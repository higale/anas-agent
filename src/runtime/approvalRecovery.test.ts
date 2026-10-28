import { describe, expect, it } from 'vitest'
import { matchApprovalResponses,
  subagentApprovalGenerationFromResponse,
  tagSubagentApprovalResponse } from './approvalRecovery'

import { conversationInterrupts } from './conversationApprovals'
import type { ExecutionState } from './executionState'

function state(): ExecutionState {
  return { threadId: 'thread', runId: 'run', revisionId: 'revision', phase: 'waiting',
    messages: [], calls: [], context: { modelCalls: 1, todos: [] },
    approvals: ['a', 'b'].map(id => ({ id, generation: `generation-${id}`, kind: 'tool', callIds: [id],
      request: { actionRequests: [{ name: 'write_file', args: { path: id }, description: 'Confirm' }],
        reviewConfigs: [{ actionName: 'write_file', allowedDecisions: ['approve', 'reject'] }] } })) }
}

describe('application approval recovery', () => {
  it('binds decisions to the native approval set, independently of unrelated commits', () => {
    const original = state(), generation = conversationInterrupts(original)[0].approvalGeneration
    expect(conversationInterrupts({ ...original, revisionId: 'sibling-commit', approvals: [...original.approvals].reverse() })[0].approvalGeneration).toBe(generation)
    for (const changed of [{ ...original, runId: 'another-run' },
      { ...original, approvals: original.approvals.slice(1) },
      { ...original, approvals: original.approvals.map(item => ({ ...item, generation: 'renewed' })) }]) {
      expect(conversationInterrupts(changed)[0].approvalGeneration).not.toBe(generation)
    }
  })

  it('matches the complete current set and preserves response ordering and explicit values', () => {
    const pending = conversationInterrupts(state())
    const responses = [...pending].reverse().map(item => ({ interruptId: item.id,
      expectedGeneration: item.approvalGeneration, response: { decisions: [{ type: 'reject', message: '' }] } }))
    const before = structuredClone(responses)
    expect(matchApprovalResponses(pending, responses)).toEqual(responses.map(({ interruptId, response }) => ({ interruptId, response })))
    expect(responses).toEqual(before)
  })

  it.each(['missing', 'extra', 'duplicate', 'stale'] as const)('rejects an invalid %s batch before returning any decisions', kind => {
    const pending = conversationInterrupts(state())
    let responses = pending.map(item => ({ interruptId: item.id, expectedGeneration: item.approvalGeneration, response: {} }))
    if (kind === 'missing') responses = responses.slice(1)
    if (kind === 'extra') responses.push({ ...responses[0], interruptId: 'other' })
    if (kind === 'duplicate') responses = [responses[0], responses[0]]
    if (kind === 'stale') responses[1].expectedGeneration = 'older'
    expect(() => matchApprovalResponses(pending, responses)).toThrow(kind === 'stale' ? 'current approval generation' : 'match the current')
  })

  it('binds nested approval responses to the child generation without changing the user response', () => {
    const original = state()
    const pending = conversationInterrupts({ ...original, approvals: [{ ...original.approvals[0],
      kind: 'subagent', callIds: ['a'], subagentId: 'child', childGeneration: 'child-current' }] })
    const response = { decisions: [{ type: 'approve' }], enabled: false }
    const [matched] = matchApprovalResponses(pending, [{ interruptId: pending[0].id,
      expectedGeneration: pending[0].approvalGeneration, response }])
    expect(subagentApprovalGenerationFromResponse(matched.response)).toBe('child-current')
    expect(matched.response).toMatchObject(response)
    expect(subagentApprovalGenerationFromResponse(response)).toBeUndefined()
    expect(() => tagSubagentApprovalResponse('invalid', 'child-current')).toThrow('must be an object')
  })
})
