import { useTranslation } from 'react-i18next'
import type { DefaultCapabilitySettings } from '@shared/agentCapabilities'
import type { AppConfigSnapshot, McpToolStatus, RuntimeToolStatus, SkillSnapshot } from '@shared/types'
import { CapabilityEditor } from '../CapabilityEditor'
import { CheckboxField } from '../CheckboxField'

interface Props {
  config: Pick<AppConfigSnapshot, 'defaultCapabilities' | 'subagents' | 'mcpServers' | 'customTools'>
  skills?: SkillSnapshot
  mcpStatus?: McpToolStatus
  runtimeToolStatus?: RuntimeToolStatus
  onSave: (value: DefaultCapabilitySettings) => void | Promise<void>
}

export function CapabilitySettings({ config, skills, mcpStatus, runtimeToolStatus, onSave }: Props) {
  const { t } = useTranslation()
  const value = config.defaultCapabilities
  function save(update: Partial<DefaultCapabilitySettings>) {
    void onSave({ ...value, ...update })
  }
  return (
    <CapabilityEditor customTools={config.customTools} value={value.capabilities} skills={skills} mcpStatus={mcpStatus}
      mcpServers={config.mcpServers} runtimeToolStatus={runtimeToolStatus}
      subagents={config.subagents}
      toolbarEnd={<CheckboxField className="ui-checkbox-field-inline" checked={value.restrictSubagents}
        label={t('capabilities.restrict_subagents')} tooltip={t('capabilities.restrict_subagents_hint')}
        onChange={(restrictSubagents) => void save({ restrictSubagents })} />}
      onEnableAll={(capabilities) => void save({ capabilities, restrictSubagents: false })}
      onChange={(capabilities) => void save({ capabilities })} />
  )
}
