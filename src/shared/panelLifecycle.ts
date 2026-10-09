import type { PanelContentState, PanelLocation } from './panels'
import type { PanelToolbar } from './panelToolbar'

export type PanelJson = null | boolean | number | string | PanelJson[] | { [key: string]: PanelJson }
export type PanelPagePhase = 'preparing' | 'active' | 'suspended'
export interface PanelPageContext extends PanelContentState {
  /** Stable panel identity and unique identity of this particular presentation. */
  panelId: string
  pageId: string
  location: PanelLocation
  phase: PanelPagePhase
  transferId?: string
  restoreState: PanelJson
  pluginUrl?: string
}
export type PanelCommandKind = 'prepare' | 'activate' | 'resume' | 'dispose' | 'action'
export interface PanelPageCommand {
  pageId: string
  requestId: string
  transferId?: string
  kind: PanelCommandKind
  payload: PanelJson
}
export interface PanelPageApi {
  list(): Promise<PanelPageContext[]>
  context(pageId: string): Promise<PanelPageContext>
  escape(pageId: string): Promise<void>
  ready(pageId: string): Promise<void>
  failed(pageId: string): Promise<void>
  complete(pageId: string, requestId: string, result: PanelJson, failed: boolean): Promise<void>
  setToolbar(pageId: string, toolbar: PanelToolbar | null): Promise<void>
  pluginInvoke(pageId: string, method: string, params?: PanelJson): Promise<unknown>
  onChanged(listener: () => void): () => void
  onCommand(listener: (command: PanelPageCommand) => void): () => void
  onCancel(listener: (requestId: string) => void): () => void
}

/** Handoff state is a bounded snapshot, never a live object or business resource. */
export function requirePanelJson(value: unknown): PanelJson {
  let nodes = 0
  const visit = (item: unknown, depth: number): void => {
    if (++nodes > 100_000 || depth > 32) throw new Error('PANEL_STATE_INVALID')
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (Array.isArray(item)) { item.forEach(child => visit(child, depth + 1)); return }
    if (item && typeof item === 'object' && Object.getPrototypeOf(item) === Object.prototype) {
      Object.values(item).forEach(child => visit(child, depth + 1)); return
    }
    throw new Error('PANEL_STATE_INVALID')
  }
  visit(value, 0)
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 1024 * 1024) throw new Error('PANEL_STATE_INVALID')
  return structuredClone(value) as PanelJson
}
