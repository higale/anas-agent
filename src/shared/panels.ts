import type { AgentApi, AgentThreadCreate } from './agentTypes'
import type { CodeReviewRequest } from './codeReview'
import type { HelpDocumentId } from './helpDocuments'
import type { PanelToolbar } from './panelToolbar'
import type { PanelPageApi } from './panelLifecycle'
import type { PluginIconSources } from './plugins'
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
  icon?: PluginIconSources
  location: PanelLocation
  locations: PanelLocation[]
  pendingLocation?: PanelLocation
  /** Page loading is independent of placement and never blocks opening the host. */
  loading?: boolean
  toolbar?: PanelToolbar
  pendingActionId?: string
}
export interface PanelRequest { requestId: string; view: PanelState }
export interface PanelMoveOptions { atCursor?: boolean }
export interface PanelWindowState {
  view: PanelState
  language: string
  theme: 'light' | 'dark'
  fontSize: number
}
export interface PanelWindowApi {
  pages: PanelPageApi
  services: ContentServices
  getState(): Promise<PanelWindowState>
  getLanguageResources(): Promise<LanguageResourcesSnapshot>
  moveToSidebar(): Promise<void>
  invokeToolbarAction(id: string): Promise<void>
  open(panel: BuiltinPanel): Promise<void>
  updatePreferences(preferences: Partial<PanelPreferences>): Promise<void>
  review(pageId: string, request: CodeReviewRequest, navigationId: string): Promise<void>
  onCloseFailed(listener: () => void): () => void
  onChanged(listener: (state: PanelWindowState) => void): () => void
}
export interface PanelsApi {
  pages: PanelPageApi
  open(panel: BuiltinPanel): Promise<void>
  followFiles(context: FilesPanelContext): Promise<void>
  list(): Promise<PanelState[]>
  move(viewId: string, location: PanelLocation, options?: PanelMoveOptions): Promise<void>
  reorder(viewId: string, beforeViewId: string | null): Promise<void>
  close(viewId: string): Promise<void>
  acknowledge(requestId: string): Promise<void>
  review(pageId: string, request: CodeReviewRequest, navigationId: string): Promise<void>
  updatePreferences(preferences: Partial<PanelPreferences>): Promise<void>
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
