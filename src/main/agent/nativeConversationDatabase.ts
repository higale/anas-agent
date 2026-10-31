import { SubagentActivityProjection } from './subagentActivityProjection'
import { randomUUID } from 'node:crypto'
import { ResourceCleanupStore } from './resourceCleanupStore'
import { BackgroundTaskStore } from './backgroundTaskStore'
import Database from 'better-sqlite3'
import { resolve } from 'node:path'
import type { SqliteMemoryStore } from './memoryStore'
import type { FileEditStore } from '../fileEditStore'
import type { ConversationInstanceOwner } from './conversationInstance'
import { initializeNativeConversationStorage, validateNativeConversationSchema } from './nativeDatabaseSchema'
import { validateNativeExecutionHeads, validateNativeExecutionStorage } from './nativeStorageValidation'
import { assertSubagentStorageIntegrity, assertCleanupStorageIntegrity, validateConversationResources } from './conversationResources'
import { NativeRunOwner } from './nativeRunOwner'
import { NativeHistoryOwner } from './nativeHistoryOwner'
import { NativeMessageProjection } from './nativeMessageProjection'
import { NativeMessageReader } from './nativeMessageReader'
import { NativeManagedResults } from './nativeManagedResults'
import { ManagedCallStore } from './managedCallStore'
import { QueuedInputStore } from './queuedInputStore'
import { ConversationResourceReader } from './conversationResourceReader'
import { FileChangeLedger } from './fileChangeLedger'
import { readConversationCatalogSnapshot } from './conversationCatalog'
import { recoverNativeConversation } from './nativeRecovery'
import { ContextSummaryStore } from './contextSummaryStore'
import type { AgentThreadSnapshot, AgentRunActivity } from '../../shared/agentTypes'
import { initialAgentMessageWindow } from '../../shared/agentMessageWindow'
import { conversationSnapshot } from './conversationSnapshot'
import { RunActivityMetadata } from './runActivityMetadata'
import { normalizeRootActivityProjection, rootActivityEvidence } from '../../runtime/runActivities'
import { projectInterruptPathPreviews } from './approvalPathPreview'
import { authorizationInputHash } from '../../runtime/authorizationReceipts'
import { RunActivityProjection } from './runActivityProjection'
import { readThreadRecord, updateThreadRecord, setThreadAccessMode } from './conversationThreads'
import type { AgentThreadCreate, AgentThreadUpdate, AgentAccessMode } from '../../shared/agentTypes'
import type { AgentApplicationReadModel } from './agentApplicationTypes'
import { backgroundCleanupUnconfirmed, type AgentBackgroundCleanup } from '../../shared/backgroundCleanup'

export interface NativeConversationDatabaseOptions {
  attachmentRoot: string
  memoryStore: SqliteMemoryStore
  fileEditStore: FileEditStore
  onFileChanges?(runId: string): void
  onChanged?(database: NativeConversationDatabase): void
}

export interface NativeSnapshotOptions {
  startIndex?: number
  executingRunId?: string
  settlingRunId?: string
  backgroundCleanup?: AgentBackgroundCleanup
  activeSubagentIds?: ReadonlySet<string>
  decorateActivity?(activity: AgentRunActivity): AgentRunActivity
}

/** Owns the one native conversation connection. Shared memory and filesystem
 * services belong to the application, and running tasks must drain before close.
 * Opening validates the current format; restart reconciliation
 * remain explicit application operations, never hidden read-time fallbacks. */
export class NativeConversationDatabase {
  readonly runs: NativeRunOwner
  readonly history: NativeHistoryOwner
  readonly messages: NativeMessageReader
  readonly subagentProjection: SubagentActivityProjection
  readonly activityProjection: RunActivityProjection
  readonly results: NativeManagedResults
  readonly background: BackgroundTaskStore
  readonly managed: ManagedCallStore
  readonly queue: QueuedInputStore
  readonly summaries: ContextSummaryStore
  readonly resources: ConversationResourceReader
  readonly resourceCleanup: ResourceCleanupStore
  private changeNotificationQueued = false
  readonly execution: ConversationInstanceOwner
  readonly readModel: AgentApplicationReadModel

  private constructor(private readonly database: Database.Database, private readonly options: NativeConversationDatabaseOptions) {
    initializeNativeConversationStorage(database)
    database.transaction(() => {
      validateNativeExecutionHeads(database)
      assertSubagentStorageIntegrity(database)
      assertCleanupStorageIntegrity(database)
    })()
    database.pragma('journal_mode=WAL')
    const projection = new NativeMessageProjection(database)
    this.runs = new NativeRunOwner(database, commit => { projection.commit(commit); this.notifyChanged() }, () => this.notifyChanged())
    this.history = new NativeHistoryOwner(database, this.runs)
    this.messages = new NativeMessageReader(database)
    this.results = new NativeManagedResults(database)
    this.managed = new ManagedCallStore(database, call => this.results.validateCallResult(call))
    const attachmentRoot = resolve(options.attachmentRoot)
    this.queue = new QueuedInputStore(database, attachmentRoot, () => this.notifyChanged())
    this.summaries = new ContextSummaryStore(database)
    this.activityProjection = new RunActivityProjection(this.messages.activities, this.messages.observations, this.summaries)
    this.subagentProjection = new SubagentActivityProjection(database, this.runs.subagents, this.messages.observations, this.messages.activities, this.activityProjection)
    this.resources = new ConversationResourceReader(database, attachmentRoot, options.memoryStore,
      new FileChangeLedger(database, options.onFileChanges, (threadId, runId) => this.messages.roundSummary(threadId, runId)), options.fileEditStore)
    this.resourceCleanup = new ResourceCleanupStore(database, attachmentRoot, this.resources.fileChanges)
    this.readModel = { fileChanges: this.resources.fileChanges, getThread: id => this.resources.getThread(id),
      getRun: id => this.messages.activities.getRun(id), getSubagentActivity: (runId, id) => this.messages.activities.getSubagentActivity(runId, id) }
    this.background = new BackgroundTaskStore(database, this.managed, this.resources, () => this.notifyChanged())
    this.execution = {
      store: this.runs.store, results: this.results, configuration: this.runs,
      managed: { format: 'conversation', get: (id, threadId) => this.managed.getManagedCall(id, threadId),
        remove: (id, threadId) => this.managed.deleteManagedCall(id, threadId),
        read: (reference, threadId) => this.results.read(reference, threadId) },
      enter: (command, request) => this.runs.enter(command, request),
      directions: state => this.runs.directions(state),
      persistFileChange: (record, observed) => this.resources.fileChanges.persist(record, observed)
    }
  }

  static open(file: string, options: NativeConversationDatabaseOptions): NativeConversationDatabase {
    const database = new Database(file)
    try { return new NativeConversationDatabase(database, options) }
    catch (error) { database.close(); throw error }
  }

  /** Validate an offline snapshot without initializing, recovering or executing it. */
  static validateBackup(file: string, attachmentRoot: string, projectIds: ReadonlySet<string>, expectedOwnerThreadId?: string): void {
    const database = new Database(file, { readonly: true, fileMustExist: true })
    try {
      database.transaction(() => {
        validateNativeConversationSchema(database)
        const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>
        if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('Native conversation database integrity check failed.')
        validateNativeExecutionStorage(database)
        validateConversationResources(database, attachmentRoot, projectIds, expectedOwnerThreadId)
      })()
    } finally { database.close() }
  }

  readCatalogSnapshot(ownerThreadId: string) { return readConversationCatalogSnapshot(this.database, ownerThreadId) }

  private notifyChanged(): void {
    if (!this.options.onChanged || this.changeNotificationQueued) return
    this.changeNotificationQueued = true
    queueMicrotask(() => {
      this.changeNotificationQueued = false
      if (this.database.open) this.options.onChanged?.(this)
    })
  }

  getThread(threadId: string) { return readThreadRecord(this.database, threadId) }
  createThread(options: AgentThreadCreate = {}, threadId: string = randomUUID()) { return this.runs.createThread(options, threadId) }
  listThreadIds() { return (this.database.prepare('SELECT id FROM agent_threads').all() as { id: string }[]).map(row => row.id) }
  updateThread(threadId: string, update: AgentThreadUpdate) { this.notifyChanged(); return updateThreadRecord(this.database, threadId, update) }
  setAccessMode(threadId: string, mode: AgentAccessMode) { this.notifyChanged(); return setThreadAccessMode(this.database, threadId, mode) }

  validate(): void {
    validateNativeExecutionStorage(this.database)
    assertSubagentStorageIntegrity(this.database)
    assertCleanupStorageIntegrity(this.database)
  }

  readActivityWindow(threadId: string, runId: string, beforeSequence: number, options: NativeSnapshotOptions = {}, page?: import('../../shared/agentTypes').AgentActivityPageInput): AgentRunActivity {
    if (!Number.isSafeInteger(beforeSequence) || beforeSequence < 0) throw new Error('The activity window cursor is invalid.')
    return this.database.transaction(() => {
      const run = this.messages.activities.getRun(runId)
      if (!run || run.threadId !== threadId) throw new Error(`Run ${runId} was not found in thread ${threadId}.`)
      const activity = page ? this.messages.activities.getDisplayPage(page) : this.messages.activities.getRunActivityWindow(runId, { beforeSequence })
      const normalized = normalizeRootActivityProjection(activity, rootActivityEvidence(this.messages.activityMessages(runId, activity), runId),
        options.executingRunId === runId, new RunActivityMetadata(this.database).canonicalChildren(runId), options.activeSubagentIds)
      return this.decorateActivity(normalized, options)
    })()
  }

  private cleanupReport(runId: string, saved: AgentBackgroundCleanup | undefined, options: NativeSnapshotOptions) {
    if (runId === options.settlingRunId) return options.backgroundCleanup ?? saved
    // A saved progress report cannot prove that cleanup still has a live owner.
    return saved?.status === 'running'
      ? { status: 'unconfirmed' as const, report: `${saved.report}\n${backgroundCleanupUnconfirmed}` }
      : saved
  }

  private decorateActivity(activity: AgentRunActivity, options: NativeSnapshotOptions) {
    const decorated = this.activityProjection.decorate({ ...activity,
      backgroundCleanup: this.cleanupReport(activity.runId, activity.backgroundCleanup, options) })
    return options.decorateActivity?.(decorated) ?? decorated
  }

  /** Call once at application startup, before starting task services. */
  recover() { this.notifyChanged(); return recoverNativeConversation(this.database, this.runs, this.managed) }

  /** One SQLite read snapshot; live disposal/progress comes from the host.
   * Filesystem path previews are applied by the application after this read. */
  readSnapshot(threadId: string, options: NativeSnapshotOptions = {}): AgentThreadSnapshot {
    if (options.startIndex !== undefined && (!Number.isSafeInteger(options.startIndex) || options.startIndex < 0)) {
      throw new Error('The message window cursor is invalid.')
    }
    return this.database.transaction(() => {
      const thread = this.resources.getThread(threadId)
      if (!thread) throw new Error(`Thread ${threadId} was not found.`)
      const savedRun = this.messages.activities.getLatestRunForThread(threadId)
      const latestRun = savedRun && { ...savedRun, backgroundCleanup: this.cleanupReport(savedRun.id, savedRun.backgroundCleanup, options) }
      const window = this.messages.window(threadId, options.startIndex, initialAgentMessageWindow)
      const waitingForResume = latestRun && this.database.prepare('SELECT 1 FROM agent_run_resume_intents WHERE run_id=?').get(latestRun.id)
      const interrupts = latestRun && !waitingForResume ? this.runs.readInterrupts({ threadId, runId: latestRun.id }) : []
      const metadata = new RunActivityMetadata(this.database)
      const head = this.runs.store.readHead(threadId)
      const snapshot = conversationSnapshot({ thread, latestRun, messages: window.messages, window, interrupts,
        todos: head?.context.todos ?? [], contextStatus: window.contextStatus,
        settling: latestRun?.id === options.settlingRunId
      }, {
        activities: runIds => this.messages.activities.getActivitiesForRuns(threadId, runIds, { includeUnanchored: initialAgentMessageWindow }),
        attachments: messageIds => this.resources.listAttachmentsForMessages(threadId, messageIds),
        normalizeActivity: activity => normalizeRootActivityProjection(activity,
          rootActivityEvidence(this.messages.activityMessages(activity.runId, activity), activity.runId),
          options.executingRunId === activity.runId, metadata.canonicalChildren(activity.runId), options.activeSubagentIds),
        decorateActivity: activity => this.decorateActivity(activity, options)
      })
      if (!options.settlingRunId && !options.executingRunId && thread.status !== 'running' && thread.status !== 'interrupted'
        && !this.resources.getSubagentCallByChildThreadId(threadId)) {
        const retries = this.history.modelRetries(threadId)
        if (retries.length) snapshot.modelRetries = retries
      }
      return snapshot
    })()
  }

  private snapshotIdentity(threadId: string): string {
    const thread = this.resources.getThread(threadId), run = this.messages.activities.getLatestRunForThread(threadId)
    const answers = run ? this.database.prepare('SELECT interrupt_id,response_json FROM agent_run_resume_intents WHERE run_id=? ORDER BY interrupt_id').all(run.id) : []
    return JSON.stringify([thread, run, this.runs.store.readHead(threadId)?.revisionId, answers])
  }

  async readSnapshotWithPreviews(threadId: string, primaryFolder: string | undefined, options: NativeSnapshotOptions = {}): Promise<AgentThreadSnapshot> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const captured = this.database.transaction(() => ({ snapshot: this.readSnapshot(threadId, options),
        state: this.runs.store.load(threadId), identity: this.snapshotIdentity(threadId) }))()
      const interrupts = await projectInterruptPathPreviews(captured.snapshot.interrupts, primaryFolder, (action, { interrupt, actionIndex }) => {
        const approval = captured.state?.approvals.find(item => item.id === interrupt.id)
        if (!approval || approval.kind === 'subagent' || approval.kind === 'context_read') return undefined
        const call = captured.state!.calls.find(item => item.id === approval.callIds[actionIndex]), receipt = call?.authorization?.patch
        return receipt && call?.name === action.name && receipt.id === call.id && receipt.name === action.name
          && receipt.inputHash === authorizationInputHash(action.args) ? receipt.targets : undefined
      })
      if (this.database.transaction(() => this.snapshotIdentity(threadId))() === captured.identity) return { ...captured.snapshot, interrupts }
    }
    throw new Error('Conversation changed while its approval paths were being read. Read the snapshot again.')
  }

  close(): void {
    if (this.database.open) this.database.close()
  }
}
