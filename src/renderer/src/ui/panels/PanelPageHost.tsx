import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { panelIdentity, workspacePanelScope } from '@shared/panels'
import type { PanelPageApi, PanelPageContext, PanelJson } from '@shared/panelLifecycle'
import { createPanelReadiness, PanelViewState } from '../agent/PanelViewState'
import { BuiltinPanelContent } from './BuiltinPanelContent'
import { PluginPage } from './PluginPage'
import { notice } from '../notice'
import { panelError } from './panelError'
import { restoreViewState, snapshotViewState } from './panelViewSnapshot'

import { panelApi } from './contentServices'
function BuiltinPage({ context, api }: { context: PanelPageContext; api: PanelPageApi }) {
  const content = context.view.content
  const scope = content.kind === 'files' ? workspacePanelScope(content.threadId, content.projectId) : panelIdentity(content)
  const store = useRef<{ scope: string; state: Map<string, unknown> } | null>(null)
  if (!store.current) store.current = { scope, state: restoreViewState(context.restoreState) }
  else if (store.current.scope !== scope) store.current = { scope, state: new Map() }
  const state = store.current.state
  const [readiness] = useState(createPanelReadiness)
  const [checkpoints] = useState(() => new Set<() => void | Promise<void>>())
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let alive = true
    const pending = new Map<string, { cancelled: boolean }>()
    const stopCancel = api.onCancel(id => { const request = pending.get(id); if (request) request.cancelled = true })
    const stopCommand = api.onCommand(command => {
      if (command.pageId !== context.pageId) return
      const request = { cancelled: false }; pending.set(command.requestId, request)
      void (async () => {
        let result: PanelJson = null
        if (command.kind === 'prepare') {
          // Flush focused controls before capturing their latest values.
          if (root.current?.contains(document.activeElement)) (document.activeElement as HTMLElement).blur()
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
          await Promise.all([...checkpoints].map(save => save()))
          result = snapshotViewState(state)
        }
        if (alive && !request.cancelled) await api.complete(context.pageId, command.requestId, result, false)
      })().catch(() => { if (alive && !request.cancelled) void api.complete(context.pageId, command.requestId, null, true).catch(() => undefined) })
        .finally(() => pending.delete(command.requestId))
    })
    let acknowledged = false
    const stopReady = readiness.subscribe(failed => {
      if (!alive || acknowledged) return
      acknowledged = true
      void (failed ? api.failed(context.pageId) : api.ready(context.pageId)).catch(() => undefined)
    })
    return () => { alive = false; stopReady(); stopCommand(); stopCancel() }
  }, [api, context.pageId, state, checkpoints, readiness])
  return <div ref={root} className="panel-content-root"><PanelViewState key={scope} state={state} checkpoints={checkpoints} readiness={readiness}>
    <BuiltinPanelContent state={context} />
  </PanelViewState></div>
}

/** Mounted once per window. Tab/scope switches only change visibility, never iframe ancestry. */
export function PanelPageHost({ activeId, visible = true }: { activeId?: string; visible?: boolean }) {
  const api = panelApi().pages
  const { t } = useTranslation()
  const [pages, setPages] = useState<PanelPageContext[]>([])
  useEffect(() => {
    let active = true, revision = 0
    const refresh = () => {
      const own = ++revision
      void api.list().then(value => {
        if (active && own === revision) setPages(previous => value.map(next => {
          const old = previous.find(page => page.pageId === next.pageId)
          return old && JSON.stringify(old) === JSON.stringify(next) ? old : next
        }))
      }).catch(reason => { if (active) notice.error(panelError(reason, t)) })
    }
    const stop = api.onChanged(refresh)
    refresh()
    return () => { active = false; stop() }
  }, [api, t])
  return <div className="panel-pages">
    {pages.map(page => <section key={page.pageId} className="panel-page" data-panel-view={page.panelId}
      data-panel-page={page.pageId} data-panel-kind={page.view.content.kind}
      data-plugin-panel={page.view.content.kind === 'plugin' ? page.view.content.pluginId : undefined}
      data-plugin-instance={page.view.content.kind === 'plugin' ? page.view.content.instanceId : undefined}
      hidden={page.panelId !== activeId || !visible} inert={page.phase !== 'active'}
      style={page.phase === 'preparing' ? { visibility: 'hidden' } : undefined}>
      {page.view.content.kind === 'plugin' ? <PluginPage context={page} api={api} /> : <BuiltinPage context={page} api={api} />}
    </section>)}
  </div>
}
