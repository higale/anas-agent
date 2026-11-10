import { useTranslation } from 'react-i18next'
import type { SubagentConfig } from '@shared/types'
import { isSubagentConfigured, type SubagentSelection } from '@shared/subagentSelection'
import { CapabilitySection } from './CapabilitySection'
import { CapabilityResourceRow, CapabilityResourceToggle } from './CapabilityResource'

export interface SubagentSelectionProps {
  value: SubagentSelection
  definitions: readonly Pick<SubagentConfig, 'id' | 'name' | 'description' | 'systemPrompt' | 'enabled' | 'directory'>[]
  onChange(value: SubagentSelection): void
}

export function SubagentSelectionEditor({ value, definitions, onChange, disabled }: SubagentSelectionProps & {
  disabled: boolean
}) {
  const { t } = useTranslation()
  const items = [
    ...definitions.map((definition) => ({ ...definition, missing: false, status: !definition.enabled ? 'capabilities.inactive' : isSubagentConfigured(definition) ? undefined : 'capabilities.subagent_incomplete' })),
    ...value.names.filter((name) => !definitions.some((definition) => definition.name === name))
      .map((name) => ({ name, description: '', directory: undefined, missing: true, status: 'capabilities.deleted' }))
  ]
  const selected = new Set(value.names)
  return <div className="ui-form-section ui-form-section-divided">
    <CapabilitySection label={t('settings.capability_subagents')} customCount={items.filter(item => selected.has(item.name)).length} total={items.length} mode={value.mode === 'default' ? 'all' : value.mode} disabled={disabled} expandable
      onChange={mode => onChange({ ...value, mode: mode === 'all' ? 'default' : mode })}>
      <div className="ui-capability-list">
        {items.map((item) => <CapabilityResourceRow key={item.name} name={item.name} description={item.description} directory={item.directory}
          status={item.status && <span className="ui-badge">{t(item.status)}</span>}
          controls={<CapabilityResourceToggle label={item.name} enabled={value.mode === 'default' || (value.mode === 'custom' && selected.has(item.name))}
            disabled={disabled || value.mode !== 'custom' || (item.missing && !selected.has(item.name))}
            onChange={enabled => onChange({ ...value, names: enabled ? [...value.names, item.name] : value.names.filter(name => name !== item.name) })} />} />)}
        {!items.length && <small>{t('settings.no_options')}</small>}
      </div>
    </CapabilitySection>
  </div>
}
