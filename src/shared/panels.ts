import type { AgentApi, AgentThreadCreate } from './agentTypes'
import type { CodeReviewRequest } from './codeReview'
import type { HelpDocumentId } from './helpDocuments'
import type { PanelToolbar, PanelToolbarApi } from './panelToolbar'
import type { NativeTooltipApi } from './nativeTooltip'
import type { AppSettings, GaleApi, LanguageResourcesSnapshot, Project } from './types'

export type PanelLocation = 'sidebar' | 'window'
export type BuiltinPanel =
  | { kind: 'document'; documentId: HelpDocumentId; anchor?: string; navigationId?: string }
  | { kind: 'files'; projectId: string; threadId?: string; runId?: string; navigationId?: string; draft?: Pick<AgentThreadCreate, 'modelConfigId' | 'modelParameterPresetId' | 'accessMode'> }
  | { kind: 'subagent'; projectId: string; threadId: string; runId: string; subagentId: string; name: string }
export type PanelContent = BuiltinPanel | { kind: 'plugin'; pluginId: string; instanceId: string }
export type FilesPanelContext = Pick<Extract<BuiltinPanel, { kind: 'files' }>, 'projectId' | 'threadId' | 'draft'>
export interface PanelState {
  viewId: string
  content: PanelContent
  name: string
  location: PanelLocation
  locations: PanelLocation[]
  pendingLocation?: PanelLocation
  /** Page loading is independent of placement and never blocks opening the host. */
  loading?: boolean
  /** Last sidebar presentation; retained while its renderer reloads. */
  sidebarVisible?: boolean
  toolbar?: PanelToolbar
  pendingActionId?: string
}
export interface PanelBounds { x: number; y: number; width: number; height: number }
export interface PanelLayout { viewId: string; requestId?: string; bounds: PanelBounds | null }
export interface PanelRequest { requestId: string; view: PanelState }
export interface PanelTabMenuOptions { closeLabel: string; position?: Pick<PanelBounds, 'x' | 'y'> }
export interface PanelWindowState {
  view: PanelState
  language: string
  theme: 'light' | 'dark'
  fontSize: number
}
export interface PanelWindowApi extends NativeTooltipApi {
  getState(): Promise<PanelWindowState>
  getLanguageResources(): Promise<LanguageResourcesSnapshot>
  moveToSidebar(): Promise<void>
  invokeToolbarAction(id: string): Promise<void>
  setLayout(bounds: PanelBounds | null): Promise<void>
  onChanged(listener: (state: PanelWindowState) => void): () => void
}
export interface PanelsApi extends NativeTooltipApi {
  open(panel: BuiltinPanel): Promise<void>
  followFiles(context: FilesPanelContext): Promise<void>
  list(): Promise<PanelState[]>
  move(viewId: string, location: PanelLocation): Promise<void>
  close(viewId: string): Promise<void>
  showTabMenu(viewId: string, options: PanelTabMenuOptions): Promise<boolean>
  setLayouts(layouts: PanelLayout[]): Promise<void>
  cancelRequest(requestId: string): Promise<void>
  hasRequest(requestId: string): Promise<boolean>
  onChanged(listener: (views: PanelState[]) => void): () => void
  onReviewStarted(listener: (threadId: string, context: FilesPanelContext) => void): () => void
  onOpen(listener: (request: PanelRequest) => void): () => void
  onEscape(listener: (viewId: string) => void): () => void
}
export type PanelPreferences = Pick<AppSettings, 'diffViewMode' | 'diffFoldUnchanged' | 'diffWordWrap'>
/** The content renderer has only the services needed by shared presentation components. */
export interface ContentServices {
  app: Pick<GaleApi['app'], 'readHelp' | 'openExternalUrl'>
  files: Pick<GaleApi['files'], 'showItemInFolder' | 'readFileIcon' | 'readAttachmentPreview'>
  agent: Pick<AgentApi, 'changes' | 'activities' | 'onEvent'> & { threads: Pick<AgentApi['threads'], 'get'> }
}
export interface PanelContentState extends PanelWindowState {
  project?: Project
  preferences: PanelPreferences
}
export interface PanelContentApi extends PanelToolbarApi {
  services: ContentServices
  getState(): Promise<PanelContentState>
  getLanguageResources(): Promise<LanguageResourcesSnapshot>
  onChanged(listener: (state: PanelWindowState) => void): () => void
  open(panel: BuiltinPanel): Promise<void>
  updatePreferences(preferences: Partial<PanelPreferences>): Promise<void>
  escape(): Promise<void>
  review(request: CodeReviewRequest, navigationId: string): Promise<void>
}

export function panelScope(content: PanelContent): string | undefined {
  return content.kind === 'subagent'
    ? workspacePanelScope(content.threadId, content.projectId) : undefined
}
export function workspacePanelScope(threadId: string | undefined, projectId: string): string {
  return JSON.stringify(threadId ? ['thread', threadId] : ['draft', projectId])
}
export function panelIdentity(content: PanelContent): string {
  switch (content.kind) {
    case 'plugin': return JSON.stringify([content.kind, content.pluginId, content.instanceId])
    case 'document': return JSON.stringify([content.kind, content.documentId])
    case 'files': return JSON.stringify([content.kind])
    case 'subagent': return JSON.stringify([content.kind, content.threadId, content.runId, content.subagentId])
  }
}
export function requirePanelBounds(value: unknown): PanelBounds | null {
  if (value === null) return null
  if (!value || typeof value !== 'object') throw new Error('Invalid panel bounds.')
  const bounds = value as PanelBounds
  if (![bounds.x, bounds.y, bounds.width, bounds.height].every(n => typeof n === 'number' && Number.isFinite(n) && Math.abs(n) <= 100_000)
    || bounds.width <= 0 || bounds.height <= 0) throw new Error('Invalid panel bounds.')
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
}
