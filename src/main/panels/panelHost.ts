import { randomUUID } from 'node:crypto'
import { validatePanelContext } from '../agent/agentIpcHandlers'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { z } from 'zod/v3'
import { helpDocuments, isHelpDocumentId } from '@shared/helpDocuments'
import type { AppConfigSnapshot, Project } from '@shared/types'
import type { BuiltinPanel, PanelContentState, PanelLayout, PanelLocation, PanelPreferences } from '@shared/panels'
import { getAppSettings, onAppConfigChanged, updateSettings } from '../config/appConfig'
import { runApplicationDataOperation } from '../applicationDataLifecycle'
import { getLanguageResources, resolveConfiguredLanguage } from '../languageStore'
import { handleMainIpc, registerContentRenderer, resolveRendererLocation } from '../ipcSecurity'
import { getProject } from '../projectStore'
import { runtimeLog } from '../runtimeLogger'
import { registerNativeContextMenu } from '../appShell'
import { registerZoomShortcuts } from '../zoomService'
import { builtinPanelCanInvoke } from './builtinPanelAccess'
import { panelViews, panelLanguages, panelLabel, setPanelLanguages } from './panelRegistry'
import { nativeTooltips } from './nativeTooltip'

const id = z.string().min(1).max(256)
const builtinSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), documentId: z.custom<keyof typeof helpDocuments>(isHelpDocumentId), anchor: z.string().max(2048).optional(), navigationId: id.optional() }).strict(),
  z.object({ kind: z.literal('files'), projectId: id, threadId: id.optional(), runId: id.optional(), navigationId: id.optional(), draft: z.object({ modelConfigId: id.optional(), modelParameterPresetId: id.nullable().optional(), accessMode: z.enum(['strict_approval', 'read_only_allowed', 'full_access']).optional() }).strict().optional() }).strict(),
  z.object({ kind: z.literal('subagent'), projectId: id, threadId: id, runId: id, subagentId: id, name: z.string().min(1).max(512) }).strict()
])
const contexts = new Map<Electron.WebContents, Pick<PanelContentState, 'project'>>()
let preferences: PanelPreferences | undefined
export function updatePanelProject(project: Project): void {
  for (const [contents, context] of contexts) if (context.project?.id === project.id) {
    context.project = project
    panelViews.notifyPageChanged(contents)
  }
}
let appearanceRevision = 0
let appearanceRefresh: Promise<void>
export function refreshPanelAppearance(snapshot?: Pick<AppConfigSnapshot, 'settings'>): Promise<void> {
  const revision = ++appearanceRevision
  const prepare = async (): Promise<void> => {
    const settings = snapshot?.settings ?? await getAppSettings()
    // An opening page must consume the latest preparation, including its
    // languages, rather than install settings from a superseded read.
    if (revision !== appearanceRevision) return appearanceRefresh
    const { diffViewMode, diffFoldUnchanged, diffWordWrap } = settings
    preferences = { diffViewMode, diffFoldUnchanged, diffWordWrap }
    for (const contents of contexts.keys()) panelViews.notifyPageChanged(contents)
    const language = await resolveConfiguredLanguage(settings.language)
    const languages = await getLanguageResources()
    if (revision !== appearanceRevision) return appearanceRefresh
    setPanelLanguages(languages)
    panelViews.configure({ language: language.code,
      theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', fontSize: settings.fontSize })
  }
  appearanceRefresh = prepare()
  return appearanceRefresh
}

export async function openBuiltinPanel(value: unknown, location: PanelLocation = 'sidebar'): Promise<void> {
  const prepared = await runApplicationDataOperation(async () => {
    const parsed = builtinSchema.parse(value)
    const content: BuiltinPanel = parsed.kind === 'files' ? { ...parsed, navigationId: randomUUID() } : parsed
    const project = content.kind !== 'document' ? await getProject(content.projectId) : undefined
    validatePanelContext(content)
    await refreshPanelAppearance()
    const source = resolveRendererLocation({ isPackaged: app.isPackaged, rendererFile: join(__dirname, '../renderer/panel-content.html'),
      rendererUrl: !app.isPackaged && process.env.ELECTRON_RENDERER_URL ? new URL('panel-content.html', process.env.ELECTRON_RENDERER_URL).toString() : undefined })
    source.url += `?panel=${randomUUID()}`
    return { ready: panelViews.open({ content, location, locations: ['sidebar', 'window'], source,
      ownerId: 'builtin', reuse: 'page',
      preload: join(__dirname, '../preload/panelContent.js'),
      name: language => content.kind === 'document' ? helpDocuments[content.documentId]
        : content.kind === 'subagent' ? content.name : panelLabel(language, 'file_changes'),
      update: contents => contexts.set(contents, { project }),
      register: contents => {
        registerNativeContextMenu(contents, () => panelViews.pageOwner(contents))
        registerZoomShortcuts(contents, () => panelViews.pageOwner(contents)?.webContents)
        contents.once('destroyed', () => contexts.delete(contents))
        registerContentRenderer(contents, { location: source, allows: (channel, args) => {
          const current = panelViews.pageContent(contents)
          return !!current && current.kind !== 'plugin' && builtinPanelCanInvoke(current, channel, args)
        } })
      }
    }) }
  })
  await prepared.ready
}

export function registerPanelIpc(): void {
  const refresh = (snapshot?: AppConfigSnapshot) => { void refreshPanelAppearance(snapshot).catch(error => runtimeLog('warn', 'panels', 'Failed to update panel appearance.', { error })) }
  onAppConfigChanged(({ snapshot }) => refresh(snapshot))
  nativeTheme.on('updated', () => refresh())
  handleMainIpc('panels:open', (_event, content: unknown) => openBuiltinPanel(content))
  handleMainIpc('panels:list', () => panelViews.list())
  handleMainIpc('panels:tooltip', (event, value: unknown) => nativeTooltips.set(BrowserWindow.fromWebContents(event.sender)!, value))
  handleMainIpc('panels:move', (_event, viewId: string, location: PanelLocation) => panelViews.move(viewId, location))
  handleMainIpc('panels:close', (_event, viewId: string) => panelViews.close(viewId))
  handleMainIpc('panels:layout', (event, layouts: PanelLayout[]) => panelViews.setLayouts(BrowserWindow.fromWebContents(event.sender)!, layouts))
  handleMainIpc('panels:cancel', (event, requestId: string) => panelViews.cancelRequest(BrowserWindow.fromWebContents(event.sender)!, requestId))
  handleMainIpc('panels:hasRequest', (event, requestId: string) => panelViews.hasRequest(BrowserWindow.fromWebContents(event.sender)!, requestId))
  ipcMain.handle('panel-window:state', event => panelViews.fromShell(event))
  ipcMain.handle('panel-window:languages', event => panelViews.shellLanguages(event))
  ipcMain.handle('panel-window:tooltip', (event, value: unknown) => {
    panelViews.fromShell(event)
    return nativeTooltips.set(BrowserWindow.fromWebContents(event.sender)!, value)
  })
  ipcMain.handle('panel-toolbar:set', (event, toolbar: unknown) => panelViews.setToolbar(panelViews.fromPage(event).viewId, toolbar))
  ipcMain.handle('panel-toolbar:complete', (event, requestId: unknown, failed: unknown) =>
    panelViews.completeToolbarAction(panelViews.fromPage(event).viewId, requestId, failed))
  ipcMain.handle('panel-window:action', (event, id: unknown) =>
    panelViews.invokeToolbarAction(panelViews.fromShell(event).view.viewId, id))
  ipcMain.handle('panel-window:layout', (event, bounds: unknown) => { panelViews.fromShell(event); panelViews.setWindowLayout(event.sender, bounds) })
  ipcMain.handle('panel-window:move', event => {
    const { view } = panelViews.fromShell(event)
    return panelViews.move(view.viewId, 'sidebar')
  })
  const fromContent = (event: Electron.IpcMainInvokeEvent) => {
    const state = panelViews.pageState(event)
    if (state.view.content.kind === 'plugin') throw new Error('Built-in panel required.')
    return state
  }
  ipcMain.handle('panel-content:state', (event): PanelContentState => {
    const state = fromContent(event)
    const context = contexts.get(event.sender)
    if (!context || !preferences) throw new Error('Panel context has not been prepared.')
    return { ...state, ...context, preferences }
  })
  ipcMain.handle('panel-content:languages', event => { fromContent(event); return panelLanguages() })
  ipcMain.handle('panel-content:escape', event => { fromContent(event); panelViews.escape(event.sender) })
  ipcMain.handle('panel-content:open', (event, input: unknown) => {
    const { view } = fromContent(event)
    const next = builtinSchema.parse(input)
    const current = view.content
    if (!(current.kind === 'document' && next.kind === 'document') && !(current.kind === 'subagent' && next.kind === 'subagent'
      && current.threadId === next.threadId && current.projectId === next.projectId && current.runId === next.runId)) throw new Error('Panel navigation must stay in its own context.')
    return openBuiltinPanel(next, view.location)
  })
  ipcMain.handle('panel-content:preferences', (event, input: Partial<PanelPreferences>) => {
    const { view } = fromContent(event)
    if (view.content.kind !== 'files') throw new Error('File changes panel required.')
    const preferences = z.object({ diffViewMode: z.enum(['inline', 'side_by_side']), diffFoldUnchanged: z.boolean(), diffWordWrap: z.boolean() }).partial().strict().parse(input)
    return runApplicationDataOperation(async () => { await updateSettings(preferences) })
  })
}
