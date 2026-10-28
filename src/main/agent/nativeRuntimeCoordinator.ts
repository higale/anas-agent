import { NativeAgentRuntime, type NativeAgentRuntimeOptions } from './nativeAgentRuntime'
import type { NativeConversationDatabase } from './nativeConversationDatabase'
import { ConversationRuntimeDirectory } from './conversationRuntimeDirectory'
import type { AgentStorage } from './agentStorage'
import type { AgentRunSubmissionExecutionInput } from './agentRunInput'
import { withConversationLeaseScope } from './agentConversationLease'
import type { RunEventSink } from './runActivityProjection'
import type { NativeRunSubmission } from './nativeRunHost'
import type { AgentRunCancellationResult } from '../../shared/agentTypes'

/** Native application entry. Startup/IPC select it only with native storage;
 * ordinary UI commands never choose a framework or create an execution factory. */
export class NativeRuntimeCoordinator extends ConversationRuntimeDirectory<NativeConversationDatabase, NativeAgentRuntime> {
  constructor(storage: AgentStorage<NativeConversationDatabase>, events: RunEventSink, options: NativeAgentRuntimeOptions = {}) {
    super(storage, { create: database => new NativeAgentRuntime(database, storage.dataDir, events, options),
      unresolvedThreads: database => database.managed.listThreadIdsWithUnresolvedManagedCalls(),
      startupCleanup: runtime => runtime.waitForStartupCleanup() })
  }

  getRunSubmission(submissionId: string) {
    const ownerId = this.storage.submissionOwner(submissionId)
    return ownerId ? this.useRuntime(ownerId, runtime => runtime.getRunSubmission(submissionId)) : undefined
  }
  submitRunWithAttachments(input: AgentRunSubmissionExecutionInput): Promise<NativeRunSubmission> {
    return withConversationLeaseScope(() => {
      this.assertOpen()
      const existing = this.getRunSubmission(input.submissionId)
      return existing ? Promise.resolve(existing) : this.routeSubmission(input, runtime => runtime.submitRunWithAttachments(input))
    })
  }
  getSnapshot(threadId: string) { return this.useRuntime(threadId, runtime => runtime.getSnapshot(threadId)) }
  getContextStatus(threadId: string) { return this.useRuntime(threadId, runtime => runtime.getContextStatus(threadId)) }
  loadEarlierMessages(input: Parameters<NativeAgentRuntime['loadEarlierMessages']>[0]) { return this.useRuntime(input.threadId, runtime => runtime.loadEarlierMessages(input)) }
  loadEarlierActivities(input: Parameters<NativeAgentRuntime['loadEarlierActivities']>[0]) { return this.useRuntime(input.threadId, runtime => runtime.loadEarlierActivities(input)) }
  previewSystemContext(input: Parameters<NativeAgentRuntime['previewSystemContext']>[0]) {
    return withConversationLeaseScope(() => this.runtimeForDatabase(this.storage.previewDatabase()).previewSystemContext(input))
  }
  previewModelRequest(input: Parameters<NativeAgentRuntime['previewModelRequest']>[0]) {
    return withConversationLeaseScope(() => this.runtimeForDatabase(this.storage.previewDatabase()).previewModelRequest(input))
  }
  startCompression(threadId: string, runId?: string) { return this.useRuntime(threadId, runtime => runtime.startCompression(threadId, undefined, runId)) }
  recoverRun(threadId: string) {
    return this.useRuntime(threadId, runtime => {
      const handle = runtime.recoverRun(threadId)
      return handle ? { run: this.databaseForThread(threadId).messages.activities.getLatestRunForThread(threadId)!, handle } : undefined
    })
  }
  resumeRun(input: Parameters<NativeAgentRuntime['resumeRun']>[0]) {
    return this.useRuntime(input.threadId, runtime => {
      const handle = runtime.resumeRun(input)
      return { run: this.databaseForThread(input.threadId).readModel.getRun(input.runId)!, handle }
    })
  }
  cancelRun(input: Parameters<NativeAgentRuntime['cancel']>[0]): AgentRunCancellationResult {
    return this.useRuntime(input.threadId, runtime => runtime.cancel(input) ? 'requested' : 'unchanged')
  }
  truncateMessages(input: Parameters<NativeAgentRuntime['truncateMessages']>[0]) { return this.useRuntime(input.threadId, runtime => runtime.truncateMessages(input)) }
  prepareMessageEdit(input: Parameters<NativeAgentRuntime['prepareMessageEdit']>[0]) { return this.useRuntime(input.threadId, runtime => runtime.prepareMessageEdit(input)) }
  regenerateMessage(input: Parameters<NativeAgentRuntime['regenerateMessage']>[0]) { return this.useRuntime(input.threadId, runtime => runtime.regenerateMessage(input)) }
  listQueuedInputs() { return this.storage.queuedConversationIds().flatMap(ownerId => this.useRuntime(ownerId, runtime => runtime.listQueuedInputs())) }
  enqueueQueuedInput(input: Parameters<NativeAgentRuntime['enqueueQueuedInput']>[0]) { return this.useRuntime(input.threadId, runtime => runtime.enqueueQueuedInput(input)) }
  removeQueuedInput(threadId: string, id: string) { return this.useRuntime(threadId, runtime => runtime.removeQueuedInput(threadId, id)) }
  markQueuedInputFailed(threadId: string, id: string, error: string) { return this.useRuntime(threadId, runtime => runtime.markQueuedInputFailed(threadId, id, error)) }
  retryQueuedInput(threadId: string, id: string) { return this.useRuntime(threadId, runtime => runtime.retryQueuedInput(threadId, id)) }
  steerRun(input: Parameters<NativeAgentRuntime['steerRun']>[0]) { return this.useRuntime(input.threadId, runtime => runtime.steerRun(input)) }
  removeSteer(input: Parameters<NativeAgentRuntime['removeSteer']>[0]) { return this.useRuntime(input.threadId, runtime => runtime.removeSteer(input)) }
}
