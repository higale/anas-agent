import { EventEmitter } from 'node:events'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import type { PanelPageCommand, PanelJson } from '@shared/panelLifecycle'
import type { LanguageResourcesSnapshot } from '@shared/types'
const mock = vi.hoisted(() => ({ window: vi.fn(), windows: vi.fn(), from: vi.fn() }))
vi.mock('electron', () => ({
  app: { isPackaged: true }, BrowserWindow: Object.assign(mock.window, { getAllWindows: mock.windows, fromWebContents: mock.from }),
  screen: { getCursorScreenPoint: () => ({ x: 500, y: 300 }), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1200, height: 800 } }) }
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
  isDestroyed = () => this.destroyed
  show = vi.fn()
  focus = vi.fn()
  setTitle = vi.fn()
  setMenuBarVisibility = vi.fn()
  loadURL = vi.fn(async () => undefined)
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
  mock.window.mockImplementation(function () { const window = new Window(); windows.push(window); return window })
  manager = new PanelPages(async () => ({ languages: [], resources: {} }) as unknown as LanguageResourcesSnapshot)
  ready = (owner, id) => manager.pageReady(event(owner), id)
  respond = async command => command.kind === 'prepare' ? { draft: 'latest edit', scroll: 347 } : null
})
afterEach(() => { manager.closeAll(); vi.useRealTimers() })

describe('page handoff', () => {
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
