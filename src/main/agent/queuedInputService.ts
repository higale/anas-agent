import type { AgentQueuedInput, AgentQueuedInputCreate } from '../../shared/agentTypes'
import type { QueuedInputStore } from './queuedInputStore'
import { normalizeAgentRunSubmissionId } from './agentRunInput'
import { archiveAgentAttachments, deleteArchivedAgentAttachments, validatedAttachmentInputs } from './agentAttachmentStore'

/** Shared product queue operations. Archival never starts execution; selecting
 * a queued item for an active run belongs to that run's durable owner. */
export class QueuedInputService {
  private readonly pending = new Map<string, Promise<AgentQueuedInput>>()
  private readonly tasks = new Set<Promise<unknown>>()
  constructor(private readonly store: Pick<QueuedInputStore, keyof QueuedInputStore>, private readonly attachmentRoot: string,
    private readonly threadExists: (id: string) => boolean, private readonly cleanup: () => Promise<void>,
    private readonly onTask: (task: Promise<unknown>) => void = () => {}) {}

  private track<T>(task: Promise<T>): Promise<T> {
    this.tasks.add(task); this.onTask(task)
    void task.then(() => this.tasks.delete(task), () => this.tasks.delete(task))
    return task
  }

  async waitForIdle(): Promise<void> {
    while (this.tasks.size) await Promise.allSettled(this.tasks)
  }

  listQueuedInputs() { return this.store.listQueuedInputs() }

  async enqueueQueuedInput(input: AgentQueuedInputCreate): Promise<AgentQueuedInput> {
    const id = normalizeAgentRunSubmissionId(input.id), text = input.text, displayText = input.displayText ?? text
    if (!text.trim()) throw new Error('Queued input text is required.')
    if (!displayText.trim()) throw new Error('Queued input display text is required.')
    if (!this.threadExists(input.threadId)) throw new Error(`Thread ${input.threadId} was not found.`)
    const existing = this.store.getQueuedInput(input.threadId, id)
    if (existing) return existing
    const key = `${input.threadId}:${id}`, pending = this.pending.get(key)
    if (pending) return pending
    const attachments = validatedAttachmentInputs(input.attachments, 'Queued input')
    const task = (async () => {
      const archived = await archiveAgentAttachments(attachments, { threadId: input.threadId, runId: id, messageId: id }, this.attachmentRoot)
      try { return this.store.createQueuedInput({ id, threadId: input.threadId, text, ...(displayText === text ? {} : { displayText }) }, archived) }
      catch (reason) {
        await deleteArchivedAgentAttachments(archived.map(item => item.artifact), this.attachmentRoot)
        throw reason
      }
    })()
    this.pending.set(key, task)
    void task.then(() => this.pending.delete(key), () => this.pending.delete(key))
    return this.track(task)
  }

  removeQueuedInput(threadId: string, queuedInputId: string): Promise<boolean> {
    return this.track((async () => {
      const removed = this.store.deleteQueuedInput(threadId, queuedInputId)
      if (removed) await this.cleanup()
      return removed
    })())
  }

  markQueuedInputFailed(threadId: string, queuedInputId: string, error: string) {
    return this.store.markQueuedInputFailed(threadId, queuedInputId, error.trim() || 'Queued message could not be sent.')
  }

  retryQueuedInput(threadId: string, queuedInputId: string) { return this.store.retryQueuedInput(threadId, queuedInputId) }
}
