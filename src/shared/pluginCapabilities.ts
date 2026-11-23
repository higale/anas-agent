/** Host-owned choices; missing groups and entries are enabled by default. */
export type PluginCapabilityKind = 'tool' | 'prompt'
export type PluginCapabilityChoices = Partial<Record<PluginCapabilityKind, Record<string, boolean>>>

export function parsePluginCapabilityChoices(value: unknown): PluginCapabilityChoices {
  if (value === undefined) return {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin capability choices.')
  return Object.fromEntries(Object.entries(value).filter(([kind]) => kind !== 'skill').map(([kind, entries]) => {
    if (!['tool', 'prompt'].includes(kind) || !entries || typeof entries !== 'object' || Array.isArray(entries)) {
      throw new Error('Invalid plugin capability group.')
    }
    const pairs = Object.entries(entries)
    if (pairs.length > 4096 || pairs.some(([id, enabled]) => typeof enabled !== 'boolean' || id.length > 64
      || !(kind === 'tool' ? /^[a-z][a-z0-9_]{0,63}$/ : /^[a-z0-9]+(?:-[a-z0-9]+)*$/).test(id))) {
      throw new Error('Invalid plugin capability choice.')
    }
    return [kind, Object.fromEntries(pairs)]
  }))
}

export function pluginCapabilityEnabled(choices: PluginCapabilityChoices | undefined, kind: PluginCapabilityKind, id: string): boolean {
  return choices?.[kind]?.[id] !== false
}
