import type { ContentServices } from '@shared/panels'
export function contentServices(): ContentServices { return window.panelWindow?.services ?? window.gale }

export function panelApi() { return window.panelWindow ?? window.gale.panels }
