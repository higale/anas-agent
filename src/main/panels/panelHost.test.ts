import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppSettings, LanguageResourcesSnapshot } from '@shared/types'
import type { PanelDefinition } from './panelViews'

const mocks = vi.hoisted(() => ({
  settings: vi.fn(), languages: vi.fn(), configure: vi.fn(), open: vi.fn(),
  setLanguages: vi.fn(), handlers: new Map<string, (...args: unknown[]) => unknown>()
}))
vi.mock('electron', () => ({ app: { isPackaged: true }, BrowserWindow: {}, nativeTheme: { on: vi.fn(), shouldUseDarkColors: true },
  ipcMain: { handle: (name: string, handler: (...args: unknown[]) => unknown) => mocks.handlers.set(name, handler) } }))
vi.mock('../agent/agentIpcHandlers', () => ({ validatePanelContext: vi.fn() }))
vi.mock('../applicationDataLifecycle', () => ({ runApplicationDataOperation: (action: () => unknown) => action() }))
vi.mock('../config/appConfig', () => ({ getAppSettings: mocks.settings, onAppConfigChanged: vi.fn(), updateSettings: vi.fn() }))
vi.mock('../languageStore', () => ({ getLanguageResources: mocks.languages, resolveConfiguredLanguage: async (code: string) => ({ code }) }))
vi.mock('../projectStore', () => ({ getProject: async () => ({ id: 'project', kind: 'workspace' }) }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
vi.mock('../appShell', () => ({ registerNativeContextMenu: vi.fn() }))
vi.mock('../zoomService', () => ({ registerZoomShortcuts: vi.fn() }))
vi.mock('../ipcSecurity', () => ({ handleMainIpc: vi.fn(), registerContentRenderer: vi.fn(),
  resolveRendererLocation: () => ({ url: 'file:///panel-content.html' }) }))
vi.mock('./panelRegistry', () => ({ panelLabel: () => 'Files', panelLanguages: vi.fn(), setPanelLanguages: mocks.setLanguages,
  panelViews: { open: mocks.open, configure: mocks.configure, notifyPageChanged: vi.fn(),
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
