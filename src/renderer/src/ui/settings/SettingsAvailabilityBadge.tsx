import { useTranslation } from 'react-i18next'

export function SettingsAvailabilityBadge({ disabled, error = false }: { disabled: boolean; error?: boolean }) {
  const { t } = useTranslation()
  if (!disabled && !error) return null
  return <span className={`ui-list-item-badge${error ? ' ui-badge-danger' : ''}`}>
    {t(error ? 'settings.error' : 'settings.disabled')}
  </span>
}
