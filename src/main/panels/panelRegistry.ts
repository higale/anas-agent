import { PanelViews } from './panelViews'
import type { LanguageResourcesSnapshot } from '@shared/types'

let languages: LanguageResourcesSnapshot | undefined
export function setPanelLanguages(snapshot: LanguageResourcesSnapshot): void { languages = snapshot }
export function panelLanguages(): LanguageResourcesSnapshot {
  if (!languages) throw new Error('Panel language resources have not been prepared.')
  return languages
}
export function panelLabel(language: string, key: 'file_changes' | 'review_title'): string {
  const resources = panelLanguages().resources
  for (const code of [language, 'en']) {
    const resource = resources[code] as { agent?: Record<string, unknown> } | undefined
    const label = resource?.agent?.[key]
    if (typeof label === 'string') return label
  }
  throw new Error(`Missing panel language label: agent.${key}`)
}
// Placement acknowledgements must not acquire application-data locks.
export const panelViews = new PanelViews(async () => panelLanguages())
