import { useIconUpload } from '../useIconUpload'
import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { findModelTemplateIcon } from '@shared/modelTemplates'
import { UI_ICON_SIZE_TINY } from '../uiConstants'
import { ProviderIcon } from './ProviderIcon'

interface ProviderIconFieldProps {
  iconData: string
  baseUrl?: string
  onChange: (iconData: string) => void
}

export function ProviderIconField({ iconData, baseUrl, onChange }: ProviderIconFieldProps) {
  const { t } = useTranslation()
  const upload = useIconUpload(t('settings.provider_icon_edit'), onChange)

  return (
    <div className="provider-icon-field">
      {upload.fileInput}
      <div className="ui-corner-host ui-hover-reveal">
        <button
          className={`ui-avatar ui-avatar-lg ui-avatar-contain${upload.dragActive ? ' ui-avatar-active' : ''}`}
          type="button"
          aria-label={t('settings.provider_icon_edit')}
          data-tooltip={t('settings.provider_icon_edit')}
          {...upload.buttonProps}
        >
          <ProviderIcon iconData={iconData} size={32} />
        </button>
        {(iconData || baseUrl) && (
          <button
            className="ui-corner-action ui-hover-reveal-target ui-icon-button ui-icon-button-xs ui-button-danger"
            type="button"
            aria-label={t('settings.provider_icon_remove')}
            data-tooltip={t('settings.provider_icon_remove')}
            onClick={() => {
              upload.cancelUpload()
              onChange(findModelTemplateIcon(baseUrl ?? '') ?? '')
            }}
          >
            <Trash2 size={UI_ICON_SIZE_TINY} />
          </button>
        )}
      </div>
    </div>
  )
}
