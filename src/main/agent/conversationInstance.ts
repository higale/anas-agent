import { prepareConversationContext } from './conversationContextPreparation'
import type { AgentThread, AgentContextStatus } from '@shared/agentTypes'
import type { AppConfigSnapshot, Project } from '@shared/types'
import type { CodeReviewSnapshot } from '@shared/codeReview'
import { commandShellToolName } from '@shared/commandShell'
import type { CompressionTrackingCallbacks } from '../../runtime/compression'
import { conversationExecution, type ConversationExecutionServices } from '../../runtime/conversationExecution'
import type { ExecutionState } from '../../runtime/executionState'
import type { RunExecution } from '../../runtime/runExecution'
import { ToolRunScope } from '../../runtime/toolEvents'
import { planningToolSpec } from '../../runtime/planning'
import type { ConversationResourceAccess } from './conversationResourceReader'
import { prepareAgentRuntimeResources, createAgentAccessModeResolver, type AgentResourceContext } from './agentRuntimeResources'
import { createManagedToolRuntime, type ManagedResultStorage } from './managedToolRuntime'
import { withPluginToolResources } from './pluginPackageResources'
import { stripConversationAttachments } from './conversationAttachments'
import type { MemoryRecallDetails } from './conversationMemory'
import { createConversationModelPreparation, conversationContextSource, type ConversationModelExecutionOptions } from './conversationModelExecution'
import { createConversationToolExecutor, type ConversationToolExecutionOptions } from './conversationToolExecution'
import { prepareConversationToolBatch, type ConversationToolPreparationOptions } from './conversationToolPreparation'
import { createConversationSubagentApproval } from './conversationSubagentApproval'
import { completeConversationReview } from './conversationReview'
import { saveToolResultFile } from './toolResultFile'
import { observeModelRetry } from './modelRetryLogging'
import { presentConversationMessage } from './conversationPresentation'
import type { RunConfiguration } from '../../shared/agentCapabilities'

/** The owner supplies the one authoritative store and durable intent/queue
 * transactions. This assembly never opens a database or enables a migration. */
export interface ConversationInstanceOwner {
  configuration: {
    getRunConfiguration(owner: { threadId: string; runId: string }): RunConfiguration | undefined
    resolveRunConfiguration(owner: { threadId: string; runId: string }, value: RunConfiguration): void
  }
  store: ConversationToolExecutionOptions['store']
  results: ManagedResultStorage & { format: 'conversation' }
  managed?: ConversationToolExecutionOptions['managed']
  enter: ConversationExecutionServices['enter']
  directions: ConversationExecutionServices['directions']
  persistFileChange: ConversationToolExecutionOptions['persistFileChange']
}
export interface ConversationInstanceContext extends Omit<AgentResourceContext, 'configuration' | 'parentConfiguration' | 'onConfigurationResolved'>, CompressionTrackingCallbacks {
  recoveryLog?: ConversationExecutionServices['recoveryLog']
  requestId: string
  prepareWorkspace?: boolean
  review?: CodeReviewSnapshot
  manualCompression?: boolean
  onContextStatus?(status: AgentContextStatus): void
  onMemoryRecall?(details: MemoryRecallDetails & { agentName?: string }): void
  providerFetch?: typeof fetch
}

/** Native product assembly for execution and storage. Config,
 * capabilities and handlers are the same services used by the current product. */
export async function createConversationInstance(thread: AgentThread, database: ConversationResourceAccess, config: AppConfigSnapshot,
  context: ConversationInstanceContext, owner: ConversationInstanceOwner, project?: Project) {
  if (!context.requestId || owner.results.format !== 'conversation' || owner.managed && owner.managed.format !== 'conversation') {
    throw new Error('Native execution requires a run and its native result owner.')
  }
  const identity = { threadId: thread.id, runId: context.requestId }
  const resources = await prepareAgentRuntimeResources(thread, database, config, { ...context,
    configuration: owner.configuration.getRunConfiguration(identity),
    parentConfiguration: context.subagentCall ? owner.configuration.getRunConfiguration({
      threadId: context.subagentCall.parentThreadId, runId: context.subagentCall.parentRunId }) : undefined,
    onConfigurationResolved: value => owner.configuration.resolveRunConfiguration(identity, value)
  }, {
    project, persistent: true, prepareWorkspace: context.prepareWorkspace !== false, review: context.review,
    requestSubagentApproval: createConversationSubagentApproval(owner.store, { threadId: thread.id, runId: context.requestId })
  })
  const { workspace, resolveModel, requestSystemPrompt, activeSubagent, runConfiguration, simpleChat, capabilities, outputLanguage } = resources
  const operations = new ToolRunScope()
  const { catalog, tools, attachments, memory, includeRules, contextRuntime } = prepareConversationContext(thread, database, config, resources, context)
  const accessMode = createAgentAccessModeResolver(database, thread.id, context.subagentCall)
  const preparation: ConversationToolPreparationOptions = { runId: context.requestId, folders: workspace.trustedFolders,
    primaryFolder: workspace.primaryFolder, fileEditStore: database.fileEditStore, accessMode, directories: resources.approvalDirectories, signal: context.signal,
    includeRules, definitions: [...catalog.definitions, ...(catalog.planning ? [planningToolSpec] : [])], review: context.review,
    ...(resources.commandShell && resources.shellCommandAuthorization ? { shell: { toolName: commandShellToolName(resources.commandShell.executable),
      analyzer: resources.shellCommandAuthorization, accessMode } } : {}) }
  const definitions = catalog.definitions.map(definition => createManagedToolRuntime(definition, {
    results: owner.results, service: context.managedCalls, threadId: thread.id, runId: context.requestId,
    allowBackground: capabilities.backgroundTools, signal: context.signal,
    providerCallId: id => {
      const state = owner.store.load(thread.id), call = state?.calls.find(call => call.id === id)
      if (state?.runId !== context.requestId || !call) throw new Error('Tool result has no owning native call.')
      return call.providerCallId ?? call.id
    },
    withResources: (args, operation) => withPluginToolResources(definition, args, workspace.primaryFolder, operation)
  }))
  const preparationFor = (state: ExecutionState): ConversationToolPreparationOptions => {
    const user = [...state.messages].reverse().find(message => message.value.kind === 'user')
    return { ...preparation, explicitSkill: user ? presentConversationMessage(user.value, user.id).skillInvocation : undefined }
  }
  let observationErrors: unknown[] = []
  const observeContext = (status: AgentContextStatus) => {
    try { context.onContextStatus?.(status) } catch (error) { if (!observationErrors.length) observationErrors.push(error) }
  }
  const modelOptions: ConversationModelExecutionOptions = { store: owner.store, resolveModel, systemPrompt: model => requestSystemPrompt(model).text,
    tools, requiresTools: () => Boolean(context.review), maxModelCalls: activeSubagent ? 0 : config.settings.maxModelCallsPerRun,
    simpleChat, review: context.review, attachments, memory, rules: includeRules ? preparation : undefined,
    manualCompression: context.manualCompression ? contextRuntime : undefined, subagentId: context.subagentCall?.id,
    outputLanguage, codingMode: runConfiguration.codingMode, compressionPrompt: activeSubagent ? undefined : runConfiguration.compressionPrompt,
    developerHttpTrace: resources.developerHttpTrace, requestId: context.requestId, requestRole: activeSubagent ? 'subagent' : 'main',
    providerFetch: context.providerFetch, compressionTracking: context,
    saveToolResult: content => saveToolResultFile(content, database.toolResultsRoot),
    supervision: {
      ...(context.managedCalls ? { managed: { unresolved: () => context.managedCalls!.unresolvedForThread(thread.id),
        resolve: id => context.managedCalls!.resolveObservedCall(id, thread.id, context.requestId) } } : {}),
      ...(context.subagents ? { subagents: { unresolved: () => context.subagents!.unresolvedForRun(),
        resolve: id => context.subagents!.resolveObserved(id) } } : {})
    },
    onRequest: (model, request) => {
      const actual = contextRuntime.statusFromMessages([...request.messages], model, { systemMessage: request.systemMessage, tools: [...request.tools] })
      const plain = contextRuntime.statusFromMessages(stripConversationAttachments([...request.messages]), model,
        { systemMessage: request.systemMessage, tools: [...request.tools] })
      actual.breakdown.attachmentTokens = Math.max(0, actual.breakdown.messageTokens - plain.breakdown.messageTokens)
      actual.breakdown.messageTokens = plain.breakdown.messageTokens
      observeContext(actual)
    }
  }
  const prepareModel = createConversationModelPreparation(modelOptions)
  const services: ConversationExecutionServices = { store: owner.store,
    enter: async (command, request) => {
      if (request.threadId !== thread.id || request.runId !== context.requestId) throw new Error('Execution does not own this product instance.')
      await owner.enter(command, request)
      const state = owner.store.load(thread.id)
      if (context.onContextStatus && state) observeContext(await contextRuntime.projectedStatus(conversationContextSource(state, owner.store)))
    },
    prepareModel: (state, request, observer) => {
      attachments.addArtifacts(database.listAttachmentsForThread(thread.id))
      return prepareModel(state, request, observer)
    }, afterModel: async () => ({ kind: 'complete' }),
    prepareTools: state => prepareConversationToolBatch(state, preparationFor(state)),
    executeTool: (call, state, request, observer) => createConversationToolExecutor({ store: owner.store, definitions,
      preparation: preparationFor(state), operations, planning: catalog.planning,
      managed: owner.managed, persistFileChange: owner.persistFileChange })(call, state, request, observer), directions: owner.directions,
    completeResponse: context.review ? state => completeConversationReview(state, context.review!) : undefined,
    observeWaiting: (state, observer) => {
      for (const approval of state.approvals) {
        if (approval.kind !== 'tool' && approval.kind !== 'effect_recovery') continue
        approval.callIds.forEach((id, actionIndex) => {
          const call = state.calls.find(call => call.id === id)!
          observer.approval({ call: { id: call.id, name: call.name, args: call.args },
            approval: { status: 'pending_approval', interruptId: approval.id, actionIndex }, subagentId: context.subagentCall?.id })
        })
      }
    }, drain: () => operations.drain(), retry: { onRetry: observeModelRetry(context.requestId) }, recoveryLog: context.recoveryLog }
  const loop = conversationExecution(services)
  let executing = false
  const execution: RunExecution = { async execute(command, request, observer) {
    // Context observations do not own durable execution or turn a saved response
    // into failure. They are reported with the loop's other observation errors.
    if (executing) return { result: { status: 'rejected', reason: new Error('This product instance is already executing.') }, interrupted: false, observationErrors: [] }
    executing = true
    observationErrors = []
    try {
      const result = await loop.execute(command, request, observer)
      return { ...result, observationErrors: [...result.observationErrors, ...observationErrors] }
    } finally { executing = false }
  } }
  return { execution, context: contextRuntime, workspace,
    dispose: () => operations.drain() }
}
