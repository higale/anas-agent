import { FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { StorageUsageValue } from '@shared/types'
import { CheckboxButton } from '../CheckboxButton'
import { StorageUsageText } from '../StorageUsageText'
import { UI_ICON_SIZE_MEDIUM } from '../uiConstants'
import { SettingsGroup } from './SettingsGroup'

interface DeveloperHttpTraceSettingsProps {
  enabled: boolean
  storageUsageLoading: boolean
  usage?: StorageUsageValue
  onChange: (enabled: boolean) => void | Promise<void>
  onOpenDirectory: () => void | Promise<void>
}

export function DeveloperHttpTraceSettings({
  enabled,
  storageUsageLoading,
  usage,
  onChange,
  onOpenDirectory
}: DeveloperHttpTraceSettingsProps) {
  const { t } = useTranslation()

  return (
    <SettingsGroup title={t('settings.developer_diagnostics')}>
      <div className="ui-field-stack">
        <div className="ui-form-section-heading">
          <strong>{t('settings.developer_http_trace')}</strong>
          <CheckboxButton
            checked={enabled}
            label={t('settings.enabled')}
            onChange={(nextEnabled) => void onChange(nextEnabled)}
          />
        </div>
        <small className="ui-field-hint">{t('settings.developer_http_trace_hint')}</small>
      </div>
      <div className="ui-section-header settings-action-row">
        <div>
          <div className="ui-field-label">{t('settings.developer_http_trace_files')}</div>
          <div className="ui-field-hint">{t('settings.developer_http_trace_files_hint')}</div>
        </div>
        <div className="ui-row">
          <StorageUsageText loading={storageUsageLoading} usage={usage} />
          <button className="ui-button ui-button-compact" type="button" onClick={() => void onOpenDirectory()}>
            <FolderOpen size={UI_ICON_SIZE_MEDIUM} />
            <span>{t('settings.open_developer_http_trace_folder')}</span>
          </button>
        </div>
      </div>
    </SettingsGroup>
  )
}
