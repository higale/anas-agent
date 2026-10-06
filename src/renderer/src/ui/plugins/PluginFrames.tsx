import { useEffect, useRef, useState } from 'react'
import { pluginPageUrl, PLUGIN_SCHEME, type PluginManifest, type PluginSummary } from '@shared/plugins'
import type { WorkspacePanelTab } from '../agent/useWorkspacePanels'

interface FrameBounds { left: number; top: number; width: number; height: number; zIndex: number }

function PluginFrame({ manifest }: { manifest: PluginManifest }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [bounds, setBounds] = useState<FrameBounds>()
  const url = pluginPageUrl(manifest)
  useEffect(() => {
    const origin = `${PLUGIN_SCHEME}://${manifest.id}`
    let disposed = false
    let pending = 0
    const receive = (event: MessageEvent) => {
      const message = event.data
      if (event.source !== frame.current?.contentWindow || event.origin !== origin
        || message?.channel !== 'anas-plugin-request' || !Number.isSafeInteger(message.id)) return
      const reply = (payload: object) => {
        if (!disposed) frame.current?.contentWindow?.postMessage({ channel: 'anas-plugin-response', id: message.id, ...payload }, origin)
      }
      if (pending >= 32) { reply({ error: 'Too many pending plugin requests.' }); return }
      pending++
      void window.gale.plugins.invoke(manifest.id, message.method, message.params).then(
        result => reply({ result }), error => reply({ error: String(error instanceof Error ? error.message : error) })
      ).finally(() => { pending-- })
    }
    window.addEventListener('message', receive)
    return () => { disposed = true; window.removeEventListener('message', receive) }
  }, [manifest.id])

  useEffect(() => {
    let request = 0
    let previous: string | undefined
    let observed: Element | undefined
    const measure = () => {
      request = 0
      const slot = document.querySelector<HTMLElement>(`[data-plugin-panel="${manifest.id}"]`)
      if (observed !== slot) {
        if (observed) resize.unobserve(observed)
        observed = slot ?? undefined
        if (observed) resize.observe(observed)
      }
      const rect = slot?.getBoundingClientRect()
      const modalOpen = document.querySelector('.ui-backdrop[data-state="open"]') !== null
      const next = !modalOpen && rect && rect.width > 0 && rect.height > 0 ? {
        left: rect.left, top: rect.top, width: rect.width, height: rect.height,
        zIndex: slot?.closest('.workspace-panels-drawer') ? 41 : 5
      } : undefined
      const serialized = JSON.stringify(next)
      if (previous !== serialized) { previous = serialized; setBounds(next) }
    }
    const schedule = () => { if (!request) request = requestAnimationFrame(measure) }
    const resize = new ResizeObserver(schedule)
    const mutations = new MutationObserver(schedule)
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden', 'data-state'] })
    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    schedule()
    return () => { cancelAnimationFrame(request); resize.disconnect(); mutations.disconnect(); window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true) }
  }, [manifest.id])

  return <iframe ref={frame} src={url} title={manifest.name} className="plugin-frame"
    sandbox="allow-scripts allow-same-origin allow-forms" style={bounds ? { ...bounds, display: 'block' } : { display: 'none' }} />
}

// Keep the browsing context outside the changing workspace tab tree.
export function PluginFrames({ tabs, plugins }: { tabs: WorkspacePanelTab[]; plugins: PluginSummary[] }) {
  const opened = new Set(tabs.flatMap(tab => tab.panel.kind === 'plugin' ? [tab.panel.pluginId] : []))
  return <>{plugins.filter(item => opened.has(item.id) && item.enabled && !item.error && item.manifest?.ui)
    .map(item => <PluginFrame key={item.id} manifest={item.manifest!} />)}</>
}
