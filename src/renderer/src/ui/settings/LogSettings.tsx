import { FolderOpen } from 'lucide-react'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppSettings, RuntimeLogLevel } from '@shared/types'
import { CommitNumberInput } from '../CommitNumberInput'
import { clampIntegerInput } from '../numberInput'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { SETTINGS_COUNT_MIN, SETTINGS_LOG_RETENTION_DEFAULT_DAYS, SETTINGS_LOG_RETENTION_MAX_DAYS, UI_ICON_SIZE_MEDIUM } from '../uiConstants'
import { SettingsGroup } from './SettingsGroup'

const logLevelOptions: Array<{ value: RuntimeLogLevel; labelKey: string }> = [
  { value: 'trace', labelKey: 'settings.log_level_trace' },
  { value: 'debug', labelKey: 'settings.log_level_debug' },
  { value: 'info', labelKey: 'settings.log_level_info' },
  { value: 'warn', labelKey: 'settings.log_level_warn' },
  { value: 'error', labelKey: 'settings.log_level_error' },
  { value: 'off', labelKey: 'settings.log_level_off' }
]

interface LogSettingsProps {
  settings: AppSettings | undefined
  onChange: (settings: Partial<AppSettings>) => void | Promise<void>
  onOpenLogDirectory: () => void | Promise<void>
  onOpenRuntimeLogViewer: () => void | Promise<void>
}

export function LogSettings({ settings, onChange, onOpenLogDirectory, onOpenRuntimeLogViewer }: LogSettingsProps) {
  const { t } = useTranslation()
  const retentionId = useId()
  const logLevelPickerOptions = logLevelOptions.map((option) => ({
    value: option.value,
    label: t(option.labelKey)
  }))

  return (
    <SettingsGroup title={t('settings.logs')}>
        <div className="ui-form-row">
          <span>
            <strong>{t('settings.log_level')}</strong>
            <small>{t('settings.log_level_hint')}</small>
          </span>
          <SearchableOptionPicker
            ariaLabel={t('settings.log_level')}
            emptyLabel={t('settings.no_options')}
            options={logLevelPickerOptions}
            searchable={false}
            value={settings?.logLevel ?? 'info'}
            onChange={(logLevel) => void onChange({ logLevel: logLevel as RuntimeLogLevel })}
          />
        </div>
        <div className="ui-form-row">
          <label htmlFor={retentionId}>
            <strong>{t('settings.log_retention_days')}</strong>
            <small>{t('settings.log_retention_hint')}</small>
          </label>
          <CommitNumberInput
            id={retentionId}
            min={SETTINGS_COUNT_MIN}
            max={SETTINGS_LOG_RETENTION_MAX_DAYS}
            value={String(settings?.logRetentionDays ?? SETTINGS_LOG_RETENTION_DEFAULT_DAYS)}
            onCommit={(value) => void onChange({ logRetentionDays: clampIntegerInput(value, SETTINGS_COUNT_MIN, SETTINGS_LOG_RETENTION_MAX_DAYS) })}
          />
        </div>
        <div className="ui-section-header settings-action-row">
          <div>
            <div className="ui-field-label">{t('settings.log_files')}</div>
            <div className="ui-field-hint">{t('settings.log_files_hint')}</div>
          </div>
          <div className="ui-toolbar">
            <button className="ui-button ui-button-compact" type="button" onClick={() => void onOpenLogDirectory()}>
              <FolderOpen size={UI_ICON_SIZE_MEDIUM} />
              <span>{t('settings.open_log_folder')}</span>
            </button>
            <button className="ui-button ui-button-compact" type="button" onClick={() => void onOpenRuntimeLogViewer()}>
              {t('settings.open_log_viewer')}
            </button>
          </div>
        </div>
    </SettingsGroup>
  )
}
