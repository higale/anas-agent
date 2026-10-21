import { useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type { AppConfigSnapshot } from '@shared/types'
import type { ConfirmDialogRequest } from '../dialogs/AppDialogs'
import { notice } from '../notice'
import { scrollListToBottom } from '../chat/scrollUtils'
import { useQueuedAutosave } from '../useQueuedAutosave'
import {
  createSubagentDraft,
  subagentSavePayload,
  subagentToDraft,
  validateSubagentForEnable,
  validateSubagentName,
  type SubagentDraft
} from './subagentDraft'

interface UseSubagentSettingsStateOptions {
  config: AppConfigSnapshot | undefined
  openConfirmDialog: (request: ConfirmDialogRequest) => void
  setConfig: (config: AppConfigSnapshot) => void
  t: TFunction
}

export function useSubagentSettingsState({
  config,
  openConfirmDialog,
  setConfig,
  t
}: UseSubagentSettingsStateOptions) {
  const [editingIndex, setEditingIndex] = useState<number | undefined>()
  const [draft, setDraft] = useState<SubagentDraft>(() => createSubagentDraft(config, t))
  const [creating, setCreating] = useState(false)
  const draftRef = useRef(draft)
  const listRef = useRef<HTMLDivElement | null>(null)
  const autosave = useQueuedAutosave()
  const additions = useQueuedAutosave()
  const creationRef = useRef<{ index?: number }>({})
  const saveFailed = useRef(false)
  const configRef = useRef(config)
  configRef.current = config
  const noticeId = 'settings-subagent'

  useEffect(() => {
    if (!config) return
    const selected = draftRef.current.id ? config.subagents.find(a => a.id === draftRef.current.id)
      : config.subagents.find(a => a.index === editingIndex)
    if (selected) {
      if (selected.index !== editingIndex) setEditingIndex(selected.index)
      if (draftRef.current.index !== selected.index) {
        const next = subagentToDraft(selected)
        draftRef.current = next
        setDraft(next)
      }
      return
    }
    if (creating) return
    const first = config.subagents[0]
    if (first) {
      setEditingIndex(first.index)
    } else {
      const next = createSubagentDraft(config, t)
      draftRef.current = next
      setDraft(next)
      setEditingIndex(undefined)
    }
  }, [config, creating, editingIndex, t])

  async function saveImmediately(nextDraft: SubagentDraft): Promise<void> {
    const creation = creationRef.current
    const revision = autosave.revise(nextDraft.index === undefined
      ? 'subagent:new'
      : `subagent:${nextDraft.index}`)
    await autosave.enqueue(revision, async (request) => {
      try {
        const nextConfig = await window.gale.config.saveSubagent(
          subagentSavePayload({ ...nextDraft, index: nextDraft.index ?? creation.index })
        )
        if (nextDraft.index === undefined) creation.index ??= nextConfig.subagents.at(-1)?.index
        if (!request.isCurrent()) return
        saveFailed.current = false
        notice.dismiss(noticeId)
        configRef.current = nextConfig
        setConfig(nextConfig)
        if (nextDraft.index === undefined) {
          const created = nextConfig.subagents.at(-1)
          if (created) {
            setEditingIndex(created.index)
            const savedDraft = subagentToDraft(created)
            draftRef.current = savedDraft
            setDraft(savedDraft)
            window.requestAnimationFrame(() => scrollListToBottom(listRef.current))
          }
        }
        setCreating(false)
      } catch {
        if (!request.isCurrent()) return
        saveFailed.current = true
        notice.error(
          t('settings.subagent_failed_save'),
          { id: noticeId, duration: Infinity,
            action: { label: t('common.retry'), onClick: () => { if (request.isCurrent()) void saveImmediately(draftRef.current) } } }
        )
      }
    })
  }

  function updateDraft(update: Partial<SubagentDraft>): void {
    const next = {
      ...draftRef.current,
      ...update
    }
    const nameError = validateSubagentName(next, config?.subagents, t)
    if (nameError) {
      notice.error(nameError, { id: noticeId })
      return
    }
    if (update.enabled === true) {
      const enableError = validateSubagentForEnable(next, t)
      if (enableError) {
        notice.error(enableError, { id: noticeId })
        return
      }
    }
    draftRef.current = next
    setDraft(next)
    void saveImmediately(next)
  }

  async function addSubagent(): Promise<void> {
    await additions.enqueue(additions.revise('add'), async () => {
      await autosave.waitForIdle()
      if (saveFailed.current) return
      creationRef.current = {}
      const next = createSubagentDraft(configRef.current, t)
      draftRef.current = next
      setCreating(true)
      setEditingIndex(undefined)
      setDraft(next)
      await saveImmediately(next)
    })
  }

  async function editSubagent(index: number): Promise<void> {
    await additions.waitForIdle()
    await autosave.waitForIdle()
    if (saveFailed.current) throw new Error(t('settings.subagent_failed_save'))
    const selected = configRef.current?.subagents.find((subagent) => subagent.index === index)
    if (!selected) return
    const next = subagentToDraft(selected)
    draftRef.current = next
    setCreating(false)
    setEditingIndex(index)
    setDraft(next)
  }

  function deleteSubagent(): void {
    const selected = config?.subagents.find((subagent) => subagent.index === editingIndex)
    if (!selected || selected.builtIn) return
    openConfirmDialog({
      title: t('settings.subagent_delete_title', { name: selected.name }),
      description: t('settings.cannot_be_undone'),
      confirmText: t('common.delete'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          await additions.waitForIdle()
          await autosave.waitForIdle()
          const nextConfig = await window.gale.config.deleteSubagent(selected.id ?? selected.index)
          saveFailed.current = false
          notice.dismiss(noticeId)
          configRef.current = nextConfig
          setConfig(nextConfig)
          const next = nextConfig.subagents[Math.min(selected.index, nextConfig.subagents.length - 1)]
          setEditingIndex(next?.index)
          draftRef.current = next ? subagentToDraft(next) : createSubagentDraft(nextConfig, t)
          setDraft(draftRef.current)
          setCreating(false)
        } catch {
          notice.error(
            t('settings.subagent_failed_delete'),
            { id: noticeId }
          )
        }
      }
    })
  }

  async function moveSubagent(direction: -1 | 1): Promise<void> {
    if (editingIndex === undefined) return
    const index = editingIndex
    try {
      await additions.waitForIdle()
      await autosave.waitForIdle()
      if (saveFailed.current) return
      const id = configRef.current?.subagents.find(a => a.index === index)?.id
      const nextConfig = await window.gale.config.moveSubagent(id ?? index, direction)
      const nextIndex = nextConfig.subagents.find(a => a.id === id)?.index ?? index
      configRef.current = nextConfig
      setConfig(nextConfig)
      setEditingIndex(nextConfig.subagents[nextIndex]?.index ?? index)
      setCreating(false)
    } catch {
      notice.error(
        t('settings.subagent_failed_move'),
        { id: noticeId }
      )
    }
  }

  async function refreshSubagents(importPackage = false): Promise<void> {
    await additions.waitForIdle()
    await autosave.waitForIdle()
    if (saveFailed.current) throw new Error(t('settings.subagent_failed_save'))
    const currentId = draftRef.current.id
    const previousIds = new Set(configRef.current?.subagents.map(a => a.id))
    const nextConfig = importPackage ? await window.gale.config.importSubagentPackage() : await window.gale.config.get()
    if (!nextConfig) return
    configRef.current = nextConfig
    setConfig(nextConfig)
    const selected = (importPackage ? nextConfig.subagents.find(a => !previousIds.has(a.id)) : undefined)
      ?? nextConfig.subagents.find(a => a.id === currentId) ?? nextConfig.subagents[0]
    setEditingIndex(selected?.index)
    draftRef.current = selected ? subagentToDraft(selected) : createSubagentDraft(nextConfig, t)
    setDraft(draftRef.current)
    if (importPackage) notice.success(t('settings.subagents_imported', { count: nextConfig.subagents.filter(a => !previousIds.has(a.id)).length }), { id: noticeId })
  }

  return {
    refreshSubagents,
    addSubagent,
    deleteSubagent,
    draft,
    editSubagent,
    editingIndex,
    listRef,
    moveSubagent,
    updateDraft
  }
}
