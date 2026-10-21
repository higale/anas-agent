import { useTranslation } from 'react-i18next'
import type { SkillSnapshot } from '@shared/types'
import type { ToolSnapshot } from '@shared/toolPackages'

/** Inventory of files in the project's source folders; availability is configured separately. */
export function ProjectResources({ skills, tools }: { skills?: SkillSnapshot; tools?: ToolSnapshot }) {
  const { t } = useTranslation()
  const groups = [
    {
      label: t('project.local_skills'),
      items: (skills?.skills ?? []).filter(skill => skill.source === 'project').map(skill => ({
        id: skill.id, name: skill.name, description: skill.description, path: skill.dirPath,
        error: skill.loadError ? t(`settings.skill_issue_${skill.loadError.code}`, {
          name: skill.loadError.name, expected: skill.loadError.expected
        }) : undefined
      })),
      errors: (skills?.roots ?? []).filter(root => root.kind === 'project' && root.issue && root.issue !== 'not_found')
        .map(root => ({ id: root.id, path: root.path, message: t(`settings.skill_root_${root.issue}`) }))
    },
    {
      label: t('project.local_tools'),
      items: (tools?.tools ?? []).filter(tool => tool.source === 'project').map(tool => ({
        id: tool.id, name: tool.name, description: tool.description, path: tool.directory,
        error: tool.error ? t(`custom_tools.load_error_${tool.error.code}`) : undefined
      })),
      errors: (tools?.roots ?? []).filter(root => root.source === 'project' && root.error && root.error.code !== 'path_not_found')
        .map(root => ({ id: root.id, path: root.path, message: t(`custom_tools.load_error_${root.error!.code}`) }))
    }
  ]
  return <>{groups.filter(group => group.items.length || group.errors.length).map(group => (
    <div key={group.label} role="group" aria-label={group.label} className="ui-form-section ui-form-section-divided">
      <strong className="ui-section-title">{group.label}</strong>
      {group.errors.map(error => <div role="alert" className="ui-field-hint ui-status-danger" key={error.id}>{error.path}: {error.message}</div>)}
      {group.items.length > 0 && <div role="list" className="ui-grid-auto ui-resource-grid">
        {group.items.map(item => <div role="listitem" className="ui-resource-item" key={item.id}
          data-tooltip={[item.description, item.path].filter(Boolean).join('\n')}>
          <span>{item.name}</span>
          {item.error && <div role="alert" className="ui-field-hint ui-status-danger">{item.error}</div>}
        </div>)}
      </div>}
    </div>
  ))}</>
}
