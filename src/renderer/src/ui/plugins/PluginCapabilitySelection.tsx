import { useTranslation } from 'react-i18next'
import { normalizeCapabilityChoices, pluginGroupMode, pluginSelectionMode, setPluginEnabled, type AgentCapabilities } from '@shared/agentCapabilities'
import { pluginDisplayText, type PluginSummary } from '@shared/plugins'
import { CheckboxField } from '../CheckboxField'
import { CapabilitySection } from '../CapabilitySection'

/** A plugin is selected as one unit; applicability and dependencies are resolved at runtime. */
export function PluginCapabilitySelection({ value: storedValue, plugins, error, onChange, disabled = false }: {
  value: AgentCapabilities; plugins: PluginSummary[]; error?: string
  disabled?: boolean; onChange(value: AgentCapabilities): void
}) {
  const { t, i18n } = useTranslation()
  const value = normalizeCapabilityChoices(storedValue)
  const ids = new Set([
    ...plugins.filter(plugin => plugin.manifest && (plugin.manifest.tools.length || plugin.manifest.skills?.length || plugin.manifest.prompts?.length)).map(plugin => plugin.id),
    ...(value.plugins ?? []).map(plugin => plugin.id)
  ])
  if (!ids.size && !error) return null
  const selected = (id: string) => pluginSelectionMode(value, id) === 'all'
  return <div className="ui-form-section ui-form-section-divided">
    <CapabilitySection label={t('plugins.title')} selected={[...ids].filter(selected).length} total={ids.size}
      mode={pluginGroupMode(value)} disabled={disabled} onChange={pluginGroupMode => onChange({ ...value, pluginGroupMode })}
      allSelected={[...ids].every(id => !plugins.some(plugin => plugin.id === id) || selected(id))}
      onSelectionChange={checked => onChange([...ids].filter(id => !checked || plugins.some(plugin => plugin.id === id) || selected(id))
        .reduce((next, id) => setPluginEnabled(next, id, checked), value))}
      reason={error ? t('plugins.load_failed') : undefined}>
      <div className="ui-capability-list ui-grid-auto">
        {error && <small role="alert" className="ui-status-danger">{t('plugins.load_failed')} {error}</small>}
        {[...ids].map(id => {
          const plugin = plugins.find(plugin => plugin.id === id)
          const name = plugin ? pluginDisplayText(plugin, i18n.language) : id
          const inactiveReason = [!plugin && t('capabilities.deleted'), plugin && !plugin.enabled && t('capabilities.globally_disabled'),
            plugin?.error].filter(Boolean).join('\n')
          return <CheckboxField className="ui-checkbox-field-inline" key={id} checked={selected(id)} aria-label={name}
            disabled={disabled || (!plugin && !selected(id))}
            inactiveReason={inactiveReason} label={name}
            onChange={enabled => onChange(setPluginEnabled(value, id, enabled))} />
        })}
      </div>
    </CapabilitySection>
  </div>
}
