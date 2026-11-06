import { NativeAgentRuntime, type NativeAgentRuntimeOptions } from './nativeAgentRuntime'
import type { NativeConversationDatabase } from './nativeConversationDatabase'
import { ConversationRuntimeDirectory } from './conversationRuntimeDirectory'
import type { AgentStorage, ConfirmWorkspaceSpeech } from './agentStorage'
import { normalizeAgentRunSubmissionId, type AgentRunSubmissionExecutionInput } from './agentRunInput'
import { withConversationLeaseScope } from './agentConversationLease'
import type { RunEventSink } from './runActivityProjection'
import type { NativeRunSubmission } from './nativeRunHost'
import type { AgentRunCancellationResult } from '../../shared/agentTypes'
import { PreferenceMemoryService, type PreferenceMessage, type PreferenceSource } from './preferenceMemoryService'
import { getAppConfigSnapshot } from '../config/appConfig'
import { listProjects } from '../projectStore'
import { effectiveProjectCapabilities } from '../../shared/agentCapabilities'
import { setImmediate as yieldToLoop } from 'node:timers/promises'
import { waitForShutdownDrain } from './runtimeShutdown'
import { contentText } from '../../runtime/inputContent'
import { conversationContentBlocks } from '../../providers/conversationInput'

/** Native application entry. Startup/IPC select it only with native storage;
 * ordinary UI commands never choose a framework or create an execution factory. */
export class NativeRuntimeCoordinator extends ConversationRuntimeDirectory<NativeConversationDatabase, NativeAgentRuntime> {
  readonly memory: PreferenceMemoryService
  constructor(storage: AgentStorage<NativeConversationDatabase>, events: RunEventSink, options: NativeAgentRuntimeOptions = {}) {
    super(storage, { create: database => new NativeAgentRuntime(database, storage.dataDir, events, options),
      unresolvedThreads: database => database.managed.listThreadIdsWithUnresolvedManagedCalls(),
      startupCleanup: runtime => runtime.waitForStartupCleanup() })
    this.memory = new PreferenceMemoryService(storage.preferences, {
      config: getAppConfigSnapshot, sources: (barrier, currentThreadId, interrupted) => this.memorySources(barrier, currentThreadId, interrupted),
      scopes: async () => [{ kind: 'global' }, ...(await listProjects()).map(project => ({ kind: 'project' as const, projectId: project.id }))],
      currentRevision: (id, revision) => withConversationLeaseScope(() => Boolean(this.readableThread(id))
        && this.databaseForThread(id).runs.store.readHead(id)?.revisionId === revision),
      current: async source => {
        const project = (await listProjects()).find(item => item.id === source.projectId)
        if (project?.kind !== 'workspace' || !effectiveProjectCapabilities(project).memory) return false
        return this.useStorage(store => this.readableThread(source.threadId)?.projectId === source.projectId
          && store.conversationForThread(source.threadId).runs.store.readHead(source.threadId)?.revisionId === source.sourceRevision)
      },
      changed: () => this.onMemoryChanged?.()
    })
  }
  onMemoryChanged?: () => void

  private async memorySources(barrier = false, currentThreadId?: string, interrupted?: () => boolean): Promise<PreferenceSource<AsyncIterable<PreferenceMessage>>[]> {
    const sources: PreferenceSource<AsyncIterable<PreferenceMessage>>[] = []
    const ids = this.memory.store.dirtyThreads()
    const projects = new Map((await listProjects()).map(project => [project.id, project]))
    let visited = 0
    for (const id of ids) {
      // Ineligible chats also consume catalog I/O. Keep a large initial queue interruptible.
      if (++visited % 64 === 0) await yieldToLoop()
      if (interrupted?.()) break
      if (id === currentThreadId) continue
      const thread = this.readableThread(id)
      if (!thread) {
        if (!this.storage.getThread(id)) this.memory.store.forgetThread(id)
        continue
      }
      const project = projects.get(thread.projectId)
      if (project?.kind === 'simple_chat') { this.memory.store.forgetThread(id); continue }
      if (!barrier && (!project || !effectiveProjectCapabilities(project).memory)) continue
      const snapshot = withConversationLeaseScope(() => {
        const store = this.databaseForThread(thread.id).runs.store, head = store.readHead(thread.id)
        if (!head) return
        const tail = store.historyTail(thread.id)
        return { revision: head.revisionId, tail: tail?.record_id ?? null, count: (tail?.position ?? -1) + 1 }
      })
      if (snapshot) sources.push({ threadId: thread.id, projectId: thread.projectId, title: thread.title, revision: snapshot.revision,
        tail: snapshot.tail, messages: this.memoryMessages(thread.id, snapshot.revision, snapshot.count, interrupted) })
      await yieldToLoop()
    }
    return sources
  }

  private async *memoryMessages(threadId: string, revision: string, count: number, interrupted?: () => boolean): AsyncGenerator<PreferenceMessage> {
    if (!this.readableThread(threadId)) return
    const start = withConversationLeaseScope(() => {
      const store = this.databaseForThread(threadId).runs.store
      const cursor = this.memory.store.cursor(threadId, id => store.recordPosition(threadId, id) !== undefined)
      if (!cursor) return 0
      const position = store.recordPosition(threadId, cursor)
      return position === undefined ? count : position + 1
    })
    for (let offset = start; offset < count; offset += 100) {
      if (interrupted?.()) return
      const records = withConversationLeaseScope(() => {
        if (!this.readableThread(threadId)) return
        const store = this.databaseForThread(threadId).runs.store
        if (store.readHead(threadId)?.revisionId !== revision) return
        return store.readHistoryRange(threadId, offset, Math.min(100, count - offset))
      })
      if (!records) return
      for (const { recordId, value } of records) {
        if (interrupted?.()) return
        if (value.kind !== 'user' && value.kind !== 'assistant' || value.context?.summary) continue
        yield { id: recordId, role: value.kind, text: value.kind === 'user' && typeof value.context?.displayText === 'string'
          ? value.context.displayText : contentText(conversationContentBlocks(value)) }
      }
      await yieldToLoop()
    }
  }

  override async shutdown(options: { timeoutMs?: number } = {}) {
    const memoryDrain = this.memory.stop()
    const [result, memoryStopped] = await Promise.all([super.shutdown(options), waitForShutdownDrain(memoryDrain, options.timeoutMs)])
    return { ...result, drained: result.drained && memoryStopped,
      lingeringRunIds: memoryStopped ? result.lingeringRunIds : [...result.lingeringRunIds, 'background-memory'] }
  }
  override async compactDatabase(): Promise<void> {
    const active = this.memory.active
    try { await super.compactDatabase() } finally { if (active) this.memory.start() }
  }
  override resumeAfterIncompleteShutdown(): void { super.resumeAfterIncompleteShutdown(); this.memory.start() }

  getRunSubmission(submissionId: string) {
    const ownerId = this.storage.submissionOwner(submissionId)
    return ownerId ? this.useRuntime(ownerId, runtime => runtime.getRunSubmission(submissionId)) : undefined
  }
  private acceptedSpeech(confirm: ConfirmWorkspaceSpeech): void {
    const currentThreadId = confirm?.()
    if (currentThreadId) void this.memory.onConversationSpeech(currentThreadId)
  }
  submitRunWithAttachments(input: AgentRunSubmissionExecutionInput,
    confirm = this.storage.captureWorkspaceSpeech(input.threadId, Boolean(input.newThread))): Promise<NativeRunSubmission> {
    return withConversationLeaseScope(() => {
      this.assertOpen()
      const existing = this.getRunSubmission(input.submissionId)
      if (existing) return Promise.resolve(existing)
      const queued = !input.newThread && this.databaseForThread(input.threadId).queue.getQueuedInput(input.threadId, input.submissionId)
      return this.routeSubmission(input, runtime => runtime.submitRunWithAttachments(input)).then(submission => {
        if (!queued && submission.handle) this.acceptedSpeech(confirm)
        return submission
      })
    })
  }
  getSnapshot(threadId: string) { return this.useRuntime(threadId, runtime => runtime.getSnapshot(threadId)) }
  getContextStatus(threadId: string) { return this.useRuntime(threadId, runtime => runtime.getContextStatus(threadId)) }
  loadEarlierMessages(input: Parameters<NativeAgentRuntime['loadEarlierMessages']>[0]) { return this.useRuntime(input.threadId, runtime => runtime.loadEarlierMessages(input)) }
  loadEarlierActivities(input: Parameters<NativeAgentRuntime['loadEarlierActivities']>[0]) { return this.useRuntime(input.threadId, runtime => runtime.loadEarlierActivities(input)) }
  loadActivityDirectory(input: Parameters<NativeAgentRuntime['loadActivityDirectory']>[0], signal: AbortSignal) { return this.useRuntime(input.threadId, runtime => runtime.loadActivityDirectory(input, signal)) }
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
  retryModel(input: Parameters<NativeAgentRuntime['retryModel']>[0]) {
    return this.useRuntime(input.threadId, async runtime => {
      const handle = await runtime.retryModel(input)
      return { run: this.databaseForThread(input.threadId).readModel.getRun(input.runId)!, handle }
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
  enqueueQueuedInput(input: Parameters<NativeAgentRuntime['enqueueQueuedInput']>[0]) {
    return this.useRuntime(input.threadId, async runtime => {
      const existing = this.databaseForThread(input.threadId).queue.getQueuedInput(input.threadId, normalizeAgentRunSubmissionId(input.id))
      const confirm = existing ? null : this.storage.captureWorkspaceSpeech(input.threadId)
      const queued = await runtime.enqueueQueuedInput(input)
      this.acceptedSpeech(confirm)
      return queued
    })
  }
  removeQueuedInput(threadId: string, id: string) { return this.useRuntime(threadId, runtime => runtime.removeQueuedInput(threadId, id)) }
  markQueuedInputFailed(threadId: string, id: string, error: string) { return this.useRuntime(threadId, runtime => runtime.markQueuedInputFailed(threadId, id, error)) }
  retryQueuedInput(threadId: string, id: string) { return this.useRuntime(threadId, runtime => runtime.retryQueuedInput(threadId, id)) }
  steerRun(input: Parameters<NativeAgentRuntime['steerRun']>[0]) { return this.useRuntime(input.threadId, runtime => runtime.steerRun(input)) }
  removeSteer(input: Parameters<NativeAgentRuntime['removeSteer']>[0]) { return this.useRuntime(input.threadId, runtime => runtime.removeSteer(input)) }
}
