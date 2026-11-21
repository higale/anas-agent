import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { SkillSnapshot, SkillSummary } from '@shared/types'
import { ProjectResourceGroup, type ProjectDirectoryControls } from './ProjectResourceGroup'

export function ProjectSkillGroup({ skills, renderSkill, ...controls }: Omit<ProjectDirectoryControls, 'onAddDirectories'> & {
  skills?: SkillSnapshot
  renderSkill(skill: SkillSummary): ReactNode
}) {
  const { t } = useTranslation()
  return <ProjectResourceGroup kind="skill" {...controls}
    roots={(skills?.roots ?? []).filter(root => root.kind === 'project').map(root => ({ ...root,
      error: root.issue ? t(`settings.skill_root_${root.issue}`) : undefined
    }))}
    items={(skills?.skills ?? []).filter(skill => skill.source === 'project')} renderItem={renderSkill} />
}
