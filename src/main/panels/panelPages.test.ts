import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { PanelPageCommand, PanelJson } from '@shared/panelLifecycle'
import type { LanguageResourcesSnapshot } from '@shared/types'
const mock = vi.hoisted(() => ({ window: vi.fn(), windows: vi.fn(), from: vi.fn(), display: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: true }, BrowserWindow: Object.assign(mock.window, { getAllWindows: mock.windows, fromWebContents: mock.from }),
  screen: { getCursorScreenPoint: () => ({ x: 500, y: 300 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }), getDisplayMatching: mock.display }
}))
vi.mock('../ipcSecurity', () => ({ assertTrustedIpcEvent: vi.fn(),
  isMainRendererWindow: (window: Window) => window.main && !window.destroyed,
  rendererLocationMatches: () => true, resolveRendererLocation: () => ({ url: 'file:///panel-window.html' }), registerContentRenderer: vi.fn() }))
vi.mock('../windowAppearance', () => ({ titleBarColors: () => ({}), titleBarOptions: () => ({}) }))
vi.mock('../zoomService', () => ({ registerWindowZoomShortcuts: vi.fn() }))
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
  setFullScreen = vi.fn((_value: boolean) => { this.isFullScreen.mockReturnValue(false); this.emit('leave-full-screen') })
  unmaximize = vi.fn(() => { this.isMaximized.mockReturnValue(false); this.emit('unmaximize') })
  getBounds = vi.fn(() => ({ x: 100, y: 50, width: 960, height: 680 }))
  getContentBounds = vi.fn(() => ({ x: 104, y: 54, width: 952, height: 672 }))
  getMinimumSize = vi.fn(() => [400, 300])
  setBounds = vi.fn()
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
  mock.display.mockReturnValue({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } })
  mock.window.mockImplementation(function () { const window = new Window(); windows.push(window); return window })
  manager = new PanelPages(async () => ({ languages: [], resources: {} }) as unknown as LanguageResourcesSnapshot)
  ready = (owner, id) => manager.pageReady(event(owner), id)
  respond = async command => command.kind === 'prepare' ? { draft: 'latest edit', scroll: 347 } : null
})
afterEach(() => { manager.closeAll(); vi.useRealTimers() })

describe('page handoff', () => {
  it('fits CSS content with application zoom and native window chrome', async () => {
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    window.webContents.getZoomFactor.mockReturnValue(1.25)
    await manager.resizeWindow(event(window), page.pageId, { width: 824, height: 658 })
    expect(window.setBounds).toHaveBeenCalledWith({ x: 100, y: 50, width: 1038, height: 831 })
  })
  it('keeps oversized content windows within the current monitor, including negative coordinates', async () => {
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    mock.display.mockReturnValue({ workArea: { x: -1280, y: 24, width: 1280, height: 1000 } })
    await manager.resizeWindow(event(window), page.pageId, { width: 2560, height: 1440 })
    expect(window.setBounds).toHaveBeenCalledWith({ x: -1280, y: 24, width: 1280, height: 1000 })
    window.isMaximized.mockReturnValue(true)
    window.setBounds.mockClear()
    await manager.resizeWindow(event(window), page.pageId, { width: 800, height: 600 })
    expect(window.setBounds).not.toHaveBeenCalled()
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
    expect(window.setBounds).not.toHaveBeenCalled()
  })
  it('restores fullscreen and maximized windows only for an explicit resize request', async () => {
    await open()
    await manager.move(manager.list()[0].viewId, 'window')
    const window = windows[1], page = manager.ownedPages(event(window))[0]
    window.isFullScreen.mockReturnValue(true)
    window.isMaximized.mockReturnValue(true)
    await manager.resizeWindow(event(window), page.pageId, { width: 800, height: 600 })
    expect(window.setFullScreen).not.toHaveBeenCalled()
    await manager.resizeWindow(event(window), page.pageId, { width: 800, height: 600, restore: true })
    expect(window.setFullScreen).toHaveBeenCalledWith(false)
    expect(window.unmaximize).toHaveBeenCalledOnce()
    expect(window.setBounds).toHaveBeenCalledWith({ x: 100, y: 50, width: 808, height: 608 })
    expect(window.listenerCount('leave-full-screen')).toBe(0)
    expect(window.listenerCount('unmaximize')).toBe(0)
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
    expect(window.setBounds).not.toHaveBeenCalled()
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
    await expect(manager.move(original.panelId, 'window')).rejects.toThrow()
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
    expect(await move).toBeInstanceOf(Error)
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
