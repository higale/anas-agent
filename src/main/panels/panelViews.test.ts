import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, WebContents, IpcMainInvokeEvent, PopupOptions } from 'electron'
import type { PluginSummary } from '@shared/plugins'
import type { PanelRequest, BuiltinPanel } from '@shared/panels'
import { pluginPanel } from '../plugins/pluginPanel'
import type { LanguageResourcesSnapshot } from '@shared/types'

const mocks = vi.hoisted(() => ({ window: vi.fn(), view: vi.fn(), windows: vi.fn(), menu: vi.fn() }))
vi.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: false }, app: { isPackaged: true },
  BrowserWindow: Object.assign(mocks.window, { getAllWindows: mocks.windows }), WebContentsView: mocks.view,
  Menu: { buildFromTemplate: mocks.menu } }))
vi.mock('../ipcSecurity', () => ({
  isMainRendererWindow: (window: { main: boolean; destroyed: boolean }) => window.main && !window.destroyed,
  rendererLocationMatches: () => true, resolveRendererLocation: () => ({ url: 'file:///panel-window.html' })
}))
import { PanelViews } from './panelViews'

class Contents extends EventEmitter {
  destroyed = false
  url = ''
  zoom = 1
  mainFrame = { url: '' }
  send = vi.fn()
  focus = vi.fn()
  setWindowOpenHandler = vi.fn()
  isDestroyed = () => this.destroyed
  isFocused = () => false
  getZoomFactor = () => this.zoom
  setZoomFactor = (value: number) => { this.zoom = value }
  close = vi.fn(() => { if (!this.destroyed) { this.destroyed = true; this.emit('destroyed') } })
  loadURL = vi.fn(async (url: string) => { this.url = url; this.mainFrame.url = url; this.emit('dom-ready') })
}
class View {
  webContents = new Contents()
  bounds = { x: 0, y: 0, width: 0, height: 0 }
  visible = false
  setBounds = (bounds: typeof this.bounds) => { this.bounds = bounds }
  getBounds = () => this.bounds
  setVisible = (value: boolean) => { this.visible = value }
  getVisible = () => this.visible
}
class Window extends EventEmitter {
  main = false
  destroyed = false
  webContents = new Contents()
  children = new Set<View>()
  contentView = { addChildView: (view: View) => this.children.add(view), removeChildView: (view: View) => this.children.delete(view) }
  show = vi.fn()
  focus = vi.fn()
  setTitle = vi.fn()
  setMenuBarVisibility = vi.fn()
  isDestroyed = () => this.destroyed
  getContentSize = () => [1200, 800]
  getContentBounds = () => ({ x: 100, y: 80, width: 1200, height: 800 })
  loadURL = vi.fn(async () => { manager.setWindowLayout(this.webContents as unknown as WebContents, bounds) })
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); this.webContents.close() } }
}
class PopupMenu {
  options?: PopupOptions
  constructor(readonly items: { label: string; click(): void }[]) {}
  popup = vi.fn((options: PopupOptions) => { this.options = options })
  closePopup = vi.fn(() => this.options?.callback?.())
}
const bounds = { x: 600, y: 100, width: 400, height: 650 }
const summary = { id: 'example', manifest: { id: 'example', name: 'Example', ui: 'index.html' } } as PluginSummary
let manager: PanelViews
let main: Window
let windows: Window[]
let nativeViews: View[]
let requests: PanelRequest[]
let acceptSidebar: boolean
let menus: PopupMenu[]

beforeEach(() => {
  windows = []; nativeViews = []; requests = []; menus = []; acceptSidebar = true
  mocks.menu.mockImplementation(items => { const menu = new PopupMenu(items); menus.push(menu); return menu })
  manager = new PanelViews(async () => ({ resources: {}, languages: [] }) as unknown as LanguageResourcesSnapshot)
  mocks.windows.mockImplementation(() => windows.filter(window => !window.destroyed))
  mocks.window.mockImplementation(function () { const window = new Window(); windows.push(window); return window })
  mocks.view.mockImplementation(function () { const view = new View(); nativeViews.push(view); return view })
  main = new Window(); main.main = true; windows.push(main)
  main.webContents.send.mockImplementation((channel: string, request: PanelRequest) => {
    if (channel !== 'panels:open') return
    requests.push(request)
    if (acceptSidebar) manager.setLayouts(main as unknown as BrowserWindow, [{ viewId: request.view.viewId, requestId: request.requestId, bounds }])
  })
})
afterEach(() => { manager.closeAll(); vi.useRealTimers(); vi.unstubAllEnvs() })
const open = (location: 'sidebar' | 'window') => manager.open(pluginPanel(summary, { instanceId: 'main', location }))
const toolbar = { status: { label: 'Connected', tone: 'success' }, actions: [{ id: 'disconnect', label: 'Disconnect', icon: 'unplug' }] }
const latestAction = (index = 0) => nativeViews[index].webContents.send.mock.calls.filter(call => call[0] === 'panel-toolbar:action').at(-1)![1]
function delayPageLoad() {
  mocks.view.mockImplementationOnce(function () {
    const view = new View(); nativeViews.push(view)
    view.webContents.loadURL.mockImplementation(async () => {})
    return view
  })
}

describe('plugin page ownership and placement', () => {
  it('keeps native content visible while a tab menu opens, cancels or chooses close', async () => {
    await open('sidebar')
    const { viewId } = manager.list()[0], page = nativeViews[0]
    main.webContents.zoom = 1.25
    const cancelled = manager.showTabMenu(main as unknown as BrowserWindow, viewId, { closeLabel: 'Close', position: { x: 10, y: 20 } })
    expect(menus[0].popup).toHaveBeenCalledWith({ window: main, x: 113, y: 105, callback: expect.any(Function) })
    expect(page.visible).toBe(true)
    expect(page.bounds).toEqual(bounds)
    menus[0].options!.callback!()
    await expect(cancelled).resolves.toBe(false)
    const selected = manager.showTabMenu(main as unknown as BrowserWindow, viewId, { closeLabel: '关闭' })
    expect(menus[1].items[0].label).toBe('关闭')
    expect(page.visible).toBe(true)
    menus[1].items[0].click()
    menus[1].options!.callback!()
    await expect(selected).resolves.toBe(true)
    expect(page.webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(manager.list()).toHaveLength(1)
  })
  it.each(['move', 'close', 'hide', 'reload', 'destroy'])('dismisses an open tab menu on %s and ignores a late selection', async action => {
    await open('sidebar')
    const { viewId } = manager.list()[0]
    const result = manager.showTabMenu(main as unknown as BrowserWindow, viewId, { closeLabel: 'Close' })
    if (action === 'move') await manager.move(viewId, 'window')
    else if (action === 'close') manager.close(viewId)
    else if (action === 'reload') main.webContents.emit('did-start-navigation')
    else if (action === 'destroy') main.destroy()
    else main.emit('hide')
    await expect(result).resolves.toBe(false)
    menus[0].items[0].click()
    expect(main.listenerCount('hide')).toBe(0)
  })
  it('rejects tab menus for another owner or a detached page', async () => {
    await open('sidebar')
    const { viewId } = manager.list()[0]
    expect(() => manager.showTabMenu(new Window() as unknown as BrowserWindow, viewId, { closeLabel: 'Close' })).toThrow('PANEL_TARGET_UNAVAILABLE')
    await manager.move(viewId, 'window')
    expect(() => manager.showTabMenu(main as unknown as BrowserWindow, viewId, { closeLabel: 'Close' })).toThrow('PANEL_TARGET_UNAVAILABLE')
    expect(menus).toHaveLength(0)
  })
  it('retains toolbar and dispatches to the same page after moving, with one action at a time', async () => {
    await open('sidebar')
    const { viewId } = manager.list()[0]
    manager.setToolbar(viewId, toolbar)
    nativeViews[0].webContents.emit('did-start-navigation', {}, 'https://blocked.invalid', false, true)
    expect(manager.state(viewId).toolbar?.status?.label).toBe('Connected')
    expect(() => manager.invokeToolbarAction(viewId, 'disconnect')).toThrow('PANEL_ACTION_UNAVAILABLE')
    await manager.move(viewId, 'window')
    expect(manager.state(viewId).toolbar?.status?.label).toBe('Connected')
    const completion = manager.invokeToolbarAction(viewId, 'disconnect')
    expect(manager.state(viewId).pendingActionId).toBe('disconnect')
    expect(() => manager.invokeToolbarAction(viewId, 'disconnect')).toThrow('PANEL_ACTION_UNAVAILABLE')
    const request = latestAction()
    expect(request.actionId).toBe('disconnect')
    await manager.move(viewId, 'sidebar')
    manager.completeToolbarAction(viewId, request.requestId, false)
    await completion
    expect(manager.state(viewId).pendingActionId).toBeUndefined()
    expect(nativeViews).toHaveLength(1)
    expect(nativeViews[0].webContents.loadURL).toHaveBeenCalledTimes(1)
  })
  it('does not allow another page to complete a pending action', async () => {
    await open('window'); await open('sidebar')
    const [first, second] = manager.list()
    manager.setToolbar(first.viewId, toolbar)
    const completion = manager.invokeToolbarAction(first.viewId, 'disconnect')
    const request = latestAction()
    manager.completeToolbarAction(second.viewId, request.requestId, false)
    expect(manager.state(first.viewId).pendingActionId).toBe('disconnect')
    manager.completeToolbarAction(first.viewId, request.requestId, true)
    await expect(completion).rejects.toThrow('PANEL_ACTION_FAILED')
  })
  it.each(['close', 'reload', 'timeout'] as const)('settles an action on %s and ignores late results', async cause => {
    vi.useFakeTimers()
    await open('window')
    const { viewId } = manager.list()[0]
    manager.setToolbar(viewId, toolbar)
    const completion = expect(manager.invokeToolbarAction(viewId, 'disconnect')).rejects.toThrow('PANEL_')
    const request = latestAction()
    if (cause === 'close') manager.close(viewId)
    else if (cause === 'reload') nativeViews[0].webContents.emit('did-navigate', {}, 'page')
    else await vi.advanceTimersByTimeAsync(30_000)
    await completion
    if (cause !== 'close') {
      if (cause === 'timeout') {
        expect(manager.state(viewId).pendingActionId).toBe('disconnect')
        expect(() => manager.invokeToolbarAction(viewId, 'disconnect')).toThrow('PANEL_ACTION_UNAVAILABLE')
      }
      manager.completeToolbarAction(viewId, request.requestId, false)
      expect(manager.state(viewId).pendingActionId).toBeUndefined()
    }
    if (cause === 'reload') expect(manager.state(viewId).toolbar).toBeUndefined()
  })
  it('rejects malformed toolbar updates without replacing valid controls, and respects disabled or removed actions', async () => {
    await open('window')
    const { viewId } = manager.list()[0]
    manager.setToolbar(viewId, toolbar)
    for (const invalid of [{ actions: [...toolbar.actions, ...toolbar.actions] }, { actions: [{ id: 'a', label: '', icon: 'unplug' }] },
      { actions: [{ id: 'a', label: 'A', icon: '<svg>' }] }, { ...toolbar, status: { label: 'a', tone: 'invalid' } },
      { actions: Array.from({ length: 5 }, (_, id) => ({ id: String(id), label: 'A', icon: 'x' })) }]) {
      expect(() => manager.setToolbar(viewId, invalid)).toThrow('Invalid panel toolbar')
      expect(manager.state(viewId).toolbar?.actions[0].id).toBe('disconnect')
    }
    manager.setToolbar(viewId, { ...toolbar, actions: [{ ...toolbar.actions[0], disabled: true }] })
    expect(() => manager.invokeToolbarAction(viewId, 'disconnect')).toThrow('PANEL_ACTION_UNAVAILABLE')
    manager.setToolbar(viewId, null)
    expect(manager.state(viewId).toolbar).toBeUndefined()
    expect(() => manager.invokeToolbarAction(viewId, 'disconnect')).toThrow('PANEL_ACTION_UNAVAILABLE')
  })
  it('routes Escape to the current sidebar owner only while the page is visible', async () => {
    await open('sidebar')
    const { viewId } = manager.list()[0], contents = nativeViews[0].webContents as unknown as WebContents
    expect(manager.pageOwner(contents)).toBe(main)
    manager.escape(contents)
    expect(main.webContents.send).toHaveBeenCalledWith('panels:escape', viewId)
    main.webContents.send.mockClear()
    manager.setLayouts(main as unknown as BrowserWindow, [{ viewId, bounds: null }])
    manager.escape(contents)
    expect(main.webContents.send).not.toHaveBeenCalledWith('panels:escape', viewId)
    await manager.move(viewId, 'window')
    expect(manager.pageOwner(contents)).toBe(windows[1])
    manager.escape(contents)
    expect(main.webContents.send).not.toHaveBeenCalledWith('panels:escape', viewId)
    expect(windows[1].webContents.send).not.toHaveBeenCalledWith('panels:escape', viewId)
  })
  it('retains sidebar presentation for renderer reload but respects an explicit hide', async () => {
    await open('sidebar')
    const { viewId } = manager.list()[0]
    main.webContents.emit('did-start-navigation', {}, 'file:///index.html', false, true)
    expect(nativeViews[0].visible).toBe(false)
    expect(manager.state(viewId).sidebarVisible).toBe(true)
    manager.setLayouts(main as unknown as BrowserWindow, [{ viewId, bounds: null }])
    expect(manager.state(viewId).sidebarVisible).toBe(false)
    manager.setLayouts(main as unknown as BrowserWindow, [{ viewId, bounds }])
    expect(nativeViews[0].visible).toBe(true)
  })
  it('ignores a development renderer environment value in a packaged window', async () => {
    vi.stubEnv('ELECTRON_RENDERER_URL', 'not a valid URL')
    await open('window')
    expect(windows[1].children.has(nativeViews[0])).toBe(true)
  })

  it('moves one native page and closes it exactly once when its final window closes', async () => {
    await open('sidebar')
    const state = manager.list()[0], view = nativeViews[0]
    await manager.move(state.viewId, 'window')
    expect(main.children.size).toBe(0)
    expect(windows[1].children.has(view)).toBe(true)
    await manager.move(state.viewId, 'sidebar')
    expect(windows[1].destroyed).toBe(true)
    expect(view.webContents.isDestroyed()).toBe(false)
    expect(main.children.has(view)).toBe(true)
    await manager.move(state.viewId, 'window')
    expect(view.webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(nativeViews).toHaveLength(1)
    windows[2].destroy()
    expect(manager.list()).toEqual([])
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('preserves the source when the target declines or times out, then permits retry', async () => {
    await open('window')
    const { viewId } = manager.list()[0], view = nativeViews[0], source = windows[1]
    acceptSidebar = false
    const declined = manager.move(viewId, 'sidebar')
    const declinedResult = expect(declined).rejects.toThrow('PANEL_TARGET_UNAVAILABLE')
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    manager.cancelRequest(main as unknown as BrowserWindow, requests[0].requestId)
    await declinedResult
    expect(source.children.has(view)).toBe(true)
    expect(manager.state(viewId).location).toBe('window')
    vi.useFakeTimers()
    const expired = manager.move(viewId, 'sidebar')
    const expiredResult = expect(expired).rejects.toThrow('PANEL_TARGET_UNAVAILABLE')
    await vi.advanceTimersByTimeAsync(15_000)
    await expiredResult
    expect(view.webContents.isDestroyed()).toBe(false)
    acceptSidebar = true
    await manager.move(viewId, 'sidebar')
    expect(main.children.has(view)).toBe(true)
  })

  it('does not replace another live instance in the destination', async () => {
    await open('sidebar'); await open('window')
    const first = manager.list()[0]
    await expect(manager.move(first.viewId, 'window')).rejects.toThrow('PANEL_CONFLICT')
    expect(nativeViews).toHaveLength(2)
    expect(nativeViews.every(view => !view.webContents.destroyed)).toBe(true)
    expect(main.children.has(nativeViews[0])).toBe(true)
    expect(windows[1].children.has(nativeViews[1])).toBe(true)
  })

  it('rejects pending and queued transfers when a page is closed', async () => {
    await open('window'); acceptSidebar = false
    const { viewId } = manager.list()[0]
    const pending = manager.move(viewId, 'sidebar'), queued = manager.move(viewId, 'window')
    const results = [expect(pending).rejects.toThrow('PANEL_CLOSED'), expect(queued).rejects.toThrow('PANEL_CLOSED')]
    await vi.waitFor(() => expect(requests).toHaveLength(1))
    manager.close(viewId)
    await Promise.all(results)
    expect(manager.list()).toEqual([])
    expect(windows[1].destroyed).toBe(true)
    expect(nativeViews[0].webContents.close).toHaveBeenCalledTimes(1)
  })

  it('rolls back to the live sidebar when a new window fails to load', async () => {
    await open('sidebar')
    mocks.window.mockImplementationOnce(function () {
      const window = new Window(); windows.push(window)
      window.loadURL.mockRejectedValue(new Error('load failed'))
      return window
    })
    const { viewId } = manager.list()[0]
    await expect(manager.move(viewId, 'window')).rejects.toThrow('load failed')
    expect(windows[1].destroyed).toBe(true)
    expect(main.children.has(nativeViews[0])).toBe(true)
    expect(manager.state(viewId)).toMatchObject({ location: 'sidebar' })
    expect(manager.state(viewId).pendingLocation).toBeUndefined()
    await manager.move(viewId, 'window')
    expect(nativeViews).toHaveLength(1)
  })

  it('uses host zoom for geometry, hides without closing, and authenticates only the registered page', async () => {
    await open('sidebar')
    const { viewId } = manager.list()[0], view = nativeViews[0]
    main.webContents.zoom = 1.25
    manager.setLayouts(main as unknown as BrowserWindow, [{ viewId, bounds }])
    expect(view.bounds).toEqual({ x: 750, y: 125, width: 450, height: 675 })
    manager.setLayouts(main as unknown as BrowserWindow, [{ viewId, bounds: null }])
    expect(view.visible).toBe(false)
    expect(view.webContents.destroyed).toBe(false)
    const event = { sender: view.webContents, senderFrame: view.webContents.mainFrame } as unknown as IpcMainInvokeEvent
    expect(manager.fromPage(event).viewId).toBe(viewId)
    expect(() => manager.fromPage({ ...event, senderFrame: {} } as IpcMainInvokeEvent)).toThrow('Unregistered')
    main.destroy()
    expect(manager.list()).toEqual([])
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
  })

  it('uses the current destination bounds when a page finishes loading slowly', async () => {
    delayPageLoad()
    let currentBounds = bounds
    main.webContents.send.mockImplementation((channel: string, request: PanelRequest) => {
      if (channel === 'panels:open') manager.setLayouts(main as unknown as BrowserWindow,
        [{ viewId: request.view.viewId, requestId: request.requestId, bounds: currentBounds }])
    })
    const opening = open('sidebar')
    await new Promise(resolve => setImmediate(resolve))
    expect(main.children.has(nativeViews[0])).toBe(true)
    expect(manager.list()[0]).toMatchObject({ loading: true, sidebarVisible: true })
    expect(manager.list()[0].pendingLocation).toBeUndefined()
    expect(nativeViews[0].visible).toBe(false)
    currentBounds = { x: 700, y: 100, width: 300, height: 650 }
    manager.setLayouts(main as unknown as BrowserWindow, [{ viewId: manager.list()[0].viewId, bounds: currentBounds }])
    nativeViews[0].webContents.emit('dom-ready')
    await opening
    expect(nativeViews[0].bounds).toEqual(currentBounds)
    expect(nativeViews[0].visible).toBe(true)
    expect(manager.list()[0].loading).toBeUndefined()
    expect(nativeViews[0].webContents.focus).not.toHaveBeenCalled()
  })

  it.each(['hide', 'reload'] as const)('does not reveal a loading page after a sidebar %s', async action => {
    delayPageLoad()
    const opening = open('sidebar')
    await vi.waitFor(() => expect(main.children.size).toBe(1))
    if (action === 'hide') manager.setLayouts(main as unknown as BrowserWindow, [{ viewId: manager.list()[0].viewId, bounds: null }])
    else main.webContents.emit('did-start-navigation', {}, 'file:///index.html', false, true)
    nativeViews[0].webContents.emit('dom-ready')
    await opening
    expect(nativeViews[0].visible).toBe(false)
    expect(nativeViews[0].webContents.focus).not.toHaveBeenCalled()
    expect(requests).toHaveLength(1)
  })

  it('moves a still-loading page without waiting or recreating it', async () => {
    delayPageLoad()
    const opening = open('sidebar')
    await vi.waitFor(() => expect(main.children.size).toBe(1))
    const { viewId } = manager.list()[0]
    await manager.move(viewId, 'window')
    expect(windows[1].show).toHaveBeenCalled()
    expect(windows[1].children.has(nativeViews[0])).toBe(true)
    expect(main.children.size).toBe(0)
    expect(nativeViews[0].visible).toBe(false)
    nativeViews[0].webContents.emit('dom-ready')
    await opening
    expect(nativeViews[0].visible).toBe(true)
    expect(manager.state(viewId).location).toBe('window')
    expect(nativeViews).toHaveLength(1)
  })

  it('closes a loading page immediately and never restores it on a late load event', async () => {
    delayPageLoad()
    const opening = expect(open('sidebar')).rejects.toThrow('PANEL_CLOSED')
    await vi.waitFor(() => expect(main.children.size).toBe(1))
    manager.close(manager.list()[0].viewId)
    await opening
    nativeViews[0].webContents.emit('dom-ready')
    expect(manager.list()).toEqual([])
    expect(main.children.size).toBe(0)
    expect(nativeViews[0].webContents.close).toHaveBeenCalledTimes(1)
  })

  it('removes the loading tab and native view when the page load times out', async () => {
    vi.useFakeTimers()
    delayPageLoad()
    const opening = expect(open('sidebar')).rejects.toThrow('PANEL_LOAD_FAILED')
    await vi.advanceTimersByTimeAsync(0)
    expect(requests).toHaveLength(1)
    expect(main.children.size).toBe(1)
    await vi.advanceTimersByTimeAsync(30_000)
    await opening
    expect(manager.list()).toEqual([])
    expect(main.children.size).toBe(0)
  })

  it('reports a loading renderer crash as failure, not a user closing the panel', async () => {
    delayPageLoad()
    const opening = expect(open('sidebar')).rejects.toThrow('PANEL_LOAD_FAILED')
    await vi.waitFor(() => expect(main.children.size).toBe(1))
    nativeViews[0].webContents.emit('render-process-gone')
    await opening
    expect(manager.list()).toEqual([])
    expect(main.children.size).toBe(0)
  })

  it('keeps source layout changes made while a destination fails to load', async () => {
    await open('sidebar')
    let rejectLoad!: (error: Error) => void
    mocks.window.mockImplementationOnce(function () {
      const window = new Window(); windows.push(window)
      window.loadURL.mockImplementation(() => new Promise((_, reject) => { rejectLoad = reject }))
      return window
    })
    const { viewId } = manager.list()[0], view = nativeViews[0]
    const moving = manager.move(viewId, 'window')
    const failed = expect(moving).rejects.toThrow('load failed')
    await vi.waitFor(() => expect(windows).toHaveLength(2))
    const resized = { x: 700, y: 100, width: 300, height: 650 }
    manager.setLayouts(main as unknown as BrowserWindow, [{ viewId, bounds: resized }, { viewId, bounds: null }])
    rejectLoad(new Error('load failed'))
    await failed
    expect(view.bounds).toEqual(resized)
    expect(view.visible).toBe(false)
    expect(main.children.has(view)).toBe(true)
    expect(view.webContents.destroyed).toBe(false)
  })
  it.each(['document', 'files', 'subagent'] as const)('keeps one %s page through transfer, reopening and main-window reload', async kind => {
    const content: BuiltinPanel = kind === 'document' ? { kind, documentId: 'USER_GUIDE.en.md' }
      : kind === 'files' ? { kind, projectId: 'project', threadId: 'thread' }
        : { kind, projectId: 'project', threadId: 'thread', runId: 'run', subagentId: 'child', name: 'Child' }
    const definition = { content, ownerId: 'builtin', reuse: 'page' as const, location: 'sidebar' as const, locations: ['sidebar', 'window'] as ('sidebar' | 'window')[],
      source: { kind: 'local' as const, url: 'file:///panel-content.html' }, preload: 'panelContent.js', name: () => kind }
    await manager.open(definition)
    const { viewId } = manager.list()[0], page = nativeViews[0]
    await manager.move(viewId, 'window')
    await manager.open(definition)
    expect(manager.state(viewId).location).toBe('window')
    expect(nativeViews).toHaveLength(1)
    await manager.move(viewId, 'sidebar')
    main.webContents.emit('did-start-navigation', {}, '', false, true)
    expect(page.visible).toBe(false)
    manager.setLayouts(main as unknown as BrowserWindow, [{ viewId, bounds }])
    expect(page.visible).toBe(true)
    expect(page.webContents.loadURL).toHaveBeenCalledTimes(1)
  })

  it('updates a global file page without changing placement or focus and reuses it when opened for another project', async () => {
    const definition = { content: { kind: 'files' as const, projectId: 'one', threadId: 'thread-one' }, ownerId: 'builtin',
      reuse: 'page' as const, location: 'sidebar' as const, locations: ['sidebar', 'window'] as ('sidebar' | 'window')[],
      source: { kind: 'local' as const, url: 'file:///panel-content.html' }, preload: 'panelContent.js', name: () => 'Files · one' }
    await manager.open(definition)
    const { viewId } = manager.list()[0], page = nativeViews[0]
    await manager.move(viewId, 'window')
    const shell = windows[1]
    shell.focus.mockClear(); shell.show.mockClear(); requests.length = 0
    const content = { kind: 'files' as const, projectId: 'two' }
    const update = vi.fn()
    manager.updateContent(viewId, content, { name: () => 'Files · two', update })
    expect(manager.state(viewId)).toMatchObject({ content, name: 'Files · two', location: 'window' })
    expect(update).toHaveBeenCalledExactlyOnceWith(page.webContents)
    expect(shell.setTitle).toHaveBeenLastCalledWith('Files · two')
    expect(shell.focus).not.toHaveBeenCalled()
    expect(shell.show).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
    await manager.open({ ...definition, content, name: () => 'Files · two' })
    expect(manager.list()).toHaveLength(1)
    expect(manager.state(viewId).location).toBe('window')
    expect(nativeViews).toHaveLength(1)
    expect(page.webContents.loadURL).toHaveBeenCalledTimes(1)
    expect(shell.focus).toHaveBeenCalledTimes(1)
  })

  it('plugin teardown leaves built-in pages alive, while shutdown cancels every pending transfer', async () => {
    await open('sidebar')
    await manager.open({ ownerId: 'builtin', reuse: 'page', content: { kind: 'document', documentId: 'USER_GUIDE.en.md' }, location: 'window', locations: ['sidebar', 'window'],
      source: { kind: 'local', url: 'file:///panel-content.html' }, preload: 'panelContent.js', name: () => 'Help' })
    manager.closeWhere(content => content.kind === 'plugin')
    expect(manager.list().map(view => view.content.kind)).toEqual(['document'])
    expect(nativeViews[1].webContents.destroyed).toBe(false)
    acceptSidebar = false
    const moving = manager.move(manager.list()[0].viewId, 'sidebar')
    const failed = expect(moving).rejects.toThrow('PANEL_CLOSED')
    await vi.waitFor(() => expect(requests).toHaveLength(2))
    manager.closeAll()
    await failed
    expect(nativeViews.every(view => view.webContents.destroyed)).toBe(true)
  })

})
