import { useCallback, useRef, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { SelectedAttachment } from '@shared/types'
import type { AgentAccessMode } from '@shared/agentTypes'

export interface ComposerDraft {
  input: string
  attachments: SelectedAttachment[]
  accessMode: AgentAccessMode
}

type StoredComposerDraft = Omit<ComposerDraft, 'accessMode'> & { accessMode?: AgentAccessMode }

const emptyDraft = (): StoredComposerDraft => ({
  input: '',
  attachments: []
})

function isEmptyDraft(draft: StoredComposerDraft): boolean {
  return draft.input.length === 0
    && draft.attachments.length === 0
    && draft.accessMode === undefined
}

export function threadComposerDraftKey(threadId: string): string {
  return `thread:${threadId}`
}

export function newThreadComposerDraftKey(projectId: string): string {
  return `new-thread:project:${projectId}`
}

export class ComposerDraftStore {
  private readonly drafts = new Map<string, StoredComposerDraft>()

  get(key: string, defaultAccessMode: AgentAccessMode = 'read_only_allowed'): ComposerDraft {
    const draft = this.drafts.get(key) ?? emptyDraft()
    return { ...draft, accessMode: draft.accessMode ?? defaultAccessMode }
  }

  setInput(key: string, input: string): void {
    this.write(key, { ...(this.drafts.get(key) ?? emptyDraft()), input })
  }

  setAttachments(key: string, attachments: SelectedAttachment[]): void {
    this.write(key, { ...(this.drafts.get(key) ?? emptyDraft()), attachments })
  }

  setAccessMode(key: string, accessMode: AgentAccessMode): void {
    this.write(key, { ...this.get(key), accessMode })
  }

  discard(key: string): ComposerDraft | undefined {
    const draft = this.drafts.get(key)
    if (!draft) return undefined
    this.drafts.delete(key)
    return { ...draft, accessMode: draft.accessMode ?? 'read_only_allowed' }
  }

  discardMany(keys: Iterable<string>): ComposerDraft[] {
    const discarded: ComposerDraft[] = []
    for (const key of new Set(keys)) {
      const draft = this.discard(key)
      if (draft) discarded.push(draft)
    }
    return discarded
  }

  private write(key: string, draft: StoredComposerDraft): void {
    if (isEmptyDraft(draft)) {
      this.drafts.delete(key)
      return
    }
    this.drafts.set(key, draft)
  }
}

export function useComposerDrafts(activeKey: string, defaultAccessMode: AgentAccessMode = 'read_only_allowed') {
  const storeRef = useRef<ComposerDraftStore | null>(null)
  const [, setRevision] = useState(0)
  if (!storeRef.current) storeRef.current = new ComposerDraftStore()
  const store = storeRef.current
  const draft = store.get(activeKey, defaultAccessMode)

  const update = useCallback((action: () => void): void => {
    action()
    setRevision((current) => current + 1)
  }, [])

  const setInput = useCallback<Dispatch<SetStateAction<string>>>((value) => {
    update(() => {
      const current = store.get(activeKey).input
      store.setInput(activeKey, typeof value === 'function' ? value(current) : value)
    })
  }, [activeKey, store, update])

  const setAttachments = useCallback<Dispatch<SetStateAction<SelectedAttachment[]>>>((value) => {
    update(() => {
      const current = store.get(activeKey).attachments
      store.setAttachments(activeKey, typeof value === 'function' ? value(current) : value)
    })
  }, [activeKey, store, update])

  const setAccessMode = useCallback((accessMode: AgentAccessMode): void => {
    update(() => store.setAccessMode(activeKey, accessMode))
  }, [activeKey, store, update])

  const discardDrafts = useCallback((keys: Iterable<string>): ComposerDraft[] => {
    const discarded = store.discardMany(keys)
    if (discarded.length > 0) setRevision((current) => current + 1)
    return discarded
  }, [store])

  return {
    attachments: draft.attachments,
    discardDrafts,
    accessMode: draft.accessMode,
    input: draft.input,
    setAttachments,
    setAccessMode,
    setInput
  }
}
