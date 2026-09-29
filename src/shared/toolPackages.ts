import type { CustomToolDefinition } from './customTools'

export interface ToolSelection {
  project: boolean
  entries: string[]
}

export interface ResolvedToolSelection extends ToolSelection { project: false }

export interface ToolLoadError {
  code: 'manifest_not_found' | 'path_not_found' | 'permission_denied' | 'not_directory' | 'not_file'
    | 'manifest_too_large' | 'invalid_json' | 'invalid_definition' | 'duplicate_id'
    | 'invalid_source_path' | 'too_many_entries' | 'read_failed'
  path: string
  detail?: string
}

export interface ToolRoot {
  id: string
  name: string
  path: string
  source: 'system' | 'user' | 'external' | 'project'
  error?: ToolLoadError
}

export interface ToolPackage {
  id: string
  name: string
  description: string
  rootId: string
  rootName: string
  source: ToolRoot['source']
  directory: string
  definition?: CustomToolDefinition
  error?: ToolLoadError
  shadowedBy?: string
}

export interface ToolSnapshot { roots: ToolRoot[]; tools: ToolPackage[] }
export interface ToolImportError {
  code: 'invalid_directory' | 'invalid_tool' | 'already_exists' | 'duplicate_id' | 'too_large' | 'too_many_tools' | 'failed'
  name?: string
  detail?: string
  issue?: ToolLoadError
}
export interface ToolDirectory { id: string; name: string; path: string }
export interface ToolSettings {
  version: 0
  order: string[]
  externalDirectories: ToolDirectory[]
}

export function validateToolSelection(value: unknown): ToolSelection {
  const v = value as ToolSelection | undefined
  if (!v || typeof v.project !== 'boolean' || !Array.isArray(v.entries)
    || v.entries.some(id => typeof id !== 'string' || !id.trim())) throw new Error('Invalid custom tool selection.')
  return { project: v.project, entries: [...new Set(v.entries)] }
}

export function normalizeToolSettings(value: unknown): ToolSettings {
  const v = value as { version?: unknown; order?: unknown; external_directories?: unknown } | undefined
  if (!v || v.version !== 0) throw new Error('Unsupported tool settings version.')
  if (!Array.isArray(v.order) || v.order.length > 10000 || v.order.some(x => typeof x !== 'string' || !x)) throw new Error('Invalid tool settings.')
  const directories = v.external_directories
  if (!Array.isArray(directories) || directories.length > 128) throw new Error('Invalid tool directories.')
  const ids = new Set<string>()
  for (const directory of directories) {
    if (!directory || typeof directory.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(directory.id)
      || ['system', 'user', 'project'].includes(directory.id) || directory.id.startsWith('project-') || ids.has(directory.id)
      || typeof directory.name !== 'string' || !directory.name.trim() || directory.name.length > 100
      || typeof directory.path !== 'string' || !directory.path.trim()) throw new Error('Invalid tool directory.')
    ids.add(directory.id)
  }
  return { version: 0, order: [...new Set(v.order)] as string[], externalDirectories: directories.map(d => ({ id: d.id, name: d.name, path: d.path })) }
}

export function serializeToolSettings(value: ToolSettings) {
  return { version: value.version, order: value.order, external_directories: value.externalDirectories }
}

export function setAllCustomTools(selection: ToolSelection, tools: readonly ToolPackage[], subagent: boolean, checked: boolean): ToolSelection {
  return { project: subagent && checked, entries: checked
    ? [...new Set([...selection.entries, ...tools.filter(tool => !subagent || tool.source !== 'project').map(tool => tool.id)])] : [] }
}

/** Catalog order is source precedence, then the source's user-defined order. */
export function resolveToolSelection(selection: ToolSelection, tools: readonly ToolPackage[], subagent = false, unique = true): ResolvedToolSelection {
  const names = new Set<string>()
  const entries = tools.filter(tool => {
    const enabled = !tool.error && tool.definition && (subagent && tool.source === 'project'
      ? selection.project : selection.entries.includes(tool.id))
    if (!enabled || (unique && names.has(tool.name.toLowerCase()))) return false
    names.add(tool.name.toLowerCase())
    return true
  }).map(tool => tool.id)
  return { project: false, entries }
}

export function withToolShadows(tools: readonly ToolPackage[], selected: readonly string[]): ToolPackage[] {
  const winners = new Map<string, string>()
  return tools.map(tool => {
    const { shadowedBy: _shadow, ...item } = tool
    if (!tool.definition || tool.error || !selected.includes(tool.id)) return item
    const name = tool.name.toLowerCase()
    const winner = winners.get(name)
    if (!winner) winners.set(name, tool.rootName)
    return { ...item, ...(winner ? { shadowedBy: winner } : {}) }
  })
}
