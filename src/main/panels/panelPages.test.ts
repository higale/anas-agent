import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { PanelPageCommand, PanelJson } from '@shared/panelLifecycle'
import type { LanguageResourcesSnapshot } from '@shared/types'
const mock = vi.hoisted(() => ({ window: vi.fn(), windows: vi.fn(), from: vi.fn(), display: vi.fn(), displays: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: true }, BrowserWindow: Object.assign(mock.window, { getAllWindows: mock.windows, fromWebContents: mock.from }),
  screen: { getCursorScreenPoint: () => ({ x: 500, y: 300 }), getDisplayNearestPoint: mock.display, getDisplayMatching: mock.display, getAllDisplays: mock.displays, getPrimaryDisplay: mock.display }
}))
vi.mock('../ipcSecurity', () => ({ assertTrustedIpcEvent: vi.fn(),
  isMainRendererWindow: (window: Window) => window.main && !window.destroyed,
  rendererLocationMatches: () => true, resolveRendererLocation: () => ({ url: 'file:///panel-window.html' }), registerContentRenderer: vi.fn() }))
vi.mock('../windowAppearance', () => ({ titleBarColors: () => ({}), titleBarOptions: () => ({}) }))
vi.mock('../zoomService', () => ({ registerWindowZoomShortcuts: vi.fn() }))
vi.mock('../macWindowMoveSize', () => ({ registerMacWindowMoveSizeGuard: vi.fn() }))
vi.mock('../appShell', () => ({ registerNativeContextMenu: vi.fn() }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
import { PanelPages } from './panelPages'

class Contents extends EventEmitter {
  mainFrame = { url: 'file:///panel-window.html' }
  setWindowOpenHandler = vi.fn()
  getZoomFactor = vi.fn(() => 1)
  send = (channel: string, value: unknown) => {
    const owner = windows.find(window => window.webContents === this)!
    if (channel === 'panels:open') queueMicrotask(() => manager.acknowledge(event(owner), (value as { requestId: string }).requestId))
    if (channel === 'panel-page:changed') queueMicrotask(() => {
      if (owner.destroyed) return
      for (const page of manager.ownedPages(event(owner))) if (!seen.has(page.pageId)) {
        seen.add(page.pageId)
        if (page.phase === 'preparing') ready(owner, page.pageId)
      }
    })
    if (channel === 'panel-page:command') {
      const command = value as PanelPageCommand
      commands.push(command)
      queueMicrotask(() => { void respond(command).then(result => {
        try { manager.complete(event(owner), command.pageId, command.requestId, result, false) } catch { /* Retired page. */ }
      }, () => {
        try { manager.complete(event(owner), command.pageId, command.requestId, null, true) } catch { /* Retired page. */ }
      }) })
    }
  }
}
class Window extends EventEmitter {
  main = false
  destroyed = false
  webContents = new Contents()
  isVisible = vi.fn(() => true)
  isMinimized = vi.fn(() => false)
  isFocused = vi.fn(() => true)
  isDestroyed = () => this.destroyed
  show = vi.fn()
  focus = vi.fn()
  setTitle = vi.fn()
  setMenuBarVisibility = vi.fn()
  loadURL = vi.fn(async () => undefined)
  isMaximized = vi.fn(() => false)
  isFullScreen = vi.fn(() => false)
  setFullScreen = vi.fn((value: boolean) => { this.isFullScreen.mockReturnValue(value); this.emit(value ? 'enter-full-screen' : 'leave-full-screen') })
  unmaximize = vi.fn(() => { this.isMaximized.mockReturnValue(false); this.emit('unmaximize') })
  bounds = { x: 100, y: 50, width: 960, height: 680 }
  getBounds = vi.fn(() => ({ ...this.bounds }))
  getNormalBounds = vi.fn(() => this.getBounds())
  getContentBounds = vi.fn(() => ({ x: this.bounds.x + 4, y: this.bounds.y + 4, width: this.bounds.width - 8, height: this.bounds.height - 8 }))
  getMinimumSize = vi.fn(() => [400, 300])
  setContentSize = vi.fn((width: number, height: number) => {
    const [minWidth, minHeight] = this.getMinimumSize()
    this.bounds = { ...this.bounds, width: Math.max(minWidth, width + 8), height: Math.max(minHeight, height + 8) }
  })
  setPosition = vi.fn((x: number, y: number) => { this.bounds = { ...this.bounds, x, y } })
  destroy() { if (!this.destroyed) { this.destroyed = true; this.emit('closed'); this.webContents.emit('destroyed') } }
}
function event(window: Window): IpcMainInvokeEvent { return { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent }
let windows: Window[], main: Window, manager: PanelPages, seen: Set<string>, commands: PanelPageCommand[]
let ready: (owner: Window, pageId: string) => void
let respond: (command: PanelPageCommand) => Promise<PanelJson>
const open = () => manager.open({ ownerId: 'plugin:example', name: () => 'Example', icon: undefined,
  content: { kind: 'plugin', pluginId: 'example', instanceId: 'main' }, location: 'sidebar', locations: ['sidebar', 'window'] })
beforeEach(() => {
  windows = []; seen = new Set(); commands = []
  main = new Window(); main.main = true; windows.push(main)
  mock.windows.mockImplementation(() => windows.filter(window => !window.destroyed))
  mock.from.mockImplementation(contents => windows.find(window => window.webContents === contents))
  mock.display.mockReturnValue({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  mock.displays.mockImplementation(() => [mock.display()])
  mock.window.mockImplementation(function () { const window = new Window(); windows.push(window); return window })
  manager = new PanelPages(async () => ({ languages: [], resources: {} }) as unknown as LanguageResourcesSnapshot)
  ready = (owner, id) => manager.pageReady(event(owner), id)
  respond = async command => command.kind === 'prepare' ? { draft: 'latest edit', scroll: 347 } : null
})
afterEach(() => { manager.closeAll(); vi.useRealTimers() })

describe('page handoff', () => {
  it.each(['ready', 'activate'])('reports an initial page load failure during %s and permits a clean retry', async phase => {
    if (phase === 'ready') ready = (owner, id) => manager.pageFailed(event(owner), id)
    else respond = async command => {
      if (command.kind === 'activate') manager.pageFailed(event(main), command.pageId)
      return null
    }
    await expect(open()).rejects.toThrow('PANEL_LOAD_FAILED')
    expect(manager.list()).toEqual([])
    expect(manager.ownedPages(event(main))).toEqual([])
    ready = (owner, id) => manager.pageReady(event(owner), id)
    respond = async () => null
    await open()
    expect(manager.list()).toHaveLength(1)
    expect(manager.ownedPages(event(main))[0].phase).toBe('active')
  })

  it('fits a hidden candidate before showing it and rejects sizing the suspended source', async () => {
    await open()
    const sidebar = manager.ownedPages(event(main))[0]
    respond = async command => {
      if (command.kind === 'prepare') return { draft: 'kept' }
      if (command.kind === 'activate') {
        const window = windows[1]
        expect(window.show).not.toHaveBeenCalled()
        await expect(manager.resizeWindow(event(main), sidebar.pageId, { width: 800, height: 600 })).rejects.toThrow('PANEL_ACTION_UNAVAILABLE')
        await manager.resizeWindow(event(window), command.pageId, { width: 1280, height: 800 })
        expect(window.getContentBounds()).toMatchObject({ width: 1280, height: 800 })
      }
      return null
    }
    await manager.move(sidebar.panelId, 'window')
    expect(windows[1].show).toHaveBeenCalledOnce()
  })
  it('never shows a candidate whose activation fails', async () => {
    await open()
    respond = async command => { if (command.kind === 'activate') throw new Error('activation failed'); return null }
    await expect(manager.move(manager.list()[0].viewId, 'window')).rejects.toThrow()
    expect(windows[1].show).not.toHaveBeenCalled()
    expect(windows[1].destroyed).toBe(true)
    expect(manager.ownedPages(event(main))[0].phase).toBe('active')
  })
  it('reports native fullscreen changes without replacing or suspending the page', async () => {
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    const previousCommands = [...commands]
    const send = vi.spyOn(window.webContents, 'send')
    expect(manager.fromShell(event(window)).fullScreen).toBe(false)
    manager.setShellFullScreen(event(window), true)
    expect(window.setFullScreen).toHaveBeenCalledWith(true)
    expect(send).toHaveBeenCalledWith('panel-window:changed', expect.objectContaining({ fullScreen: true }))
    expect(manager.fromShell(event(window)).fullScreen).toBe(true)
    manager.setShellFullScreen(event(window), false)
    expect(window.setFullScreen).toHaveBeenCalledWith(false)
    expect(send).toHaveBeenCalledWith('panel-window:changed', expect.objectContaining({ fullScreen: false }))
    expect(manager.ownedPages(event(window))).toEqual([{ ...page, windowResizeRevision: 2 }])
    expect(commands).toEqual(previousCommands)
    window.destroy()
    expect(window.listenerCount('enter-full-screen')).toBe(0)
    expect(window.listenerCount('leave-full-screen')).toBe(0)
  })
  it('reports the current page window mode and notifies maximize/fullscreen changes', async () => {
    await open()
    expect(manager.ownedPages(event(main))[0].windowMode).toBeUndefined()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], pageId = manager.ownedPages(event(window))[0].pageId
    const mode = () => manager.pageContext(event(window), pageId).windowMode
    const send = vi.spyOn(window.webContents, 'send')
    expect(mode()).toBe('normal')
    window.isMaximized.mockReturnValue(true); window.emit('maximize')
    expect(mode()).toBe('maximized')
    expect(send).toHaveBeenCalledWith('panel-page:changed')
    window.setFullScreen(true); expect(mode()).toBe('fullscreen')
    window.setFullScreen(false); expect(mode()).toBe('maximized')
    window.unmaximize(); expect(mode()).toBe('normal')
    window.destroy()
    for (const event of ['maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'moved']) expect(window.listenerCount(event)).toBe(0)
  })
  it('only allows a registered panel shell to set its own fullscreen state with a boolean', async () => {
    await open()
    expect(() => manager.setShellFullScreen(event(main), true)).toThrow('Unregistered panel window')
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1]
    expect(() => manager.setShellFullScreen({ ...event(window), senderFrame: {} } as IpcMainInvokeEvent, false)).toThrow('Unregistered panel host')
    for (const value of ['true', 1, null, undefined]) expect(() => manager.setShellFullScreen(event(window), value)).toThrow('Invalid fullscreen state')
    expect(window.setFullScreen).not.toHaveBeenCalled()
  })
  it('distinguishes deliberate window resizing from movement, DPI notifications and plugin fits', async () => {
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], pageId = manager.ownedPages(event(window))[0].pageId
    const revision = () => manager.pageContext(event(window), pageId).windowResizeRevision
    expect(revision()).toBe(0)
    window.emit('resize'); window.emit('moved')
    expect(revision()).toBe(0)
    window.emit('resized')
    expect(revision()).toBe(1)
    window.setFullScreen(true)
    expect(revision()).toBe(2)
    await manager.resizeWindow(event(window), pageId, { width: 1600, height: 937, restore: true })
    expect(revision()).toBe(2)
    window.destroy()
    expect(window.listenerCount('resized')).toBe(0)
  })
  it('fits CSS content with application zoom and native window chrome', async () => {
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    window.webContents.getZoomFactor.mockReturnValue(1.25)
    await manager.resizeWindow(event(window), page.pageId, { width: 824, height: 658 })
    expect(window.getBounds()).toEqual({ x: 100, y: 50, width: 1038, height: 831 })
  })
  it('keeps repeated content requests stable despite fractional zoom and rounded native bounds', async () => {
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    window.webContents.getZoomFactor.mockReturnValue(1.1)
    window.getContentBounds.mockImplementation(() => ({ ...window.bounds, width: window.bounds.width - 7, height: window.bounds.height - 9 }))
    for (let repeat = 0; repeat < 3; repeat++) {
      await manager.resizeWindow(event(window), page.pageId, { width: 1600, height: 937 })
      expect(window.getBounds()).toEqual({ x: 100, y: 41, width: 1768, height: 1039 })
      expect(window.setContentSize).toHaveBeenLastCalledWith(1760, 1031)
    }
  })
  it('preserves oversized content dimensions while keeping the title bar reachable', async () => {
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    mock.display.mockReturnValue({ id: 1, workArea: { x: -1280, y: 24, width: 1280, height: 1000 } })
    window.bounds.x = -1200; window.bounds.y = 100
    await manager.resizeWindow(event(window), page.pageId, { width: 2560, height: 1440 })
    expect(window.getBounds()).toEqual({ x: -1200, y: 100, width: 2568, height: 1448 })
    window.isMaximized.mockReturnValue(true)
    window.setContentSize.mockClear()
    await manager.resizeWindow(event(window), page.pageId, { width: 800, height: 600 })
    expect(window.setContentSize).not.toHaveBeenCalled()
  })
  it('restores display-relative placement and falls back without shrinking when a monitor is unplugged', async () => {
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    const external = { id: 9, workArea: { x: -2560, y: 40, width: 2560, height: 1440 } }
    mock.displays.mockReturnValue([mock.display(), external])
    const restorePlacement = { displayId: 9, x: 200, y: 60 }
    await manager.resizeWindow(event(window), page.pageId, { width: 800, height: 600, restorePlacement })
    expect(window.getBounds()).toEqual({ x: -2360, y: 100, width: 808, height: 608 })
    external.workArea.x = 1920
    await manager.resizeWindow(event(window), page.pageId, { width: 800, height: 600, restorePlacement })
    expect(window.getBounds()).toEqual({ x: 2120, y: 100, width: 808, height: 608 })
    mock.displays.mockReturnValue([mock.display()])
    await manager.resizeWindow(event(window), page.pageId, { width: 2560, height: 1440, restorePlacement })
    expect(window.getBounds()).toEqual({ x: 200, y: 60, width: 2568, height: 1448 })
  })
  it('keeps a usable titlebar region on screen when an oversized placement is no longer reachable', async () => {
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    await manager.resizeWindow(event(window), page.pageId, { width: 2560, height: 1440,
      restorePlacement: { displayId: 1, x: 10000, y: 10000 } })
    expect(window.getBounds()).toEqual({ x: 1520, y: 780, width: 2568, height: 1448 })
    await manager.resizeWindow(event(window), page.pageId, { width: 2560, height: 1440,
      restorePlacement: { displayId: 1, x: -10000, y: -10000 } })
    expect(window.getBounds()).toEqual({ x: 0, y: 0, width: 2568, height: 1448 })
  })
  it('starts on the source monitor and preserves an explicit drag-out destination', async () => {
    mock.display.mockReturnValue({ id: 9, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } })
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    expect(mock.window).toHaveBeenLastCalledWith(expect.objectContaining({ x: 2720, y: 380, enableLargerThanScreen: true }))
    await manager.move(manager.list()[0].viewId, 'sidebar')
    mock.display.mockReturnValue({ id: 1, workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
    await manager.move(manager.list()[0].viewId, 'window', { atCursor: true })
    const window = windows[2], page = manager.ownedPages(event(window))[0]
    mock.displays.mockReturnValue([{ id: 9, workArea: { x: 1920, y: 0, width: 2560, height: 1440 } }])
    await manager.resizeWindow(event(window), page.pageId, { width: 800, height: 600, restorePlacement: { displayId: 9, x: 100, y: 100 } })
    expect(window.getBounds()).toEqual({ x: 100, y: 50, width: 808, height: 608 })
  })
  it('reports normal placement after movement and while maximized', async () => {
    await open()
    expect(manager.ownedPages(event(main))[0].windowPlacement).toBeUndefined()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    const send = vi.spyOn(window.webContents, 'send')
    mock.display.mockReturnValue({ id: 9, workArea: { x: -2560, y: 40, width: 2560, height: 1440 } })
    window.getNormalBounds.mockReturnValue({ x: -2400, y: 100, width: 1100, height: 800 })
    window.emit('moved')
    expect(send).toHaveBeenCalledWith('panel-page:changed')
    window.isMaximized.mockReturnValue(true)
    expect(manager.pageContext(event(window), page.pageId).windowPlacement).toEqual({ displayId: 9, x: 160, y: 60 })
  })
  it('rejects sidebar, foreign, retired and invalid resize requests', async () => {
    await open()
    const sidebar = manager.ownedPages(event(main))[0]
    const size = { width: 1024, height: 768 }
    await expect(manager.resizeWindow(event(main), sidebar.pageId, size)).rejects.toThrow('PANEL_ACTION_UNAVAILABLE')
    await manager.move(sidebar.panelId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    await expect(manager.resizeWindow(event(main), page.pageId, size)).rejects.toThrow('PANEL_CLOSED')
    await expect(manager.resizeWindow(event(main), sidebar.pageId, size)).rejects.toThrow('PANEL_CLOSED')
    for (const width of [0, -1, Infinity, NaN, 32769, '1024']) {
      await expect(manager.resizeWindow(event(window), page.pageId, { ...size, width })).rejects.toThrow('Invalid panel size')
    }
    await expect(manager.resizeWindow(event(window), page.pageId, { ...size, restore: 'true' })).rejects.toThrow('Invalid panel size')
    for (const restorePlacement of [null, {}, { displayId: NaN, x: 0, y: 0 }, { displayId: 1, x: Infinity, y: 0 }]) {
      await expect(manager.resizeWindow(event(window), page.pageId, { ...size, restorePlacement })).rejects.toThrow('Invalid panel placement')
    }
    expect(window.setContentSize).not.toHaveBeenCalled()
  })
  it('restores fullscreen and maximized windows only for an explicit resize request', async () => {
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    window.isFullScreen.mockReturnValue(true)
    window.isMaximized.mockReturnValue(true)
    const listeners = window.listenerCount('leave-full-screen'), maximizeListeners = window.listenerCount('unmaximize')
    await manager.resizeWindow(event(window), page.pageId, { width: 800, height: 600 })
    expect(window.setFullScreen).not.toHaveBeenCalled()
    await manager.resizeWindow(event(window), page.pageId, { width: 800, height: 600, restore: true })
    expect(window.setFullScreen).toHaveBeenCalledWith(false)
    expect(window.unmaximize).toHaveBeenCalledOnce()
    expect(window.getBounds()).toEqual({ x: 100, y: 50, width: 808, height: 608 })
    expect(window.listenerCount('leave-full-screen')).toBe(listeners)
    expect(window.listenerCount('unmaximize')).toBe(maximizeListeners)
  })
  it('stops a pending restore when the window closes and releases its listeners', async () => {
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    window.isFullScreen.mockReturnValue(true)
    window.setFullScreen.mockImplementation(() => {})
    const resizing = manager.resizeWindow(event(window), page.pageId, { width: 800, height: 600, restore: true })
    window.destroy()
    await expect(resizing).rejects.toThrow('PANEL_CLOSED')
    expect(window.setContentSize).not.toHaveBeenCalled()
    expect(window.listenerCount('leave-full-screen')).toBe(0)
  })
  it('preserves page icons across handoffs and replaces them when reopening with a new definition', async () => {
    const icon = { light: 'anas-plugin://example/_anas/icon/light.svg', dark: 'anas-plugin://example/_anas/icon/dark.svg' }
    await open()
    const original = manager.ownedPages(event(main))[0]
    manager.updateContent(original.panelId, original.view.content, { icon })
    await manager.move(original.panelId, 'window')
    expect(manager.fromShell(event(windows[1])).view.icon).toEqual(icon)
    await manager.move(original.panelId, 'sidebar')
    expect(manager.ownedPages(event(main))[0].view.icon).toEqual(icon)
    await open()
    expect(manager.state(original.panelId).icon).toBeUndefined()
  })
  it('rebuilds only the presentation and commits after restoration, then disposes the source', async () => {
    await open()
    const original = manager.ownedPages(event(main))[0]
    await manager.move(original.panelId, 'window')
    const target = manager.ownedPages(event(windows[1]))[0]
    expect(target.panelId).toBe(original.panelId)
    expect(target.pageId).not.toBe(original.pageId)
    expect(target.restoreState).toEqual({ draft: 'latest edit', scroll: 347 })
    expect(target.phase).toBe('active')
    expect(manager.ownedPages(event(main))).toEqual([])
    expect(commands.map(command => command.kind)).toEqual(['activate', 'prepare', 'activate', 'dispose'])
    expect(commands.at(-1)?.payload).toEqual({ reason: 'moved' })
    await manager.move(original.panelId, 'sidebar')
    expect(windows[1].destroyed).toBe(true)
    expect(manager.ownedPages(event(main))[0].panelId).toBe(original.panelId)
  })
  it.each(['ready', 'activate', 'prepare'])('preserves the source when %s fails', async phase => {
    await open()
    const original = manager.ownedPages(event(main))[0]
    if (phase === 'ready') ready = (owner, id) => manager.pageFailed(event(owner), id)
    else respond = async command => { if (command.kind === phase) throw new Error('failed'); return { draft: 'retained' } }
    await expect(manager.move(original.panelId, 'window')).rejects.toThrow(phase === 'ready' ? 'PANEL_LOAD_FAILED' : 'PANEL_ACTION_FAILED')
    expect(manager.ownedPages(event(main))[0]).toMatchObject({ pageId: original.pageId, phase: 'active' })
    expect(windows.slice(1).every(window => window.destroyed)).toBe(true)
    expect(commands.at(-1)?.kind).toBe('resume')
    expect(commands.some(command => command.kind === 'dispose')).toBe(false)
  })
  it('cancels a pending target and ignores stale completion when the panel closes', async () => {
    await open()
    const original = manager.ownedPages(event(main))[0]
    let pending: { owner: Window; pageId: string } | undefined
    ready = (owner, pageId) => { pending = { owner, pageId } }
    const move = manager.move(original.panelId, 'window').catch(error => error)
    await vi.waitFor(() => expect(pending).toBeDefined())
    await manager.close(original.panelId)
    expect(await move).toMatchObject({ message: 'PANEL_CLOSED' })
    expect(manager.list()).toEqual([])
    expect(windows[1].destroyed).toBe(true)
    expect(() => manager.pageReady(event(pending!.owner), pending!.pageId)).toThrow()
    expect(commands.at(-1)?.payload).toEqual({ reason: 'closed' })
  })
  it('serializes rapid moves without letting an old request replace a newer page', async () => {
    await open()
    const id = manager.list()[0].viewId
    await Promise.all([manager.move(id, 'window'), manager.move(id, 'sidebar'), manager.move(id, 'window')])
    expect(manager.state(id).location).toBe('window')
    expect(windows.filter(window => !window.destroyed)).toHaveLength(2)
    expect(commands.filter(command => command.kind === 'prepare')).toHaveLength(3)
  })
  it('keeps the source suspended if resource reattachment itself fails', async () => {
    await open()
    const source = manager.ownedPages(event(main))[0]
    respond = async command => { if (command.kind === 'activate' || command.kind === 'resume') throw new Error('resource failed'); return null }
    await expect(manager.move(source.panelId, 'window')).rejects.toThrow('PANEL_ACTION_FAILED')
    expect(manager.ownedPages(event(main))[0]).toMatchObject({ pageId: source.pageId, phase: 'suspended' })
    expect(windows[1].destroyed).toBe(true)
  })
  it('restores input after an unsuccessful close and keeps the original page', async () => {
    await open()
    const source = manager.ownedPages(event(main))[0]
    respond = async command => { if (command.kind === 'dispose') throw new Error('unsaved operation'); return null }
    await expect(manager.close(source.panelId)).rejects.toThrow('PANEL_ACTION_FAILED')
    expect(manager.ownedPages(event(main))[0]).toMatchObject({ pageId: source.pageId, phase: 'active' })
    expect(commands.at(-1)?.kind).toBe('resume')
  })
  it('rolls back a crashed target renderer and drops registrations on host reload', async () => {
    await open()
    const source = manager.ownedPages(event(main))[0]
    ready = owner => { owner.webContents.emit('render-process-gone') }
    await expect(manager.move(source.panelId, 'window')).rejects.toThrow()
    expect(manager.ownedPages(event(main))[0].phase).toBe('active')
    main.webContents.emit('did-start-navigation', {}, 'file:///index.html', false, true)
    expect(manager.list()).toEqual([])
    expect(manager.ownedPages(event(main))).toEqual([])
  })
  it('rejects a readiness acknowledgement from a different window', async () => {
    await open()
    const source = manager.ownedPages(event(main))[0]
    await manager.move(source.panelId, 'window')
    const target = manager.ownedPages(event(windows[1]))[0]
    expect(() => manager.pageReady(event(main), target.pageId)).toThrow('PANEL_CLOSED')
  })
  it('times out a target and resumes the original page', async () => {
    await open()
    const source = manager.ownedPages(event(main))[0]
    vi.useFakeTimers()
    ready = () => undefined
    const moving = manager.move(source.panelId, 'window')
    const rejection = expect(moving).rejects.toThrow('PANEL_LOAD_FAILED')
    await vi.advanceTimersByTimeAsync(30001)
    await rejection
    expect(manager.ownedPages(event(main))[0].phase).toBe('active')
    expect(windows[1].destroyed).toBe(true)
  })
})

it('combines native focus with sidebar selection and interaction without conflating lifecycle phase', async () => {
  await open()
  const id = manager.list()[0].viewId
  expect(manager.list()[0].activity).toEqual({ visible: false, active: false })
  manager.setActivity(event(main), id, id)
  expect(manager.list()[0].activity).toEqual({ visible: true, active: true })
  manager.setActivity(event(main), id, null)
  expect(manager.list()[0].activity).toEqual({ visible: true, active: false })
  manager.setActivity(event(main), id, id)
  main.isFocused.mockReturnValue(false); main.emit('blur')
  expect(manager.list()[0].activity?.active).toBe(false)
  main.isFocused.mockReturnValue(true); main.emit('focus')
  expect(manager.list()[0].activity?.active).toBe(true)
  manager.setActivity(event(main), null, null)
  expect(manager.list()[0].activity?.visible).toBe(false)
  await manager.move(id, 'window')
  expect(manager.list()[0].activity?.active).toBe(true)
  windows[1].isMinimized.mockReturnValue(true); windows[1].emit('minimize')
  expect(manager.list()[0].activity).toEqual({ visible: false, active: false })
})


it('concurrent closes both wait for disposal and share a failure without losing the page', async () => {
  await open()
  const id = manager.list()[0].viewId
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let fail = true
  respond = async command => {
    if (command.kind === 'dispose') { await gate; if (fail) throw new Error('dispose failed') }
    return null
  }
  const first = manager.close(id), second = manager.close(id)
  const failures = Promise.all([expect(first).rejects.toThrow(), expect(second).rejects.toThrow()])
  await vi.waitFor(() => expect(commands.filter(command => command.kind === 'dispose')).toHaveLength(1))
  expect(manager.list()).toHaveLength(1)
  release(); await failures
  expect(manager.list()).toHaveLength(1)
  fail = false
  await manager.close(id)
  expect(manager.list()).toHaveLength(0)
})

it.each(['ready', 'failed'])('settles repeated opens against the initial page when it becomes %s', async outcome => {
  let pending: { owner: Window; pageId: string } | undefined
  ready = (owner, pageId) => { pending = { owner, pageId } }
  const openFiles = (navigationId: string) => manager.open({ ownerId: 'builtin', name: () => 'Files',
    content: { kind: 'files', projectId: 'project', navigationId }, location: 'sidebar', locations: ['sidebar', 'window'] })
  const first = openFiles('first')
  await vi.waitFor(() => expect(pending).toBeDefined())
  let secondSettled = false
  const second = openFiles('second').finally(() => { secondSettled = true })
  const results = Promise.allSettled([first, second])
  await Promise.resolve()
  expect(secondSettled).toBe(false)
  if (outcome === 'ready') manager.pageReady(event(pending!.owner), pending!.pageId)
  else manager.pageFailed(event(pending!.owner), pending!.pageId)
  const settled = await results
  if (outcome === 'ready') {
    expect(settled.map(result => result.status)).toEqual(['fulfilled', 'fulfilled'])
    expect(manager.list()).toHaveLength(1)
    expect(manager.ownedPages(event(main))).toHaveLength(1)
    expect(manager.ownedPages(event(main))[0]).toMatchObject({ pageId: pending!.pageId, phase: 'active',
      view: { content: { navigationId: 'second' } } })
  } else {
    expect(settled).toEqual([expect.objectContaining({ status: 'rejected', reason: new Error('PANEL_LOAD_FAILED') }),
      expect.objectContaining({ status: 'rejected', reason: new Error('PANEL_LOAD_FAILED') })])
    expect(manager.list()).toEqual([])
    expect(manager.ownedPages(event(main))).toEqual([])
  }
})

it('waits for pending disposal before reopening the same identity', async () => {
  await open()
  const id = manager.list()[0].viewId
  let release!: () => void
  respond = async command => { if (command.kind === 'dispose') await new Promise<void>(resolve => { release = resolve }); return null }
  const closing = manager.close(id)
  await vi.waitFor(() => expect(release).toBeTypeOf('function'))
  let reopened = false
  const opening = open().then(() => { reopened = true })
  await Promise.resolve()
  expect(reopened).toBe(false)
  release(); await closing; await opening
  expect(manager.list()).toHaveLength(1)
  expect(manager.list()[0].viewId).not.toBe(id)
})
it('self-closing toolbar actions retire without a spurious failure', async () => {
  await open()
  const view = manager.list()[0], page = manager.ownedPages(event(main))[0]
  manager.setToolbar(event(main), page.pageId, { actions: [{ id: 'close', label: 'Close', icon: 'close.svg' }] })
  respond = async command => { if (command.kind === 'action') await manager.close(view.viewId); return null }
  await manager.invokeToolbarAction(view.viewId, 'close')
  expect(manager.list()).toHaveLength(0)
})

it('dispatches toolbar menu leaves and rejects containers, disabled parents and obsolete entries', async () => {
  await open()
  const view = manager.list()[0], page = manager.ownedPages(event(main))[0]
  const menu = (disabled = false) => ({ actions: [{ id: 'sizes', label: 'Sizes', icon: 'sizes.svg', disabled,
    items: [{ id: 'small', label: 'Small' }, { id: 'large', label: 'Large', disabled: true }] }] })
  manager.setToolbar(event(main), page.pageId, menu())
  await expect(manager.invokeToolbarAction(view.viewId, 'sizes')).rejects.toThrow('PANEL_ACTION_UNAVAILABLE')
  await expect(manager.invokeToolbarAction(view.viewId, 'large')).rejects.toThrow('PANEL_ACTION_UNAVAILABLE')
  await manager.invokeToolbarAction(view.viewId, 'small')
  expect(commands.filter(command => command.kind === 'action').at(-1)?.payload).toEqual({ actionId: 'small' })
  manager.setToolbar(event(main), page.pageId, menu(true))
  await expect(manager.invokeToolbarAction(view.viewId, 'small')).rejects.toThrow('PANEL_ACTION_UNAVAILABLE')
  manager.setToolbar(event(main), page.pageId, null)
  await expect(manager.invokeToolbarAction(view.viewId, 'small')).rejects.toThrow('PANEL_ACTION_UNAVAILABLE')
})
