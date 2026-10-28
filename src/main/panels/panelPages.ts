import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { app, BrowserWindow, screen, type IpcMainInvokeEvent, type Point, type WebContents } from 'electron'
import { panelIdentity, type PanelContent, type PanelLocation, type PanelMoveOptions, type PanelState, type PanelWindowState, type PanelWindowShellState, type PanelPreferences } from '@shared/panels'
import { requirePanelJson, requirePanelSize, type PanelJson, type PanelPageContext, type PanelPageCommand, type PanelPagePhase } from '@shared/panelLifecycle'
import { findPanelToolbarAction, requirePanelToolbar, type PanelToolbar } from '@shared/panelToolbar'
import type { LanguageResourcesSnapshot, Project } from '@shared/types'
import { assertTrustedIpcEvent, isMainRendererWindow, rendererLocationMatches, resolveRendererLocation, registerContentRenderer, type RendererLocation } from '../ipcSecurity'
import { titleBarColors, titleBarOptions } from '../windowAppearance'
import { registerWindowZoomShortcuts } from '../zoomService'
import { registerMacWindowMoveSizeGuard } from '../macWindowMoveSize'
import { registerNativeContextMenu } from '../appShell'
import { builtinPanelCanInvoke } from './builtinPanelAccess'
import { runtimeLog } from '../runtimeLogger'

export interface PanelDefinition {
  ownerId: string
  content: PanelContent
  location: PanelLocation
  locations: PanelLocation[]
  pluginUrl?: string
  icon?: PanelState['icon']
  project?: Project
  name(language: string, project?: Project): string
}
interface Deferred<T> { promise: Promise<T>; resolve(value: T): void; reject(error: Error): void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void, reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  // A page can fail before its caller starts awaiting readiness.
  void promise.catch(() => undefined)
  return { promise, resolve, reject }
}
function panelCancellation(signal?: AbortSignal): Error {
  return new Error(signal?.reason === 'PANEL_LOAD_FAILED' ? 'PANEL_LOAD_FAILED' : 'PANEL_CLOSED')
}
interface Page {
  id: string
  entry: Entry
  owner: BrowserWindow
  location: PanelLocation
  phase: PanelPagePhase
  restoreState: PanelJson
  transferId?: string
  toolbar?: PanelToolbar
  ready: Deferred<void>
}
interface Entry {
  state: PanelState
  definition: PanelDefinition
  source?: Page
  candidate?: Page
  operation: Promise<void>
  transfer?: AbortController
  closing?: Promise<void>
}
interface Shell { entry: Entry; window: BrowserWindow; source: RendererLocation; resources: LanguageResourcesSnapshot; atCursor: boolean; resizeRevision: number; fitting: number }
interface SidebarRequest { entry: Entry; owner: BrowserWindow; finish(error?: Error): void }
interface Pending { page: Page; finish(value: PanelJson, error?: Error): void }

/** Owns identities and asynchronous handoffs. Renderers own ordinary DOM pages. */
export class PanelPages {
  private entries = new Map<string, Entry>()
  private pages = new Map<string, Page>()
  private shells = new Map<WebContents, Shell>()
  private requests = new Map<string, SidebarRequest>()
  private pending = new Map<string, Pending>()
  private activity = new WeakMap<BrowserWindow, { visibleId: string | null; interactionId: string | null }>()
  private listeners = new Set<() => void>()
  onChanged(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener) } }
  private watched = new WeakSet<BrowserWindow>()
  private appearance = { language: 'en', theme: 'light' as 'light' | 'dark', fontSize: 14 }
  private preferences: PanelPreferences = { diffViewMode: 'inline', diffFoldUnchanged: true, diffWordWrap: true }

  constructor(private readonly loadLanguages: () => Promise<LanguageResourcesSnapshot>) {}
  private view(entry: Entry): PanelState {
    const page = entry.source
    const selected = page && this.activity.get(page.owner)
    const visible = !!page && page.phase === 'active' && !page.owner.isDestroyed()
      && page.owner.isVisible() && !page.owner.isMinimized()
      && (page.location === 'window' || selected?.visibleId === entry.state.viewId)
    const active = visible && page!.owner.isFocused()
      && (page!.location === 'window' || selected?.interactionId === entry.state.viewId)
    return { ...entry.state, activity: { visible, active } }
  }
  setActivity(event: IpcMainInvokeEvent, visibleId: unknown, interactionId: unknown): void {
    const owner = this.assertHost(event)
    if ((visibleId !== null && typeof visibleId !== 'string') || (interactionId !== null && typeof interactionId !== 'string')) throw new Error('Invalid panel activity.')
    // A selection can arrive while its page is still loading. It must belong to this window once created.
    const entry = visibleId ? this.entries.get(visibleId) : undefined
    if (entry?.source && entry.source.owner !== owner && entry.candidate?.owner !== owner && !entry.transfer) throw new Error('PANEL_TARGET_UNAVAILABLE')
    if (interactionId !== null && interactionId !== visibleId) interactionId = null
    const next = { visibleId: visibleId as string | null, interactionId: interactionId as string | null }
    const previous = this.activity.get(owner)
    if (previous?.visibleId === next.visibleId && previous?.interactionId === next.interactionId) return
    this.activity.set(owner, next); this.watch(owner); this.changed()
  }
  list(): PanelState[] { return [...this.entries.values()].map(entry => this.view(entry)) }
  state(id: string): PanelState { return this.view(this.require(id)) }
  configure(appearance: typeof this.appearance, preferences?: PanelPreferences): void {
    this.appearance = appearance
    if (preferences) this.preferences = preferences
    for (const entry of this.entries.values()) {
      entry.state.name = entry.definition.name(appearance.language, entry.definition.project)
      for (const page of [entry.source, entry.candidate]) if (page?.location === 'window' && !page.owner.isDestroyed()) page.owner.setTitle(entry.state.name)
    }
    this.changed()
  }
  updateProject(project: Project): void {
    for (const entry of this.entries.values()) if (entry.definition.project?.id === project.id) {
      entry.definition.project = project
      entry.state.name = entry.definition.name(this.appearance.language, entry.definition.project)
    }
    this.changed()
  }
  assertHost(event: IpcMainInvokeEvent): BrowserWindow {
    if (event.senderFrame !== event.sender.mainFrame || !event.senderFrame) throw new Error('Unregistered panel host.')
    const shell = this.shells.get(event.sender)
    if (shell) {
      if (!rendererLocationMatches(shell.source, event.senderFrame.url)) throw new Error('Invalid panel window source.')
      return shell.window
    }
    assertTrustedIpcEvent(event)
    const owner = BrowserWindow.fromWebContents(event.sender)
    if (!owner || !isMainRendererWindow(owner)) throw new Error('Unregistered panel host.')
    return owner
  }
  private page(event: IpcMainInvokeEvent, pageId: unknown): Page {
    const owner = this.assertHost(event)
    const page = typeof pageId === 'string' ? this.pages.get(pageId) : undefined
    if (!page || page.owner !== owner) throw new Error('PANEL_CLOSED')
    return page
  }
  fromPage(event: IpcMainInvokeEvent, pageId: unknown): PanelState { return { ...this.page(event, pageId).entry.state } }
  pageState(event: IpcMainInvokeEvent, pageId: unknown): PanelWindowState { return { view: this.fromPage(event, pageId), ...this.appearance } }
  pageContent(pageId: string): PanelContent | undefined { return this.pages.get(pageId)?.entry.state.content }
  private context(page: Page): PanelPageContext {
    const bounds = page.location === 'window' ? page.owner.getNormalBounds() : undefined
    // Locate oversized windows by their title bar, not by the largest screen overlap.
    const display = bounds ? screen.getDisplayNearestPoint({ x: bounds.x + Math.min(80, bounds.width / 2), y: bounds.y + 16 }) : undefined
    return { panelId: page.entry.state.viewId, pageId: page.id, view: this.view(page.entry),
      location: page.location, phase: page.phase, transferId: page.transferId, restoreState: page.restoreState,
      windowMode: page.location === 'window' ? page.owner.isFullScreen() ? 'fullscreen' : page.owner.isMaximized() ? 'maximized' : 'normal' : undefined,
      windowResizeRevision: page.location === 'window' ? this.shells.get(page.owner.webContents)?.resizeRevision : undefined,
      windowPlacement: bounds && display ? { displayId: display.id, x: bounds.x - display.workArea.x, y: bounds.y - display.workArea.y } : undefined,
      pluginUrl: page.entry.definition.pluginUrl, project: page.entry.definition.project,
      preferences: this.preferences, ...this.appearance }
  }
  pageContext(event: IpcMainInvokeEvent, pageId: unknown): PanelPageContext { return this.context(this.page(event, pageId)) }
  ownedPages(event: IpcMainInvokeEvent): PanelPageContext[] {
    const owner = this.assertHost(event)
    return [...this.pages.values()].filter(page => page.owner === owner).map(page => this.context(page))
  }
  pageReady(event: IpcMainInvokeEvent, pageId: unknown): void { this.page(event, pageId).ready.resolve() }
  pageFailed(event: IpcMainInvokeEvent, pageId: unknown): void {
    const page = this.page(event, pageId)
    page.ready.reject(new Error('PANEL_LOAD_FAILED'))
    if (page.entry.candidate === page) page.entry.transfer?.abort('PANEL_LOAD_FAILED')
  }
  private shellState(shell: Shell): PanelWindowShellState {
    return { view: { ...shell.entry.state, loading: !!shell.entry.state.loading || shell.entry.source?.owner !== shell.window },
      ...this.appearance, fullScreen: shell.window.isFullScreen() }
  }
  fromShell(event: IpcMainInvokeEvent): PanelWindowShellState {
    this.assertHost(event)
    const shell = this.shells.get(event.sender)
    if (!shell) throw new Error('Unregistered panel window.')
    return this.shellState(shell)
  }
  setShellFullScreen(event: IpcMainInvokeEvent, fullScreen: unknown): void {
    this.fromShell(event)
    if (typeof fullScreen !== 'boolean') throw new Error('Invalid fullscreen state.')
    this.shells.get(event.sender)!.window.setFullScreen(fullScreen)
  }
  shellLanguages(event: IpcMainInvokeEvent): LanguageResourcesSnapshot {
    this.fromShell(event)
    return this.shells.get(event.sender)!.resources
  }
  async open(definition: PanelDefinition): Promise<void> {
    if (!definition.locations.includes(definition.location)) throw new Error('PANEL_TARGET_UNAVAILABLE')
    const existing = [...this.entries.values()].find(entry => panelIdentity(entry.state.content) === panelIdentity(definition.content))
    if (existing?.closing) {
      await existing.closing
      return this.open(definition)
    }
    if (existing) {
      // A later open must not abort the first page before it can become active.
      if (!existing.source) { await existing.operation; return this.open(definition) }
      this.updateContent(existing.state.viewId, definition.content, definition)
      if (existing.source?.location === 'window') { existing.source.owner.show(); existing.source.owner.focus() }
      else if (existing.source) await this.prepareSidebar(existing)
      return existing.operation
    }
    if ([...this.entries.values()].filter(entry => entry.definition.ownerId === definition.ownerId).length >= 64) throw new Error('Too many panel pages.')
    const entry: Entry = { state: { viewId: randomUUID(), content: definition.content, location: definition.location,
      locations: definition.locations, name: definition.name(this.appearance.language, definition.project), icon: definition.icon, loading: true },
      definition, operation: Promise.resolve() }
    this.entries.set(entry.state.viewId, entry)
    this.changed()
    return this.enqueue(entry, async () => {
      const abort = new AbortController(); entry.transfer = abort
      let owner: BrowserWindow | undefined
      try {
        owner = definition.location === 'window' ? await this.prepareWindow(entry, undefined, abort.signal) : await this.prepareSidebar(entry, abort.signal)
        this.check(entry, abort.signal)
        const page = this.createPage(entry, owner, definition.location, null)
        entry.candidate = page
        this.changed()
        await this.waitReady(page, abort.signal)
        await this.command(page, 'activate', null, abort.signal)
        this.check(entry, abort.signal)
        entry.source = page; delete entry.candidate
        page.phase = 'active'
        entry.state.toolbar = page.toolbar
        entry.state.loading = false
        owner.show()
        this.changed()
      } catch (error) {
        this.removeEntry(entry)
        if (owner && definition.location === 'window' && !owner.isDestroyed()) owner.destroy()
        throw error
      } finally { if (entry.transfer === abort) delete entry.transfer }
    })
  }
  move(viewId: string, location: PanelLocation, options?: PanelMoveOptions): Promise<void> {
    const entry = this.require(viewId)
    if (!entry.state.locations.includes(location) || (options?.atCursor && location !== 'window')) throw new Error('PANEL_TARGET_UNAVAILABLE')
    const position = options?.atCursor ? screen.getCursorScreenPoint() : undefined
    return this.enqueue(entry, () => this.transfer(entry, location, position))
  }
  private async transfer(entry: Entry, location: PanelLocation, position?: Point): Promise<void> {
    const source = entry.source
    if (!source || entry.state.pendingActionId) throw new Error('PANEL_ACTION_UNAVAILABLE')
    if (source.location === location) {
      if (location === 'sidebar') await this.prepareSidebar(entry)
      else { source.owner.show(); source.owner.focus() }
      return
    }
    const abort = new AbortController(), transferId = randomUUID(), targetPageId = randomUUID()
    entry.transfer = abort; entry.state.pendingLocation = location
    let targetOwner: BrowserWindow | undefined, target: Page | undefined, committed = false
    this.changed()
    try {
      // Choose/prepare a destination before freezing the source, including unsaved settings confirmation.
      targetOwner = location === 'window' ? await this.prepareWindow(entry, position, abort.signal) : await this.prepareSidebar(entry, abort.signal)
      this.check(entry, abort.signal)
      source.phase = 'suspended'; source.transferId = transferId; this.changed()
      const restore = await this.command(source, 'prepare', { location, targetPageId }, abort.signal)
      this.check(entry, abort.signal)
      target = this.createPage(entry, targetOwner, location, restore, targetPageId, transferId)
      entry.candidate = target; this.changed()
      await this.waitReady(target, abort.signal)
      await this.command(target, 'activate', null, abort.signal)
      this.check(entry, abort.signal)
      entry.source = target; delete entry.candidate
      target.phase = 'active'; delete target.transferId
      entry.state.location = location; entry.state.toolbar = target.toolbar
      delete entry.state.pendingLocation
      committed = true; this.changed()
      targetOwner.show(); targetOwner.focus()
      // The target owns input now. Releasing the old presentation cannot terminate resources.
      try { await this.command(source, 'dispose', { reason: 'moved' }, undefined, 5000) }
      catch { runtimeLog('warn', 'panels', 'Source page cleanup did not acknowledge completion.') }
      finally {
        this.removePage(source)
        if (source.location === 'window' && !source.owner.isDestroyed()) source.owner.destroy()
      }
    } catch (error) {
      if (!committed) {
        if (target) this.removePage(target)
        delete entry.candidate
        if (targetOwner && location === 'window' && !targetOwner.isDestroyed()) targetOwner.destroy()
        if (this.entries.has(entry.state.viewId) && !entry.closing && source.phase === 'suspended') {
          // Cancelled targets are gone before the source reacquires its resource.
          await this.command(source, 'resume', { targetPageId }, undefined, 15000)
          source.phase = 'active'; delete source.transferId; this.changed()
        }
      }
      throw error
    } finally {
      if (entry.transfer === abort) delete entry.transfer
      delete entry.state.pendingLocation
      this.changed()
    }
  }
  reorder(viewId: string, beforeViewId: string | null): void {
    const entry = this.require(viewId), before = beforeViewId ? this.require(beforeViewId) : undefined
    if ([entry, ...(before ? [before] : [])].some(value => value.state.location !== 'sidebar' || value.state.pendingLocation)) throw new Error('PANEL_TARGET_UNAVAILABLE')
    if (entry === before) return
    const list = [...this.entries].filter(([id]) => id !== viewId)
    list.splice(beforeViewId === null ? list.length : list.findIndex(([id]) => id === beforeViewId), 0, [viewId, entry])
    this.entries = new Map(list); this.changed()
  }
  async close(viewId: string, force = false): Promise<void> {
    const entry = this.entries.get(viewId)
    if (!entry) return
    if (force) { entry.transfer?.abort(); this.removeEntry(entry); return }
    if (entry.closing) return entry.closing
    entry.transfer?.abort()
    entry.closing = (async () => {
      try {
        await entry.operation.catch(() => undefined)
        if (!this.entries.has(viewId)) return
        if (entry.source) {
          entry.source.phase = 'suspended'; this.changed()
          try { await this.command(entry.source, 'dispose', { reason: 'closed' }, undefined, 15000) }
          catch (error) {
            await this.command(entry.source, 'resume', null, undefined, 15000)
            entry.source.phase = 'active'; this.changed()
            throw error
          }
        }
        this.removeEntry(entry)
      } finally { delete entry.closing }
    })()
    return entry.closing
  }
  closeWhere(predicate: (content: PanelContent) => boolean): void {
    for (const entry of [...this.entries.values()]) if (predicate(entry.state.content)) { entry.transfer?.abort(); this.removeEntry(entry) }
  }
  closeAll(): void { this.closeWhere(() => true) }
  private removeEntry(entry: Entry): void {
    this.entries.delete(entry.state.viewId)
    for (const request of [...this.requests.values()]) if (request.entry === entry) request.finish(new Error('PANEL_CLOSED'))
    for (const page of [...this.pages.values()]) if (page.entry === entry) this.removePage(page)
    for (const [contents, shell] of [...this.shells]) if (shell.entry === entry) {
      this.shells.delete(contents)
      if (!shell.window.isDestroyed()) shell.window.destroy()
    }
    this.changed()
  }
  private removePage(page: Page): void {
    this.pages.delete(page.id)
    page.ready.reject(new Error('PANEL_CLOSED'))
    for (const request of [...this.pending.values()]) if (request.page === page) request.finish(null, new Error('PANEL_CLOSED'))
    this.changed()
  }
  setToolbar(event: IpcMainInvokeEvent, pageId: unknown, input: unknown): void {
    const page = this.page(event, pageId)
    page.toolbar = requirePanelToolbar(input)
    if (page.entry.source === page) page.entry.state.toolbar = page.toolbar
    this.changed()
  }
  async resizeWindow(event: IpcMainInvokeEvent, pageId: unknown, input: unknown): Promise<void> {
    const page = this.page(event, pageId), size = requirePanelSize(input)
    const requireResizable = () => {
      const active = page.phase === 'active' && page.entry.source === page && !page.entry.state.pendingLocation
      const preparing = page.phase === 'preparing' && page.entry.candidate === page
      if (this.page(event, pageId) !== page || page.location !== 'window' || (!active && !preparing)
        || page.entry.closing) throw new Error('PANEL_ACTION_UNAVAILABLE')
    }
    requireResizable()
    const window = page.owner
    // Automatic fits preserve window state; a deliberate fit may restore it.
    if (!size.restore && (window.isMaximized() || window.isFullScreen())) return
    const shell = this.shells.get(window.webContents)!
    shell.fitting++
    try {
      const transition = (eventName: 'leave-full-screen' | 'unmaximize', change: () => void) => new Promise<void>((resolve, reject) => {
        const events: NodeJS.EventEmitter = window
        const cleanup = () => {
          clearTimeout(timer)
          events.removeListener(eventName, done)
          events.removeListener('closed', closed)
        }
        const done = () => { cleanup(); resolve() }
        const closed = () => { cleanup(); reject(new Error('PANEL_CLOSED')) }
        const timer = setTimeout(() => { cleanup(); reject(new Error('PANEL_TARGET_UNAVAILABLE')) }, 10000)
        events.once(eventName, done)
        events.once('closed', closed)
        try { change() } catch (error) { cleanup(); reject(error) }
      })
      if (window.isFullScreen()) { await transition('leave-full-screen', () => window.setFullScreen(false)); requireResizable() }
      if (window.isMaximized()) { await transition('unmaximize', () => window.unmaximize()); requireResizable() }
      const bounds = window.getBounds()
      const placement = this.shells.get(window.webContents)?.atCursor ? undefined : size.restorePlacement
      const display = (placement && screen.getAllDisplays().find(value => value.id === placement.displayId))
        || screen.getDisplayNearestPoint({ x: bounds.x + Math.min(80, bounds.width / 2), y: bounds.y + 16 })
      const area = display.workArea
      const zoom = window.webContents.getZoomFactor()
      const [minWidth, minHeight] = window.getMinimumSize()
      // Electron owns the native frame. Inferring it by subtracting rounded DIP
      // rectangles accumulates errors at fractional display scales.
      const contentWidth = Math.round(size.width * zoom), contentHeight = Math.round(size.height * zoom)
      window.setContentSize(contentWidth, contentHeight)
      const { width, height } = window.getBounds()
      // Keep ordinary windows in view. Oversized windows only need their minimum
      // usable region and title bar in view; full-window clamping loses their position.
      const visibleWidth = width > area.width ? Math.min(minWidth, area.width) : width
      const visibleHeight = height > area.height ? Math.min(minHeight, area.height) : height
      const x = placement ? area.x + placement.x : bounds.x, y = placement ? area.y + placement.y : bounds.y
      const nextX = Math.round(Math.max(area.x, Math.min(x, area.x + area.width - visibleWidth)))
      const nextY = Math.round(Math.max(area.y, Math.min(y, area.y + area.height - visibleHeight)))
      if (nextX !== bounds.x || nextY !== bounds.y) {
        window.setPosition(nextX, nextY)
        // Moving can change DPI and round the native frame again. The final
        // operation sizes the content on the destination display.
        window.setContentSize(contentWidth, contentHeight)
      }
    } finally { shell.fitting-- }
  }
  async invokeToolbarAction(viewId: string, actionId: unknown): Promise<void> {
    const entry = this.require(viewId), page = entry.source
    const action = findPanelToolbarAction(entry.state.toolbar, actionId)
    if (!page || !action || action.disabled || entry.state.pendingActionId || entry.state.pendingLocation || entry.closing) throw new Error('PANEL_ACTION_UNAVAILABLE')
    entry.state.pendingActionId = action.id; this.changed()
    return this.command(page, 'action', { actionId: action.id }, undefined, 30000, () => {
      delete entry.state.pendingActionId; this.changed()
    }).then(() => undefined).catch(error => {
      // The action's page can disappear after its own successful close/move.
      // Treat teardown as cancellation of its UI receipt, not an action failure.
      if (error instanceof Error && error.message === 'PANEL_CLOSED' && !this.pages.has(page.id)) return
      throw error
    })
  }
  complete(event: IpcMainInvokeEvent, pageId: unknown, requestId: unknown, result: unknown, failed: unknown): void {
    const page = this.page(event, pageId)
    if (typeof requestId !== 'string' || typeof failed !== 'boolean') throw new Error('Invalid panel reply.')
    const request = this.pending.get(requestId)
    if (request?.page === page) request.finish(failed ? null : requirePanelJson(result), failed ? new Error('PANEL_ACTION_FAILED') : undefined)
  }
  private command(page: Page, kind: PanelPageCommand['kind'], payload: PanelJson, signal?: AbortSignal, timeoutMs = 15000, settled?: () => void): Promise<PanelJson> {
    if (signal?.aborted || !this.pages.has(page.id)) return Promise.reject(panelCancellation(signal))
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const finish = (value: PanelJson, error?: Error) => {
        if (!this.pending.delete(requestId)) return
        clearTimeout(timer); signal?.removeEventListener('abort', cancel); settled?.()
        if (error) reject(error); else resolve(value)
      }
      const cancel = () => {
        if (!page.owner.isDestroyed()) page.owner.webContents.send('panel-page:cancel', requestId)
        finish(null, panelCancellation(signal))
      }
      const timer = setTimeout(() => {
        if (kind === 'action') { reject(new Error('PANEL_ACTION_TIMEOUT')); return }
        if (!page.owner.isDestroyed()) page.owner.webContents.send('panel-page:cancel', requestId)
        finish(null, new Error('PANEL_TARGET_UNAVAILABLE'))
      }, timeoutMs)
      this.pending.set(requestId, { page, finish })
      signal?.addEventListener('abort', cancel, { once: true })
      if (page.owner.isDestroyed()) { finish(null, new Error('PANEL_CLOSED')); return }
      page.owner.webContents.send('panel-page:command', { pageId: page.id, requestId, transferId: page.transferId, kind, payload } satisfies PanelPageCommand)
    })
  }
  updateContent(viewId: string, content: PanelContent, definition?: Partial<PanelDefinition>): void {
    const entry = this.require(viewId)
    if (JSON.stringify(entry.state.content) !== JSON.stringify(content)) entry.transfer?.abort()
    entry.state.content = content; entry.definition = { ...entry.definition, ...definition, content }
    entry.state.name = entry.definition.name(this.appearance.language, entry.definition.project)
    entry.state.icon = entry.definition.icon
    this.changed()
  }
  acknowledge(event: IpcMainInvokeEvent, requestId: string): void {
    const owner = this.assertHost(event), request = this.requests.get(requestId)
    if (request?.owner === owner) request.finish()
  }
  cancelRequest(owner: BrowserWindow, requestId: string): void {
    const request = this.requests.get(requestId)
    if (request?.owner === owner) request.finish(new Error('PANEL_TARGET_UNAVAILABLE'))
  }
  hasRequest(owner: BrowserWindow, requestId: string): boolean { return this.requests.get(requestId)?.owner === owner }
  private createPage(entry: Entry, owner: BrowserWindow, location: PanelLocation, restoreState: PanelJson, id = randomUUID(), transferId?: string): Page {
    const page: Page = { id, entry, owner, location, restoreState, transferId, phase: 'preparing', ready: deferred<void>() }
    this.pages.set(id, page); this.watch(owner)
    return page
  }
  private waitReady(page: Page, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const finish = (error?: unknown) => { clearTimeout(timer); signal.removeEventListener('abort', cancel); if (error) reject(error); else resolve() }
      const cancel = () => finish(panelCancellation(signal))
      const timer = setTimeout(() => finish(new Error('PANEL_LOAD_FAILED')), 30000)
      signal.addEventListener('abort', cancel, { once: true })
      if (signal.aborted) cancel()
      else void page.ready.promise.then(() => finish(), finish)
    })
  }
  private require(id: string): Entry {
    const entry = this.entries.get(id)
    if (!entry) throw new Error('PANEL_CLOSED')
    return entry
  }
  private check(entry: Entry, signal: AbortSignal): void { if (signal.aborted || !this.entries.has(entry.state.viewId)) throw panelCancellation(signal) }
  private enqueue(entry: Entry, action: () => Promise<void>): Promise<void> {
    const result = entry.operation.catch(() => undefined).then(() => { this.require(entry.state.viewId); if (entry.closing) throw new Error('PANEL_CLOSED'); return action() })
    entry.operation = result; return result
  }
  private prepareSidebar(entry: Entry, signal?: AbortSignal): Promise<BrowserWindow> {
    const owner = BrowserWindow.getAllWindows().find(isMainRendererWindow)
    if (!owner) return Promise.reject(new Error('PANEL_TARGET_UNAVAILABLE'))
    this.watch(owner)
    return new Promise((resolve, reject) => {
      const requestId = randomUUID()
      const finish = (error?: Error) => {
        if (!this.requests.delete(requestId)) return
        clearTimeout(timer); signal?.removeEventListener('abort', cancel)
        if (error) reject(error); else resolve(owner)
      }
      const cancel = () => finish(panelCancellation(signal))
      const timer = setTimeout(() => finish(new Error('PANEL_TARGET_UNAVAILABLE')), 15000)
      this.requests.set(requestId, { entry, owner, finish })
      signal?.addEventListener('abort', cancel, { once: true })
      if (signal?.aborted) { cancel(); return }
      owner.show(); owner.focus()
      owner.webContents.send('panels:open', { requestId, view: { ...entry.state, location: 'sidebar' } })
    })
  }
  private async prepareWindow(entry: Entry, position: Point | undefined, signal: AbortSignal): Promise<BrowserWindow> {
    if (this.shells.size >= 32) throw new Error('Too many panel windows.')
    const resources = await this.loadLanguages(); this.check(entry, signal)
    const source = resolveRendererLocation({ isPackaged: app.isPackaged, rendererFile: join(__dirname, '../renderer/panel-window.html'),
      rendererUrl: !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? new URL('panel-window.html', process.env.ELECTRON_RENDERER_URL).toString() : undefined })
    const sourceWindow = entry.source?.owner ?? BrowserWindow.getAllWindows().find(isMainRendererWindow)
    const area = (position ? screen.getDisplayNearestPoint(position)
      : sourceWindow ? screen.getDisplayMatching(sourceWindow.getBounds()) : screen.getPrimaryDisplay()).workArea
    const width = Math.min(960, area.width), height = Math.min(680, area.height)
    const placement = { x: Math.round(position ? Math.max(area.x, Math.min(position.x - 120, area.x + area.width - width)) : area.x + (area.width - width) / 2),
      y: Math.round(position ? Math.max(area.y, Math.min(position.y - 18, area.y + area.height - height)) : area.y + (area.height - height) / 2) }
    const window = new BrowserWindow({ title: entry.state.name, width, height, ...placement, minWidth: Math.min(400, width), minHeight: Math.min(300, height),
      show: false, enableLargerThanScreen: true, backgroundColor: titleBarColors().backgroundColor, ...titleBarOptions({ compact: true }),
      webPreferences: { preload: join(__dirname, '../preload/panelWindow.js'), sandbox: true, contextIsolation: true, nodeIntegration: false } })
    const contents = window.webContents
    const shell = { entry, window, source, resources, atCursor: !!position, resizeRevision: 0, fitting: 0 }
    this.shells.set(contents, shell)
    const windowModeChanged = () => {
      if (!shell.fitting) shell.resizeRevision++
      if (!window.isDestroyed()) this.changed()
    }
    // Unlike `resize`, `resized` reports completion of a native user resize
    // (Windows/macOS), not each programmatic size or DPI/layout notification.
    const windowResized = () => {
      if (!shell.fitting && !window.isDestroyed()) { shell.resizeRevision++; contents.send('panel-page:changed') }
    }
    window.on('resized', windowResized)
    window.on('enter-full-screen', windowModeChanged)
    window.on('leave-full-screen', windowModeChanged)
    window.on('maximize', windowModeChanged)
    window.on('unmaximize', windowModeChanged)
    const windowMoved = () => { if (!window.isDestroyed()) contents.send('panel-page:changed') }
    window.on('moved', windowMoved)
    registerContentRenderer(window.webContents, { location: source, allows: (channel, args) => entry.state.content.kind !== 'plugin' && builtinPanelCanInvoke(entry.state.content, channel, args) })
    registerNativeContextMenu(window)
    registerWindowZoomShortcuts(window)
    window.setMenuBarVisibility(false)
    window.on('page-title-updated', event => event.preventDefault())
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    window.webContents.on('will-navigate', event => event.preventDefault())
    window.on('close', event => {
      if (entry.source?.owner !== window) { entry.transfer?.abort(); return }
      event.preventDefault()
      void this.close(entry.state.viewId).catch(() => { if (!window.isDestroyed()) contents.send('panel-window:closeFailed') })
    })
    window.once('closed', () => {
      window.removeListener('enter-full-screen', windowModeChanged)
      window.removeListener('leave-full-screen', windowModeChanged)
      window.removeListener('maximize', windowModeChanged)
      window.removeListener('unmaximize', windowModeChanged)
      window.removeListener('moved', windowMoved)
      window.removeListener('resized', windowResized)
      this.shells.delete(contents)
      if (entry.candidate?.owner === window) { entry.transfer?.abort(); entry.candidate.ready.reject(new Error('PANEL_CLOSED')) }
    })
    const cancel = () => { if (!window.isDestroyed()) window.destroy() }
    signal.addEventListener('abort', cancel, { once: true })
    try {
      registerMacWindowMoveSizeGuard(window)
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { cancel(); reject(new Error('PANEL_LOAD_FAILED')) }, 30000)
        void window.loadURL(source.url).then(() => { clearTimeout(timer); resolve() }, () => { clearTimeout(timer); reject(new Error('PANEL_LOAD_FAILED')) })
      })
      // The candidate may restore its layout during activation. Show only after
      // that succeeds, so the default shell size is never presented first.
      this.check(entry, signal); return window
    } catch (error) { cancel(); throw error }
    finally { signal.removeEventListener('abort', cancel) }
  }
  private watch(owner: BrowserWindow): void {
    if (this.watched.has(owner)) return
    this.watched.add(owner)
    const activityChanged = () => this.changed()
    owner.on('focus', activityChanged); owner.on('blur', activityChanged)
    owner.on('show', activityChanged); owner.on('hide', activityChanged)
    owner.on('minimize', activityChanged); owner.on('restore', activityChanged)
    const releasePages = () => {
      for (const request of [...this.requests.values()]) if (request.owner === owner) request.finish(new Error('PANEL_CLOSED'))
      for (const page of [...this.pages.values()]) if (page.owner === owner) {
        page.entry.transfer?.abort()
        if (page.entry.source === page) this.removeEntry(page.entry)
        else this.removePage(page)
      }
    }
    owner.once('closed', releasePages)
    const contents = owner.webContents
    contents.on('render-process-gone', releasePages)
    contents.on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) releasePages()
    })
  }
  private changed(): void {
    for (const listener of this.listeners) listener()
    for (const window of BrowserWindow.getAllWindows()) if (isMainRendererWindow(window)) {
      window.webContents.send('panels:changed', this.list())
      window.webContents.send('panel-page:changed')
    }
    for (const shell of this.shells.values()) if (!shell.window.isDestroyed()) {
      shell.window.webContents.send('panel-window:changed', this.shellState(shell))
      shell.window.webContents.send('panel-page:changed')
    }
  }
}
