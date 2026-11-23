import { useId, useState } from 'react'
import { FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppSettings, SpeechReplyConfig } from '@shared/types'
import { normalizeChatContentWidth } from '@shared/uiPreferences'
import { CommitNumberInput } from '../CommitNumberInput'
import { clampIntegerInput } from '../numberInput'
import { SpeechReplySettings } from '../speech/SpeechReplySettings'
import {
  SETTINGS_COUNT_MIN,
  SETTINGS_MAX_MODEL_CALLS,
  SETTINGS_MAX_MODEL_CALLS_DEFAULT
} from '../uiConstants'
import { AttachmentSettings } from './AttachmentSettings'
import { SettingsGroup } from './SettingsGroup'
import { SegmentedControl } from '../SegmentedControl'
import { unwrapProjectResult } from '@shared/projectOperation'
import { projectErrorDescription } from '../projects/projectErrorDescription'
import { notice } from '../notice'

interface ChatModeSettingsProps {
  settings: AppSettings | undefined
  speechReply?: SpeechReplyConfig
  onChange: (settings: Partial<AppSettings>) => void | Promise<void>
  onSpeechReplyChange: (settings: Partial<SpeechReplyConfig>) => void | Promise<void>
}

export function ChatModeSettings({ settings, speechReply, onChange, onSpeechReplyChange }: ChatModeSettingsProps) {
  const { t } = useTranslation()
  const maxCallsId = useId()
  const directoryId = useId()
  const [choosingDirectory, setChoosingDirectory] = useState(false)
  const maxModelCallsPerRun = settings?.maxModelCallsPerRun ?? SETTINGS_MAX_MODEL_CALLS_DEFAULT

  async function chooseProjectDirectory(): Promise<void> {
    setChoosingDirectory(true)
    try {
      const folders = unwrapProjectResult(await window.gale.projects.chooseSourceFolders(false))
      if (folders.length) await onChange({ projectDefaultDirectory: folders[0] })
    } catch (error) {
      notice.error(t('project.failed_choose_folders'), { description: projectErrorDescription(error, t) })
    } finally { setChoosingDirectory(false) }
  }

  return (
    <div className="settings-page-groups">
      <SettingsGroup title={t('settings.tabs.general')}>
        <div className="ui-form-row">
          <label htmlFor={directoryId}>
            <strong>{t('settings.project_default_directory')}</strong>
            <small>{t('settings.project_default_directory_hint')}</small>
          </label>
          <div className="ui-input-action">
            <input id={directoryId} className="ui-input" value={settings?.projectDefaultDirectory ?? ''}
              onChange={event => void onChange({ projectDefaultDirectory: event.target.value })}
              placeholder={t('settings.documents_directory')} title={settings?.projectDefaultDirectory || t('settings.documents_directory')} />
            <button type="button" className="ui-tool-button" disabled={choosingDirectory}
              aria-label={t('settings.choose_project_default_directory')} data-tooltip={t('settings.choose_project_default_directory')}
              onClick={() => void chooseProjectDirectory()}><FolderOpen size={16} /></button>
          </div>
        </div>
        <div className="ui-form-row ui-form-row-narrow">
          <label htmlFor={maxCallsId}>
            <strong>{t('settings.max_model_calls_per_run')}</strong>
            <small>{t('settings.max_model_calls_per_run_hint')}</small>
          </label>
          <CommitNumberInput
            id={maxCallsId}
            min={SETTINGS_COUNT_MIN}
            max={SETTINGS_MAX_MODEL_CALLS}
            placeholder={t('settings.max_model_calls_unlimited')}
            value={maxModelCallsPerRun === 0 ? '' : String(maxModelCallsPerRun)}
            normalizeDraft={(value) => value === '0' ? '' : value}
            onDraftChange={(value) => {
              if (value === '' && maxModelCallsPerRun !== 0) void onChange({ maxModelCallsPerRun: 0 })
            }}
            onCommit={(value) => void onChange({
              maxModelCallsPerRun: clampIntegerInput(
                value,
                SETTINGS_COUNT_MIN,
                SETTINGS_MAX_MODEL_CALLS
              )
            })}
          />
        </div>
      </SettingsGroup>
      <SettingsGroup title={t('settings.chat_display')}>
        <div className="ui-form-row ui-form-row-narrow ui-form-row-fit-control">
          <span>
            <strong>{t('settings.chat_content_width')}</strong>
            <small>{t('settings.chat_content_width_hint')}</small>
          </span>
          <SegmentedControl<AppSettings['chatContentWidth']>
            ariaLabel={t('settings.chat_content_width')}
            minWidth="var(--settings-control-width-narrow-preferred)"
            options={[
              { value: 'narrow', label: t('settings.chat_content_width_narrow') },
              { value: 'wide', label: t('settings.chat_content_width_wide') },
              { value: 'adaptive', label: t('settings.chat_content_width_adaptive') }
            ]}
            value={normalizeChatContentWidth(settings?.chatContentWidth)}
            onChange={chatContentWidth => void onChange({ chatContentWidth })}
          />
        </div>
        <div className="ui-form-row ui-form-row-narrow ui-form-row-fit-control">
          <span>
            <strong>{t('settings.running_process_display')}</strong>
            <small>{t('settings.running_process_display_hint')}</small>
          </span>
          <SegmentedControl
            ariaLabel={t('settings.running_process_display')}
            minWidth="var(--settings-control-width-narrow-preferred)"
            options={[{ value: 'expanded', label: t('settings.process_expanded') }, { value: 'collapsed', label: t('settings.process_collapsed') }]}
            value={settings?.runningProcessDisplay ?? 'expanded'}
            onChange={runningProcessDisplay => void onChange({ runningProcessDisplay })}
          />
        </div>
        <div className="ui-form-row ui-form-row-narrow ui-form-row-fit-control">
          <span>
            <strong>{t('settings.show_model_rounds')}</strong>
            <small>{t('settings.show_model_rounds_hint')}</small>
          </span>
          <SegmentedControl
            ariaLabel={t('settings.show_model_rounds')}
            minWidth="var(--settings-control-width-narrow-preferred)"
            options={[{ value: 'show', label: t('settings.model_rounds_show') }, { value: 'hide', label: t('settings.model_rounds_hide') }]}
            value={(settings?.showModelRounds ?? true) ? 'show' : 'hide'}
            onChange={value => void onChange({ showModelRounds: value === 'show' })}
          />
        </div>
      </SettingsGroup>
      <SpeechReplySettings value={speechReply} onChange={onSpeechReplyChange} />
      <AttachmentSettings settings={settings} onChange={onChange} />
    </div>
  )
}
