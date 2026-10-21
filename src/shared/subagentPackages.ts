// Persisted identities also cover former presets in conversation snapshots.
// The bundled _system directory determines which Agents are currently built in.
export const subagentPresetIds = ['general-purpose', 'web-researcher', 'project-analyst'] as const
export interface SubagentPackageSettings {
  version: 1
  order: string[]
  disabled: string[]
  external_directories: SubagentExternalDirectory[]
}

export type SubagentDirectoryUpdate = { name: string } | { remove: true } | { direction: -1 | 1 }
export interface SubagentExternalDirectory { id: string; name: string; path: string }
export interface SubagentRootSummary extends SubagentExternalDirectory {
  kind: 'system' | 'user' | 'external'
  available: boolean
  issue?: 'not_found' | 'not_directory' | 'unreadable'
  agentIds: string[]
  errors: { path: string; message: string }[]
}
export function normalizeSubagentDirectoryName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 100) throw new Error('Invalid Agent directory display name.')
  return value.trim()
}

export function requireSubagentPackageId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(value)) throw new Error('Invalid Agent package ID.')
  return value
}

export function normalizeSubagentPackageSettings(value: unknown): SubagentPackageSettings {
  const raw = value as SubagentPackageSettings | undefined
  if (!raw || raw.version !== 1 || 'subagents' in raw) throw new Error('Unsupported subagent configuration version.')
  const ids = (items: unknown): string[] => {
    if (!Array.isArray(items) || items.length > 10000) throw new Error('Invalid Agent package selection.')
    return [...new Set(items.map(requireSubagentPackageId))]
  }
  const directories = raw.external_directories ?? []
  if (!Array.isArray(directories) || directories.length > 256) throw new Error('Invalid external Agent directories.')
  const external = directories.map(item => {
    if (!item || typeof item.path !== 'string' || !item.path.trim() || item.path.includes('\0')) throw new Error('Invalid Agent directory path.')
    const id = requireSubagentPackageId(item.id)
    if (id === 'system' || id === 'user') throw new Error('Reserved Agent directory ID.')
    return { id, name: normalizeSubagentDirectoryName(item.name), path: item.path }
  })
  if (new Set(external.map(item => item.id)).size !== external.length) throw new Error('Duplicate Agent directory ID.')
  return { version: 1, order: ids(raw.order ?? []), disabled: ids(raw.disabled ?? []), external_directories: external }
}
