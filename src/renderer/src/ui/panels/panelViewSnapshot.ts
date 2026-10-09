import { requirePanelJson, type PanelJson } from '@shared/panelLifecycle'

// Tagged values preserve refs and Monaco's per-model Map without transferring services or data caches.
function encode(value: unknown): PanelJson {
  if (value === undefined) return { type: 'undefined' }
  if (value instanceof Map) return { type: 'map', entries: [...value].map(([key, item]) => [encode(key), encode(item)]) }
  if (Array.isArray(value)) return { type: 'array', items: value.map(encode) }
  if (value && typeof value === 'object') return { type: 'object', entries: Object.entries(value).map(([key, item]) => [key, encode(item)]) }
  return { type: 'value', value: value as PanelJson }
}
function decode(value: PanelJson): unknown {
  const tagged = value as { type: string; value: PanelJson; entries: [PanelJson, PanelJson][]; items: PanelJson[] }
  switch (tagged.type) {
    case 'undefined': return undefined
    case 'map': return new Map(tagged.entries.map(([key, item]) => [decode(key), decode(item)]))
    case 'array': return tagged.items.map(decode)
    case 'object': return Object.fromEntries(tagged.entries.map(([key, item]) => [key, decode(item)]))
    case 'value': return tagged.value
    default: throw new Error('PANEL_STATE_INVALID')
  }
}
export function snapshotViewState(state: Map<string, unknown>): PanelJson { return requirePanelJson(encode(state)) }
export function restoreViewState(state: PanelJson): Map<string, unknown> {
  if (state === null) return new Map()
  const restored = decode(requirePanelJson(state))
  if (!(restored instanceof Map)) throw new Error('PANEL_STATE_INVALID')
  return restored
}
