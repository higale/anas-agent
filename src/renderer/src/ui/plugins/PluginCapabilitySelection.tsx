import { useTranslation } from 'react-i18next'
import { isPluginSkillId, pluginToolId, pluginPromptId, pluginToolName } from '@shared/pluginTools'
import { pluginGroupMode, pluginSelectionMode, type AgentCapabilities } from '@shared/agentCapabilities'
import { pluginDisplayText, pluginIconSources, type PluginSummary } from '@shared/plugins'
import type { SkillSnapshot } from '@shared/types'
import { CheckboxField } from '../CheckboxField'
import { CapabilitySection } from '../CapabilitySection'
import { SkillAvailabilityNotice } from '../SkillAvailabilityNotice'
import { SegmentedMultiSelect } from '../SegmentedMultiSelect'
import { PluginIcon } from './PluginIcon'

/** One scoped selection for every contribution of a plugin. */
export function PluginCapabilitySelection({ value, plugins, skills, error, onChange, subagent = false, disabled = false }: {
  value: AgentCapabilities; plugins: PluginSummary[]; skills?: SkillSnapshot
  error?: string; subagent?: boolean; disabled?: boolean; onChange(value: AgentCapabilities): void
}) {
  const { t, i18n } = useTranslation()
  const pluginSkills = value.skills.entries.filter(entry => isPluginSkillId(entry.id))
  const ids = new Set([
    ...plugins.filter(plugin => plugin.manifest && (plugin.manifest.tools.length || plugin.manifest.skills?.length || plugin.manifest.prompts?.length)).map(plugin => plugin.id),
    ...(value.plugins ?? []).map(plugin => plugin.id),
    ...[...value.pluginTools, ...value.pluginPrompts, ...pluginSkills.map(skill => skill.id)].map(id => id.split(':')[0])
  ])
  const dependencyReason = (tools: string[]) => {
    const missing = tools.filter(id => {
      const mode = pluginSelectionMode(value, id.split(':')[0])
      return mode === 'off' || (mode === 'custom' && !value.pluginTools.includes(id))
    })
    return missing.length ? t('plugins.missing_tools_detail', { tools: missing.map(id => { const [plugin, , tool] = id.split(':'); return pluginToolName(plugin, tool) }).join(', ') }) : ''
  }
  function select(ids: string[], id: string, checked: boolean) { return checked ? [...new Set([...ids, id])] : ids.filter(item => item !== id) }
  if (!ids.size && !error) return null
  const groupMode = pluginGroupMode(value)
  return <div className="ui-form-section ui-form-section-divided">
    <CapabilitySection label={t('plugins.title')} mode={groupMode} expandable disabled={disabled}
      total={ids.size} customCount={[...ids].filter(id => pluginSelectionMode(value, id) !== 'off').length}
      reason={error ? t('plugins.load_failed') : undefined}
      onChange={pluginGroupMode => onChange({ ...value, pluginGroupMode })}>
      <div className="ui-capability-list">
      {error && <small role="alert" className="ui-status-danger">{t('plugins.load_failed')} {error}</small>}
      {[...ids].map(id => {
        const plugin = plugins.find(plugin => plugin.id === id)
        const name = plugin ? pluginDisplayText(plugin, i18n.language) : id
        const unavailable = !plugin || !plugin.enabled || Boolean(plugin.error)
        const reason = plugin?.error || (unavailable ? t('capabilities.inactive') : '')
        const toolIds = [...new Set([...(plugin?.manifest?.tools ?? []).map(tool => pluginToolId(id, tool.id)), ...value.pluginTools.filter(tool => tool.startsWith(`${id}:`))])]
        const promptIds = [...new Set([...(plugin?.manifest?.prompts ?? []).map(prompt => pluginPromptId(id, prompt.id)), ...value.pluginPrompts.filter(prompt => prompt.startsWith(`${id}:`))])]
        const savedSkills = pluginSkills.filter(skill => skill.id.startsWith(`${id}:skill:`))
        const skillIds = [...new Set([...(plugin?.manifest?.skills ?? []).map(skill => `${id}:skill:${skill.id}`), ...savedSkills.map(skill => skill.id)])]
        const total = toolIds.length + promptIds.length + skillIds.length
        const count = toolIds.filter(tool => value.pluginTools.includes(tool)).length + promptIds.filter(prompt => value.pluginPrompts.includes(prompt)).length
          + savedSkills.filter(skill => skill.model || (!subagent && skill.shortcut)).length
        const mode = pluginSelectionMode(value, id)
        const selectionDisabled = disabled || groupMode !== 'custom' || mode !== 'custom'
        const displayed = (selected: boolean) => mode === 'all' || (mode === 'custom' && selected)
        function change(next: AgentCapabilities) {
          onChange({ ...next, plugins: next.plugins?.some(plugin => plugin.id === id)
            ? next.plugins : [...(next.plugins ?? []), { id, mode }] })
        }
        function setMode(mode: 'all' | 'custom' | 'off') {
          change({ ...value, plugins: [...(value.plugins ?? []).filter(plugin => plugin.id !== id), { id, mode }] })
        }
        return <CapabilitySection key={id} label={name} title={<><PluginIcon icon={pluginIconSources(id, plugin?.manifest?.icon)} /><span>{name}</span></>}
          customCount={count} total={total} mode={mode} reason={reason} expandable disabled={disabled || groupMode !== 'custom'} onChange={setMode}>
            <fieldset className="ui-capability-list" aria-label={name} disabled={selectionDisabled}>
              {toolIds.length > 0 && <div className="ui-form-section">
                <strong>{t('plugins.tools')}</strong>
                <div className="ui-capability-tools ui-grid-auto ui-resource-grid">{toolIds.map(toolId => {
                  const localId = toolId.split(':')[2]
                  const tool = plugin?.manifest?.tools.find(tool => tool.id === localId)
                  const toolName = pluginToolName(id, localId)
                  return <CheckboxField key={toolId} className="ui-checkbox-field-inline" checked={displayed(value.pluginTools.includes(toolId))} disabled={!tool && !value.pluginTools.includes(toolId)} aria-label={toolName}
                    tooltip={[tool?.description, reason].filter(Boolean).join('\n')}
                    label={<span className="ui-row"><span>{toolName}</span>{(!unavailable && !tool) && <span className="ui-badge">{t('capabilities.inactive')}</span>}</span>}
                    onChange={checked => change({ ...value, pluginTools: select(value.pluginTools, toolId, checked) })} />
                })}</div>
              </div>}
              {skillIds.length > 0 && <div className="ui-form-section">
                <strong>{t('settings.skills')}</strong>
                {skillIds.map(skillId => {
                  const skill = skills?.skills.find(skill => skill.id === skillId)
                  const definition = plugin?.manifest?.skills?.find(skill => `${id}:skill:${skill.id}` === skillId)
                  const selected = value.skills.entries.find(skill => skill.id === skillId)
                  const shownSelection = { id: skillId, model: displayed(selected?.model ?? false), shortcut: displayed(selected?.shortcut ?? false) }
                  const skillName = skill?.name ?? skillId.split(':')[2]
                  const warning = !definition || skill?.loadError ? t('capabilities.inactive') : dependencyReason(definition.tools.map(tool => pluginToolId(id, tool)))
                  const setSkill = (key: 'model' | 'shortcut', checked: boolean) => change({ ...value, skills: { ...value.skills,
                    entries: [...value.skills.entries.filter(skill => skill.id !== skillId), { id: skillId, model: selected?.model ?? false, shortcut: selected?.shortcut ?? false, [key]: checked }] } })
                  return <div className="ui-field-stack" key={skillId}>
                    <div className="ui-capability-resource"><span className="ui-field-stack"><span className="ui-row" data-tooltip={skill?.description}><span className="ui-truncate">{skillName}</span></span><SkillAvailabilityNotice skill={skill} selected={shownSelection} subagent={subagent} /></span>
                      {subagent ? <CheckboxField label={t('capabilities.model')} aria-label={`${skillName} ${t('capabilities.model')}`} checked={shownSelection.model} disabled={(!definition || skill?.modelAvailable === false) && !selected?.model} onChange={checked => setSkill('model', checked)} />
                        : <SegmentedMultiSelect<'model' | 'shortcut'> ariaLabel={skillName} options={(['shortcut', 'model'] as const).map(key => ({ value: key, label: t(`capabilities.${key}`), ariaLabel: `${skillName} ${t(`capabilities.${key}`)}`, checked: shownSelection[key], disabled: (!definition || (key === 'model' ? skill?.modelAvailable : skill?.userAvailable) === false) && !selected?.[key] }))} onChange={setSkill} />}
                    </div>
                    {warning && <small className="ui-field-hint">{warning}</small>}
                  </div>
                })}
              </div>}
              {promptIds.length > 0 && <div className="ui-form-section">
                <strong>{t('plugins.prompts')}</strong>
                {promptIds.map(promptId => {
                  const prompt = plugin?.manifest?.prompts?.find(prompt => pluginPromptId(id, prompt.id) === promptId)
                  const warning = !prompt ? t('capabilities.inactive') : dependencyReason(prompt.tools.map(tool => pluginToolId(id, tool)))
                    || (prompt.scope !== 'all' && prompt.scope !== (subagent ? 'subagent' : 'main') ? t(`plugins.scope_${prompt.scope}`) : '')
                  return <div className="ui-field-stack" key={promptId}>
                    <CheckboxField className="ui-checkbox-field-inline" label={prompt?.id ?? promptId.split(':')[2]} tooltip={prompt?.description}
                      aria-label={prompt?.id ?? promptId} checked={displayed(value.pluginPrompts.includes(promptId))} disabled={!prompt && !value.pluginPrompts.includes(promptId)}
                      onChange={checked => change({ ...value, pluginPrompts: select(value.pluginPrompts, promptId, checked) })} />
                    {warning && <small className="ui-field-hint">{warning}</small>}
                  </div>
                })}
              </div>}
            </fieldset>
        </CapabilitySection>
      })}
      </div>
    </CapabilitySection>
  </div>
}
