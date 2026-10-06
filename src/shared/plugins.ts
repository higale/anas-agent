export const PLUGIN_API_VERSION = 1
export const PLUGIN_SCHEME = 'anas-plugin'
export const PLUGIN_RPC_BYTES = 1024 * 1024

export interface PluginManifest {
  id: string
  name: string
  pluginVersion: string
  apiVersion: number
  description: string
  ui?: string
  backend?: string
  platforms?: string[]
}

export interface PluginSummary {
  id: string
  manifest?: PluginManifest
  enabled: boolean
  error?: string
  backendStatus: 'stopped' | 'starting' | 'running' | 'failed'
  backendError?: string
}

export interface PluginsApi {
  list(): Promise<PluginSummary[]>
  install(): Promise<PluginSummary | null>
  setEnabled(id: string, enabled: boolean): Promise<void>
  uninstall(id: string): Promise<void>
  openWindow(id: string): Promise<void>
  startBackend(id: string): Promise<void>
  stopBackend(id: string): Promise<void>
  invoke(id: string, method: string, params?: unknown): Promise<unknown>
  onChanged(listener: (closeViews?: string[] | 'all') => void): () => void
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
    description: raw.description as string ?? '', ui, backend, platforms: platforms as string[] | undefined }
}

export function pluginPageUrl(manifest: PluginManifest): string {
  if (!manifest.ui) throw new Error('Plugin has no UI entry.')
  return `${PLUGIN_SCHEME}://${manifest.id}/${manifest.ui.split('/').map(encodeURIComponent).join('/')}`
}

export function requirePluginJson(value: unknown): string {
  const json = JSON.stringify(value)
  if (json === undefined || new TextEncoder().encode(json).length > PLUGIN_RPC_BYTES) throw new Error('Plugin JSON exceeds the 1 MiB limit or is invalid.')
  return json
}
