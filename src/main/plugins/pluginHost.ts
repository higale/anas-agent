import { app, BrowserWindow, ipcMain, nativeTheme, net, protocol, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { PLUGIN_API_VERSION, PLUGIN_SCHEME, pluginDisplayText, pluginPageUrl, requirePluginHomeLocation, requirePluginJson, requirePluginView, type PluginSummary, type PluginViewOptions } from '@shared/plugins'
import { getDataDir } from '../config/dataDir'
import { getAppConfigSnapshot, onAppConfigChanged } from '../config/appConfig'
import { resolveConfiguredLanguage } from '../languageStore'
import { runtimeLog } from '../runtimeLogger'
import { handleMainIpc, isMainRendererWindow } from '../ipcSecurity'
import { runApplicationDataOperation } from '../applicationDataLifecycle'
import { dialogParentFromEvent, showModalOpenDialog } from '../modalDialog'
import { openExternalUrl } from '../appShell'
import { PluginStore } from './pluginStore'
import { PluginBackends } from './pluginBackend'
import { pluginSdk } from './pluginSdk'

let store: PluginStore | undefined
let backends: PluginBackends | undefined
interface PluginWindow { window: BrowserWindow; ready: Promise<void>; pluginId: string; summary: PluginSummary; customTitle?: string }
const windows = new Map<string, PluginWindow>()
const pluginContents = new Map<WebContents, string>()
let titleRevision = 0

export async function refreshPluginWindowTitles(preference: string): Promise<void> {
  const revision = ++titleRevision
  if (!windows.size) return
  const language = await resolveConfiguredLanguage(preference)
  if (revision !== titleRevision) return
  for (const entry of windows.values()) {
    if (!entry.customTitle && entry.summary.manifest?.lang && !entry.window.isDestroyed()) entry.window.setTitle(pluginDisplayText(entry.summary, language.code))
  }
}

function closeWindows(id: string): void {
  for (const entry of windows.values()) if (entry.pluginId === id) entry.window.destroy()
}

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
    case 'host.home': return store.exclusive(() => store.home(id))
    case 'host.openHome':
    case 'host.openView': {
      const prepared = await store.exclusive(async () => {
        const view: PluginViewOptions = method === 'host.openHome'
          ? { instanceId: 'main', location: (await store.home(id)).location }
          : requirePluginView(params)
        const manifest = await store.requireEnabled(id)
        if (!manifest.ui) throw new Error('Plugin has no UI entry.')
        if (view.instanceId === 'main') requirePluginHomeLocation(manifest, view.location)
        if (view.location === 'window') return prepareWindow(id, view)
        const window = BrowserWindow.getAllWindows().find(isMainRendererWindow)
        if (!window) throw new Error('Main window is unavailable.')
        window.show(); window.focus()
        const language = await resolveConfiguredLanguage((await getAppConfigSnapshot()).settings.language)
        window.webContents.send('plugins:openView', { ...view, pluginId: id, name: view.title ?? pluginDisplayText(await store.read(id), language.code) })
        return undefined
      })
      await prepared?.ready
      return null
    }
    case 'host.info': {
      await store.requireEnabled(id)
      const config = await getAppConfigSnapshot()
      const language = await resolveConfiguredLanguage(config.settings.language)
      return { apiVersion: PLUGIN_API_VERSION, appVersion: app.getVersion(), pluginId: id,
        language: language.code,
        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', fontSize: config.settings.fontSize }
    }
    case 'host.languages': return store.exclusive(() => store.languageResources(id))
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

async function prepareWindow(id: string, view?: PluginViewOptions): Promise<PluginWindow> {
  const manifest = await runtime().store.requireEnabled(id)
  if (!view || view.instanceId === 'main') requirePluginHomeLocation(manifest, 'window')
  const summary = await runtime().store.read(id)
  const language = await resolveConfiguredLanguage((await getAppConfigSnapshot()).settings.language)
  const key = JSON.stringify([id, view?.instanceId ?? 'main'])
  const url = pluginPageUrl(manifest, view?.instanceId)
  const existing = windows.get(key)
  if (existing && !existing.window.isDestroyed()) { existing.window.show(); existing.window.focus(); return existing }
  if ([...windows.values()].filter(item => item.pluginId === id).length >= 32) throw new Error('Too many plugin windows.')
  const window = new BrowserWindow({
    title: view?.title ?? pluginDisplayText(summary, language.code), width: 960, height: 680, minWidth: 400, minHeight: 300, show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#202020' : '#ffffff',
    webPreferences: { preload: join(__dirname, '../preload/plugin.js'), sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  window.setMenuBarVisibility(false)
  const contents = window.webContents
  if (view?.title || manifest.lang) window.on('page-title-updated', event => event.preventDefault())
  pluginContents.set(contents, id)
  contents.setWindowOpenHandler(() => ({ action: 'deny' }))
  contents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault() })
  window.once('closed', () => { windows.delete(key); pluginContents.delete(contents) })
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
  const entry = { window, ready, pluginId: id, summary, customTitle: view?.title }
  windows.set(key, entry)
  return entry
}

export function registerPluginIpc(): void {
  onAppConfigChanged(({ snapshot }) => {
    void refreshPluginWindowTitles(snapshot.settings.language).catch(reason => runtimeLog('warn', 'plugins', 'Failed to update plugin window languages.', { error: reason }))
  })
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
      if (!enabled) { closeWindows(id); await backends.stop(id) }
    })
    changed(enabled ? undefined : [id])
  })
  handleMainIpc('plugins:uninstall', async (_event, id: string, deleteData = false) => {
    if (typeof deleteData !== 'boolean') throw new Error('Invalid plugin data deletion option.')
    const { store, backends } = runtime()
    await store.exclusive(async () => {
      closeWindows(id)
      await backends.stop(id)
      await store.uninstall(id, deleteData)
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
