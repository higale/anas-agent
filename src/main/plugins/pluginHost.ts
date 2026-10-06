import { app, BrowserWindow, ipcMain, nativeTheme, net, protocol, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_API_VERSION, PLUGIN_SCHEME, pluginPageUrl, requirePluginJson, type PluginSummary } from '@shared/plugins'
import { getDataDir } from '../config/dataDir'
import { getAppConfigSnapshot } from '../config/appConfig'
import { handleMainIpc } from '../ipcSecurity'
import { runApplicationDataOperation } from '../applicationDataLifecycle'
import { dialogParentFromEvent, showModalOpenDialog } from '../modalDialog'
import { openExternalUrl } from '../appShell'
import { PluginStore } from './pluginStore'
import { PluginBackends } from './pluginBackend'
import { pluginSdk } from './pluginSdk'

let store: PluginStore | undefined
let backends: PluginBackends | undefined
interface PluginWindow { window: BrowserWindow; ready: Promise<void> }
const windows = new Map<string, PluginWindow>()
const pluginContents = new Map<WebContents, string>()

function changed(closeViews?: string[] | 'all'): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && !pluginContents.has(window.webContents)) window.webContents.send('plugins:changed', closeViews)
  }
}

function runtime(): { store: PluginStore; backends: PluginBackends } {
  if (!store) {
    store = new PluginStore(getDataDir())
    backends = new PluginBackends(store, changed)
  }
  return { store, backends: backends! }
}

export async function stopPluginBackends(): Promise<void> {
  await backends?.stopAll()
}

export async function closePluginHost(): Promise<void> {
  changed('all')
  for (const { window } of windows.values()) window.destroy()
  windows.clear()
  await stopPluginBackends()
  changed()
}

export function registerPluginScheme(): void {
  protocol.registerSchemesAsPrivileged([{ scheme: PLUGIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }])
}

export function registerPluginProtocol(): void {
  protocol.handle(PLUGIN_SCHEME, async request => {
    try {
      if (request.method !== 'GET') return new Response('Method not allowed', { status: 405 })
      const url = new URL(request.url)
      const { store } = runtime()
      await store.requireEnabled(url.hostname)
      const relativePath = decodeURIComponent(url.pathname.slice(1))
      if (relativePath === '_anas/sdk.js') return new Response(pluginSdk, { headers: { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-store' } })
      const path = await store.packageFile(url.hostname, relativePath)
      const response = await net.fetch(pathToFileURL(path).toString())
      const headers = new Headers(response.headers)
      headers.set('Cache-Control', 'no-store')
      headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self' https: http: ws: wss:; worker-src 'self' blob:; media-src 'self' blob: data: https: http:; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'")
      return new Response(response.body, { status: response.status, headers })
    } catch {
      return new Response('Plugin resource unavailable. Check Settings > Plugins.', { status: 404 })
    }
  })
}

async function invoke(id: string, method: unknown, params: unknown): Promise<unknown> {
  requirePluginJson(params ?? null)
  const { store, backends } = runtime()
  const input = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
  switch (method) {
    case 'host.info': {
      await store.requireEnabled(id)
      const config = await getAppConfigSnapshot()
      return { apiVersion: PLUGIN_API_VERSION, appVersion: app.getVersion(), pluginId: id,
        language: config.settings.language === 'system' ? app.getLocale() : config.settings.language,
        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', fontSize: config.settings.fontSize }
    }
    case 'host.openExternal':
      await store.requireEnabled(id)
      if (typeof input.url !== 'string' || input.url.length > 8192) throw new Error('Invalid external URL.')
      return openExternalUrl(input.url)
    case 'data.get': return store.exclusive(() => store.data(id, input.key))
    case 'data.set': return store.exclusive(() => store.data(id, input.key, true, input.value))
    case 'backend.call': {
      const prepared = await store.exclusive(() => backends.prepare(id))
      await prepared.ready
      return backends.call(id, input.method, input.params, prepared)
    }
    default: throw new Error('Unknown plugin host method.')
  }
}

async function prepareWindow(id: string): Promise<PluginWindow> {
  const manifest = await runtime().store.requireEnabled(id)
  const url = pluginPageUrl(manifest)
  const existing = windows.get(id)
  if (existing && !existing.window.isDestroyed()) { existing.window.show(); existing.window.focus(); return existing }
  const window = new BrowserWindow({
    title: manifest.name, width: 960, height: 680, minWidth: 400, minHeight: 300, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#ffffff',
    webPreferences: { preload: join(__dirname, '../preload/plugin.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  window.setMenuBarVisibility(false)
  const contents = window.webContents
  pluginContents.set(contents, id)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault() })
  window.once('closed', () => { windows.delete(id); pluginContents.delete(contents) })
  // DOM readiness does not wait for remote images/media; the shared store queue
  // protects window registration only, never page or network loading.
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false
    const cleanup = () => { clearTimeout(timer); contents.removeListener('dom-ready', loaded); window.removeListener('closed', closed) }
    const loaded = () => { if (settled) return; settled = true; cleanup(); if (!window.isDestroyed()) window.show(); resolve() }
    const closed = () => { if (settled) return; settled = true; cleanup(); reject(new Error('Plugin window closed before loading.')) }
    const failed = (error: Error) => { if (settled) return; settled = true; cleanup(); if (!window.isDestroyed()) window.destroy(); reject(error) }
    const timer = setTimeout(() => failed(new Error('Plugin window loading timed out.')), 30_000)
    contents.once('dom-ready', loaded)
    window.once('closed', closed)
    void window.loadURL(url).catch(error => {
      // Closing a page after DOM readiness can abort its remaining resources.
      if (!settled) failed(error)
    })
  })
  void ready.catch(() => undefined)
  const entry = { window, ready }
  windows.set(id, entry)
  return entry
}

export function registerPluginIpc(): void {
  handleMainIpc('plugins:list', async (): Promise<PluginSummary[]> => {
    const { store, backends } = runtime()
    return (await store.list()).map(item => ({ ...item, ...backends.status(item.id) }))
  })
  handleMainIpc('plugins:install', async event => {
    const result = await showModalOpenDialog(dialogParentFromEvent(event), {
      properties: ['openFile'], title: 'Install plugin / 安装插件',
      filters: [{ name: 'Plugin ZIP or PLUGIN.json / 插件 ZIP 或 PLUGIN.json', extensions: ['zip', 'json'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const { store } = runtime()
    const item = await store.exclusive(() => store.install(result.filePaths[0]))
    changed()
    return item
  })
  handleMainIpc('plugins:setEnabled', async (_event, id: string, enabled: boolean) => {
    const { store, backends } = runtime()
    await store.exclusive(async () => {
      await store.setEnabled(id, enabled)
      if (!enabled) { windows.get(id)?.window.destroy(); await backends.stop(id) }
    })
    changed(enabled ? undefined : [id])
  })
  handleMainIpc('plugins:uninstall', async (_event, id: string) => {
    const { store, backends } = runtime()
    await store.exclusive(async () => {
      windows.get(id)?.window.destroy()
      await backends.stop(id)
      await store.uninstall(id)
    })
    changed([id])
  })
  handleMainIpc('plugins:openWindow', async (_event, id: string) => {
    await (await runtime().store.exclusive(() => prepareWindow(id))).ready
  })
  handleMainIpc('plugins:startBackend', async (_event, id: string) => {
    await (await runtime().store.exclusive(() => runtime().backends.prepare(id))).ready
  })
  handleMainIpc('plugins:stopBackend', (_event, id: string) => runtime().store.exclusive(() => runtime().backends.stop(id)))
  handleMainIpc('plugins:invoke', (_event, id: string, method: unknown, params: unknown) => invoke(id, method, params))
  ipcMain.handle('plugin:invoke', (event, method: unknown, params: unknown) => {
    const id = pluginContents.get(event.sender)
    if (!id || event.senderFrame !== event.sender.mainFrame || !event.senderFrame.url.startsWith(`${PLUGIN_SCHEME}://${id}/`)) throw new Error('Unregistered plugin page.')
    return runApplicationDataOperation(() => invoke(id, method, params))
  })
}
