export interface PluginWidgetDefinition {
  id: string
  location: 'sidebar.footer'
  handler: string
  actions: string[]
  modelHosts?: string[]
}

export interface PluginWidgetContent {
  title: string
  html: string
}

const identifier = /^[a-z][a-z0-9_-]{0,63}$/
export function parsePluginWidgets(value: unknown, hasBackend: boolean): PluginWidgetDefinition[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 8 || (value.length && !hasBackend)) throw new Error('Widgets require a backend and at most 8 declarations.')
  const result = value.map(raw => {
    if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.handler !== 'string' || !identifier.test(raw.id) || !identifier.test(raw.handler)
      || raw.location !== 'sidebar.footer') throw new Error('Invalid plugin widget declaration.')
    const actions = raw.actions ?? []
    if (!Array.isArray(actions) || actions.length > 8 || actions.some(id => typeof id !== 'string' || !identifier.test(id))
      || new Set(actions).size !== actions.length) throw new Error('Invalid widget actions.')
    const hosts = raw.model_hosts
    if (hosts !== undefined && (!Array.isArray(hosts) || !hosts.length || hosts.length > 32
      || hosts.some(host => typeof host !== 'string' || host.length > 253 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(host)))) throw new Error('Invalid widget model hosts.')
    return { id: raw.id, location: raw.location, handler: raw.handler, actions, ...(hosts ? { modelHosts: hosts } : {}) } as PluginWidgetDefinition
  })
  if (new Set(result.map(item => item.id)).size !== result.length) throw new Error('Duplicate widget ID.')
  return result
}

export function widgetMatchesModel(widget: PluginWidgetDefinition, baseUrl?: string): boolean {
  if (!widget.modelHosts) return true
  try {
    const url = new URL(baseUrl ?? '')
    return ['https:', 'http:'].includes(url.protocol) && widget.modelHosts.includes(url.hostname)
  } catch { return false }
}

/** Widgets return presentation HTML; action declarations remain in the manifest. */
export function requirePluginWidgetContent(value: unknown): PluginWidgetContent | null {
  if (value === null) return null
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid widget content.')
  const raw = value as Record<string, unknown>
  if (typeof raw.title !== 'string' || !raw.title.trim() || raw.title.length > 160
    || typeof raw.html !== 'string' || !raw.html.trim() || new TextEncoder().encode(raw.html).length > 64 * 1024) {
    throw new Error('Widgets require a title and at most 64 KiB of HTML.')
  }
  return { title: raw.title, html: raw.html }
}
