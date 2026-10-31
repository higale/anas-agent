import { NativeRunHost, type NativeRunContext, type NativeRunFactory } from './nativeRunHost'
import type { NativeConversationDatabase } from './nativeConversationDatabase'
import { ManagedCallService } from './managedCallService'
import { NativeSubagentService } from './nativeSubagentService'
import { createConversationInstance } from './conversationInstance'
import { getAppConfigSnapshot } from '../config/appConfig'
import { getAgentConversationTempDir } from '../config/dataDir'
import { getProject } from '../projectStore'
import { validateCodeReviewSnapshot } from '../../runtime/codeReviewReport'
import { ModelSelectionError } from '../../runtime/errors'
import type { RunEventSink } from './runActivityProjection'
import type { AgentModelRetryInput, AgentResumeInput, AgentMessageRangeInput, AgentMessageWindowInput, AgentActivityWindowInput,
  AgentSystemContextPreviewInput, AgentSystemContextPreview, AgentModelRequestPreviewInput, AgentModelRequestPreview } from '../../shared/agentTypes'
import type { AgentRunSubmissionExecutionInput, AgentMessageRegenerateExecutionInput } from './agentRunInput'
import { earlierAgentMessagePageSize } from '../../shared/agentMessageWindow'
import { resolveAgentPreviewTarget } from './agentPreviewTarget'
import { captureAgentSystemPrompt, captureAgentModelRequest, projectConversationContextStatus } from './conversationPreview'
import { conversationContextSource } from './conversationModelExecution'
import { createAgentModelResolver } from './modelSelection'
import { modelContextKey } from '../../shared/modelConfig'
import { isDeepStrictEqual } from 'node:util'
import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import type { ExecutionMessageRecord } from '../../runtime/executionState'
import { recordModelRecovery } from './modelRecoveryDiagnostics'

export interface NativeAgentRuntimeOptions {
  providerFetch?: typeof fetch
  prepareWorkspace?: boolean
}

/** Product assembly on the native lifecycle owner. The model, project, tools
 * and child tasks use the existing configuration services and one connection. */
export class NativeAgentRuntime extends NativeRunHost {
  private readonly subagents: NativeSubagentService
  private readonly startupCleanup: Promise<void>
  private readonly managedCalls: ManagedCallService

  constructor(private readonly connection: NativeConversationDatabase, private readonly dataDir: string,
    events: RunEventSink, private readonly options: NativeAgentRuntimeOptions = {}) {
    connection.recover()
    const managed = new ManagedCallService(connection.managed, connection.results)
    super(connection, managed, events, recordModelRecovery)
    this.managedCalls = managed
    this.subagents = new NativeSubagentService(connection, this, {
      configuration: () => getAppConfigSnapshot(), snapshot: threadId => this.getSnapshot(threadId),
      create: (call, context) => this.createInstance(call.childThreadId, context)
    })
    this.startupCleanup = this.cleanupResources()
  }

  private async createInstance(threadId: string, context: NativeRunContext) {
    await this.startupCleanup
    const thread = this.connection.getThread(threadId)
    if (!thread) throw new Error(`Thread ${threadId} was not found.`)
    const run = this.connection.messages.activities.getRun(context.requestId)
    if (!run || run.threadId !== threadId) throw new Error('The run does not belong to this conversation.')
    let config: Awaited<ReturnType<typeof getAppConfigSnapshot>>
    try { config = await getAppConfigSnapshot() }
    catch (cause) {
      throw new ModelSelectionError(`The current model configuration could not be loaded. The run was stopped. Correct its settings and send again. ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
    const subagentCall = this.connection.resources.getSubagentCallByChildThreadId(threadId)
    const input = this.connection.runs.readRunInput({ threadId, runId: run.id })
    const reviewScope = !subagentCall ? input?.value.context?.reviewScope : undefined
    return createConversationInstance(thread, this.connection.resources, config, {
      ...context, ...this.options, managedCalls: this.managedCalls, subagentCall,
      subagents: this.subagents.forRun({ threadId, runId: run.id }),
      manualCompression: run.operation === 'compression',
      review: reviewScope === undefined ? undefined : validateCodeReviewSnapshot(reviewScope)
    }, this.connection.execution)
  }

  private factory(threadId: string): NativeRunFactory { return context => this.createInstance(threadId, context) }
  waitForStartupCleanup() { return this.startupCleanup }

  override submitRunWithAttachments(input: AgentRunSubmissionExecutionInput, create = this.factory(input.threadId)) {
    return super.submitRunWithAttachments(input, create)
  }
  override startCompression(threadId: string, create = this.factory(threadId), runId?: string) {
    return super.startCompression(threadId, create, runId)
  }
  override retryModel(input: AgentModelRetryInput, create = this.factory(input.threadId)) { return super.retryModel(input, create) }
  override resumeRun(input: AgentResumeInput, create = this.factory(input.threadId)) { return super.resumeRun(input, create) }
  override recoverRun(threadId: string, create = this.factory(threadId)) { return super.recoverRun(threadId, create) }
  override regenerateMessage(input: AgentMessageRegenerateExecutionInput, create = this.factory(input.threadId)) {
    return super.regenerateMessage(input, create)
  }
  override prepareMessageEdit(input: AgentMessageRangeInput, temporaryRoot?: string) {
    const ownerId = this.connection.resources.getSubagentCallByChildThreadId(input.threadId)?.ownerThreadId ?? input.threadId
    return super.prepareMessageEdit(input, temporaryRoot ?? getAgentConversationTempDir(ownerId, this.dataDir))
  }
  async getSnapshot(threadId: string, startIndex?: number) {
    const snapshot = this.readSnapshot(threadId, startIndex)
    if (!snapshot.interrupts.length) return snapshot
    const project = await getProject(snapshot.thread.projectId)
    return this.readSnapshotWithPreviews(threadId, project.kind === 'workspace' ? project.sourceFolders[0] : undefined, startIndex)
  }

  loadEarlierMessages(input: AgentMessageWindowInput) {
    if (!Number.isSafeInteger(input.beforeIndex) || input.beforeIndex < 0) throw new Error('The message window cursor is invalid.')
    return this.getSnapshot(input.threadId, Math.max(0, input.beforeIndex - earlierAgentMessagePageSize))
  }
  loadEarlierActivities(input: AgentActivityWindowInput) { return this.readActivityWindow(input.threadId, input.runId, input.beforeSequence) }

  async previewSystemContext(input: AgentSystemContextPreviewInput): Promise<AgentSystemContextPreview> {
    const target = await resolveAgentPreviewTarget(input, { id: 'system-context-preview', title: 'System context preview' })
    if (!target) return { content: '', unavailableReason: 'model_not_selected' }
    return { content: await captureAgentSystemPrompt(target.thread, this.connection.resources, target.config, target.project) }
  }

  async previewModelRequest(input: AgentModelRequestPreviewInput): Promise<AgentModelRequestPreview> {
    const target = await resolveAgentPreviewTarget(input, { id: 'model-request-preview', title: 'Model request preview' })
    if (!target) return { content: '', unavailableReason: 'model_not_selected' }
    return { content: await captureAgentModelRequest(target.thread, this.connection.resources, target.config, this.managedCalls, target.project) }
  }

  async getContextStatus(threadId: string) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const store = this.connection.runs.store
      const thread = this.connection.getThread(threadId), head = store.readHead(threadId)
      if (!thread) throw new Error(`Thread ${threadId} was not found.`)
      if (!head) return undefined
      // A status preview needs only the effective context. Read in batches so
      // an uncompressed long conversation does not monopolize startup IPC.
      const messages: ExecutionMessageRecord[] = [], start = head.context.summary?.cutoffIndex ?? 0, count = store.messageCount(threadId)
      if (start > count) throw new Error('The summary boundary is outside this conversation history.')
      for (let offset = start; offset < count; offset += 100) {
        await yieldToEventLoop()
        if (store.readHead(threadId)?.revisionId !== head.revisionId) break
        const batch = store.readHistoryRange(threadId, offset, Math.min(100, count - offset))
        messages.push(...batch)
      }
      if (store.readHead(threadId)?.revisionId !== head.revisionId) continue
      if (!messages.length && !head.context.summary) return undefined
      let summaryOffset = 0
      if (start > 0 && !messages.some(record => record.value.kind === 'user')) {
        const query = await this.connection.messages.latestUserMessageBefore(threadId, start, head.revisionId)
        if (store.readHead(threadId)?.revisionId !== head.revisionId) continue
        // Keep the recall query before the local summary boundary: it is
        // available to memory projection, but never counted as model history.
        if (query) { messages.unshift(query); summaryOffset = 1 }
      }
      const history = { revisionId: head.revisionId, messages, context: { ...head.context,
        ...(head.context.summary ? { summary: { ...head.context.summary, cutoffIndex: summaryOffset } } : {}) } }
      const run = this.connection.messages.activities.getLatestRunForThread(threadId)
      const continuation = run && ['running', 'interrupted'].includes(run.status) ? { threadId, runId: run.id } : undefined
      const subagentCall = this.connection.resources.getSubagentCallByChildThreadId(threadId)
      const scope = continuation && !subagentCall ? this.connection.runs.readRunInput(continuation)?.value.context?.reviewScope : undefined
      const status = await projectConversationContextStatus(thread, this.connection.resources, await getAppConfigSnapshot(),
        conversationContextSource({ threadId, ...history }, this.connection.runs.store), {
          requestId: continuation?.runId, managedCalls: this.managedCalls, subagentCall,
          configuration: continuation ? this.connection.runs.getRunConfiguration(continuation) : undefined,
          parentConfiguration: subagentCall ? this.connection.runs.getRunConfiguration({ threadId: subagentCall.parentThreadId, runId: subagentCall.parentRunId }) : undefined,
          review: scope === undefined ? undefined : validateCodeReviewSnapshot(scope)
        })
      const model = await createAgentModelResolver(threadId, this.connection.resources)()
      if (this.connection.runs.store.readHead(threadId)?.revisionId === history.revisionId
        && isDeepStrictEqual(this.connection.getThread(threadId), thread)
        && isDeepStrictEqual(this.connection.messages.activities.getLatestRunForThread(threadId), run)
        && status.modelContextKey === modelContextKey(model)) return status
    }
    return undefined
  }
}
