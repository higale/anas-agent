import type { AgentThreadUpdate, AgentThreadCleanupResult } from '@shared/agentTypes'
import { isAgentThreadLocked } from '@shared/agentTypes'
import { DEFAULT_WORKSPACE_PROJECT_ID, type ProjectDeleteResult } from '@shared/types'
import { getProject, deleteProjectWithThreads } from '../projectStore'
import { runtimeLog } from '../runtimeLogger'
import { AgentThreadLockedError } from './agentErrors'
import type { AgentStorage, ConversationStorageConnection } from './agentStorage'
import type { AgentRunSubmissionExecutionInput } from './agentRunInput'
import { validateShutdownTimeout, waitForShutdownDrain, type AgentRuntimeShutdownResult as RuntimeShutdownResult } from './runtimeShutdown'
import { acquireConversationLease, ownsConversationLease, withConversationLeaseScope } from './agentConversationLease'
import { withApplicationDataMutation } from '../applicationDataSnapshot'

export interface ConversationRuntimeLifetime {
  hasLiveWork(): boolean
  retireIfIdle(): boolean
  shutdown(options?: { timeoutMs?: number }): Promise<RuntimeShutdownResult>
  resumeAfterIncompleteShutdown(): void
}

const maximumIdleConversations = 32

/** Shared product directory ownership: leases, idle handles, project exclusion
 * and physical deletion. It does not interpret execution state or events. */
export class ConversationRuntimeDirectory<Connection extends ConversationStorageConnection, Runtime extends ConversationRuntimeLifetime> {
  private readonly runtimes = new Map<Connection, Runtime>()
  private readonly mutatingProjects = new Set<string>()
  private readonly creatingProjects = new Map<string, object>()
  private closing = false
  private readonly leases = new Map<object, number>()
  private readonly leaseWaiters = new Set<() => void>()
  private readonly lastUsed = new Map<Connection, number>()
  private usageSequence = 0
  private pruneTask?: NodeJS.Immediate

  constructor(readonly storage: AgentStorage<Connection>, private readonly services: {
    create(database: Connection): Runtime
    unresolvedThreads(database: Connection): string[]
    startupCleanup(runtime: Runtime): Promise<void>
  }) {}

  databaseForThread(threadId: string): Connection {
    this.assertOpen()
    const database = this.storage.conversationForThread(threadId)
    const thread = database.getThread(threadId)
    if (!thread) throw new Error(`Thread ${threadId} was not found.`)
    if (this.mutatingProjects.has(thread.projectId)) {
      throw new AgentThreadLockedError(threadId, 'be changed while its project is being deleted')
    }
    this.lease(database)
    return database
  }

  private lease(database: Connection): void {
    this.lastUsed.set(database, ++this.usageSequence)
    this.leaseResource(database)
    this.schedulePrune()
  }

  private leaseResource(resource: object, onReleased?: () => void): void {
    acquireConversationLease(resource, () => {
      this.leases.set(resource, (this.leases.get(resource) ?? 0) + 1)
      return () => {
        const remaining = (this.leases.get(resource) ?? 1) - 1
        if (remaining === 0) {
          this.leases.delete(resource)
          onReleased?.()
        }
        else this.leases.set(resource, remaining)
        for (const settled of this.leaseWaiters) settled()
        this.schedulePrune()
      }
    })
  }

  storageForOperation(): AgentStorage<Connection> {
    this.assertOpen()
    this.leaseResource(this.storage)
    return this.storage
  }

  useStorage<T>(operation: (storage: AgentStorage<Connection>) => T): T {
    return withConversationLeaseScope(() => operation(this.storageForOperation()))
  }

  private schedulePrune(): void {
    if (this.closing || this.pruneTask) return
    this.pruneTask = setImmediate(() => {
      this.pruneTask = undefined
      try { this.trimIdleConversations() } catch (error) {
        runtimeLog('warn', 'agent-storage', 'Failed to close an idle conversation database.', { error })
      }
    })
    this.pruneTask.unref()
  }

  trimIdleConversations(): void {
    if (this.closing) return
    const idle = this.storage.openedConversations().filter(({ ownerId, database }) =>
      !this.leases.has(database)
      && !this.mutatingProjects.has(this.storage.getThread(ownerId)?.projectId ?? '')
      && !isAgentThreadLocked(this.storage.getThread(ownerId)?.status ?? 'idle')
      && !this.runtimes.get(database)?.hasLiveWork()
    ).sort((a, b) => (this.lastUsed.get(a.database) ?? 0) - (this.lastUsed.get(b.database) ?? 0))
    let excess = idle.length - maximumIdleConversations
    for (const { ownerId, database } of idle) {
      if (excess <= 0) break
      const runtime = this.runtimes.get(database)
      if (runtime && !runtime.retireIfIdle()) continue
      this.runtimes.delete(database)
      this.lastUsed.delete(database)
      this.storage.closeConversation(ownerId)
      excess -= 1
    }
  }

  protected useRuntime<T>(threadId: string, operation: (runtime: Runtime) => T): T {
    return withConversationLeaseScope(() => operation(this.forThread(threadId)))
  }

  protected runtimeForDatabase(database: Connection): Runtime {
    this.assertOpen()
    this.lease(database)
    let runtime = this.runtimes.get(database)
    if (!runtime) {
      runtime = this.services.create(database)
      this.runtimes.set(database, runtime)
    }
    return runtime
  }

  forThread(threadId: string): Runtime {
    return this.runtimeForDatabase(this.databaseForThread(threadId))
  }

  updateThread(threadId: string, update: AgentThreadUpdate) {
    this.databaseForThread(threadId)
    return this.storage.updateThread(threadId, update)
  }

  protected assertOpen(): void {
    if (this.closing) throw new Error('Agent runtime is shutting down.')
  }

  protected routeSubmission<Submission>(input: AgentRunSubmissionExecutionInput, submit: (runtime: Runtime) => Promise<Submission>): Promise<Submission> {
    return withConversationLeaseScope(() => this.submitToConversation(input, submit))
  }

  private async submitToConversation<Submission>(input: AgentRunSubmissionExecutionInput, submit: (runtime: Runtime) => Promise<Submission>): Promise<Submission> {
    this.assertOpen()
    if (!input.newThread) return this.useRuntime(input.threadId, submit)
    if (this.mutatingProjects.has(input.newThread.projectId)) {
      throw new AgentThreadLockedError(input.threadId, 'be created while its project is being deleted')
    }
    const projectId = input.newThread.projectId
    const creation = this.creatingProjects.get(projectId) ?? {}
    this.creatingProjects.set(projectId, creation)
    this.leaseResource(creation, () => {
      if (this.creatingProjects.get(projectId) === creation) this.creatingProjects.delete(projectId)
    })
    const database = this.storage.openConversation(input.threadId, { create: true, projectId: input.newThread.projectId })
    const runtime = this.runtimeForDatabase(database)
    try {
      const submission = await submit(runtime)
      this.storage.refreshConversation(input.threadId)
      return submission
    } catch (error) {
      if (!database.getThread(input.threadId)) {
        await runtime.shutdown()
        this.runtimes.delete(database)
        await this.storage.removeConversation(input.threadId)
      }
      throw error
    }
  }

  deleteThread(threadId: string): Promise<void> {
    return withApplicationDataMutation(() => withConversationLeaseScope(() => this.deleteConversation(threadId)))
  }

  private async deleteConversation(threadId: string): Promise<void> {
    this.assertOpen()
    const thread = this.storage.getThread(threadId)
    if (!thread) throw new Error(`Conversation ${threadId} was not found.`)
    if (this.mutatingProjects.has(thread.projectId)) throw new AgentThreadLockedError(threadId, 'be deleted while its project is being deleted')
    const database = this.storage.openedConversation(threadId)
    if (database) {
      this.assertNoOtherLeases(database, threadId)
    }
    await this.deletePreparedConversation(threadId, database)
  }

  private async deletePreparedConversation(threadId: string, database?: Connection): Promise<void> {
    this.storage.beginConversationDeletion(threadId)
    if (database) {
      this.lease(database)
      const runtime = this.runtimes.get(database)
      if (runtime) {
        const result = await runtime.shutdown()
        if (!result.drained) throw new AgentThreadLockedError(threadId, 'be removed before its work stops')
      }
      this.runtimes.delete(database)
      this.lastUsed.delete(database)
    }
    await this.storage.removeConversation(threadId)
  }

  cleanupThreads(): Promise<AgentThreadCleanupResult> {
    return withApplicationDataMutation(() => withConversationLeaseScope(() => this.cleanupConversations()))
  }

  private async cleanupConversations(): Promise<AgentThreadCleanupResult> {
    const result: AgentThreadCleanupResult = {
      deleted: 0, skipped: 0, failed: 0,
      deletedThreadIds: [], skippedThreadIds: [], failures: []
    }
    for (const thread of this.storage.listThreads().filter((item) => !item.pinned)) {
      if (isAgentThreadLocked(thread.status) || this.mutatingProjects.has(thread.projectId)) {
        result.skippedThreadIds.push(thread.id)
        continue
      }
      try {
        const database = this.storage.conversationForCleanup(thread.id)
        if (database && (this.runtimes.get(database)?.hasLiveWork()
          || this.services.unresolvedThreads(database).length > 0)) {
          result.skippedThreadIds.push(thread.id)
          continue
        }
        await this.deleteConversation(thread.id)
        result.deletedThreadIds.push(thread.id)
      } catch (error) {
        result.failures.push({ threadId: thread.id, error: error instanceof Error ? error.message : String(error) })
      }
    }
    result.deleted = result.deletedThreadIds.length
    result.skipped = result.skippedThreadIds.length
    result.failed = result.failures.length
    return result
  }

  deleteProjectThreads(projectId: string): Promise<ProjectDeleteResult> {
    return withApplicationDataMutation(() => withConversationLeaseScope(() => this.deleteProjectConversations(projectId, false)))
  }

  deleteProject(projectId: string): Promise<ProjectDeleteResult> {
    if (projectId === DEFAULT_WORKSPACE_PROJECT_ID) {
      return Promise.reject(new Error('The default workspace project cannot be deleted.'))
    }
    return withApplicationDataMutation(() => withConversationLeaseScope(() => this.deleteProjectConversations(projectId, true)))
  }

  private async deleteProjectConversations(projectId: string, removeProject: boolean): Promise<ProjectDeleteResult> {
    this.assertOpen()
    if (this.mutatingProjects.has(projectId)) throw new Error('Project conversation deletion is already running.')
    if (this.creatingProjects.has(projectId)) throw new Error('Project conversations are still being created.')
    this.mutatingProjects.add(projectId)
    try {
      await getProject(projectId)
      const threads = this.storage.listThreads().filter((thread) => thread.projectId === projectId)
      const targets = threads.map((thread) => {
        if (isAgentThreadLocked(thread.status)) throw new AgentThreadLockedError(thread.id, 'be deleted with its project')
        const database = this.storage.openedConversation(thread.id)
        if (database) {
          this.assertNoOtherLeases(database, thread.id)
          if (this.runtimes.get(database)?.hasLiveWork()) throw new AgentThreadLockedError(thread.id, 'be deleted with its project')
        }
        return { thread, database }
      })
      const deletedThreadIds: string[] = []
      for (const { thread, database } of targets) {
        await this.deletePreparedConversation(thread.id, database)
        deletedThreadIds.push(thread.id)
      }
      if (removeProject) {
        await deleteProjectWithThreads(projectId, deletedThreadIds, (commitProjectStore) => {
          this.storage.completeProjectDeletion(projectId)
          commitProjectStore()
        })
      }
      return { projectId, deletedThreadIds }
    } finally {
      this.mutatingProjects.delete(projectId)
    }
  }

  clearMemories(): number {
    this.assertOpen()
    if ([...this.runtimes.values()].some((runtime) => runtime.hasLiveWork())
      || this.storage.listThreads().some((thread) => isAgentThreadLocked(thread.status))) {
      throw new Error('Memories cannot be cleared while Agent runs are active.')
    }
    return this.storage.memoryStore.clearMemories()
  }

  getStorageUsage() { return this.storage.getStorageUsage() }

  private assertNoOtherLeases(database: Connection, threadId: string): void {
    if ((this.leases.get(database) ?? 0) > (ownsConversationLease(database) ? 1 : 0)) {
      throw new AgentThreadLockedError(threadId, 'be removed while a conversation operation is in progress')
    }
  }

  async compactDatabase(): Promise<void> {
    if ([...this.leases].some(([resource, count]) => count > (ownsConversationLease(resource) ? 1 : 0))
      || [...this.runtimes.values()].some((runtime) => runtime.hasLiveWork())
      || this.storage.listThreads().some((thread) => isAgentThreadLocked(thread.status))) {
      throw new Error('Database maintenance requires Agent runs to finish.')
    }
    const stopped = await this.shutdown()
    if (!stopped.drained) {
      this.resumeAfterIncompleteShutdown()
      throw new Error('Database maintenance requires all Agent work to stop.')
    }
    this.runtimes.clear()
    this.lastUsed.clear()
    try {
      await this.storage.compact()
    } finally {
      this.closing = false
    }
  }

  async waitForStartupCleanup(): Promise<void> {
    await Promise.all([...this.runtimes.values()].map((runtime) => this.services.startupCleanup(runtime)))
  }

  private async waitForOtherLeases(timeoutMs?: number): Promise<boolean> {
    // Maintenance may own its caller's lease. It must wait for other operations,
    // including plain readers and shared-memory writes without a live executor.
    const owned = new Set([...this.leases.keys()].filter(ownsConversationLease))
    let check!: () => void
    const drain = new Promise<void>(resolve => {
      check = () => {
        if (![...this.leases].some(([resource, count]) => count > (owned.has(resource) ? 1 : 0))) resolve()
      }
      this.leaseWaiters.add(check)
      check()
    })
    try { return await waitForShutdownDrain(drain, timeoutMs) }
    finally { this.leaseWaiters.delete(check) }
  }

  async shutdown(options: { timeoutMs?: number } = {}): Promise<RuntimeShutdownResult> {
    validateShutdownTimeout(options.timeoutMs)
    this.closing = true
    if (this.pruneTask) clearImmediate(this.pruneTask)
    this.pruneTask = undefined
    const [results, leasesDrained] = await Promise.all([
      Promise.all([...this.runtimes.values()].map((runtime) => runtime.shutdown(options))),
      this.waitForOtherLeases(options.timeoutMs)
    ])
    return {
      drained: leasesDrained && results.every((result) => result.drained),
      lingeringRunIds: results.flatMap((result) => result.lingeringRunIds),
      lingeringCallIds: results.flatMap((result) => result.lingeringCallIds)
    }
  }

  resumeAfterIncompleteShutdown(): void {
    this.closing = false
    for (const runtime of this.runtimes.values()) runtime.resumeAfterIncompleteShutdown()
  }
}
