import { customToolCapabilityIssue } from '@shared/customTools'
import { useTranslation } from 'react-i18next'
import type { AgentCapabilities } from '@shared/agentCapabilities'
import { packageResourceEnabled, packageResourceKey } from '@shared/packageResourceSelection'
import { CheckboxField } from '../CheckboxField'
import { SkillDescriptionWarning } from '../SkillDescriptionWarning'
import { CapabilityGroupActions } from '../CapabilityGroupActions'

type Resources = Awaited<ReturnType<typeof window.gale.config.subagentResources>>
export function SubagentPackagePanel({ resources, value, onChange }: { resources: Resources; value: AgentCapabilities; onChange(value: AgentCapabilities): void }) {
  const { t } = useTranslation()
  const toggle = (group: 'skills' | 'customTools', resource: { id: string; rootId: string }, checked: boolean) => {
    const selection = value[group]
    const items = group === 'skills' ? resources.skills.skills : resources.tools
    const packageChoices = selection.mode === 'off'
      ? Object.fromEntries([...Object.keys(selection.package ?? {}), ...items.map(packageResourceKey)].map(key => [key, false]))
      : selection.package
    onChange({ ...value, [group]: { ...selection,
      ...(selection.mode === 'off' ? { mode: 'custom', entries: [], project: false } : {}),
      package: { ...packageChoices, [packageResourceKey(resource)]: checked } } })
  }
  const toggleGroup = (group: 'skills' | 'customTools', checked: boolean) => {
    const selection = value[group]
    const keys = group === 'skills'
      ? resources.skills.skills.filter(skill => !checked || !skill.loadError).map(packageResourceKey)
      : resources.tools.filter(tool => !checked || !tool.error).map(packageResourceKey)
    onChange({ ...value, [group]: { ...selection,
      package: { ...selection.package, ...Object.fromEntries(keys.map(key => [key, checked])) } } })
  }
  return <>
    {resources.skills.roots.filter(root => root.issue && root.issue !== 'not_found').map(root => <span key={root.id} className="ui-resource-unavailable"
      data-tooltip={t(`settings.skill_root_${root.issue}`)}>{root.path}</span>)}
    {Boolean(resources.skills.skills.length) && <div role="group" className="ui-form-section ui-form-section-divided" aria-label={t('settings.subagent_package_skills')}>
      <div className="ui-row">
        <strong className="ui-section-title">{t('settings.subagent_package_skills')}</strong>
        {value.skills.mode === 'custom' && <CapabilityGroupActions allSelected={resources.skills.skills.every(skill => skill.loadError || packageResourceEnabled(value.skills.package, skill))} onChange={checked => toggleGroup('skills', checked)} />}
      </div>
      <div className="ui-grid-auto">
        {resources.skills.skills.map(skill => <div className="ui-field-stack" key={skill.id}>
          <div className="ui-row"><CheckboxField className="ui-checkbox-field-inline" label={skill.name}
            tooltip={[skill.description, skill.dirPath].filter(Boolean).join('\n')}
            inactiveReason={skill.loadError ? [t(`settings.skill_issue_${skill.loadError.code}`, { name: skill.loadError.name, expected: skill.loadError.expected }), skill.loadError.detail].filter(Boolean).join('\n') : undefined}
            checked={value.skills.mode !== 'off' && packageResourceEnabled(value.skills.package, skill)} onChange={checked => toggle('skills', skill, checked)} /><SkillDescriptionWarning description={skill.description} /></div>
        </div>)}
      </div>
    </div>}
    {Boolean(resources.tools.length) && <div role="group" className="ui-form-section ui-form-section-divided" aria-label={t('settings.subagent_package_tools')}>
      <div className="ui-row">
        <strong className="ui-section-title">{t('settings.subagent_package_tools')}</strong>
        {value.customTools.mode === 'custom' && <CapabilityGroupActions allSelected={resources.tools.every(tool => tool.error || packageResourceEnabled(value.customTools.package, tool))} onChange={checked => toggleGroup('customTools', checked)} />}
      </div>
      <div className="ui-grid-auto">
        {resources.tools.map(tool => {
          const issue = customToolCapabilityIssue(tool.definition, value.backgroundTools)
          return <div className="ui-field-stack" key={tool.id}>
            <CheckboxField className="ui-checkbox-field-inline" label={tool.name}
              tooltip={[tool.description, tool.directory].filter(Boolean).join('\n')}
              inactiveReason={[tool.error && [t(`custom_tools.load_error_${tool.error.code}`), tool.error.detail].filter(Boolean).join('\n'),
                issue && t(issue)].filter(Boolean).join('\n')}
              checked={value.customTools.mode !== 'off' && packageResourceEnabled(value.customTools.package, tool)} onChange={checked => toggle('customTools', tool, checked)} />
          </div>
        })}
      </div>
    </div>}
  </>
}
