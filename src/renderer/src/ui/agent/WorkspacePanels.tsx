import { helpDocuments } from '@shared/helpDocuments'
import * as ContextMenu from '@radix-ui/react-context-menu'
import { ContextMenuShell } from '../ContextMenuShell'
import { installPanelEscapeHandler } from '../panels/panelKeyboard'
import { PanelPageHost } from '../panels/PanelPageHost'
import { PluginIcon } from '../plugins/PluginIcon'
import * as Tabs from '@radix-ui/react-tabs'
import { BookOpen, FileDiff, Maximize2, Minimize2, PanelLeftOpen, PanelRightClose, SquareArrowOutUpRight, X } from 'lucide-react'
import { useEffect, useRef, type RefObject } from 'react'
import { useTranslation } from 'react-i18next'
import type { AgentRunActivity } from '@shared/agentTypes'
import { WORKSPACE_PANEL_WIDTH_DEFAULT } from '@shared/uiPreferences'
import { ResizeHandle } from '../ResizeHandle'
import { AgentSubagentStatusIcon, subagentStatusLabel } from './AgentSubagentActivityDock'
import { workspacePanelGroup, type WorkspacePanelsController } from './useWorkspacePanels'
import { notice } from '../notice'
import { panelError } from '../panels/panelError'
import { usePanelTabDrag } from './usePanelTabDrag'

interface WorkspacePanelsProps {
  controller: WorkspacePanelsController
  scope: string
  activities: AgentRunActivity[]
  sidebarVisible?: boolean
  onToggleSidebar?(): void | Promise<void>
  narrow: boolean
  width: number
  minWidth: number
  maxWidth: number
  toggleRef: RefObject<HTMLButtonElement | null>
  inputRef: RefObject<HTMLTextAreaElement | null>
  onWidthCommit(width: number): void | Promise<void>

}

export function WorkspacePanels({ controller, scope, activities, narrow, width, minWidth, maxWidth,
  toggleRef, inputRef, onWidthCommit, sidebarVisible, onToggleSidebar }: WorkspacePanelsProps) {
  const { t } = useTranslation()
  const rootRef = useRef<HTMLDivElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const group = workspacePanelGroup(controller, scope)
  const activeTab = group.tabs.find(tab => tab.id === group.activeId)
  const activeViewId = activeTab?.viewId
  const drag = usePanelTabDrag({ scope, enabled: group.expanded, tabs: group.tabs, listRef,
    onReorder: (viewId, beforeViewId) => {
      void window.gale.panels.reorder(viewId, beforeViewId).catch(reason => notice.error(panelError(reason, t)))
    },
    onDetach: viewId => {
      void window.gale.panels.move(viewId, 'window', { atCursor: true }).catch(reason => notice.error(panelError(reason, t)))
    }
  })
  const { dismiss } = controller
  useEffect(() => {
    if (!narrow || !group.expanded) return
    return installPanelEscapeHandler(() => {
      if (rootRef.current?.closest('.workspace-panels')?.contains(document.activeElement)) {
        dismiss(scope)
        requestAnimationFrame(() => (toggleRef.current ?? inputRef.current)?.focus({ preventScroll: true }))
      }
    })
  }, [narrow, group.expanded, dismiss, scope, toggleRef, inputRef])
  useEffect(() => {
    if (!narrow || !group.expanded || !activeViewId) return
    return window.gale.panels.onEscape(viewId => {
      if (activeViewId !== viewId) return
      dismiss(scope)
      requestAnimationFrame(() => (toggleRef.current ?? inputRef.current)?.focus({ preventScroll: true }))
    })
  }, [narrow, group.expanded, activeViewId, dismiss, scope, toggleRef, inputRef])
  const close = (id: string) => {
    const index = group.tabs.findIndex((tab) => tab.id === id)
    const remaining = group.tabs.filter((tab) => tab.id !== id)
    const next = group.activeId === id ? remaining[Math.min(index, remaining.length - 1)]?.id : group.activeId
    const tab = group.tabs[index]
    if (tab) void window.gale.panels.close(tab.viewId).catch(reason => notice.error(panelError(reason, t)))
    requestAnimationFrame(() => {
      const trigger = Array.from(rootRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]') ?? [])
        .find((button) => button.dataset.panelId === next)
      ;(trigger ?? toggleRef.current ?? inputRef.current)?.focus({ preventScroll: true })
    })
  }
  const collapse = () => {
    controller.dismiss(scope)
    requestAnimationFrame(() => (toggleRef.current ?? inputRef.current)?.focus({ preventScroll: true }))
  }
  useEffect(() => {
    const selected = rootRef.current?.querySelector<HTMLElement>('[role="tab"][data-state="active"]')
    const list = rootRef.current?.querySelector<HTMLElement>('[role="tablist"]')
    if (!selected || !list) return
    const reveal = () => selected.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    reveal()
    const observer = new ResizeObserver(reveal)
    observer.observe(list)
    return () => observer.disconnect()
  }, [scope, group.activeId, group.expanded, narrow])

  useEffect(() => {
    if (!group.expanded) return
    for (const tab of group.tabs) if (tab.requestId) void window.gale.panels.acknowledge(tab.requestId).catch(reason => notice.error(panelError(reason, t)))
  }, [group.expanded, group.tabs, t])
  const content = <Tabs.Root ref={rootRef} className="ui-tab-workspace" value={group.activeId}
    onValueChange={(id) => controller.select(scope, id)}>
    <div className="ui-tab-workspace-header workspace-panels-titlebar">
      <div className="ui-tab-workspace-tabs">
        {group.maximized && sidebarVisible === false && <button type="button" className="ui-tool-button ui-tool-button-square"
          aria-label={t('chat.show_sidebar')} data-tooltip={t('chat.show_sidebar')} onClick={() => void onToggleSidebar?.()}><PanelLeftOpen size={16} /></button>}
        <Tabs.List ref={listRef} className="ui-tab-list ui-tab-list-adaptive" aria-label={t('agent.workspace_panels')}
          data-dragging={!!drag.preview} onPointerDown={drag.onPointerDown} onDragStart={event => event.preventDefault()}>
          {group.tabs.map((tab) => {
            const panel = tab.panel
            const subagent = panel.kind === 'subagent'
              ? activities.find((run) => run.runId === panel.runId)?.subagents.find((item) => item.id === panel.subagentId)
              : undefined
            const label = panel.kind === 'document' ? helpDocuments[panel.documentId]
              : subagent?.name ?? tab.name
            return <ContextMenuShell key={tab.id} className="ui-menu ui-menu-list" trigger={<div className="ui-tab-item" data-active={group.activeId === tab.id}
              data-dragging={drag.preview?.viewId === tab.id} data-app-context-menu
              onMouseDownCapture={(event) => { if (event.button === 1) event.preventDefault() }}
              onAuxClick={(event) => {
                if (event.button !== 1) return
                event.preventDefault()
                close(tab.id)
              }}>
              <Tabs.Trigger className="ui-tab-trigger" value={tab.id} data-panel-id={tab.id} aria-label={label} data-tooltip={label}
                onKeyDown={event => {
                  if (event.key === 'Delete') { event.preventDefault(); close(tab.id) }
                  if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
                    event.preventDefault()
                    const rect = event.currentTarget.getBoundingClientRect()
                    event.currentTarget.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom }))
                  }

                }}>
                {panel.kind === 'subagent'
                  ? <span role="img" aria-label={subagent ? subagentStatusLabel(subagent.status) : t('agent.panel_unavailable')}>
                      <AgentSubagentStatusIcon status={subagent?.status ?? 'failed'} size={14} />
                    </span>
                  : panel.kind === 'document' ? <BookOpen size={14} /> : panel.kind === 'plugin' ? <PluginIcon icon={tab.icon} size={14} /> : <FileDiff size={14} />}
                <span className="ui-tab-title ui-truncate">{label}</span>
              </Tabs.Trigger>
              <span className="ui-tab-close-overlay">
                <button className="ui-tab-close ui-tool-button" type="button"
                  aria-label={t('agent.close_panel', { name: label })} onClick={() => close(tab.id)}><X size={12} /></button>
              </span>
            </div>}>
              {tab.locations.includes('window') && <ContextMenu.Item className="ui-menu-item ui-menu-item-row" disabled={tab.moving}
                onSelect={() => void window.gale.panels.move(tab.viewId, 'window').catch(reason => notice.error(panelError(reason, t)))}>
                <SquareArrowOutUpRight size={16} aria-hidden="true" /><span>{t('panels.move_window')}</span>
              </ContextMenu.Item>}
              <ContextMenu.Item className="ui-menu-item ui-menu-item-row" onSelect={() => close(tab.id)}><X size={16} aria-hidden="true" /><span>{t('common.close')}</span></ContextMenu.Item>
            </ContextMenuShell>
          })}
          {drag.preview && !drag.preview.outside && <span className="ui-tab-insertion-marker" aria-hidden="true"
            style={{ left: drag.preview.markerLeft }} />}
        </Tabs.List>
        {drag.preview?.outside && <span className="ui-tab-drag-hint" role="status">
          {t(drag.preview.canDetach ? 'panels.drop_to_window' : 'panels.sidebar_only')}
        </span>}
      </div>
      <div className="ui-tab-workspace-actions">
        <button type="button" className="ui-tool-button ui-tool-button-square" onClick={() => controller.toggleMaximized(scope)}
          aria-label={t(group.maximized ? 'agent.restore_panels' : 'agent.maximize_panels')}
          data-tooltip={t(group.maximized ? 'agent.restore_panels' : 'agent.maximize_panels')} aria-pressed={group.maximized}>
          {group.maximized ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
        </button>
        <button type="button" className="ui-tool-button ui-tool-button-square" onClick={collapse}
          aria-label={t('agent.hide_panels')} data-tooltip={t('agent.hide_panels')}><PanelRightClose size={18} /></button>
      </div>
    </div>
    <div className="panel-slot" aria-busy={!!activeTab?.loading}>
      {activeTab?.loading && <p className="ui-detail-panel-empty" role="status">{t('common.loading')}</p>}
      <PanelPageHost activeId={group.activeId} visible={group.expanded} /></div>
  </Tabs.Root>

  return <aside className={narrow ? "workspace-panels workspace-panels-drawer" : "workspace-panels"}
    hidden={!group.expanded || !group.tabs.length} data-maximized={group.maximized} aria-label={t('agent.workspace_panels')}>
    {!group.maximized && <ResizeHandle label={t('agent.resize_panels')} width={width} minWidth={minWidth} maxWidth={maxWidth}
      defaultWidth={WORKSPACE_PANEL_WIDTH_DEFAULT} direction={-1} onCommit={onWidthCommit}
      rootSelector=".agent-workspace-body" paneSelector=".workspace-panels" property="--workspace-panel-width"
      className="workspace-panel-resize" />}
    {content}
  </aside>
}
