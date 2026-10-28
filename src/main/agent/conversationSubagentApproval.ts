import { requireObjectToolCall } from '../../runtime/toolInput'
import { randomUUID } from 'node:crypto'
import type { AgentApprovalDecision } from '@shared/agentTypes'
import type { ExecutionApproval, ExecutionCommitScope } from '../../runtime/executionState'
import type { ToolApprovalRequest } from '../../runtime/toolApproval'
import { subagentApprovalGenerationFromInterrupt, tagSubagentApprovalResponse } from '../../runtime/approvalRecovery'
import type { NativeExecutionStore } from './nativeExecutionStore'
import type { SubagentToolOptions } from './subagentTools'

export class ConversationSubagentApprovalRequired extends Error {
  constructor(readonly approval: Extract<ExecutionApproval, { kind: 'subagent' }>) {
    super('The child run is waiting for an approval decision.')
    this.name = 'ConversationSubagentApprovalRequired'
  }
}

/** The wait tool supplies its application call identity explicitly. No async
 * execution context or graph interrupt is needed to pause a parent call. */
export function createConversationSubagentApproval(store: NativeExecutionStore,
  owner: Pick<ExecutionCommitScope, 'threadId' | 'runId'>): NonNullable<SubagentToolOptions['requestApproval']> {
  return (request, child) => {
    const state = store.load(owner.threadId), call = state?.calls.find(call => call.id === child.callId)
    const generation = subagentApprovalGenerationFromInterrupt(request)
    if (!state || state.runId !== owner.runId || !['tools', 'waiting'].includes(state.phase)
      || !call || call.result || !call.prepared || call.authorization?.approval === 'pending'
      || call.name !== 'wait_subagent' || requireObjectToolCall(call).args.subagent_id !== child.subagentId || !generation) {
      throw new Error('Subagent approval does not belong to the active parent wait.')
    }
    const answer = call.subagentApproval
    if (answer?.subagentId === child.subagentId && answer.generation === generation) {
      return tagSubagentApprovalResponse({ decisions: answer.decisions }, generation)
    }
    throw new ConversationSubagentApprovalRequired({ id: randomUUID(), generation: randomUUID(), kind: 'subagent',
      callIds: [call.id], subagentId: child.subagentId, childGeneration: generation,
      request: structuredClone({ actionRequests: request.actionRequests, reviewConfigs: request.reviewConfigs }) as ToolApprovalRequest })
  }
}

export function conversationSubagentDecisions(approval: Extract<ExecutionApproval, { kind: 'subagent' }>, response: unknown): AgentApprovalDecision[] {
  const decisions = response && typeof response === 'object' && !Array.isArray(response)
    ? (response as { decisions?: unknown }).decisions : undefined
  if (!Array.isArray(decisions) || decisions.length !== approval.request.actionRequests.length) {
    throw new Error('Subagent decisions do not match the saved actions.')
  }
  return decisions.map((decision, index) => {
    if (!decision || typeof decision !== 'object' || !approval.request.reviewConfigs[index].allowedDecisions.includes(decision.type)
      || decision.type !== 'approve' && decision.type !== 'reject'
      || decision.type === 'reject' && decision.message !== undefined && typeof decision.message !== 'string') {
      throw new Error('Invalid subagent approval decision.')
    }
    return decision.type === 'approve' ? { type: 'approve' } : { type: 'reject', ...(decision.message === undefined ? {} : { message: decision.message }) }
  })
}
