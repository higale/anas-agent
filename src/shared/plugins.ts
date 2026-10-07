import { matchLanguageCode } from './languages'

export const PLUGIN_API_VERSION = 1
export const PLUGIN_SCHEME = 'anas-plugin'
export const PLUGIN_RPC_BYTES = 1024 * 1024

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

export interface PluginSidebarView extends PluginViewOptions { pluginId: string; name: string }

export function requirePluginView(value: unknown): PluginViewOptions {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid plugin view.')
  const input = value as Record<string, unknown>
  if (typeof input.instanceId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(input.instanceId)
    || !['sidebar', 'window'].includes(input.location as string)
    || (input.title !== undefined && (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 120))) {
    throw new Error('Invalid plugin view.')
  }
  return { instanceId: input.instanceId, location: input.location as PluginViewOptions['location'], title: input.title as string | undefined }
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
}

export interface PluginSummary {
  id: string
  manifest?: PluginManifest
  enabled: boolean
  error?: string
  backendStatus: 'stopped' | 'starting' | 'running' | 'failed'
  backendError?: string
  languages?: PluginLanguage[]
  languageErrors?: string[]
}

export interface PluginsApi {
  list(): Promise<PluginSummary[]>
  install(): Promise<PluginSummary | null>
  setEnabled(id: string, enabled: boolean): Promise<void>
  uninstall(id: string, deleteData?: boolean): Promise<void>
  openWindow(id: string): Promise<void>
  startBackend(id: string): Promise<void>
  stopBackend(id: string): Promise<void>
  invoke(id: string, method: string, params?: unknown): Promise<unknown>
  onChanged(listener: (closeViews?: string[] | 'all') => void): () => void
  onOpenView(listener: (view: PluginSidebarView) => void): () => void
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
  if (!ui && !backend) throw new Error('A plugin must provide a UI or backend entry.')
  if (ui && !/\.html$/i.test(ui)) throw new Error('Plugin UI entry must be HTML.')
  if (backend && !backend.endsWith('.cjs')) throw new Error('Plugin backend entry must be .cjs.')
  const platforms = raw.platforms
  if (platforms !== undefined && (!Array.isArray(platforms) || platforms.length === 0
    || platforms.some(item => !['win32', 'darwin', 'linux'].includes(item)))) throw new Error('Invalid plugin platforms.')
  return { id, name: raw.name.trim(), pluginVersion: raw.plugin_version, apiVersion: raw.api_version,
    description: raw.description as string ?? '', ui, backend, platforms: platforms as string[] | undefined,
    lang: raw.lang === undefined ? undefined : requirePluginPath(raw.lang), home: parsePluginHome(raw.home) }
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
