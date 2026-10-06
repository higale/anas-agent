import { useCallback, useEffect, useRef, useState } from 'react'
import type { TFunction } from 'i18next'
import type { SkillAvailabilityUpdate, SkillImportError, SkillRootSummary, SkillRootUpdate, SkillSnapshot } from '@shared/types'
import type { ConfirmDialogRequest } from '../dialogs/AppDialogs'
import { notice } from '../notice'
import { useQueuedDraftSave } from '../useQueuedAutosave'
import type { SettingsTab } from './settingsTabs'

interface Options {
  openConfirmDialog: (request: ConfirmDialogRequest) => void
  settingsOpen: boolean
  settingsTab: SettingsTab
  t: TFunction
}

interface SkillEdits {
  scriptAutoApprove?: boolean
  skills?: Record<string, SkillAvailabilityUpdate & { scriptAutoApprove?: boolean }>
}

function skillImportErrorText(t: TFunction, error: SkillImportError): string {
  if (error.code === 'already_exists') return t('settings.skill_import_error_already_exists', { name: error.name })
  if (error.code === 'invalid_directory') return t('settings.skill_import_error_invalid_directory')
  if (error.code === 'invalid_skill') {
    const reason = t(`settings.skill_issue_${error.issue.code}`, {
      name: error.issue.name ?? '',
      expected: error.issue.expected ?? ''
    })
    return t('settings.skill_import_error_invalid_skill', {
      reason: error.issue.detail ? `${reason} ${error.issue.detail}` : reason
    })
  }
  return t('settings.failed_import_skill')
}

export function useSkillsSettingsState({ openConfirmDialog, settingsOpen, settingsTab, t }: Options) {
  const [savedSkills, setSavedSkills] = useState<SkillSnapshot>()
  const snapshotRevision = useRef(0)
  const noticeId = 'settings-skill-status'
  function setSkills(snapshot: SkillSnapshot) {
    snapshotRevision.current++
    setSavedSkills(snapshot)
  }
  const edits = useQueuedDraftSave<SkillEdits, SkillSnapshot>({
    merge: (previous, update) => {
      const skills = { ...previous?.skills }
      for (const [id, patch] of Object.entries(update.skills ?? {})) skills[id] = { ...skills[id], ...patch }
      return { ...previous, ...update, skills }
    },
    persist: async (draft) => {
      let result: SkillSnapshot | undefined
      if (draft.scriptAutoApprove !== undefined) {
        result = await window.gale.skills.updateScriptApproval(undefined, undefined, draft.scriptAutoApprove)
      }
      for (const [id, { scriptAutoApprove, ...availability }] of Object.entries(draft.skills ?? {})) {
        if (Object.keys(availability).length) result = await window.gale.skills.updateAvailability(undefined, id, availability)
        if (scriptAutoApprove !== undefined) result = await window.gale.skills.updateScriptApproval(undefined, id, scriptAutoApprove)
      }
      return result ?? await window.gale.skills.get()
    },
    onSaved: (snapshot) => { setSkills(snapshot); notice.dismiss(noticeId) },
    onError: (retry) => notice.error(t('settings.failed_save_skill'), {
      id: noticeId, duration: Infinity, action: { label: t('common.retry'), onClick: retry }
    })
  })
  const skills = savedSkills && edits.draft ? {
    ...savedSkills,
    scriptAutoApprove: edits.draft.scriptAutoApprove ?? savedSkills.scriptAutoApprove,
    skills: savedSkills.skills.map((skill) => ({ ...skill, ...edits.draft?.skills?.[skill.id] }))
  } : savedSkills
  const refreshSkills = useCallback(async (): Promise<void> => {
    const revision = ++snapshotRevision.current
    try {
      const snapshot = await window.gale.skills.get()
      if (revision === snapshotRevision.current) setSavedSkills(snapshot)
    } catch {
      notice.error(t('chat.failed_load_skill'), { id: noticeId })
    }
  }, [t])

  useEffect(() => {
    void refreshSkills()
  }, [refreshSkills])

  useEffect(() => {
    if (settingsOpen && settingsTab === 'skills') void refreshSkills()
  }, [refreshSkills, settingsOpen, settingsTab])

  async function addDirectory(): Promise<void> {
    try {
      await edits.waitForIdle()
      const result = await window.gale.skills.addDirectory()
      if (result.status === 'added') setSkills(result.snapshot)
    } catch {
      notice.error(t('settings.failed_add_skill_directory'), { id: noticeId })
    }
  }

  async function importDirectories(): Promise<void> {
    try {
      await edits.waitForIdle()
      const result = await window.gale.skills.importDirectories()
      if (result.status === 'cancelled') return
      if (result.status === 'error') {
        notice.error(skillImportErrorText(t, result.error), { id: noticeId })
        return
      }
      setSkills(result.snapshot)
      notice.success(t('settings.skills_imported', { count: result.names.length }), { id: noticeId })
    } catch {
      notice.error(t('settings.failed_import_skill'), { id: noticeId })
    }
  }

  function removeDirectory(root: SkillRootSummary): void {
    if (!root.removable) return
    openConfirmDialog({
      title: t('settings.remove_skill_directory_title', { name: root.name }),
      description: t('settings.remove_skill_directory_description'),
      confirmText: t('common.remove'),
      variant: 'danger',
      onConfirm: async () => {
        try {
          await edits.waitForIdle()
          const snapshot = await window.gale.skills.removeDirectory(undefined, root.id)
          const remaining = new Set(snapshot.skills.map((skill) => skill.id))
          const hasPendingEdits = edits.discardPending((draft) => {
            const skills = Object.fromEntries(Object.entries(draft.skills ?? {}).filter(([id]) => remaining.has(id)))
            return draft.scriptAutoApprove === undefined && Object.keys(skills).length === 0
              ? undefined : { ...draft, skills }
          })
          if (!hasPendingEdits) notice.dismiss(noticeId)
          setSkills(snapshot)
        } catch {
          notice.error(t('settings.failed_remove_skill_directory'), { id: noticeId })
        }
      }
    })
  }

  async function moveDirectory(rootId: string, direction: -1 | 1): Promise<void> {
    try {
      await edits.waitForIdle()
      setSkills(await window.gale.skills.moveDirectory(undefined, rootId, direction))
    } catch {
      notice.error(t('settings.failed_move_skill_directory'), { id: noticeId })
    }
  }

  async function updateDirectory(rootId: string, update: SkillRootUpdate): Promise<void> {
    try {
      setSkills(await window.gale.skills.updateDirectory(undefined, rootId, update))
    } catch {
      notice.error(t('settings.failed_update_skill_directory'), { id: noticeId })
    }
  }

  async function updateAvailability(skillId: string, update: SkillAvailabilityUpdate): Promise<void> {
    await edits.save({ skills: { [skillId]: update } })
  }

  async function updateScriptApproval(skillId: string | undefined, enabled: boolean): Promise<void> {
    await edits.save(skillId === undefined
      ? { scriptAutoApprove: enabled }
      : { skills: { [skillId]: { scriptAutoApprove: enabled } } })
  }

  return {
    updateScriptApproval,
    addDirectory,
    importDirectories,
    moveDirectory,
    refreshSkills,
    removeDirectory,
    skills,
    updateDirectory,
    updateAvailability
  }
}
