import { useEffect } from 'react'
import type { PanelLayout } from '@shared/panels'
import type { WorkspacePanelTab } from '../agent/useWorkspacePanels'
import { notice } from '../notice'
import { useTranslation } from 'react-i18next'
import { observePanelLayout, panelBounds } from './panelLayout'

export function PanelLayouts({ tabs }: { tabs: WorkspacePanelTab[] }) {
  const { t } = useTranslation()
  useEffect(() => {
    let previous = ''
    let active = true
    const stop = observePanelLayout(() => {
      const layouts: PanelLayout[] = tabs.flatMap(tab => {
        const { viewId, requestId } = tab
        const slot = document.querySelector<HTMLElement>(`[data-panel-view="${viewId}"]`)
        return [{ viewId, requestId, bounds: panelBounds(slot) }]
      })
      const serialized = JSON.stringify(layouts)
      if (serialized === previous) return
      previous = serialized
      void window.gale.panels.setLayouts(layouts).catch(() => {
        if (active) { active = false; notice.error(t('panels.operation_failed')) }
      })
    })
    return () => { active = false; stop() }
  }, [tabs, t])
  return null
}
