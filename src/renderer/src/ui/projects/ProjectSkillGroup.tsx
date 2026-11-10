import type { ReactNode } from 'react'
import { FolderOpen, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { SkillRootSummary, SkillSnapshot, SkillSummary } from '@shared/types'
import { notice } from '../notice'
import { UI_ICON_SIZE_SMALL } from '../uiConstants'
import { CapabilityResourceGroup } from '../CapabilityResourceGroup'

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
    data-tooltip={label + '\n' + root.path} disabled={!root.available} onClick={() => void openFolder()}>
    <FolderOpen size={UI_ICON_SIZE_SMALL} aria-hidden="true" />
  </button>
}

/** Directory management within the shared skill list; skill rows have a single renderer. */
export function ProjectSkillGroup({ skills, disabled, onAddDirectories, onRemoveDirectory, renderSkill }: {
  skills?: SkillSnapshot
  disabled?: boolean
  onAddDirectories(): void
  onRemoveDirectory(path: string): void
  renderSkill(skill: SkillSummary): ReactNode
}) {
  const { t } = useTranslation()
  const items = (skills?.skills ?? []).filter(skill => skill.source === 'project')
  const roots = (skills?.roots ?? []).filter(root => root.kind === 'project' && (
    root.removable || items.some(skill => skill.rootId === root.id) || (root.issue && root.issue !== 'not_found')
  ))
  const singleRoot = roots.length === 1 ? roots[0] : undefined
  function rootActions(root: SkillRootSummary) {
    return <>
      <ProjectSkillFolder root={root} />
      {root.removable && <button type="button" className="ui-icon-button" disabled={disabled}
        aria-label={t('project.remove_skill_directory')} data-tooltip={t('project.remove_skill_directory')} onClick={() => onRemoveDirectory(root.path)}>
        <X size={UI_ICON_SIZE_SMALL} aria-hidden="true" />
      </button>}
    </>
  }
  return <CapabilityResourceGroup label={t('settings.skill_group_project')} ariaLabel={t('project.local_skills')} count={items.length} fullWidthDivider
    actions={<>
      {singleRoot && rootActions(singleRoot)}
      <button type="button" className="ui-icon-button" disabled={disabled}
        aria-label={t('project.add_skill_directories')} data-tooltip={t('project.add_skill_directories')} onClick={onAddDirectories}>
        <Plus size={UI_ICON_SIZE_SMALL} aria-hidden="true" />
      </button>
    </>}>
    <p className="ui-field-hint">{t('project.skill_directories_hint')}</p>
    {skills?.scriptAutoApprove && <p className="ui-field-hint">{t('project.global_skill_scripts_auto_approved')}</p>}
    {roots.map(root => {
      const rootItems = items.filter(skill => skill.rootId === root.id)
      const content = <>
        {root.issue && <div role="alert" className="ui-field-hint ui-status-danger">{root.path}: {t(`settings.skill_root_${root.issue}`)}</div>}
        {rootItems.map(renderSkill)}
      </>
      return singleRoot
        ? <section key={root.id} className="ui-form-section" aria-label={root.path}>{content}</section>
        : <CapabilityResourceGroup key={root.id} label={root.name} ariaLabel={root.path} tooltip={root.path} count={rootItems.length} actions={rootActions(root)}>{content}</CapabilityResourceGroup>
    })}
  </CapabilityResourceGroup>
}
