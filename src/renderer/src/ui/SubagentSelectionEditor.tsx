import { useTranslation } from 'react-i18next'
import type { SubagentConfig } from '@shared/types'
import { isSubagentConfigured, selectedSubagents, type SubagentSelection } from '@shared/subagentSelection'
import { CheckboxField } from './CheckboxField'
import { CapabilitySection } from './CapabilitySection'

export interface SubagentSelectionProps {
  value: SubagentSelection
  definitions: readonly Pick<SubagentConfig, 'name' | 'description' | 'systemPrompt' | 'enabled'>[]
  onChange(value: SubagentSelection): void
}

export function SubagentSelectionEditor({ value, definitions, onChange, disabled }: SubagentSelectionProps & {
  disabled: boolean
}) {
  const { t } = useTranslation()
  const items = [
    ...definitions.map((definition) => ({ ...definition, missing: false, status: !definition.enabled ? 'capabilities.inactive' : isSubagentConfigured(definition) ? undefined : 'capabilities.subagent_incomplete' })),
    ...value.names.filter((name) => !definitions.some((definition) => definition.name === name))
      .map((name) => ({ name, description: '', missing: true, status: 'capabilities.deleted' }))
  ]
  const selected = new Set(value.names)
  const count = selectedSubagents(definitions, value).length
  return <div className="ui-form-section ui-form-section-divided">
    <CapabilitySection label={t('settings.capability_subagents')} count={count} mode={value.mode === 'default' ? 'all' : value.mode} disabled={disabled}
      onChange={mode => onChange({ ...value, mode: mode === 'all' ? 'default' : mode })}>
    {value.mode === 'custom' && <fieldset className="ui-capability-editor" disabled={disabled}>
      <div className="ui-capability-list">
        {items.map((item) => <CheckboxField key={item.name} className="ui-checkbox-field-inline"
          checked={selected.has(item.name)} disabled={disabled || (item.missing && !selected.has(item.name))} aria-label={item.name} tooltip={item.description || undefined}
          label={<span className="ui-row"><code>{item.name}</code>{item.status && <span className="ui-badge">{t(item.status)}</span>}</span>}
          onChange={(checked) => onChange({ ...value, names: checked ? [...value.names, item.name] : value.names.filter((name) => name !== item.name) })} />)}
        {!items.length && <small>{t('settings.no_options')}</small>}
      </div>
    </fieldset>}
    </CapabilitySection>
  </div>
}
