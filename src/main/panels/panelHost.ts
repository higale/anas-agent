import { randomUUID } from 'node:crypto'
import { validatePanelContext } from '../agent/agentIpcHandlers'
import { BrowserWindow, ipcMain, nativeTheme } from 'electron'
import { z } from 'zod/v3'
import { helpDocuments, isHelpDocumentId } from '@shared/helpDocuments'
import type { AppConfigSnapshot, Project } from '@shared/types'
import type { BuiltinPanel, PanelLocation, PanelPreferences } from '@shared/panels'
import { getAppSettings, onAppConfigChanged, updateSettings } from '../config/appConfig'
import { runApplicationDataOperation } from '../applicationDataLifecycle'
import { getLanguageResources, resolveConfiguredLanguage } from '../languageStore'
import { handleMainIpc } from '../ipcSecurity'
import { getProject } from '../projectStore'
import { runtimeLog } from '../runtimeLogger'
import { panelPages, panelLabel, setPanelLanguages } from './panelRegistry'
import type { PanelDefinition } from './panelPages'

const id = z.string().min(1).max(256)
const builtinSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('document'), documentId: z.custom<keyof typeof helpDocuments>(isHelpDocumentId), anchor: z.string().max(2048).optional(), navigationId: id.optional() }).strict(),
  z.object({ kind: z.literal('files'), projectId: id, threadId: id.optional(), runId: id.optional(), navigationId: id.optional(), draft: z.object({ modelConfigId: id.optional(), modelParameterPresetId: id.nullable().optional(), accessMode: z.enum(['strict_approval', 'read_only_allowed', 'full_access']).optional() }).strict().optional() }).strict(),
  z.object({ kind: z.literal('subagent'), projectId: id, threadId: id, runId: id, subagentId: id, name: z.string().min(1).max(512) }).strict()
])
let preferences: PanelPreferences | undefined
// Serialize context preparation, not page loading or placement acknowledgements.
let filesPreparation: Promise<unknown> = Promise.resolve()
function prepareFiles<T>(action: () => Promise<T>): Promise<T> {
  const result = filesPreparation.then(action, action)
  filesPreparation = result.catch(() => undefined)
  return result
}
function presentation(content: BuiltinPanel, project?: Project): Pick<PanelDefinition, 'name' | 'project'> {
  return { project, name: (language, currentProject) => content.kind === 'document' ? helpDocuments[content.documentId]
    : content.kind === 'subagent' ? content.name : `${panelLabel(language, 'file_changes')} · ${currentProject!.name}` }
}
export function updatePanelProject(project: Project): void { panelPages.updateProject(project) }
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
    const language = await resolveConfiguredLanguage(settings.language)
    const languages = await getLanguageResources()
    if (revision !== appearanceRevision) return appearanceRefresh
    setPanelLanguages(languages)
    panelPages.configure({ language: language.code,
      theme: nativeTheme.shouldUseDarkColors ? 'dark' : 'light', fontSize: settings.fontSize }, preferences)
  }
  appearanceRefresh = prepare()
  return appearanceRefresh
}

export async function openBuiltinPanel(value: unknown, location: PanelLocation = 'sidebar'): Promise<void> {
  const parsed = builtinSchema.parse(value)
  const prepare = () => runApplicationDataOperation(async () => {
    const content: BuiltinPanel = parsed.kind === 'files' ? { ...parsed, navigationId: randomUUID() } : parsed
    const project = content.kind !== 'document' ? await getProject(content.projectId) : undefined
    validatePanelContext(content)
    await refreshPanelAppearance()
    return { ready: panelPages.open({ content, location, locations: ['sidebar', 'window'], ownerId: 'builtin', ...presentation(content, project) }) }
  })
  const prepared = await (parsed.kind === 'files' ? prepareFiles(prepare) : prepare())
  await prepared.ready
}

export function followFilesPanel(value: unknown): Promise<void> {
  const context = builtinSchema.options[1].omit({ kind: true, runId: true, navigationId: true }).parse(value)
  return prepareFiles(() => runApplicationDataOperation(async () => {
    const view = panelPages.list().find(view => view.content.kind === 'files')
    if (!view || view.content.kind !== 'files') return
    const previous = view.content
    const sameContext = previous.projectId === context.projectId && previous.threadId === context.threadId
    if (sameContext && JSON.stringify(previous.draft) === JSON.stringify(context.draft)) return
    const content: BuiltinPanel = { kind: 'files', ...context, navigationId: randomUUID(),
      ...(sameContext && previous.runId ? { runId: previous.runId } : {}) }
    const project = await getProject(content.projectId)
    validatePanelContext(content)
    // Closing while the project is being read must not recreate the panel.
    if (!panelPages.list().some(current => current.viewId === view.viewId)) return
    panelPages.updateContent(view.viewId, content, presentation(content, project))
  }))
}

export function registerPanelIpc(): void {
  const refresh = (snapshot?: AppConfigSnapshot) => { void refreshPanelAppearance(snapshot).catch(error => runtimeLog('warn', 'panels', 'Failed to update panel appearance.', { error })) }
  onAppConfigChanged(({ snapshot }) => refresh(snapshot))
  nativeTheme.on('updated', () => refresh())
  handleMainIpc('panels:open', (_event, content: unknown) => openBuiltinPanel(content))
  handleMainIpc('panels:followFiles', (_event, context: unknown) => followFilesPanel(context))
  handleMainIpc('panels:list', () => panelPages.list())
  handleMainIpc('panels:move', (_event, viewId: string, location: PanelLocation, options: unknown) => panelPages.move(
    id.parse(viewId), z.enum(['sidebar', 'window']).parse(location),
    z.object({ atCursor: z.boolean().optional() }).strict().optional().parse(options)))
  handleMainIpc('panels:reorder', (_event, viewId: unknown, beforeViewId: unknown) =>
    panelPages.reorder(id.parse(viewId), id.nullable().parse(beforeViewId)))
  handleMainIpc('panels:close', (_event, viewId: string) => panelPages.close(viewId))
  handleMainIpc('panels:acknowledge', (event, requestId: unknown) => panelPages.acknowledge(event, id.parse(requestId)))
  handleMainIpc('panels:cancel', (event, requestId: string) => panelPages.cancelRequest(BrowserWindow.fromWebContents(event.sender)!, requestId))
  handleMainIpc('panels:hasRequest', (event, requestId: string) => panelPages.hasRequest(BrowserWindow.fromWebContents(event.sender)!, requestId))
  ipcMain.handle('panel-page:list', event => panelPages.ownedPages(event))
  ipcMain.handle('panel-page:context', (event, pageId: unknown) => panelPages.pageContext(event, pageId))
  ipcMain.handle('panel-page:escape', (event, pageId: unknown) => {
    const page = panelPages.pageContext(event, pageId)
    if (page.phase === 'active' && page.location === 'sidebar') event.sender.send('panels:escape', page.panelId)
  })
  ipcMain.handle('panel-page:ready', (event, pageId: unknown) => panelPages.pageReady(event, pageId))
  ipcMain.handle('panel-page:failed', (event, pageId: unknown) => panelPages.pageFailed(event, pageId))
  ipcMain.handle('panel-page:complete', (event, pageId: unknown, requestId: unknown, result: unknown, failed: unknown) =>
    panelPages.complete(event, pageId, requestId, result, failed))
  ipcMain.handle('panel-page:toolbar', (event, pageId: unknown, toolbar: unknown) => panelPages.setToolbar(event, pageId, toolbar))
  ipcMain.handle('panel-window:state', event => panelPages.fromShell(event))
  ipcMain.handle('panel-window:languages', event => panelPages.shellLanguages(event))
  ipcMain.handle('panel-window:action', (event, actionId: unknown) => panelPages.invokeToolbarAction(panelPages.fromShell(event).view.viewId, actionId))
  ipcMain.handle('panel-window:move', event => panelPages.move(panelPages.fromShell(event).view.viewId, 'sidebar'))
  ipcMain.handle('panel-window:open', (event, input: unknown) => {
    const current = panelPages.fromShell(event).view.content, next = builtinSchema.parse(input)
    if (!(current.kind === 'document' && next.kind === 'document') && !(current.kind === 'subagent' && next.kind === 'subagent'
      && current.threadId === next.threadId && current.projectId === next.projectId && current.runId === next.runId)) throw new Error('Panel navigation must stay in its own context.')
    return openBuiltinPanel(next, 'window')
  })
  ipcMain.handle('panels:preferences', (event, input: unknown) => {
    panelPages.assertHost(event)
    const preferences = z.object({ diffViewMode: z.enum(['inline', 'side_by_side']), diffFoldUnchanged: z.boolean(), diffWordWrap: z.boolean() }).partial().strict().parse(input)
    return runApplicationDataOperation(async () => { await updateSettings(preferences) })
  })
}
