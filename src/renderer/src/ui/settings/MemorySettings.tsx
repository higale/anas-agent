import { useTranslation } from 'react-i18next'
import { PreferenceMemoryDocument } from '../PreferenceMemoryDocument'
import { SettingsGroup } from './SettingsGroup'

export function MemorySettings({ sectionClass }: { sectionClass: string }) {
  const { t } = useTranslation()
  return <section className={`${sectionClass} settings-memory`}>
    <SettingsGroup className="settings-global-memory" title={t('settings.memory_global')} description={t('settings.memory_global_hint')}>
      <PreferenceMemoryDocument />
    </SettingsGroup>
  </section>
}
