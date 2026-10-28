import type { AgentApprovalDecision } from '../shared/agentTypes'

export interface ApprovalToolCall {
  id?: string
  name: string
  args: unknown
}

export interface ToolApprovalPolicy {
  allowedDecisions: AgentApprovalDecision['type'][]
  description?: string
  when?: (request: { toolCall: ApprovalToolCall & { args: Record<string, unknown> }; state: unknown }) => boolean | Promise<boolean>
}

export interface PendingToolApproval {
  call: ApprovalToolCall & { args: Record<string, unknown> }
  policy: ToolApprovalPolicy
}

/** Existing UI and saved interrupt payload. No execution state lives here. */
export interface ToolApprovalRequest {
  actionRequests: { name: string; args: Record<string, unknown>; description: string }[]
  reviewConfigs: { actionName: string; allowedDecisions: AgentApprovalDecision['type'][] }[]
}

export function toolApprovalRequest(pending: readonly PendingToolApproval[]): ToolApprovalRequest {
  return {
    actionRequests: pending.map(({ call, policy }) => ({ name: call.name, args: call.args,
      description: policy.description ?? `Tool execution requires approval\n\nTool: ${call.name}\nArgs: ${JSON.stringify(call.args, null, 2)}` })),
    reviewConfigs: pending.map(({ call, policy }) => ({ actionName: call.name, allowedDecisions: policy.allowedDecisions }))
  }
}

export interface WithheldToolCall {
  call: ApprovalToolCall
  content: string
}

/** Validate the entire answer before granting anything. Rejection withholds
 * every unanswered sibling, including calls that did not need approval. */
export function resolveToolApprovals(calls: readonly ApprovalToolCall[], pending: readonly PendingToolApproval[],
  answered: ReadonlySet<string>, response: unknown): { approved: Set<string>; withheld: WithheldToolCall[] } {
  const decisions = response && typeof response === 'object' && !Array.isArray(response)
    ? (response as { decisions?: unknown }).decisions : undefined
  if (!Array.isArray(decisions)) throw new Error('Invalid approval response: decisions must be an array.')
  if (decisions.length !== pending.length) {
    throw new Error(`Number of human decisions (${decisions.length}) does not match number of hanging tool calls (${pending.length}).`)
  }
  const withheld: WithheldToolCall[] = []
  for (const [index, { call, policy }] of pending.entries()) {
    const decision = decisions[index] as AgentApprovalDecision | undefined
    if (!decision || !policy.allowedDecisions.includes(decision.type) || (decision.type !== 'approve' && decision.type !== 'reject')) {
      throw new Error(`Unexpected human decision: ${JSON.stringify(decision)} for tool '${call.name}'. Expected one of ${JSON.stringify(policy.allowedDecisions)}.`)
    }
    if (decision.type === 'reject') {
      if (decision.message !== undefined && typeof decision.message !== 'string') {
        throw new Error(`Tool call response for "${call.name}" must be a string, got ${typeof decision.message}`)
      }
      withheld.push({ call, content: decision.message ?? `User rejected the tool call for \`${call.name}\` with id ${call.id}` })
    }
  }
  if (withheld.length) {
    const resolved = new Set([...answered, ...withheld.map(item => item.call.id!)])
    for (const call of calls) {
      if (resolved.has(call.id!)) continue
      withheld.push({ call, content: "NOT EXECUTED: Another action in this batch was rejected. Reconsider this operation with the user's feedback before calling it again." })
    }
    return { approved: new Set(), withheld }
  }
  return { approved: new Set(pending.map(item => item.call.id!)), withheld }
}
