import { requirePluginIconPath } from './plugins'

export interface PanelToolbarMenuItem { id: string; label: string; disabled?: boolean; checked?: boolean; separatorBefore?: boolean }
export interface PanelToolbarAction {
  id: string; label: string; icon: string; disabled?: boolean; pressed?: boolean
  items?: PanelToolbarMenuItem[]
  description?: string
}
export interface PanelToolbar {
  status?: { label: string; tone?: 'neutral' | 'success' | 'warning' | 'danger' }
  actions: PanelToolbarAction[]
}
/** Menu containers are not executable; disabled parents also disable their entries. */
export function findPanelToolbarAction(toolbar: PanelToolbar | undefined, id: unknown): PanelToolbarMenuItem | undefined {
  for (const action of toolbar?.actions ?? []) {
    if (action.items) {
      const item = action.items.find(item => item.id === id)
      if (item) return { ...item, disabled: action.disabled || item.disabled }
    } else if (action.id === id) return action
  }
  return undefined
}
export function requirePanelToolbar(input: unknown): PanelToolbar | undefined {
  if (input === null) return undefined
  const invalid = () => { throw new Error('Invalid panel toolbar.') }
  if (!input || typeof input !== 'object') return invalid()
  const value = input as PanelToolbar
  const label = (text: unknown) => typeof text === 'string' && text.trim().length > 0 && text.length <= 120
  if (!Array.isArray(value.actions)) return invalid()
  const ids = new Set<string>()
  const actions = value.actions.map(action => {
    if (!action || typeof action.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(action.id)
      || ids.has(action.id) || !label(action.label)
      || (action.disabled !== undefined && typeof action.disabled !== 'boolean')
      || (action.pressed !== undefined && typeof action.pressed !== 'boolean')) return invalid()
    ids.add(action.id)
    if (action.description !== undefined && !label(action.description)) return invalid()
    let items: PanelToolbarMenuItem[] | undefined
    if (action.items !== undefined) {
      if (!Array.isArray(action.items) || !action.items.length || action.pressed !== undefined) return invalid()
      items = action.items.map(item => {
        if (!item || typeof item.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(item.id)
          || ids.has(item.id) || !label(item.label)
          || (item.disabled !== undefined && typeof item.disabled !== 'boolean')
          || (item.checked !== undefined && typeof item.checked !== 'boolean')
          || (item.separatorBefore !== undefined && typeof item.separatorBefore !== 'boolean')) return invalid()
        ids.add(item.id)
        return { id: item.id, label: item.label, disabled: item.disabled ?? false,
          ...(item.checked !== undefined ? { checked: item.checked } : {}),
          ...(item.separatorBefore !== undefined ? { separatorBefore: item.separatorBefore } : {}) }
      })
    } else if (action.description !== undefined) return invalid()
    return { id: action.id, label: action.label, icon: requirePluginIconPath(action.icon), disabled: action.disabled ?? false,
      ...(items ? { items, ...(action.description ? { description: action.description } : {}) } : {}),
      ...(action.pressed !== undefined ? { pressed: action.pressed } : {}) }
  })
  if (value.status !== undefined && (!value.status || !label(value.status.label)
    || (value.status.tone !== undefined && !['neutral', 'success', 'warning', 'danger'].includes(value.status.tone)))) return invalid()
  return { actions, ...(value.status ? { status: { label: value.status.label, tone: value.status.tone ?? 'neutral' } } : {}) }
}
