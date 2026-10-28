import type { AgentAttachmentArtifact } from '../../shared/agentTypes'
import type { ResourceCleanupStore } from './resourceCleanupStore'
import type { ManagedCallService } from './managedCallService'
import { deleteArchivedAgentAttachments, deleteArchivedAgentThreadAttachments } from './agentAttachmentStore'
import { runWithCurrentAgentToolEffect } from './toolEffectScope'
import { runtimeLog } from '../runtimeLogger'

const errorMessage = (error: unknown) => error instanceof Error ? error.message : String(error)
export type FileEditCleanup = (runId: string, retainedOperationIds?: readonly string[]) => Promise<void>

/** Retryable cleanup starts only after the real file executor releases ownership.
 * Its pending outbox is acknowledged only after filesystem work succeeds. */
export class ResourceCleanup {
  private readonly fileEditCleanupTasks = new Map<string, Promise<void>>()
  constructor(private readonly store: ResourceCleanupStore,
    private readonly managedCalls: Pick<ManagedCallService, 'hasActiveForRun' | 'waitForRunIdle'>,
    private readonly cleanupFileEdits: FileEditCleanup,
    private readonly onTask: (task: Promise<void>) => void = () => {}) {}

  async waitForIdle(): Promise<void> {
    while (this.fileEditCleanupTasks.size) await Promise.all(this.fileEditCleanupTasks.values())
  }

  async drainPendingAttachmentCleanup(): Promise<void> {
    let threadIds: string[]
    let attachments: Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>>
    try {
      threadIds = this.store.listAttachmentCleanupThreadIds()
      attachments = this.store.listAttachmentFileCleanup()
    } catch (error) {
      runtimeLog('warn', 'agent', 'Failed to list pending attachment cleanup.', {
        error: errorMessage(error)
      })
      return
    }
    for (const attachment of attachments) {
      try {
        await deleteArchivedAgentAttachments([attachment], this.store.attachmentRoot)
        this.store.acknowledgeAttachmentFileCleanup(attachment.id)
      } catch (error) {
        runtimeLog('warn', 'agent', 'Failed to clean a discarded attachment.', {
          attachmentId: attachment.id,
          error: errorMessage(error)
        })
      }
    }
    for (const threadId of threadIds) {
      try {
        await this.completeThreadAttachmentCleanup(threadId)
      } catch (error) {
        runtimeLog('warn', 'agent', 'Failed to clean archived thread attachments.', {
          threadId,
          error: errorMessage(error)
        })
      }
    }
  }

  async completeThreadAttachmentCleanup(
    threadId: string,
    attachments: Array<Pick<AgentAttachmentArtifact, 'id' | 'path'>> = []
  ): Promise<void> {
    await deleteArchivedAgentAttachments(attachments, this.store.attachmentRoot)
    await deleteArchivedAgentThreadAttachments(threadId, this.store.attachmentRoot)
    this.store.acknowledgeAttachmentCleanup(threadId)
  }

  async drainPendingFileEditCleanup(): Promise<void> {
    let runIds: string[]
    try {
      runIds = this.store.listFileEditCleanupRunIds()
    } catch (error) {
      runtimeLog('warn', 'agent', 'Failed to list pending file edit cleanup.', {
        error: errorMessage(error)
      })
      return
    }
    await Promise.all(runIds.map((runId) => this.completeFileEditCleanup(runId)))
  }

  async completeFileEditCleanup(runId: string): Promise<void> {
    if (!this.store.hasFileEditCleanup(runId)) return
    let cleanup = this.fileEditCleanupTasks.get(runId)
    if (!cleanup) {
      cleanup = Promise.resolve().then(async () => {
        try {
          // Run cancellation may finish before an already-dispatched local
          // commit. Keep its file-edit recovery records until the actual executor
          // releases ownership, including result/patch persistence.
          while (this.managedCalls.hasActiveForRun(runId)) {
            await this.managedCalls.waitForRunIdle(runId)
          }
          const retainedOperationIds = this.store.listRetainedFileEditOperationIds(runId)
          await runWithCurrentAgentToolEffect({
            arm: () => undefined,
            persistFileChange: (record) => this.store.fileChanges.persist(record, true)
          }, async () => {
            if (retainedOperationIds.length > 0) {
              await this.cleanupFileEdits(runId, retainedOperationIds)
            } else {
              await this.cleanupFileEdits(runId)
            }
          })
          this.store.acknowledgeFileEditCleanup(runId)
        } catch (error) {
          runtimeLog('warn', 'agent', 'Failed to clean file edit records.', {
            runId,
            error: errorMessage(error)
          })
        } finally {
          this.fileEditCleanupTasks.delete(runId)
        }
      })
      this.fileEditCleanupTasks.set(runId, cleanup)
      this.onTask(cleanup)
    }
    // Deferred cleanup must not delay the run's cancellation response. It is
    // still tracked by runtime shutdown and retried from the durable outbox.
    if (!this.managedCalls.hasActiveForRun(runId)) await cleanup
  }

}
