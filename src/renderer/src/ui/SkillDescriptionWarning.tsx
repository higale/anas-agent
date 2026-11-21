import { useTranslation } from 'react-i18next'
import { SettingsStatusIndicator } from './settings/SettingsStatusIndicator'

/** Description length is advisory; it never changes Skill availability. */
export function SkillDescriptionWarning({ description = '' }: { description?: string }) {
  const { t } = useTranslation()
  const length = description.trim().length
  if (length <= 1024) return null
  const hint = t('settings.skill_description_too_long', { length })
  return <SettingsStatusIndicator label={hint} hint={hint} />
}
