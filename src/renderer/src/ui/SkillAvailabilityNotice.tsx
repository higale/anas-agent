import { useTranslation } from 'react-i18next'

/** Only saved choices that conflict with global availability need a warning. */
export function SkillAvailabilityNotice({ skill, selected, subagent = false }: {
  skill?: { source?: string; modelAvailable?: boolean; userAvailable?: boolean }
  selected?: { model: boolean; shortcut: boolean }; subagent?: boolean
}) {
  const { t } = useTranslation()
  if (!skill || skill.source === 'project') return null
  const messages = [
    selected?.model && skill.modelAvailable === false && t('capabilities.skill_model_globally_off'),
    !subagent && selected?.shortcut && skill.userAvailable === false && t('capabilities.skill_user_globally_off')
  ].filter(Boolean)
  return messages.length ? <small role="alert" className="ui-field-hint ui-status-warning">{messages.join(' · ')}</small> : null
}
