export const panelActionIcons = ['unplug', 'x', 'refresh-cw', 'play', 'pause', 'square', 'settings', 'save'] as const
export interface PanelToolbar {
  status?: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }
  actions: { id: string; label: string; icon: typeof panelActionIcons[number]; disabled?: boolean }[]
}
export interface PanelToolbarApi {
  /** Replaces this live page's toolbar. Null clears it; nothing is persisted. */
  setToolbar(toolbar: PanelToolbar | null): Promise<void>
  /** One handler per page. Resolve after completion; reject to report failure. */
  onToolbarAction(listener: (id: string) => void | Promise<void>): () => void
}
export interface PanelActionRequest { requestId: string; actionId: string }

export function requirePanelToolbar(input: unknown): PanelToolbar | undefined {
  if (input === null) return undefined
  const invalid = () => { throw new Error('Invalid panel toolbar.') }
  if (!input || typeof input !== 'object') return invalid()
  const value = input as PanelToolbar
  const label = (text: unknown) => typeof text === 'string' && text.trim().length > 0 && text.length <= 120
  if (!Array.isArray(value.actions) || value.actions.length > 4) return invalid()
  const ids = new Set<string>()
  const actions = value.actions.map(action => {
    if (!action || typeof action.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(action.id)
      || ids.has(action.id) || !label(action.label) || !panelActionIcons.includes(action.icon)
      || (action.disabled !== undefined && typeof action.disabled !== 'boolean')) return invalid()
    ids.add(action.id)
    return { id: action.id, label: action.label, icon: action.icon, disabled: action.disabled ?? false }
  })
  if (value.status !== undefined && (!value.status || !label(value.status.label)
    || (value.status.tone !== undefined && !['neutral', 'success', 'warning', 'danger'].includes(value.status.tone)))) return invalid()
  return { actions, ...(value.status ? { status: { label: value.status.label, tone: value.status.tone ?? 'neutral' } } : {}) }
}
