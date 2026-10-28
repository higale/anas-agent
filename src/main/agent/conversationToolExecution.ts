import { requireObjectToolCall } from '../../runtime/toolInput'
import { randomUUID } from 'node:crypto'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { ConversationExecutionServices } from '../../runtime/conversationExecution'
import type { ExecutionApproval, ExecutionCommitScope, ExecutionEffectRecord, ExecutionMessageInput, ExecutionToolStateUpdate } from '../../runtime/executionState'
import type { ToolDefinition } from '../../runtime/toolDefinition'
import type { ToolRunScope } from '../../runtime/toolEvents'
import { invokeCapability } from '../../runtime/toolInvocation'
import { ToolInputError } from '../../runtime/errors'
import { toolInputDiagnostic } from '../../runtime/toolInput'
import { planningToolSpec, planningUpdate, type todoListSchema } from '../../runtime/planning'
import { isFileEditTool } from '../../runtime/authorizationReceipts'
import { executeJournaledTool, toolEffectRecoveryDecision, toolEffectRejectionText, type ToolEffectRecoveryRequest } from '../../runtime/toolEffects'
import type { z } from 'zod/v3'
import type { FilePatchEditRecord } from '../filePatchRecord'
import type { AgentManagedCallRecord } from './managedCallStore'
import { managedCallHandle, managedCallInlineResult } from './managedCallService'
import { classifyAgentToolEffect } from './toolEffectClassification'
import { runWithCurrentAgentToolEffect, runWithoutCurrentAgentToolEffect } from './toolEffectScope'
import { withoutToolExecution } from './toolExecutionContext'
import { conversationRuleResult, conversationRuleToolRejection } from './conversationRules'
import { conversationToolError, type ConversationToolPreparationOptions } from './conversationToolPreparation'
import { toolAuthorizationDiagnostic, withPatchAuthorization, withShellAuthorization, withToolAuthorization } from './toolAuthorizationRuntime'
import type { NativeExecutionStore } from './nativeExecutionStore'
import { presentToolResult } from '../../runtime/messagePresentation'
import { presentConversationMessage } from './conversationPresentation'
import { ConversationSubagentApprovalRequired, conversationSubagentDecisions } from './conversationSubagentApproval'

interface ManagedResults {
  format: string
  get(callId: string, threadId: string): AgentManagedCallRecord | undefined
  remove(callId: string, threadId: string): unknown
  read(reference: string, threadId: string): Promise<ConversationMessage>
}
export interface ConversationToolExecutionOptions {
  store: NativeExecutionStore
  definitions: readonly ToolDefinition<ConversationMessage>[]
  preparation: ConversationToolPreparationOptions
  operations: ToolRunScope
  planning: boolean
  managed?: ManagedResults
  persistFileChange(record: FilePatchEditRecord, observed: boolean): void
}
class EffectRecoveryRequired extends Error {
  constructor(readonly approval: ExecutionApproval) { super('Tool effect recovery requires a decision.'); this.name = 'EffectRecoveryRequired' }
}

/** Bind saved call identities, receipts and effects to the actual capability.
 * The conversation loop still owns batch scheduling and result acceptance. */
export function createConversationToolExecutor(options: ConversationToolExecutionOptions): ConversationExecutionServices['executeTool'] {
  const available = new Map(options.definitions.map(definition => [definition.name, definition]))
  return (requested, state, request, observer) => options.operations.track(runWithoutCurrentAgentToolEffect(() => withoutToolExecution(async () => {
    const current = options.store.load(request.threadId), rawCall = current?.calls.find(call => call.id === requested.id)
    if (!current || current.runId !== request.runId || state.runId !== request.runId || !rawCall) throw new Error('The tool call no longer belongs to this run.')
    if (rawCall.result) return { kind: 'result' as const, message: rawCall.result, update: rawCall.resultUpdate }
    const call = requireObjectToolCall(rawCall)
    const key = { threadId: request.threadId, runId: request.runId, callId: call.id }, existing = options.store.loadEffect(key)
    const ownedManaged = () => {
      const managed = options.managed?.get(call.artifacts['managed-call'], request.threadId)
      return managed?.runId === request.runId && managed.threadId === request.threadId ? managed : undefined
    }
    const cleanup = () => {
      const managed = ownedManaged()
      if (managed && !managed.detachedAt && !['preparing', 'running', 'uncertain'].includes(managed.status)) options.managed!.remove(managed.id, request.threadId)
    }
    if (existing?.result) { cleanup(); return { kind: 'result' as const, message: existing.result } }
    if (!call.prepared || call.authorization?.approval === 'pending') throw new Error('Tool dispatch requires saved preflight and approval.')
    const observedCall = { id: call.id, name: call.name, args: call.args }
    request.signal.throwIfAborted()
    const toInput = (message: ConversationMessage): ExecutionMessageInput => {
      if (message.kind !== 'tool' || message.resultFor !== (call.providerCallId ?? call.id)) throw new Error('The capability result does not answer its saved call.')
      const id = message.id ?? `${call.id}:result`
      return { id, value: { ...message, id, context: { ...message.context, runId: request.runId,
        createdAt: message.context?.createdAt ?? new Date().toISOString() } } }
    }
    const errorResult = (content: string) => toInput(conversationToolError(call, content).value)
    let update: ExecutionToolStateUpdate | undefined
    const definition: ToolDefinition<ConversationMessage> | undefined = call.name === planningToolSpec.name
      ? options.planning ? { ...planningToolSpec, execute: args => {
        const changed = planningUpdate(args.todos as z.infer<typeof todoListSchema>)
        update = { todos: changed.todos }
        return { kind: 'tool', name: call.name, resultFor: call.providerCallId ?? call.id, content: changed.content, resultStatus: 'success' }
      } } : undefined : available.get(call.name)
    try {
      if (!definition) throw new ToolInputError(`Tool '${call.name}' is not available in this run.`)
      if (options.preparation.includeRules) {
        const rejection = await conversationRuleToolRejection(current.context, call, options.preparation)
        if (rejection) return { kind: 'result' as const, message: errorResult(rejection) }
      }
      const diagnostic = await toolAuthorizationDiagnostic(call, options.preparation)
      if (diagnostic) return { kind: 'result' as const, message: errorResult(diagnostic) }
      const invoke = async (): Promise<ExecutionMessageInput> => {
        let started = false
        try {
          const operation = () => withToolAuthorization(async () => {
            const diagnostic = await toolAuthorizationDiagnostic(call, options.preparation)
            if (diagnostic) throw new ToolInputError(diagnostic)
          }, () => invokeCapability(definition, call.args, { callId: call.id, signal: request.signal }, () => {
            started = true; observer.tool({ kind: 'started', call: observedCall })
          }))
          const authorized = () => isFileEditTool(call.name) ? withPatchAuthorization(call.authorization!.patch!, operation) : operation()
          const shell = options.preparation.shell
          const result = shell?.toolName === call.name
            ? await withShellAuthorization(call.authorization?.shell, call, options.preparation.explicitSkill, shell, authorized) : await authorized()
          const message = toInput(options.preparation.includeRules ? conversationRuleResult(current.context, result) : result)
          observer.tool({ kind: 'settled', call: observedCall,
            output: presentToolResult(presentConversationMessage(result, message.id).content), succeeded: true })
          return message
        } catch (error) {
          if (started && !(error instanceof ConversationSubagentApprovalRequired)) observer.tool({ kind: 'settled', call: observedCall, succeeded: false, output: { status: 'error', error: error instanceof Error ? error.message : String(error) } })
          throw error
        }
      }
      const classification = classifyAgentToolEffect(call.name, call.args, definition)
      const currentClassification = !existing || existing.state === 'prepared' && existing.effectAttempt === 0
      const identity = { runId: request.runId, artifacts: call.artifacts }
      if (currentClassification && !classification) {
        if (existing) options.store.discardUnarmedEffect(key)
        const message = await runWithCurrentAgentToolEffect({ identity, arm: () => undefined }, invoke)
        return { kind: 'result' as const, message, update }
      }
      const recoveryMode = currentClassification ? classification!.recoveryMode : existing!.recoveryMode
      const initial = options.store.prepareEffect(key, recoveryMode)
      const message = await executeJournaledTool<ExecutionEffectRecord, ExecutionMessageInput>({ initial,
        initialArmRecoveryMode: currentClassification ? recoveryMode : undefined,
        load: () => options.store.loadEffect(key), arm: effect => options.store.armEffect(key, effect), retry: retry => options.store.retryEffect(key, retry),
        save: async (message, confirmation) => options.store.saveEffectResult(key, message, confirmation),
        restore: async row => { if (!row.result) throw new Error('A completed effect has no saved result.'); return row.result }, cleanup,
        recoverManaged: async () => {
          const managed = ownedManaged()
          if (!managed || managed.status === 'uncertain' || !managed.detachedAt && ['preparing', 'running'].includes(managed.status)) return undefined
          const result = !managed.detachedAt && managed.result && managed.outcome?.result_format === options.managed!.format
            ? toInput(await options.managed!.read(managed.result, request.threadId))
            : toInput({ kind: 'tool', name: call.name, resultFor: call.providerCallId ?? call.id,
              content: managed.detachedAt ? managedCallHandle(managed) : managedCallInlineResult(managed), resultStatus: 'success' })
          if (!['preparing', 'running'].includes(managed.status)) { options.store.saveEffectResult(key, result); cleanup() }
          return result
        },
        isInterruption: error => error instanceof EffectRecoveryRequired,
        requestRecovery: approval => { throw new EffectRecoveryRequired({ id: randomUUID(), generation: randomUUID(), kind: 'effect_recovery', callIds: [call.id], request: approval }) },
        errorResult,
        invoke: attempt => runWithCurrentAgentToolEffect({ identity, arm: attempt.arm,
          deferManagedCallResult: managed => {
            if (managed.id !== call.artifacts['managed-call'] || managed.runId !== request.runId || managed.threadId !== request.threadId) throw new Error('Deferred managed call does not belong to this effect.')
            attempt.deferResult()
          },
          persistFileChange: (record, observed) => options.persistFileChange(record, observed || record.requestId !== request.runId),
          isUnarmed: () => { const effect = options.store.loadEffect(key); return effect?.state === 'prepared' && effect.effectAttempt === 0 },
          previousEffect: () => { const effect = options.store.loadEffect(key); return effect?.effectKind && effect.targetJson && effect.effectAttempt > 0
            ? { kind: effect.effectKind, target: JSON.parse(effect.targetJson) as unknown } : undefined }
        }, invoke)
      })
      return { kind: 'result' as const, message, update }
    } catch (error) {
      if (error instanceof EffectRecoveryRequired) return { kind: 'wait' as const, approval: error.approval }
      if (error instanceof ConversationSubagentApprovalRequired) return { kind: 'wait' as const, approval: error.approval }
      request.signal.throwIfAborted()
      if (error instanceof ToolInputError) return { kind: 'result' as const, message: errorResult(toolInputDiagnostic(call.name, error.message)) }
      throw error
    }
  })))
}

/** Child answers and uncertain-effect decisions can share a parallel batch.
 * Consume selected generations and inputs in one transaction; ordinary tool access
 * remains a separate preflight decision. */
export function resolveConversationToolWaits(store: NativeExecutionStore, scope: ExecutionCommitScope,
  answers: readonly { id: string; generation: string; response: unknown }[], consumeIntent?: () => void): string {
  const state = store.load(scope.threadId)
  if (!state || state.runId !== scope.runId || state.phase !== 'waiting' || state.approvals.some(approval => approval.kind !== 'effect_recovery' && approval.kind !== 'subagent')
    || !answers.length || answers.length > state.approvals.length || new Set(answers.map(answer => answer.id)).size !== answers.length) throw new Error('The response does not match pending tool waits.')
  const generations: Record<string, string> = {}
  const decisions = answers.map(answer => {
    const approval = state.approvals.find(approval => approval.id === answer.id)
    if (!approval || answer.generation !== approval.generation || approval.callIds.length !== 1) throw new Error('The pending tool wait generation changed.')
    generations[approval.id] = answer.generation
    if (approval.kind === 'subagent') return { kind: 'subagent' as const, approval, decisions: conversationSubagentDecisions(approval, answer.response) }
    const key = { threadId: scope.threadId, runId: scope.runId, callId: approval.callIds[0] }, effect = store.loadEffect(key)
    const ordinal = (approval.request as ToolEffectRecoveryRequest).actionRequests[0].anasRecovery?.ordinal
    if (!effect || effect.state !== 'intent' || ordinal !== effect.confirmationCount + 1) throw new Error('The effect recovery ordinal changed.')
    return { kind: 'effect' as const, key, effect, decision: toolEffectRecoveryDecision(answer.response) }
  })
  return store.resolveWait(scope, generations, () => {
    for (const item of decisions) {
      if (item.kind === 'subagent') { store.saveSubagentApproval(scope, item.approval.id, item.decisions); continue }
      const { key, effect, decision } = item
      if (decision.type === 'approve') store.retryEffect(key, { kind: 'approved', expectedConfirmationCount: effect.confirmationCount })
      else {
        const call = state.calls.find(call => call.id === key.callId)!
        const result = conversationToolError(call, toolEffectRejectionText(effect, decision.message))
        store.saveEffectResult(key, result, { kind: 'rejected', expectedConfirmationCount: effect.confirmationCount })
        store.settleCall(scope, call.id, result)
      }
    }
    consumeIntent?.()
  })
}
