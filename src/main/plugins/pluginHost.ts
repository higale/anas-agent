import { app, BrowserWindow, ipcMain, nativeTheme, net, protocol } from 'electron'
import { pathToFileURL } from 'node:url'
import { PLUGIN_API_VERSION, PLUGIN_SCHEME, requirePluginJson, requirePluginView, type PluginSummary, type PluginViewOptions } from '@shared/plugins'
import { getDataDir } from '../config/dataDir'
import { getAppConfigSnapshot } from '../config/appConfig'
import { resolveConfiguredLanguage } from '../languageStore'
import { handleMainIpc, isMainRendererWindow } from '../ipcSecurity'
import { runApplicationDataOperation } from '../applicationDataLifecycle'
import { dialogParentFromEvent, showModalOpenDialog } from '../modalDialog'
import { openExternalUrl } from '../appShell'
import { PluginStore } from './pluginStore'
import { PluginBackends } from './pluginBackend'
import { pluginSdk } from './pluginSdk'
import type { PanelState, PanelLocation } from '@shared/panels'
import { panelViews as views } from '../panels/panelRegistry'
import { refreshPanelAppearance } from '../panels/panelHost'
import { pluginPanel } from './pluginPanel'

let store: PluginStore | undefined
let backends: PluginBackends | undefined
function changed(): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (isMainRendererWindow(window)) window.webContents.send('plugins:changed')
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
  views.closeWhere(content => content.kind === 'plugin')
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

async function invoke(id: string, method: unknown, params: unknown, caller?: PanelState): Promise<unknown> {
  if (method === 'host.openHome' || method === 'host.openView') {
    const prepared = await runApplicationDataOperation(async () => {
      requirePluginJson(params ?? null)
      const { store } = runtime()
      await refreshPanelAppearance()
      return store.exclusive(async () => {
        const options: PluginViewOptions = method === 'host.openHome'
          ? { instanceId: 'main', location: (await store.home(id)).location } : requirePluginView(params)
        const manifest = await store.requireEnabled(id)
        if (!manifest.ui) throw new Error('Plugin has no UI entry.')
        return { ready: views.open(pluginPanel(await store.read(id), options)) }
      })
    })
    await prepared.ready
    return null
  }
  if (method === 'host.moveView') {
    const location = await runApplicationDataOperation(async () => {
      const input = params as { location?: unknown } | undefined
      if (!caller || !['sidebar', 'window'].includes(input?.location as string)) throw new Error('Invalid plugin view move.')
      await runtime().store.requireEnabled(id)
      return input!.location as PanelLocation
    })
    await views.move(caller!.viewId, location)
    return null
  }
  return runApplicationDataOperation(() => invokeData(id, method, params, caller))
}

async function invokeData(id: string, method: unknown, params: unknown, caller?: PanelState): Promise<unknown> {
  requirePluginJson(params ?? null)
  const { store, backends } = runtime()
  const input = params && typeof params === 'object' && !Array.isArray(params) ? params as Record<string, unknown> : {}
  switch (method) {
    case 'host.home': return store.exclusive(() => store.home(id))
    case 'host.info': {
      await store.requireEnabled(id)
      const config = await getAppConfigSnapshot()
      const language = await resolveConfiguredLanguage(config.settings.language)
      const view = caller && views.state(caller.viewId)
      return { apiVersion: PLUGIN_API_VERSION, appVersion: app.getVersion(), pluginId: id,
        language: language.code,
        theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', fontSize: config.settings.fontSize,
        ...(view ? { view: { instanceId: view.content.kind === 'plugin' ? view.content.instanceId : undefined, location: view.location } } : {}) }
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
      if (!enabled) { views.closeWhere(content => content.kind === 'plugin' && content.pluginId === id); await backends.stop(id) }
    })
    changed()
  })
  handleMainIpc('plugins:uninstall', async (_event, id: string, deleteData = false) => {
    if (typeof deleteData !== 'boolean') throw new Error('Invalid plugin data deletion option.')
    const { store, backends } = runtime()
    await store.exclusive(async () => {
      views.closeWhere(content => content.kind === 'plugin' && content.pluginId === id)
      await backends.stop(id)
      await store.uninstall(id, deleteData)
    })
    changed()
  })
  handleMainIpc('plugins:openWindow', async (_event, id: string) => {
    await invoke(id, 'host.openView', { instanceId: 'main', location: 'window' })
  })
  handleMainIpc('plugins:startBackend', async (_event, id: string) => {
    await (await runtime().store.exclusive(() => runtime().backends.prepare(id))).ready
  })
  handleMainIpc('plugins:stopBackend', (_event, id: string) => runtime().store.exclusive(() => runtime().backends.stop(id)))
  handleMainIpc('plugins:invoke', (_event, id: string, method: unknown, params: unknown) => invoke(id, method, params))
  ipcMain.handle('plugin:invoke', (event, method: unknown, params: unknown) => {
    const caller = views.fromPage(event)
    if (caller.content.kind !== 'plugin') throw new Error('Plugin page required.')
    const { pluginId } = caller.content
    return invoke(pluginId, method, params, caller)
  })
}
