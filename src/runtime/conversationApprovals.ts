import { createHash } from 'node:crypto'
import type { AgentInterrupt } from '../shared/agentTypes'
import type { ExecutionState } from './executionState'
import { encodeExecutionValue } from './executionValue'
import { subagentApprovalInterruptMetadata } from './approvalRecovery'

/** Adapt the native wait to the existing product approval contract. The set
 * identity follows its requests/generations, not unrelated sibling commits. */
export function conversationInterrupts(state: ExecutionState): AgentInterrupt[] {
  if (state.phase !== 'waiting' && state.phase !== 'waiting_context') return []
  if (!state.approvals.length) throw new Error('A waiting execution has no approval requests.')
  const identity = ['anas-native-approval-set-v1', state.threadId, state.runId,
    [...state.approvals].sort((left, right) => left.id.localeCompare(right.id))]
  const approvalGeneration = createHash('sha256').update(encodeExecutionValue(identity)).digest('hex')
  return state.approvals.map(approval => ({ id: approval.id, approvalGeneration,
    value: structuredClone({ ...approval.request,
      ...(approval.kind === 'subagent' ? subagentApprovalInterruptMetadata(approval.childGeneration) : {}) }) }))
}
