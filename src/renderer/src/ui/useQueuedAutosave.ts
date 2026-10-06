import { useCallback, useRef, useState } from 'react'

export interface AutosaveRevision {
  entityId: string
  revision: number
}

export interface AutosaveRequest extends AutosaveRevision {
  isCurrent(): boolean
}

type QueuedAutosaveTask = (request: AutosaveRequest) => Promise<void>

export class QueuedAutosave {
  private queue: Promise<void> = Promise.resolve()
  private current?: AutosaveRevision
  private revision = 0

  revise(entityId: string): AutosaveRevision {
    const next = { entityId, revision: ++this.revision }
    this.current = next
    return next
  }

  isCurrent(revision: AutosaveRevision): boolean {
    return revision.revision === this.current?.revision
      && revision.entityId === this.current.entityId
  }

  async enqueue(revision: AutosaveRevision, task: QueuedAutosaveTask): Promise<boolean> {
    const request: AutosaveRequest = {
      ...revision,
      isCurrent: () => this.isCurrent(revision)
    }
    const saveTask = this.queue
      .catch(() => undefined)
      .then(() => task(request))
    this.queue = saveTask
    await saveTask
    return request.isCurrent()
  }

  async waitForIdle(): Promise<void> {
    let tail: Promise<void>
    do {
      tail = this.queue
      await tail.catch(() => undefined)
    } while (tail !== this.queue)
  }
}

// Keep unacknowledged edits across renders and page changes. Every queued payload
// includes earlier edits, so a failed write can be retried by the next edit too.
export function useQueuedDraftSave<Draft, Result>(options: {
  merge: (previous: Draft | undefined, update: Draft) => Draft
  persist: (draft: Draft) => Promise<Result>
  onSaved: (result: Result, draft: Draft) => void
  onError: (retry: () => void) => void
}) {
  const [draft, setDraft] = useState<Draft>()
  const draftRef = useRef<Draft | undefined>(undefined)
  const autosave = useQueuedAutosave()

  async function save(update: Draft): Promise<void> {
    const next = options.merge(draftRef.current, update)
    draftRef.current = next
    setDraft(next)
    const revision = autosave.revise('draft')
    await autosave.enqueue(revision, async (request) => {
      try {
        const result = await options.persist(next)
        if (!request.isCurrent()) return
        options.onSaved(result, next)
        draftRef.current = undefined
        setDraft(undefined)
      } catch {
        if (!request.isCurrent()) return
        options.onError(() => {
          if (draftRef.current !== undefined) void save(draftRef.current)
        })
      }
    })
  }

  // Structural actions call this after the queue is idle, to discard edits for
  // entities the user explicitly removed without dropping other failed edits.
  function discardPending(filter: (pending: Draft) => Draft | undefined): boolean {
    if (draftRef.current === undefined) return false
    const next = filter(draftRef.current)
    autosave.revise('draft')
    draftRef.current = next
    setDraft(next)
    return next !== undefined
  }

  return { draft, save, discardPending, waitForIdle: autosave.waitForIdle }
}

export function useQueuedAutosave(): {
  enqueue: (revision: AutosaveRevision, task: QueuedAutosaveTask) => Promise<boolean>
  isCurrent: (revision: AutosaveRevision) => boolean
  revise: (entityId: string) => AutosaveRevision
  waitForIdle: () => Promise<void>
} {
  const autosaveRef = useRef<QueuedAutosave | null>(null)
  if (!autosaveRef.current) autosaveRef.current = new QueuedAutosave()
  const autosave = autosaveRef.current

  const enqueue = useCallback(
    (revision: AutosaveRevision, task: QueuedAutosaveTask) => autosave.enqueue(revision, task),
    [autosave]
  )
  const isCurrent = useCallback(
    (revision: AutosaveRevision) => autosave.isCurrent(revision),
    [autosave]
  )
  const revise = useCallback(
    (entityId: string) => autosave.revise(entityId),
    [autosave]
  )
  const waitForIdle = useCallback(() => autosave.waitForIdle(), [autosave])

  return { enqueue, isCurrent, revise, waitForIdle }
}
