import type { TFunction } from 'i18next'

export function isPanelClosed(reason: unknown): boolean {
  return String(reason).includes('PANEL_CLOSED')
}

export function panelError(reason: unknown, t: TFunction): string {
  const message = String(reason)
  if (message.includes('PANEL_TARGET_UNAVAILABLE')) return t('panels.view_target_unavailable')
  if (isPanelClosed(reason)) return t('panels.view_closed')
  if (message.includes('PANEL_ACTION_UNAVAILABLE')) return t('panels.action_unavailable')
  if (message.includes('PANEL_ACTION_TIMEOUT')) return t('panels.action_timeout')
  if (message.includes('PANEL_ACTION_FAILED')) return t('panels.action_failed')
  return t('panels.operation_failed')
}
