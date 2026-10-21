import { useTranslation } from 'react-i18next'
import type { AgentCapabilities } from '@shared/agentCapabilities'
import { packageResourceEnabled, packageResourceKey } from '@shared/packageResourceSelection'
import { CheckboxField } from '../CheckboxField'

type Resources = Awaited<ReturnType<typeof window.gale.config.subagentResources>>
export function SubagentPackagePanel({ resources, value, onChange }: { resources: Resources; value: AgentCapabilities; onChange(value: AgentCapabilities): void }) {
  const { t } = useTranslation()
  const toggle = (group: 'skills' | 'customTools', resource: { id: string; rootId: string }, checked: boolean) => {
    const selection = value[group]
    onChange({ ...value, [group]: { ...selection, package: { ...selection.package, [packageResourceKey(resource)]: checked } } })
  }
  return <>
    {resources.skills.roots.filter(root => root.issue && root.issue !== 'not_found').map(root => <small key={root.id} role="alert" className="ui-status-danger">{root.path}: {t(`settings.skill_root_${root.issue}`)}</small>)}
    {Boolean(resources.skills.skills.length) && <div role="group" className="ui-form-section ui-form-section-divided" aria-label={t('settings.subagent_package_skills')}>
      <strong className="ui-section-title">{t('settings.subagent_package_skills')}</strong>
      <div className="ui-grid-auto ui-resource-grid">
        {resources.skills.skills.map(skill => <div className="ui-field-stack" key={skill.id}>
          <CheckboxField label={skill.name} checked={packageResourceEnabled(value.skills.package, skill)} onChange={checked => toggle('skills', skill, checked)} />
          {skill.loadError && <small className="ui-status-danger">{skill.loadError.detail ?? skill.loadError.code}</small>}
        </div>)}
      </div>
    </div>}
    {Boolean(resources.tools.length) && <div role="group" className="ui-form-section ui-form-section-divided" aria-label={t('settings.subagent_package_tools')}>
      <strong className="ui-section-title">{t('settings.subagent_package_tools')}</strong>
      <div className="ui-grid-auto ui-resource-grid">
        {resources.tools.map(tool => <div className="ui-field-stack" key={tool.id}>
          <CheckboxField label={tool.name} checked={packageResourceEnabled(value.customTools.package, tool)} onChange={checked => toggle('customTools', tool, checked)} />
          {tool.error && <small className="ui-status-danger">{tool.error.detail ?? tool.error.code}</small>}
        </div>)}
      </div>
    </div>}
  </>
}
