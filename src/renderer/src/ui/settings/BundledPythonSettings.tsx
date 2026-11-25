import { useTranslation } from 'react-i18next'
import { SettingsGroup } from './SettingsGroup'

export function BundledPythonSettings() {
  const { t } = useTranslation()
  return <SettingsGroup title={t('settings.bundled_python')}>
    <div className="ui-field-hint">{t('settings.bundled_python_hint')}</div>
  </SettingsGroup>
}
