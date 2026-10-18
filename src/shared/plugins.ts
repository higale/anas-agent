import { matchLanguageCode } from './languages'
import { parsePluginTools, pluginToolName, type PluginToolDefinition } from './pluginTools'
import { parsePluginSettings, type PluginSetting } from './pluginSettings'
import { parsePluginWidgets, type PluginWidgetDefinition, type PluginWidgetContent } from './pluginWidgets'

export const PLUGIN_API_VERSION = 2
export const PLUGIN_SCHEME = 'anas-plugin'
export const PLUGIN_RPC_BYTES = 1024 * 1024
export const PLUGIN_ICON_PATH = '_anas/icon/'

/** Package-relative assets; a single image applies to both themes. */
export type PluginIcon = string | { light: string; dark: string }
export interface PluginBackendCallContext {
  caller: { panelId: string; instanceId: string } | null
  views: { panelId: string; instanceId: string; location: 'sidebar' | 'window'; activity?: import('./panels').PanelActivity }[]
}
export interface PluginIconSources { light: string; dark: string }

export function requirePluginIconPath(value: unknown): string {
  const path = requirePluginPath(value)
  if (!/\.(svg|png|webp)$/i.test(path)) throw new Error('Plugin icons must be SVG, PNG or WebP files.')
  return path
}

export function requirePluginIcon(value: unknown): PluginIcon {
  if (typeof value === 'string') return requirePluginIconPath(value)
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin icon.')
  const input = value as Record<string, unknown>
  return { light: requirePluginIconPath(input.light), dark: requirePluginIconPath(input.dark) }
}

export function pluginIconSources(id: string, icon?: PluginIcon): PluginIconSources | undefined {
  if (!icon) return undefined
  const url = (path: string) => `${PLUGIN_SCHEME}://${id}/${PLUGIN_ICON_PATH}${path.split('/').map(encodeURIComponent).join('/')}`
  return typeof icon === 'string' ? { light: url(icon), dark: url(icon) } : { light: url(icon.light), dark: url(icon.dark) }
}

export interface PluginLanguage {
  code: string
  name: string
  author?: string
  pluginName?: string
  pluginDescription?: string
}

export interface PluginLanguageResources {
  resources: Record<string, Record<string, unknown>>
  errors: string[]
}

export function pluginDisplayText(plugin: PluginSummary, language: string, field: 'name' | 'description' = 'name'): string {
  const languages = plugin.languages ?? []
  const selected = matchLanguageCode(language, languages.map(item => item.code))
  const key = field === 'name' ? 'pluginName' : 'pluginDescription'
  return languages.find(item => item.code === selected)?.[key]
    ?? languages.find(item => item.code.toLowerCase() === 'en')?.[key]
    ?? plugin.manifest?.[field] ?? (field === 'name' ? plugin.id : '')
}

export interface PluginViewOptions {
  instanceId: string
  location: 'sidebar' | 'window'
  title?: string
  icon?: PluginIcon
}

export interface PluginHomePolicy {
  defaultLocation: PluginViewOptions['location']
  locations: PluginViewOptions['location'][]
}

export function pluginHomePolicy(manifest: PluginManifest): PluginHomePolicy {
  return manifest.home ?? { defaultLocation: 'sidebar', locations: ['sidebar', 'window'] }
}

export function requirePluginHomeLocation(manifest: PluginManifest, value: unknown): PluginViewOptions['location'] {
  const policy = pluginHomePolicy(manifest)
  if (typeof value !== 'string' || !policy.locations.includes(value as PluginViewOptions['location'])) throw new Error('Invalid or unsupported plugin home location.')
  return value as PluginViewOptions['location']
}

function parsePluginHome(value: unknown): PluginHomePolicy | undefined {
  if (value === undefined) return undefined
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin home declaration.')
  const raw = value as Record<string, unknown>
  const locations = raw.locations === undefined ? ['sidebar', 'window'] : raw.locations
  if (!Array.isArray(locations) || !locations.length || locations.length > 2
    || locations.some(item => !['sidebar', 'window'].includes(item)) || new Set(locations).size !== locations.length) throw new Error('Invalid plugin home locations.')
  const defaultLocation = raw.default_location === undefined ? locations[0] : raw.default_location
  if (!locations.includes(defaultLocation)) throw new Error('Invalid plugin home default location.')
  return { defaultLocation, locations } as PluginHomePolicy
}

export function requirePluginView(value: unknown): PluginViewOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin view.')
  const input = value as Record<string, unknown>
  if (typeof input.instanceId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.instanceId)
    || !['sidebar', 'window'].includes(input.location as string)
    || (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120))) {
    throw new Error('Invalid plugin view.')
  }
  return { instanceId: input.instanceId, location: input.location as PluginViewOptions['location'], title: input.title as string | undefined,
    icon: input.icon === undefined ? undefined : requirePluginIcon(input.icon) }
}

export interface PluginManifest {
  id: string
  name: string
  pluginVersion: string
  apiVersion: number
  description: string
  ui?: string
  backend?: string
  platforms?: string[]
  lang?: string
  home?: PluginHomePolicy
  icon?: PluginIcon
  tools: PluginToolDefinition[]
  skills?: PluginSkillDefinition[]
  prompts?: PluginPromptDefinition[]
  settings?: PluginSetting[]
  widgets?: PluginWidgetDefinition[]
}

export interface PluginSkillDefinition { id: string; path: string; tools: string[] }
export interface PluginPromptDefinition extends PluginSkillDefinition {
  description: string
  scope: 'all' | 'main' | 'subagent'
}

function parseContributions(value: unknown, kind: 'skill' | 'prompt', toolIds: Set<string>): PluginSkillDefinition[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 128) throw new Error(`Invalid plugin ${kind} declarations.`)
  const items = value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || typeof raw.id !== 'string'
      || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(raw.id) || raw.id.length > 64) throw new Error(`Invalid plugin ${kind} ID.`)
    const path = requirePluginPath(raw.path)
    if (kind === 'skill' ? !path.endsWith('/SKILL.md') : !path.endsWith('.md')) throw new Error(`Invalid plugin ${kind} path.`)
    const dependencies = raw.tools ?? []
    if (!Array.isArray(dependencies) || dependencies.some(id => !toolIds.has(id)) || new Set(dependencies).size !== dependencies.length) throw new Error(`Invalid plugin ${kind} tool dependencies.`)
    const item = { id: raw.id, path, tools: dependencies }
    if (kind === 'skill') return item
    const scope = raw.scope ?? 'all'
    if (!['all', 'main', 'subagent'].includes(scope) || typeof raw.description !== 'string' || !raw.description.trim() || raw.description.length > 1024) throw new Error('Invalid plugin prompt description or scope.')
    return { ...item, description: raw.description.trim(), scope } as PluginPromptDefinition
  })
  if (new Set(items.map(item => item.id)).size !== items.length || new Set(items.map(item => item.path)).size !== items.length) throw new Error(`Duplicate plugin ${kind} declaration.`)
  return items
}

export interface PluginSummary {
  id: string
  builtin?: boolean
  manifest?: PluginManifest
  enabled: boolean
  showInTitlebar?: boolean
  error?: string
  backendStatus: 'stopped' | 'starting' | 'running' | 'failed'
  backendError?: string
  languages?: PluginLanguage[]
  languageErrors?: string[]
  skillSummaries?: PluginSkillSummary[]
}

export interface PluginSkillSummary { id: string; name: string; description: string }
export type PluginContributionKind = 'skill' | 'prompt'
export interface PluginContributionPreview { content: string; resolvedPath: string }

export interface PluginInstallPreview {
  token: string
  incoming: PluginManifest
  installed?: PluginSummary
}

export type PluginInstallResult = PluginSummary | { replacement: PluginInstallPreview }

export interface PluginsApi {
  readWidget(id: string, widgetId: string, modelConfigId?: string, action?: string): Promise<PluginWidgetContent | null>
  list(): Promise<PluginSummary[]>
  readContribution(id: string, kind: PluginContributionKind, contributionId: string): Promise<PluginContributionPreview>
  install(file?: File): Promise<PluginInstallResult | null>
  confirmInstall(token: string, deleteData?: boolean): Promise<PluginSummary>
  cancelInstall(token: string): Promise<void>
  setEnabled(id: string, enabled: boolean): Promise<void>
  setShowInTitlebar(id: string, show: boolean): Promise<void>
  uninstall(id: string, deleteData?: boolean): Promise<void>
  openWindow(id: string): Promise<void>
  startBackend(id: string): Promise<void>
  stopBackend(id: string): Promise<void>
  invoke(id: string, method: string, params?: unknown): Promise<unknown>
  onChanged(listener: () => void): () => void
}

export function requirePluginId(value: unknown): string {
  if (typeof value !== 'string' || value.length > 64 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(value)
    || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(value)) throw new Error('Invalid plugin ID.')
  return value
}

export function requirePluginPath(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024 || value.includes('\\')
    || value.split('/').some(part => !part || part === '.' || part === '..' || /[<>:"|?*]/.test(part) || [...part].some(char => char.charCodeAt(0) < 32)
      || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error('Invalid plugin relative path.')
  }
  return value
}

export function parsePluginManifest(value: unknown): PluginManifest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid PLUGIN.json.')
  const raw = value as Record<string, unknown>
  if (raw.version !== 0) throw new Error('Unsupported plugin manifest version; expected v0.')
  const id = requirePluginId(raw.id)
  if (typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 120) throw new Error('Invalid plugin name.')
  if (typeof raw.plugin_version !== 'string' || !/^\d+\.\d+\.\d+$/.test(raw.plugin_version)) throw new Error('Invalid plugin version.')
  if (raw.api_version !== PLUGIN_API_VERSION) throw new Error(`Unsupported plugin API version; expected ${PLUGIN_API_VERSION}.`)
  if (raw.description !== undefined && (typeof raw.description !== 'string' || raw.description.length > 2000)) throw new Error('Invalid plugin description.')
  const ui = raw.ui === undefined ? undefined : requirePluginPath(raw.ui)
  const backend = raw.backend === undefined ? undefined : requirePluginPath(raw.backend)
  const tools = parsePluginTools(raw.tools, Boolean(backend))
  const widgets = parsePluginWidgets(raw.widgets, Boolean(backend))
  if (tools.some(tool => pluginToolName(id, tool.id).length > 64)) {
    throw new Error('Plugin model tool names must be at most 64 characters. Shorten the plugin ID or tool ID.')
  }
  const toolIds = new Set(tools.map(tool => tool.id))
  const skills = parseContributions(raw.skills, 'skill', toolIds)
  const prompts = parseContributions(raw.prompts, 'prompt', toolIds) as PluginPromptDefinition[]
  if (!ui && !backend && !skills.length && !prompts.length) throw new Error('A plugin must provide an entry, skill or prompt.')
  if (ui && !/\.html$/i.test(ui)) throw new Error('Plugin UI entry must be HTML.')
  if (backend && !backend.endsWith('.cjs')) throw new Error('Plugin backend entry must be .cjs.')
  const platforms = raw.platforms
  if (platforms !== undefined && (!Array.isArray(platforms) || platforms.length === 0
    || platforms.some(item => !['win32', 'darwin', 'linux'].includes(item)))) throw new Error('Invalid plugin platforms.')
  return { id, name: raw.name.trim(), pluginVersion: raw.plugin_version, apiVersion: raw.api_version,
    description: raw.description as string ?? '', ui, backend, platforms: platforms as string[] | undefined,
    lang: raw.lang === undefined ? undefined : requirePluginPath(raw.lang), home: parsePluginHome(raw.home),
    icon: raw.icon === undefined ? undefined : requirePluginIcon(raw.icon),
    tools, ...(widgets.length ? { widgets } : {}), ...(skills.length ? { skills } : {}), ...(prompts.length ? { prompts } : {}),
    ...(raw.settings === undefined ? {} : { settings: parsePluginSettings(raw.settings) }) }
}

export function pluginPageUrl(manifest: PluginManifest, instanceId?: string): string {
  if (!manifest.ui) throw new Error('Plugin has no UI entry.')
  return `${PLUGIN_SCHEME}://${manifest.id}/${manifest.ui.split('/').map(encodeURIComponent).join('/')}${instanceId && instanceId !== 'main' ? `?instance=${encodeURIComponent(instanceId)}` : ''}`
}

export function requirePluginJson(value: unknown): string {
  const json = JSON.stringify(value)
  if (json === undefined || new TextEncoder().encode(json).length > PLUGIN_RPC_BYTES) throw new Error('Plugin JSON exceeds the 1 MiB limit or is invalid.')
  return json
}
