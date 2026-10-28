import { describe, expect, it } from 'vitest'
import { resolveToolApprovals, toolApprovalRequest, type PendingToolApproval } from './toolApproval'

const calls = ['reviewed', 'automatic', 'answered', 'invalid', 'rejected'].map(id => ({ id, name: 'operate', args: { id } }))
const pending: PendingToolApproval[] = [calls[0], calls[4]].map(call => ({ call, policy: { allowedDecisions: ['approve', 'reject'], description: '' } }))

describe('tool approval decisions', () => {
  it('preserves order, explicit empty descriptions and raw arguments in the existing UI request', () => {
    const request = toolApprovalRequest(pending)
    expect(request).toEqual({
      actionRequests: [calls[0], calls[4]].map(call => ({ name: call.name, args: call.args, description: '' })),
      reviewConfigs: pending.map(() => ({ actionName: 'operate', allowedDecisions: ['approve', 'reject'] }))
    })
  })

  it('withholds automatic siblings on rejection without replacing existing results or granting approval', () => {
    const before = structuredClone(calls)
    const result = resolveToolApprovals(calls, pending, new Set(['answered', 'invalid']), {
      decisions: [{ type: 'approve' }, { type: 'reject', message: '' }]
    })
    expect(result.approved.size).toBe(0)
    expect(result.withheld.map(item => item.call.id)).toEqual(['rejected', 'reviewed', 'automatic'])
    expect(result.withheld[0].content).toBe('')
    expect(result.withheld[1].content).toContain('NOT EXECUTED')
    expect(calls).toEqual(before)
  })

  it.each([null, {}, { decisions: 'approve' }, { decisions: [] },
    { decisions: [{ type: 'approve' }, null] },
    { decisions: [{ type: 'approve' }, { type: 'edit', editedAction: { name: 'operate', args: {} } }] },
    { decisions: [{ type: 'approve' }, { type: 'reject', message: false }] }
  ])('rejects an invalid response without partial grants: %j', response => {
    expect(() => resolveToolApprovals(calls, pending, new Set(), response)).toThrow()
  })

  it('rejects a decision excluded by the current policy', () => {
    expect(() => resolveToolApprovals(calls, [{ call: calls[0], policy: { allowedDecisions: ['reject'] } }], new Set(),
      { decisions: [{ type: 'approve' }] })).toThrow('Unexpected human decision')
  })
})
