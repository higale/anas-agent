import { ChevronRight, FolderOpen } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { UI_ICON_SIZE_SMALL } from '../uiConstants'
import type { SkillRootSummary, SkillSnapshot } from '@shared/types'
import { notice } from '../notice'
import type { ToolSnapshot } from '@shared/toolPackages'

function ProjectSkillFolder({ root }: { root: SkillRootSummary }) {
  const { t } = useTranslation()
  const label = t('project.open_skills_folder')

  async function openFolder(): Promise<void> {
    try {
      await window.gale.files.openDirectory(root.path)
    } catch {
      notice.error(t('project.failed_open_skills_folder'))
    }
  }

  return <button className="ui-icon-button" type="button" aria-label={label}
    data-tooltip={label + '\n' + root.path} disabled={!root.available} onClick={event => {
      event.preventDefault()
      void openFolder()
    }}>
    <FolderOpen size={UI_ICON_SIZE_SMALL} aria-hidden="true" />
  </button>
}

/** Inventory of files in the project's source folders; availability is configured separately. */
export function ProjectResources({ skills, tools }: { skills?: SkillSnapshot; tools?: ToolSnapshot }) {
  const { t } = useTranslation()
  const groups = [
    {
      label: t('project.local_skills'),
      folders: (skills?.roots ?? []).filter(root => root.kind === 'project'),
      items: (skills?.skills ?? []).filter(skill => skill.source === 'project').map(skill => ({
        id: skill.id, rootId: skill.rootId, name: skill.name, description: skill.description, path: skill.dirPath,
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
        id: tool.id, rootId: tool.rootId, name: tool.name, description: tool.description, path: tool.directory,
        error: tool.error ? t(`custom_tools.load_error_${tool.error.code}`) : undefined
      })),
      errors: (tools?.roots ?? []).filter(root => root.source === 'project' && root.error && root.error.code !== 'path_not_found')
        .map(root => ({ id: root.id, path: root.path, message: t(`custom_tools.load_error_${root.error!.code}`) }))
    }
  ]
  function renderContents(items: typeof groups[number]['items'], errors: typeof groups[number]['errors']) {
    return <>
      {errors.map(error => <div role="alert" className="ui-field-hint ui-status-danger" key={error.id}>{error.path}: {error.message}</div>)}
      {items.length > 0 && <div role="list" className="ui-grid-auto ui-resource-grid">
        {items.map(item => <div role="listitem" className="ui-resource-item" key={item.id}
          data-tooltip={[item.description, item.path].filter(Boolean).join('\n')}>
          <span>{item.name}</span>
          {item.error && <div role="alert" className="ui-field-hint ui-status-danger">{item.error}</div>}
        </div>)}
      </div>}
    </>
  }

  return <>{groups.filter(group => group.items.length || group.errors.length).map(group => (
    <details key={group.label} aria-label={group.label} className="ui-form-section-divided">
      <summary className="ui-disclosure-trigger ui-row">
        <span>{group.label}</span><small>{group.items.length}</small>
        <ChevronRight className="ui-disclosure-chevron" size={UI_ICON_SIZE_SMALL} aria-hidden="true" />
        {group.folders?.length === 1 && <ProjectSkillFolder root={group.folders[0]} />}
      </summary>
      <div className="ui-capability-list">
        {group.folders && group.folders.length > 1 ? group.folders.map(root => {
          const items = group.items.filter(item => item.rootId === root.id)
          return <section key={root.id} className="ui-form-section" aria-label={root.path}>
            <div className="ui-row">
              <span className="ui-truncate" data-tooltip={root.path}>{root.name}</span><small>{items.length}</small>
              <ProjectSkillFolder root={root} />
            </div>
            {renderContents(items, group.errors.filter(error => error.id === root.id))}
          </section>
        }) : renderContents(group.items, group.errors)}
      </div>
    </details>
  ))}</>
}
