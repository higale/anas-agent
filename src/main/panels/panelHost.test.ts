import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, LanguageResourcesSnapshot, Project } from '@shared/types'
import type { PanelState } from '@shared/panels'
import type { PanelDefinition } from './panelViews'

const mocks = vi.hoisted(() => ({
  settings: vi.fn(), languages: vi.fn(), configure: vi.fn(), open: vi.fn(),
  project: vi.fn(), list: vi.fn(), updateContent: vi.fn(),
  setLanguages: vi.fn(), handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({ app: { isPackaged: true }, BrowserWindow: {}, nativeTheme: { on: vi.fn(), shouldUseDarkColors: true },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(name, handler) } }))
vi.mock('../agent/agentIpcHandlers', () => ({ validatePanelContext: vi.fn() }))
vi.mock('../applicationDataLifecycle', () => ({ runApplicationDataOperation: (action: () => unknown) => action() }))
vi.mock('../config/appConfig', () => ({ getAppSettings: mocks.settings, onAppConfigChanged: vi.fn(), updateSettings: vi.fn() }))
vi.mock('../languageStore', () => ({ getLanguageResources: mocks.languages, resolveConfiguredLanguage: async (code: string) => ({ code }) }))
vi.mock('../projectStore', () => ({ getProject: mocks.project }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../appShell', () => ({ registerNativeContextMenu: vi.fn() }))
vi.mock('../zoomService', () => ({ registerZoomShortcuts: vi.fn() }))
vi.mock('../ipcSecurity', () => ({ handleMainIpc: vi.fn(), registerContentRenderer: vi.fn(),
  resolveRendererLocation: () => ({ url: 'file:///panel-content.html' }) }))
vi.mock('./panelRegistry', () => ({ panelLabel: () => 'Files', panelLanguages: vi.fn(), setPanelLanguages: mocks.setLanguages,
  panelViews: { open: mocks.open, configure: mocks.configure, notifyPageChanged: vi.fn(),
    list: mocks.list, updateContent: mocks.updateContent,
    pageState: () => ({ view: { content: { kind: 'files' } } }) } }))

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => { resolve = done })
  return { promise, resolve }
}
const settings = { language: 'en', fontSize: 14, diffViewMode: 'inline', diffFoldUnchanged: true, diffWordWrap: false } as AppSettings
const resources = { resources: {}, languages: [], langDir: '/languages' } as LanguageResourcesSnapshot
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.handlers.clear()
  mocks.settings.mockResolvedValue(settings)
  mocks.languages.mockResolvedValue(resources)
  mocks.project.mockImplementation(async (id: string) => ({ id, name: id, kind: 'workspace' }))
  mocks.list.mockReturnValue([])
})

describe('file panel follows the active workspace', () => {
  it('updates the existing page in order without opening or focusing it, and clears the old run', async () => {
    const { followFilesPanel } = await import('./panelHost')
    let view: PanelState = { viewId: 'files', content: { kind: 'files', projectId: 'one', threadId: 'thread-one', runId: 'run-one' },
      name: 'Files · one', location: 'window', locations: ['window', 'sidebar'] }
    mocks.list.mockImplementation(() => [view])
    mocks.updateContent.mockImplementation((viewId, content, presentation: Pick<PanelDefinition, 'name' | 'update'>) => {
      view = { ...view, viewId, content, name: presentation.name('en') }
    })
    const slow = pending<Project>()
    mocks.project.mockReturnValueOnce(slow.promise)
    const first = followFilesPanel({ projectId: 'two', threadId: 'thread-two' })
    await vi.waitFor(() => expect(mocks.project).toHaveBeenCalledWith('two'))
    const second = followFilesPanel({ projectId: 'three' })
    expect(mocks.project).not.toHaveBeenCalledWith('three')
    slow.resolve({ id: 'two', name: 'Two' } as Project)
    await Promise.all([first, second])
    expect(view).toMatchObject({ viewId: 'files', location: 'window', name: 'Files · three', content: { projectId: 'three' } })
    expect(view.content).not.toHaveProperty('runId')
    expect(view.content).not.toHaveProperty('threadId')
    expect(mocks.open).not.toHaveBeenCalled()
    mocks.updateContent.mockClear()
    await followFilesPanel({ projectId: 'three' })
    expect(mocks.updateContent).not.toHaveBeenCalled()
  })
  it('does not create a closed panel, including closing during a project read', async () => {
    const { followFilesPanel } = await import('./panelHost')
    await followFilesPanel({ projectId: 'two' })
    expect(mocks.project).not.toHaveBeenCalled()
    mocks.list.mockReturnValue([{ viewId: 'files', content: { kind: 'files', projectId: 'one' } }])
    const slow = pending<Project>()
    mocks.project.mockReturnValueOnce(slow.promise)
    const following = followFilesPanel({ projectId: 'two' })
    await vi.waitFor(() => expect(mocks.project).toHaveBeenCalled())
    mocks.list.mockReturnValue([])
    slow.resolve({ id: 'two', name: 'Two' } as Project)
    await following
    expect(mocks.updateContent).not.toHaveBeenCalled()
    expect(mocks.open).not.toHaveBeenCalled()
  })
})

describe('panel appearance preparation', () => {
  it.each(['settings', 'languages'] as const)('opens with current preferences when %s preparation is superseded', async phase => {
    const read = pending<AppSettings>(), languages = pending<LanguageResourcesSnapshot>()
    if (phase === 'settings') mocks.settings.mockReturnValueOnce(read.promise)
    else mocks.languages.mockReturnValueOnce(languages.promise)
    const contents = {}
    mocks.open.mockImplementation(async (definition: PanelDefinition) => definition.update?.(contents as Electron.WebContents))
    const { openBuiltinPanel, refreshPanelAppearance, registerPanelIpc } = await import('./panelHost')
    registerPanelIpc()
    const opening = openBuiltinPanel({ kind: 'files', projectId: 'project' })
    await vi.waitFor(() => expect(phase === 'settings' ? mocks.settings : mocks.languages).toHaveBeenCalledTimes(1))
    const latest = { ...settings, language: 'zh-CN', fontSize: 18, diffWordWrap: true }
    await refreshPanelAppearance({ settings: latest })
    read.resolve(settings); languages.resolve({ ...resources, langDir: '/stale-languages' })
    await opening
    const state = mocks.handlers.get('panel-content:state')!({ sender: contents })
    expect(state).toMatchObject({ preferences: { diffViewMode: 'inline', diffFoldUnchanged: true, diffWordWrap: true } })
    expect(mocks.configure).toHaveBeenLastCalledWith({ language: 'zh-CN', theme: 'dark', fontSize: 18 })
    expect(mocks.setLanguages).toHaveBeenLastCalledWith(resources)
  })
})
