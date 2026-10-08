import type { ContentServices, PanelContentApi } from '@shared/panels'

declare global { interface Window { panelContent?: PanelContentApi } }

export function contentServices(): ContentServices {
  return window.panelContent?.services ?? window.gale
}
