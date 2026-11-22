import { useTranslation } from 'react-i18next'
import type { SubagentConfig } from '@shared/types'
import { isSubagentConfigured, type SubagentSelection } from '@shared/subagentSelection'
import { CapabilitySection } from './CapabilitySection'
import { CapabilityResourceRow } from './CapabilityResource'

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
    ...definitions.map((definition) => ({ ...definition, missing: false, status: !definition.enabled ? 'capabilities.globally_disabled' : isSubagentConfigured(definition) ? undefined : 'capabilities.subagent_incomplete' })),
    ...value.names.filter((name) => !definitions.some((definition) => definition.name === name))
      .map((name) => ({ name, description: '', directory: undefined, missing: true, status: 'capabilities.deleted' }))
  ]
  const selected = new Set(value.mode === 'default' ? items.map(item => item.name) : value.mode === 'off' ? [] : value.names)
  return <div className="ui-form-section ui-form-section-divided">
    <CapabilitySection label={t('settings.capability_subagents')} selected={items.filter(item => selected.has(item.name)).length} total={items.length}
      mode={value.mode === 'default' ? 'all' : value.mode} disabled={disabled}
      onSelectionChange={checked => onChange({ ...value, names: checked ? items.filter(item => !item.missing || selected.has(item.name)).map(item => item.name) : [] })}
      onChange={mode => onChange({ ...value, mode: mode === 'all' ? 'default' : mode })}>
      <div className="ui-capability-list ui-grid-auto">
        {items.map((item) => <CapabilityResourceRow key={item.name} name={item.name} description={item.description} directory={item.directory}
          inactiveReason={item.status ? t(item.status) : undefined}
          label={item.name} enabled={selected.has(item.name)}
            disabled={disabled || (item.missing && !selected.has(item.name))}
            onChange={enabled => onChange({ mode: 'custom', names: enabled ? [...new Set([...selected, item.name])] : [...selected].filter(name => name !== item.name) })} />)}
        {!items.length && <small>{t('settings.no_options')}</small>}
      </div>
    </CapabilitySection>
  </div>
}
