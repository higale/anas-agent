import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SkillSnapshot } from '@shared/types'
import { notice } from '../notice'

export function useProjectSkills(projectId: string, globalSkills: SkillSnapshot | undefined, skillDirectories?: string[]): SkillSnapshot | undefined {
  const { t } = useTranslation()
  const [loaded, setLoaded] = useState<{ projectId: string; skillDirectories?: string[]; snapshot: SkillSnapshot }>()

  useEffect(() => {
    let cancelled = false
    void window.gale.skills.get(projectId, skillDirectories).then((snapshot) => {
      if (!cancelled) setLoaded({ projectId, skillDirectories, snapshot })
    }).catch(() => {
      if (!cancelled) notice.error(t('chat.failed_load_skill'))
    })
    return () => { cancelled = true }
  }, [projectId, skillDirectories, globalSkills, t])

  return loaded?.projectId === projectId && loaded.skillDirectories === skillDirectories ? loaded.snapshot : undefined
}
