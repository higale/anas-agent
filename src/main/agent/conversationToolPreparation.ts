import { randomUUID } from 'node:crypto'
import type { ExecutionApproval, ExecutionCommitScope, ExecutionMessageInput, ExecutionPendingCall, ExecutionState, ExecutionToolPreparation } from '../../runtime/executionState'
import { ToolInputError } from '../../runtime/errors'
import { requireObjectToolCall, toolInputDiagnostic, validateCapabilityInput, type ToolInputDefinition } from '../../runtime/toolInput'
import { conflictingPlanUpdates, conflictingPlanUpdatesError } from '../../runtime/planning'
import { authorizationInputHash, isFileEditTool } from '../../runtime/authorizationReceipts'
import { resolveToolApprovals, toolApprovalRequest, type PendingToolApproval } from '../../runtime/toolApproval'
import type { ConversationExecutionServices } from '../../runtime/conversationExecution'
import type { SkillScriptInvocation } from '../skillsStore'
import type { CodeReviewSnapshot } from '@shared/codeReview'
import { conversationReviewResults } from './conversationReview'
import { approvalToolNames, requiresToolApproval } from './toolAuthorization'
import { preparePatchAuthorization, prepareShellAuthorization, type ShellAuthorizationOptions } from './toolAuthorizationRuntime'
import { preflightConversationRules, type ConversationRulesOptions } from './conversationRules'
import type { NativeExecutionStore } from './nativeExecutionStore'

export interface ConversationToolPreparationOptions extends ConversationRulesOptions {
  definitions: readonly ToolInputDefinition[]
  includeRules: boolean
  shell?: ShellAuthorizationOptions & { toolName: string }
  explicitSkill?: SkillScriptInvocation
  review?: CodeReviewSnapshot
}

export function conversationToolError(call: Pick<ExecutionPendingCall, 'id' | 'providerCallId' | 'name'>, content: string): ExecutionMessageInput {
  const id = `${call.id}:result`
  return { id, value: { id, kind: 'tool', name: call.name, resultFor: call.providerCallId ?? call.id, content, resultStatus: 'error' } }
}

/** Prepare the entire unanswered batch without invoking a capability. Original
 * arguments remain untransformed; final schema parsing belongs to invocation. */
export async function prepareConversationToolBatch(state: ExecutionState, options: ConversationToolPreparationOptions): Promise<
  Awaited<ReturnType<ConversationExecutionServices['prepareTools']>>> {
  if (state.runId !== options.runId || state.phase !== 'tools') throw new Error('Tool preparation does not own the active batch.')
  let calls = structuredClone(state.calls.filter(call => !call.prepared && !call.result))
  const available = new Map(options.definitions.map(definition => [definition.name, definition]))
  const preparation = new Map<string, ExecutionToolPreparation>(calls.map(call => [call.id, { callId: call.id, args: call.args }]))
  const reject = (call: ExecutionPendingCall, content: string) => { preparation.get(call.id)!.result = conversationToolError(call, content) }
  const reports = options.review ? conversationReviewResults(state, options.review) : new Map<string, ExecutionMessageInput>()
  for (const call of calls) {
    options.signal?.throwIfAborted()
    const report = reports.get(call.id)
    if (report) { preparation.get(call.id)!.result = report; continue }
    try {
      const definition = available.get(call.name)
      if (!definition) throw new ToolInputError(`Tool '${call.name}' is not available in this run.`)
      await validateCapabilityInput(definition, call.args)
    } catch (error) {
      options.signal?.throwIfAborted()
      if (!(error instanceof ToolInputError)) throw error
      reject(call, toolInputDiagnostic(call.name, error.message))
    }
  }
  const answered = new Set([...state.calls.filter(call => call.result).map(call => call.id),
    ...calls.filter(call => preparation.get(call.id)!.result).map(call => call.id)])
  for (const call of conflictingPlanUpdates(calls, answered)) { reject(call, conflictingPlanUpdatesError); answered.add(call.id) }
  let context = state.context
  if (options.includeRules) {
    const result = await preflightConversationRules(context, calls.filter(call => !answered.has(call.id)), state.response?.value.context?.projectRulesReceipt, options)
    context = result.context
    const updated = new Map(result.calls.map(call => [call.id, call]))
    calls = calls.map(call => updated.get(call.id) ?? call)
    for (const call of calls) {
      preparation.get(call.id)!.args = call.args
      if (answered.has(call.id) || !context.projectRules!.blockedCalls.includes(call.id)) continue
      reject(call, (!context.projectRules!.fatalError && context.projectRules!.rejectedCalls.find(rejected => rejected.id === call.id)?.reason)
        || context.projectRules!.blockedReason)
    }
  }
  const approvalNames = new Set(approvalToolNames(options.shell?.toolName)), pending: PendingToolApproval[] = []
  for (const call of calls) {
    options.signal?.throwIfAborted()
    const item = preparation.get(call.id)!
    if (item.result) continue
    const validated = requireObjectToolCall(call)
    const savedReceipt = call.authorization?.patch ?? call.authorization?.shell
    if (savedReceipt && (savedReceipt.id !== call.id || savedReceipt.name !== call.name
      || savedReceipt.inputHash !== authorizationInputHash(call.args))) {
      reject(call, 'NOT EXECUTED: The saved authorization no longer matches this call. Submit the operation again.')
      continue
    }
    // An imported, completed approval can precede the remaining deterministic
    // batch preparation. Keep the saved grant while still validating inputs,
    // planning conflicts and receipt identity above.
    if (call.authorization?.approval === 'granted') {
      item.authorization = call.authorization
      continue
    }
    let requiresApproval = false
    if (isFileEditTool(call.name)) {
      const patch = call.authorization?.patch ?? await preparePatchAuthorization(validated, options)
      item.authorization = { patch }
      if (patch.error) { reject(call, patch.error); continue }
      requiresApproval = options.accessMode() !== 'full_access' && patch.requiresApproval
    } else if (options.shell?.toolName === call.name) {
      try {
        const shell = call.authorization?.shell ?? await prepareShellAuthorization(validated, options.explicitSkill, options.shell)
        item.authorization = { shell }
        requiresApproval = options.accessMode() !== 'full_access' && shell.requiresApproval
      } catch (error) {
        if (!(error instanceof ToolInputError)) throw error
        reject(call, toolInputDiagnostic(call.name, error.message))
        continue
      }
    } else if (approvalNames.has(call.name)) {
      try {
        requiresApproval = await requiresToolApproval({ toolName: call.name, args: validated.args, primaryFolder: options.primaryFolder,
          trustedFolders: options.folders, accessMode: options.accessMode(), commandShellToolName: options.shell?.toolName, directories: options.directories })
      } catch (error) {
        options.signal?.throwIfAborted()
        reject(call, `NOT EXECUTED: ${String(error)}. Correct the arguments and decide again.`)
        continue
      }
    }
    if (requiresApproval) {
      item.authorization = { ...item.authorization, approval: 'pending' }
      pending.push({ call: validated, policy: { allowedDecisions: ['approve', 'reject'], description: call.name === options.shell?.toolName
        ? `Run a command with ${call.name}.` : call.name === 'update_config' ? 'Modify application configuration.'
          : call.name === 'write_call' ? 'Send input to the selected live terminal. Input may execute a pending command.'
            : 'Review the file operation and its resolved targets.' } })
    }
  }
  options.signal?.throwIfAborted()
  const approvals: ExecutionApproval[] = pending.length ? [{ id: randomUUID(), generation: randomUUID(), kind: 'tool',
    callIds: pending.map(item => item.call.id!), request: toolApprovalRequest(pending) }] : []
  return { calls: [...preparation.values()], approvals, context }
}

/** Validate the whole response before applying any grant, rejection or saved
 * resume intent. Rejection withholds all unanswered siblings, as in the UI. */
export function resolveConversationToolApprovals(store: NativeExecutionStore, scope: ExecutionCommitScope,
  answers: readonly { id: string; generation: string; response: unknown }[], consumeIntent?: () => void): string {
  const state = store.load(scope.threadId)
  if (!state || state.runId !== scope.runId || state.phase !== 'waiting' || state.approvals.some(approval => approval.kind !== 'tool')
    || answers.length !== state.approvals.length || new Set(answers.map(answer => answer.id)).size !== answers.length) {
    throw new Error('The response does not match the pending tool approvals.')
  }
  const pending: PendingToolApproval[] = [], decisions: unknown[] = [], generations: Record<string, string> = {}
  for (const approval of state.approvals) {
    const answer = answers.find(answer => answer.id === approval.id)
    if (!answer || answer.generation !== approval.generation) throw new Error('The pending approval generation changed.')
    const values = answer.response && typeof answer.response === 'object' && !Array.isArray(answer.response)
      ? (answer.response as { decisions?: unknown }).decisions : undefined
    if (!Array.isArray(values) || values.length !== approval.callIds.length) throw new Error('Invalid tool approval decision count.')
    decisions.push(...values)
    generations[approval.id] = answer.generation
    for (const [index, id] of approval.callIds.entries()) {
      const call = state.calls.find(call => call.id === id)
      if (!call || call.result) throw new Error('Approval no longer belongs to an unanswered call.')
      pending.push({ call: requireObjectToolCall(call), policy: { allowedDecisions: approval.request.reviewConfigs[index].allowedDecisions } })
    }
  }
  const result = resolveToolApprovals(state.calls, pending, new Set(state.calls.filter(call => call.result).map(call => call.id)), { decisions })
  return store.resolveWait(scope, generations, () => {
    store.grantToolApprovals(scope, [...result.approved])
    for (const rejected of result.withheld) {
      const call = state.calls.find(call => call.id === rejected.call.id)!
      store.settleCall(scope, call.id, conversationToolError(call, rejected.content))
    }
    consumeIntent?.()
  })
}
