import type { DefaultCapabilitySettings } from '@shared/agentCapabilities'
import { useMemo, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { TFunction } from 'i18next'
import type { AppConfigSnapshot, AppProfileUpdate, AppSettings, SpeechReplyConfig } from '@shared/types'
import { applyLanguagePreference } from '../../i18n'
import { notice } from '../notice'
import { useQueuedDraftSave } from '../useQueuedAutosave'
import type { SettingsTab } from './settingsTabs'

type CanLeaveSettingsTab = () => boolean | Promise<boolean>

interface UseSettingsControllerOptions {
  config?: AppConfigSnapshot
  setConfig: Dispatch<SetStateAction<AppConfigSnapshot | undefined>>
  t: TFunction
}

export function useSettingsController({ config, setConfig, t }: UseSettingsControllerOptions) {
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('general')
  function reportFailure(key: string, id: string, retry: () => void) {
    notice.error(t(key), { id, duration: Infinity, action: { label: t('common.retry'), onClick: retry } })
  }

  const settingsSave = useQueuedDraftSave<Partial<AppSettings>, AppConfigSnapshot>({
    merge: (previous, update) => ({ ...previous, ...update }),
    persist: (draft) => window.gale.config.updateSettings(draft),
    onSaved: (result, draft) => {
      const saved = Object.fromEntries(Object.keys(draft).map((key) => [key, result.settings[key as keyof AppSettings]]))
      setConfig((current) => current ? { ...current, settings: { ...current.settings, ...saved } } : result)
      notice.dismiss('settings-save')
    },
    onError: (retry) => reportFailure('chat.failed_save_settings', 'settings-save', retry)
  })
  const capabilitiesSave = useQueuedDraftSave<DefaultCapabilitySettings, AppConfigSnapshot>({
    merge: (_previous, update) => update,
    persist: (draft) => window.gale.config.saveDefaultCapabilities(draft),
    onSaved: (result) => {
      setConfig((current) => current ? { ...current, defaultCapabilities: result.defaultCapabilities } : result)
      notice.dismiss('capabilities-save')
    },
    onError: (retry) => reportFailure('chat.failed_save_settings', 'capabilities-save', retry)
  })
  const profileSave = useQueuedDraftSave<AppProfileUpdate, AppConfigSnapshot>({
    merge: (previous, update) => ({
      assistant: { ...previous?.assistant, ...update.assistant },
      user: { ...previous?.user, ...update.user }
    }),
    persist: (draft) => window.gale.config.updateProfile(draft),
    onSaved: (result) => {
      setConfig((current) => current ? { ...current, settings: { ...current.settings, profile: result.settings.profile } } : result)
      notice.dismiss('profile-save')
    },
    onError: (retry) => reportFailure('chat.failed_save_profile', 'profile-save', retry)
  })
  const speechSave = useQueuedDraftSave<Partial<SpeechReplyConfig>, AppConfigSnapshot>({
    merge: (previous, update) => ({ ...previous, ...update }),
    persist: (draft) => window.gale.config.updateSpeechReply(draft),
    onSaved: (result) => {
      setConfig((current) => current ? { ...current, settings: { ...current.settings, speechReply: result.settings.speechReply } } : result)
      notice.dismiss('speech-save')
    },
    onError: (retry) => reportFailure('chat.failed_save_speech', 'speech-save', retry)
  })
  const displayConfig = useMemo(() => config ? {
    ...config,
    defaultCapabilities: capabilitiesSave.draft ?? config.defaultCapabilities,
    settings: {
      ...config.settings,
      ...settingsSave.draft,
      profile: profileSave.draft ? {
        assistant: { ...config.settings.profile.assistant, ...profileSave.draft.assistant },
        user: { ...config.settings.profile.user, ...profileSave.draft.user }
      } : config.settings.profile,
      speechReply: speechSave.draft ? { ...config.settings.speechReply, ...speechSave.draft } : config.settings.speechReply
    }
  } : undefined, [config, capabilitiesSave.draft, settingsSave.draft, profileSave.draft, speechSave.draft])

  async function switchSettingsTab(tab: SettingsTab, canLeave?: CanLeaveSettingsTab): Promise<void> {
    if (tab === settingsTab) return
    if (canLeave && !(await canLeave())) return
    setSettingsTab(tab)
  }

  async function closeSettings(canLeave?: CanLeaveSettingsTab): Promise<void> {
    if (canLeave && !(await canLeave())) return
    setSettingsOpen(false)
  }

  async function saveLanguage(language: string): Promise<void> {
    await Promise.all([applyLanguagePreference(language), settingsSave.save({ language })])
  }

  async function saveProfile(update: AppProfileUpdate): Promise<void> {
    if (update.assistant?.name !== undefined && !update.assistant.name.trim()) {
      notice.error(t('settings.assistant_name_required'))
      return
    }
    await profileSave.save(update)
  }

  return {
    closeSettings,
    config: displayConfig,
    saveLanguage,
    saveProfile,
    saveSettings: settingsSave.save,
    saveDefaultCapabilities: capabilitiesSave.save,
    saveSpeechReply: speechSave.save,
    setSettingsOpen,
    setSettingsTab,
    settingsOpen,
    settingsTab,
    switchSettingsTab
  }
}
