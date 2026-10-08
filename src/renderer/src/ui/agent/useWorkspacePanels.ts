import { useCallback, useRef, useState } from 'react'
import { panelScope, type BuiltinPanel, type PanelContent, type PanelLocation, type PanelState } from '@shared/panels'
import { notice } from '../notice'
import { isPanelClosed, panelError } from '../panels/panelError'
import i18n from '../../i18n'
export { workspacePanelScope } from '@shared/panels'

export interface WorkspacePanelTab {
  id: string
  name: string
  panel: PanelContent
  viewId: string
  requestId?: string
  locations: PanelLocation[]
  moving: boolean
  loading?: boolean
}

export interface WorkspacePanelGroup {
  tabs: WorkspacePanelTab[]
  activeId?: string
  expanded: boolean
  maximized: boolean
}

const emptyGroup: WorkspacePanelGroup = { tabs: [], expanded: false, maximized: false }

interface SidebarState {
  groups: Record<string, WorkspacePanelGroup>
  documents: WorkspacePanelGroup
}

function visibleGroup(state: SidebarState, scope: string): WorkspacePanelGroup {
  const local = state.groups[scope] ?? emptyGroup
  const documents = state.documents
  const activeId = documents.activeId ?? local.activeId ?? documents.tabs[0]?.id
  const active = documents.tabs.some((tab) => tab.id === activeId) ? documents : local
  return { ...active, activeId, tabs: [...local.tabs, ...documents.tabs] }
}

export function useWorkspacePanels() {
  const [state, setState] = useState<SidebarState>({ groups: {}, documents: emptyGroup })
  const initialized = useRef(false)
  const update = useCallback((scope: string, change: (group: WorkspacePanelGroup) => WorkspacePanelGroup) => {
    setState((current) => {
      const group = change(visibleGroup(current, scope))
      const localTabs = group.tabs.filter((tab) => tab.panel.kind !== 'document' && tab.panel.kind !== 'plugin')
      const documentTabs = group.tabs.filter((tab) => tab.panel.kind === 'document' || tab.panel.kind === 'plugin')
      const documentActive = documentTabs.some((tab) => tab.id === group.activeId)
      const previousLocal = current.groups[scope] ?? emptyGroup
      const localActiveId = localTabs.some((tab) => tab.id === previousLocal.activeId)
        ? previousLocal.activeId : localTabs[0]?.id
      return {
        groups: { ...current.groups, [scope]: documentActive
          ? { ...previousLocal, tabs: localTabs, activeId: localActiveId }
          : { ...group, tabs: localTabs } },
        documents: { ...(documentActive ? group : current.documents), tabs: documentTabs,
          activeId: documentActive ? group.activeId : undefined }
      }
    })
  }, [])
  const open = useCallback((panel: BuiltinPanel) => {
    void window.gale.panels.open(panel).catch(error => {
      if (!isPanelClosed(error)) notice.error(panelError(error, i18n.t))
    })
  }, [])
  const present = useCallback((scope: string, view: PanelState, requestId?: string) => {
    const tab: WorkspacePanelTab = { id: view.viewId, name: view.name, panel: view.content, viewId: view.viewId,
      requestId, locations: view.locations, moving: !!view.pendingLocation, loading: view.loading }
    update(panelScope(view.content) ?? scope, group => ({ ...group, expanded: true, activeId: tab.id,
      tabs: group.tabs.some(item => item.id === tab.id) ? group.tabs.map(item => item.id === tab.id ? tab : item) : [...group.tabs, tab] }))
  }, [update])
  const select = useCallback((scope: string, id: string) => {
    update(scope, (group) => group.tabs.some((tab) => tab.id === id) ? { ...group, activeId: id } : group)
  }, [update])
  const toggle = useCallback((scope: string) => {
    update(scope, (group) => ({ ...group, expanded: group.tabs.length > 0 && !group.expanded, maximized: false }))
  }, [update])
  const dismiss = useCallback((scope: string) => {
    update(scope, (group) => ({ ...group, expanded: false, maximized: false }))
  }, [update])
  const toggleMaximized = useCallback((scope: string) => {
    update(scope, (group) => group.expanded && group.tabs.length > 0 ? { ...group, maximized: !group.maximized } : group)
  }, [update])
  const remove = useCallback((scope: string) => {
    setState((current) => {
      const next = { ...current.groups }
      delete next[scope]
      return { ...current, groups: next }
    })
  }, [])
  const syncViews = useCallback((views: PanelState[]) => {
    const restore = !initialized.current
    initialized.current = true
    const visible = views.filter(view => view.location === 'sidebar' || view.pendingLocation === 'sidebar')
    setState(current => {
      const project = (group: WorkspacePanelGroup, scope?: string): WorkspacePanelGroup => {
        const relevant = visible.filter(view => panelScope(view.content) === scope)
        const restored = restore ? relevant.find(view => view.sidebarVisible) : undefined
        const tabs = relevant.map(view => ({ id: view.viewId, name: view.name, viewId: view.viewId, panel: view.content,
          locations: view.locations, moving: !!view.pendingLocation, loading: view.loading,
          requestId: group.tabs.find(tab => tab.id === view.viewId)?.requestId }))
        const previousIndex = group.tabs.findIndex(tab => tab.id === group.activeId)
        const activeId = restored?.viewId ?? (tabs.some(tab => tab.id === group.activeId) ? group.activeId : tabs[Math.min(Math.max(0, previousIndex), tabs.length - 1)]?.id)
        return { ...group, tabs, activeId, expanded: !!restored || (tabs.length > 0 && group.expanded), maximized: tabs.length > 0 && group.maximized }
      }
      const scopes = new Set([...Object.keys(current.groups), ...visible.flatMap(view => { const scope = panelScope(view.content); return scope ? [scope] : [] })])
      return { groups: Object.fromEntries([...scopes].map(scope => [scope, project(current.groups[scope] ?? emptyGroup, scope)])),
        documents: { ...project(current.documents), activeId: current.documents.activeId || (restore && visible.some(view => !panelScope(view.content) && view.sidebarVisible))
          ? project(current.documents).activeId : undefined } }
    })
  }, [])
  return { ...state, open, present, select, toggle, dismiss, toggleMaximized, remove, syncViews }
}

export type WorkspacePanelsController = ReturnType<typeof useWorkspacePanels>
export function workspacePanelGroup(controller: WorkspacePanelsController, scope: string): WorkspacePanelGroup {
  return visibleGroup(controller, scope)
}
