import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, WebContentsView, type WebContents, type IpcMainInvokeEvent } from 'electron'
import { panelIdentity, requirePanelBounds, type PanelContent, type PanelBounds, type PanelLayout, type PanelLocation, type PanelState, type PanelTabMenuOptions, type PanelWindowState } from '@shared/panels'
import { isMainRendererWindow, rendererLocationMatches, resolveRendererLocation, type RendererLocation } from '../ipcSecurity'
import { titleBarColors, titleBarOptions } from '../windowAppearance'
import { registerWindowZoomShortcuts } from '../zoomService'
import type { LanguageResourcesSnapshot } from '@shared/types'
import { requirePanelToolbar } from '@shared/panelToolbar'

export interface PanelDefinition {
  ownerId: string
  reuse: 'page' | 'location'
  content: PanelContent
  location: PanelLocation
  locations: PanelLocation[]
  source: RendererLocation
  preload: string
  name(language: string): string
  register?(contents: WebContents): void
  update?(contents: WebContents): void
  moved?(contents: WebContents, location: PanelLocation): void
}

interface Placement { window: BrowserWindow; bounds: PanelBounds }
interface ViewEntry {
  state: PanelState
  definition: PanelDefinition
  view: WebContentsView
  ready: Promise<void>
  operation: Promise<void>
  parent?: BrowserWindow
  window?: BrowserWindow
  visible: boolean
  closed: boolean
  dismissMenu?(): void
  action?: { requestId: string; finish(error?: Error): void }
}
interface SidebarRequest {
  entry: ViewEntry
  owner: BrowserWindow
  resolve(placement: Placement): void
  reject(error: Error): void
}
interface WindowShell {
  entry: ViewEntry
  window: BrowserWindow
  source: RendererLocation
  resources: LanguageResourcesSnapshot
  bounds?: PanelBounds
  resolve(placement: Placement): void
  reject(error: Error): void
}

/** Owns live pages independently of their display location. React only projects tabs and bounds. */
export class PanelViews {
  private entries = new Map<string, ViewEntry>()
  private pages = new Map<WebContents, ViewEntry>()
  private shells = new Map<WebContents, WindowShell>()
  private requests = new Map<string, SidebarRequest>()
  private watched = new WeakSet<BrowserWindow>()
  private appearance = { language: 'en', theme: 'light' as 'light' | 'dark', fontSize: 14 }

  constructor(private readonly loadLanguages: () => Promise<LanguageResourcesSnapshot>) {}

  list(): PanelState[] { return [...this.entries.values()].map(entry => ({ ...entry.state })) }

  state(viewId: string): PanelState { return { ...this.require(viewId).state } }

  configure(appearance: typeof this.appearance): void {
    this.appearance = appearance
    for (const entry of this.entries.values()) {
      entry.state.name = entry.definition.name(appearance.language)
      entry.window?.setTitle(entry.state.name)
    }
    for (const shell of this.shells.values()) this.updateShell(shell)
    this.changed()
  }

  fromPage(event: IpcMainInvokeEvent): PanelState {
    const entry = this.pages.get(event.sender)
    if (!entry || entry.closed || event.senderFrame !== event.sender.mainFrame
      || !rendererLocationMatches(entry.definition.source, event.senderFrame.url)) throw new Error('Unregistered panel page.')
    return { ...entry.state }
  }

  fromShell(event: IpcMainInvokeEvent): PanelWindowState {
    const shell = this.shells.get(event.sender)
    if (!shell || shell.entry.closed || event.senderFrame !== event.sender.mainFrame
      || !rendererLocationMatches(shell.source, event.senderFrame.url)) throw new Error('Unregistered panel window.')
    return { view: { ...shell.entry.state }, ...this.appearance }
  }

  shellLanguages(event: IpcMainInvokeEvent): LanguageResourcesSnapshot {
    this.fromShell(event)
    return this.shells.get(event.sender)!.resources
  }

  open(definition: PanelDefinition): Promise<void> {
    const { content, location, locations, source } = definition
    if (!locations.includes(location)) throw new Error('Unsupported panel location.')
    const existing = this.find(content, definition.reuse === 'location' ? location : undefined)
    if (existing) {
      existing.state.content = content
      existing.definition = definition
      existing.state.name = definition.name(this.appearance.language)
      existing.window?.setTitle(existing.state.name)
      definition.update?.(existing.view.webContents)
      this.changed()
      return Promise.all([this.enqueue(existing, () => this.present(existing, existing.state.location)), existing.ready]).then(() => undefined)
    }
    if ([...this.entries.values()].filter(entry => entry.definition.ownerId === definition.ownerId).length >= 64) throw new Error('Too many panels.')
    const view = new WebContentsView({ webPreferences: {
      preload: definition.preload, sandbox: true, contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false
    } })
    view.setVisible(false)
    const state: PanelState = { content, location, viewId: randomUUID(), locations, loading: true,
      name: definition.name(this.appearance.language) }
    const entry: ViewEntry = { state, definition, view, ready: Promise.resolve(), operation: Promise.resolve(), visible: false, closed: false }
    this.entries.set(state.viewId, entry)
    this.pages.set(view.webContents, entry)
    const contents = view.webContents
    definition.register?.(contents)
    definition.update?.(contents)
    const url = source.url
    let failLoad: ((error: Error) => void) | undefined
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, target) => { if (target !== url) event.preventDefault() })
    // Clear only after main-frame navigation commits. A blocked navigation must
    // not remove controls belonging to the still-running page.
    contents.on('did-navigate', () => {
      entry.action?.finish(new Error('PANEL_ACTION_UNAVAILABLE'))
      delete entry.state.toolbar
      this.changed()
    })
    contents.on('render-process-gone', () => {
      failLoad?.(new Error('PANEL_LOAD_FAILED'))
      this.close(state.viewId)
    })
    contents.once('destroyed', () => this.close(state.viewId))
    entry.ready = new Promise<void>((resolve, reject) => {
      let settled = false
      const cleanup = () => { failLoad = undefined; clearTimeout(timer); contents.removeListener('dom-ready', loaded); contents.removeListener('destroyed', destroyed) }
      const finish = (error?: Error) => { if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve() }
      const loaded = () => finish()
      const destroyed = () => finish(new Error('PANEL_CLOSED'))
      const timer = setTimeout(() => finish(new Error('PANEL_LOAD_FAILED')), 30_000)
      failLoad = finish
      contents.once('dom-ready', loaded)
      contents.once('destroyed', destroyed)
      void contents.loadURL(url).catch(error => finish(error))
    })
    entry.ready = entry.ready.then(() => {
      this.require(state.viewId)
      delete state.loading
      // Layout continues to update while loading. Reveal only in the current
      // placement, without restoring an old selection or stealing focus.
      view.setVisible(entry.visible)
      this.changed()
    })
    return Promise.all([this.enqueue(entry, () => this.present(entry, location)), entry.ready])
      .then(() => undefined).catch(error => { this.close(state.viewId); throw error })
  }

  move(viewId: string, location: PanelLocation): Promise<void> {
    const entry = this.require(viewId)
    if (!entry.state.locations.includes(location)) throw new Error('Invalid or unsupported panel location.')
    return this.enqueue(entry, () => this.present(entry, location))
  }

  close(viewId: string): void {
    const entry = this.entries.get(viewId)
    if (!entry || entry.closed) return
    entry.dismissMenu?.()
    entry.closed = true
    entry.action?.finish(new Error('PANEL_CLOSED'))
    this.entries.delete(viewId)
    this.pages.delete(entry.view.webContents)
    for (const request of this.requests.values()) if (request.entry === entry) request.reject(new Error('PANEL_CLOSED'))
    for (const shell of [...this.shells.values()]) if (shell.entry === entry) {
      shell.reject(new Error('PANEL_CLOSED'))
      this.shells.delete(shell.window.webContents)
      if (!shell.window.isDestroyed()) shell.window.destroy()
    }
    if (entry.parent && !entry.parent.isDestroyed()) entry.parent.contentView.removeChildView(entry.view)
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close({ waitForBeforeUnload: false })
    this.changed()
  }

  closeWhere(predicate: (content: PanelContent) => boolean): void {
    for (const entry of [...this.entries.values()]) if (predicate(entry.state.content)) this.close(entry.state.viewId)
  }

  closeAll(): void { this.closeWhere(() => true) }

  /** Native menus can overlap the content view without hiding or resizing it. */
  showTabMenu(owner: BrowserWindow, viewId: string, options: PanelTabMenuOptions): Promise<boolean> {
    const entry = this.require(viewId)
    const available = () => !entry.closed && !owner.isDestroyed() && entry.parent === owner && entry.state.location === 'sidebar' && !entry.state.pendingLocation
    if (!available()) throw new Error('PANEL_TARGET_UNAVAILABLE')
    for (const item of this.entries.values()) if (item.parent === owner) item.dismissMenu?.()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (selected = false) => {
        if (settled) return
        settled = true
        delete entry.dismissMenu
        owner.removeListener('hide', dismiss)
        owner.removeListener('closed', dismiss)
        owner.webContents.removeListener('did-start-navigation', dismiss)
        resolve(selected && available())
      }
      const menu = Menu.buildFromTemplate([{ label: options.closeLabel.replaceAll('&', '&&'), click: () => finish(true) }])
      const dismiss = () => { finish(); if (!owner.isDestroyed()) menu.closePopup(owner) }
      entry.dismissMenu = dismiss
      owner.on('hide', dismiss)
      owner.on('closed', dismiss)
      owner.webContents.on('did-start-navigation', dismiss)
      const zoom = owner.webContents.getZoomFactor()
      const origin = owner.getContentBounds()
      const position = options.position ? { x: Math.round(origin.x + options.position.x * zoom), y: Math.round(origin.y + options.position.y * zoom) } : {}
      try {
        menu.popup({ window: owner, ...position, callback: () => finish() })
      } catch (error) {
        reject(error)
        dismiss()
      }
    })
  }

  pageState(event: IpcMainInvokeEvent): PanelWindowState {
    return { view: this.fromPage(event), ...this.appearance }
  }

  setToolbar(viewId: string, value: unknown): void {
    const entry = this.require(viewId)
    entry.state.toolbar = requirePanelToolbar(value)
    this.changed()
  }

  invokeToolbarAction(viewId: string, actionId: unknown): Promise<void> {
    const entry = this.require(viewId)
    const action = entry.state.toolbar?.actions.find(item => item.id === actionId)
    if (!action || action.disabled || entry.action || entry.state.loading || entry.state.pendingLocation
      || entry.state.location !== 'window' || entry.parent !== entry.window) throw new Error('PANEL_ACTION_UNAVAILABLE')
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const finish = (error?: Error) => {
        if (entry.action?.requestId !== requestId) return
        clearTimeout(timer)
        delete entry.action
        delete entry.state.pendingActionId
        this.changed()
        if (error) reject(error); else resolve()
      }
      // A timeout cannot cancel page code. Keep the action locked until its real
      // completion (or page teardown), rather than allowing a duplicate operation.
      const timer = setTimeout(() => reject(new Error('PANEL_ACTION_TIMEOUT')), 30_000)
      entry.action = { requestId, finish }
      entry.state.pendingActionId = action.id
      this.changed()
      try { entry.view.webContents.send('panel-toolbar:action', { requestId, actionId: action.id }) }
      catch { finish(new Error('PANEL_ACTION_FAILED')) }
    })
  }

  completeToolbarAction(viewId: string, requestId: unknown, failed: unknown): void {
    const entry = this.require(viewId)
    if (typeof requestId !== 'string' || typeof failed !== 'boolean') throw new Error('Invalid panel action result.')
    if (entry.action?.requestId === requestId) entry.action.finish(failed ? new Error('PANEL_ACTION_FAILED') : undefined)
  }

  updateContent(viewId: string, content: PanelContent, presentation?: Pick<PanelDefinition, 'name' | 'update'>): void {
    const entry = this.require(viewId)
    const conflict = this.find(content)
    if (conflict && conflict !== entry) throw new Error('PANEL_CONFLICT')
    entry.state.content = content
    entry.definition = { ...entry.definition, content, ...presentation }
    presentation?.update?.(entry.view.webContents)
    entry.state.name = entry.definition.name(this.appearance.language)
    entry.window?.setTitle(entry.state.name)
    this.changed()
  }

  pageContent(contents: WebContents): PanelContent | undefined { return this.pages.get(contents)?.state.content }
  pageOwner(contents: WebContents): BrowserWindow | undefined { return this.pages.get(contents)?.parent }
  escape(contents: WebContents): void {
    const entry = this.pages.get(contents)
    if (entry?.state.location === 'sidebar' && entry.view.getVisible() && entry.parent && !entry.parent.isDestroyed()) {
      entry.parent.webContents.send('panels:escape', entry.state.viewId)
    }
  }
  notifyPageChanged(contents: WebContents): void {
    const entry = this.pages.get(contents)
    if (entry && !contents.isDestroyed()) contents.send('panel-content:changed', { view: { ...entry.state }, ...this.appearance })
  }

  setLayouts(owner: BrowserWindow, layouts: PanelLayout[]): void {
    if (!Array.isArray(layouts)) throw new Error('Invalid panel layouts.')
    for (const layout of layouts) {
      if (!layout || typeof layout !== 'object' || typeof layout.viewId !== 'string'
        || (layout.requestId !== undefined && typeof layout.requestId !== 'string')) throw new Error('Invalid panel layout.')
      const bounds = requirePanelBounds(layout.bounds)
      const request = layout.requestId ? this.requests.get(layout.requestId) : undefined
      if (request && request.owner === owner && request.entry.state.viewId === layout.viewId && bounds) request.resolve({ window: owner, bounds })
      const entry = this.entries.get(layout.viewId)
      if (!entry || entry.parent !== owner || entry.state.location !== 'sidebar') continue
      entry.state.sidebarVisible = !!bounds
      this.layout(entry, owner, bounds)
    }
  }

  cancelRequest(owner: BrowserWindow, requestId: string): void {
    const request = this.requests.get(requestId)
    if (request?.owner === owner) request.reject(new Error('PANEL_TARGET_UNAVAILABLE'))
  }

  hasRequest(owner: BrowserWindow, requestId: string): boolean {
    return this.requests.get(requestId)?.owner === owner
  }

  setWindowLayout(sender: WebContents, bounds: unknown): void {
    const shell = this.shells.get(sender)
    if (!shell) throw new Error('Unregistered panel window.')
    const value = requirePanelBounds(bounds)
    if (value) { shell.bounds = value; shell.resolve({ window: shell.window, bounds: value }) }
    if (shell.entry.parent === shell.window) this.layout(shell.entry, shell.window, value)
  }

  private require(viewId: string): ViewEntry {
    const entry = this.entries.get(viewId)
    if (!entry || entry.closed) throw new Error('PANEL_CLOSED')
    return entry
  }

  private find(content: PanelContent, location?: PanelLocation): ViewEntry | undefined {
    return [...this.entries.values()].find(entry => panelIdentity(entry.state.content) === panelIdentity(content)
      && (!location || entry.state.location === location || entry.state.pendingLocation === location))
  }

  private enqueue(entry: ViewEntry, action: () => Promise<void>): Promise<void> {
    const result = entry.operation.catch(() => undefined).then(() => { this.require(entry.state.viewId); return action() })
    entry.operation = result
    return result
  }

  private async present(entry: ViewEntry, location: PanelLocation): Promise<void> {
    entry.dismissMenu?.()
    const conflict = this.find(entry.state.content, location)
    if (conflict && conflict !== entry) throw new Error('PANEL_CONFLICT')
    if (location === 'window' && entry.window && !entry.window.isDestroyed()) {
      entry.window.show(); entry.window.focus()
      if (entry.view.getVisible()) entry.view.webContents.focus()
      return
    }
    if (location === 'window' && [...this.entries.values()].filter(item => item !== entry && item.definition.ownerId === entry.definition.ownerId
      && (item.state.location === 'window' || item.state.pendingLocation === 'window')).length >= 32) throw new Error('Too many panel windows.')
    const oldParent = entry.parent
    const oldWindow = entry.window
    const oldLocation = entry.state.location
    let sourceLayout: { bounds: PanelBounds; visible: boolean } | undefined
    let target: Placement | undefined
    entry.state.pendingLocation = location
    this.changed()
    try {
      // Prepare and show the host immediately; page loading is not part of the
      // placement queue, so even a loading page can be moved or closed.
      target = location === 'sidebar' ? await this.prepareSidebar(entry) : await this.prepareWindow(entry)
      this.require(entry.state.viewId)
      if (target.window.isDestroyed()) throw new Error('PANEL_TARGET_UNAVAILABLE')
      sourceLayout = { bounds: entry.view.getBounds(), visible: entry.visible }
      entry.view.setVisible(false)
      if (oldParent && !oldParent.isDestroyed()) oldParent.contentView.removeChildView(entry.view)
      target.window.contentView.addChildView(entry.view)
      entry.parent = target.window
      entry.window = location === 'window' ? target.window : undefined
      entry.state.location = location
      entry.state.sidebarVisible = location === 'sidebar'
      this.layout(entry, target.window, target.bounds)
      target.window.show(); target.window.focus()
      if (entry.view.getVisible()) entry.view.webContents.focus()
      this.watchParent(target.window)
      if (oldWindow && oldWindow !== target.window && !oldWindow.isDestroyed()) oldWindow.destroy()
      entry.definition.moved?.(entry.view.webContents, location)
    } catch (error) {
      if (!entry.closed) {
        // Preparing a destination does not detach the source; preserve any live
        // resize/hide changes made there while the destination was loading.
        if (sourceLayout) {
          if (target && !target.window.isDestroyed()) target.window.contentView.removeChildView(entry.view)
          entry.parent = oldParent; entry.window = oldWindow; entry.state.location = oldLocation
          entry.state.sidebarVisible = oldLocation === 'sidebar' && sourceLayout.visible
          if (oldParent && !oldParent.isDestroyed()) {
            oldParent.contentView.addChildView(entry.view)
            entry.visible = sourceLayout.visible
            entry.view.setBounds(sourceLayout.bounds); entry.view.setVisible(entry.visible && !entry.state.loading)
          }
        }
        if (target && location === 'window' && target.window !== oldWindow && !target.window.isDestroyed()) target.window.destroy()
      }
      throw error
    } finally {
      delete entry.state.pendingLocation
      this.changed()
    }
  }

  private prepareSidebar(entry: ViewEntry): Promise<Placement> {
    const owner = BrowserWindow.getAllWindows().find(isMainRendererWindow)
    if (!owner) return Promise.reject(new Error('PANEL_TARGET_UNAVAILABLE'))
    this.watchParent(owner)
    const requestId = randomUUID()
    const result = new Promise<Placement>((resolve, reject) => {
      const finish = (placement?: Placement, error?: Error) => {
        clearTimeout(timer); this.requests.delete(requestId)
        if (placement) resolve(placement); else reject(error)
      }
      const timer = setTimeout(() => finish(undefined, new Error('PANEL_TARGET_UNAVAILABLE')), 15_000)
      this.requests.set(requestId, { entry, owner, resolve: placement => finish(placement), reject: error => finish(undefined, error) })
    })
    owner.show(); owner.focus()
    owner.webContents.send('panels:open', { requestId, view: { ...entry.state, location: 'sidebar' } })
    return result
  }

  private async prepareWindow(entry: ViewEntry): Promise<Placement> {
    // Prepared resources keep renderer acknowledgements independent of the data
    // lock, including while a backup is queued.
    const resources = await this.loadLanguages()
    this.require(entry.state.viewId)
    const rendererFile = join(__dirname, '../renderer/panel-window.html')
    const source = resolveRendererLocation({ isPackaged: app.isPackaged, rendererFile,
      rendererUrl: !app.isPackaged && process.env.ELECTRON_RENDERER_URL
        ? new URL('panel-window.html', process.env.ELECTRON_RENDERER_URL).toString() : undefined })
    const window = new BrowserWindow({ title: entry.state.name, width: 960, height: 680, minWidth: 400, minHeight: 300, show: false,
      backgroundColor: titleBarColors().backgroundColor, ...titleBarOptions({ compact: true }),
      webPreferences: { preload: join(__dirname, '../preload/panelWindow.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
    window.setMenuBarVisibility(false)
    registerWindowZoomShortcuts(window)
    window.on('page-title-updated', event => event.preventDefault())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    return new Promise<Placement>((resolve, reject) => {
      let settled = false
      const finish = (placement?: Placement, error?: Error) => {
        if (settled) return
        settled = true; clearTimeout(timer)
        if (placement) resolve(placement)
        else { if (!window.isDestroyed()) window.destroy(); reject(error) }
      }
      const timer = setTimeout(() => finish(undefined, new Error('PANEL_LOAD_FAILED')), 30_000)
      this.shells.set(window.webContents, { entry, window, source, resources, resolve: placement => finish(placement), reject: error => finish(undefined, error) })
      const contents = window.webContents
      window.once('closed', () => {
        this.shells.delete(contents)
        finish(undefined, new Error('PANEL_CLOSED'))
        if (entry.window === window) this.close(entry.state.viewId)
      })
      void window.loadURL(source.url).catch(error => finish(undefined, error))
    })
  }

  private layout(entry: ViewEntry, owner: BrowserWindow, bounds: PanelBounds | null): void {
    if (!bounds || owner.isDestroyed()) {
      entry.visible = false
      if (!owner.isDestroyed() && entry.view.webContents.isFocused()) owner.webContents.focus()
      entry.view.setVisible(false)
      return
    }
    const zoom = owner.webContents.getZoomFactor()
    const [width, height] = owner.getContentSize()
    const x = Math.max(0, Math.min(width, Math.round(bounds.x * zoom)))
    const y = Math.max(0, Math.min(height, Math.round(bounds.y * zoom)))
    const size = { width: Math.max(0, Math.min(width - x, Math.round(bounds.width * zoom))),
      height: Math.max(0, Math.min(height - y, Math.round(bounds.height * zoom))) }
    entry.view.setBounds({ x, y, ...size })
    entry.view.webContents.setZoomFactor(zoom)
    entry.visible = size.width > 0 && size.height > 0
    entry.view.setVisible(entry.visible && !entry.state.loading)
  }

  private watchParent(window: BrowserWindow): void {
    if (this.watched.has(window)) return
    this.watched.add(window)
    window.once('closed', () => {
      for (const request of [...this.requests.values()]) if (request.owner === window) request.reject(new Error('PANEL_TARGET_UNAVAILABLE'))
      for (const entry of [...this.entries.values()]) if (entry.parent === window) this.close(entry.state.viewId)
    })
    if (isMainRendererWindow(window)) window.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) for (const entry of this.entries.values()) if (entry.parent === window) {
        entry.visible = false
        entry.view.setVisible(false)
      }
    })
  }

  private updateShell(shell: WindowShell): void {
    if (!shell.window.isDestroyed()) shell.window.webContents.send('panel-window:changed', { view: { ...shell.entry.state }, ...this.appearance })
  }

  private changed(): void {
    for (const window of BrowserWindow.getAllWindows()) if (isMainRendererWindow(window)) window.webContents.send('panels:changed', this.list())
    for (const shell of this.shells.values()) this.updateShell(shell)
    for (const entry of this.entries.values()) this.notifyPageChanged(entry.view.webContents)
  }
}
