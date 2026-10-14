import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { requirePanelSize, type PanelPageApi, type PanelPageContext, type PanelJson } from '@shared/panelLifecycle'

function withViewport(context: PanelPageContext, frame: HTMLIFrameElement | null): PanelPageContext {
  // The owning document is authoritative: an out-of-process iframe can briefly
  // report its old physical size with the new device scale during a screen move.
  const bounds = frame?.getBoundingClientRect()
  return { ...context, viewport: { width: bounds?.width ?? 0, height: bounds?.height ?? 0 } }
}

/** One isolated iframe and one private channel per presentation, never a preload in plugin code. */
export function PluginPage({ context, api }: { context: PanelPageContext; api: PanelPageApi }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const [port, setPort] = useState<MessagePort>()
  const current = useRef(context); current.current = context
  useEffect(() => {
    if (!port) return
    let alive = true
    const reply = (id: unknown, result: unknown, error?: string) => {
      if (alive) port.postMessage({ type: 'reply', id, result, error })
    }
    port.onmessage = event => {
      const message = event.data
      if (!message || typeof message !== 'object' || typeof message.id !== 'string') return
      const run = async () => {
        switch (message.method) {
          case 'interact': window.dispatchEvent(new CustomEvent('panel-interaction', { detail: context.panelId })); return null
          case 'context': return withViewport(await api.context(context.pageId), frame.current)
          case 'escape': return api.escape(context.pageId)
          case 'ready': return api.ready(context.pageId)
          case 'failed': return api.failed(context.pageId)
          case 'toolbar': return api.setToolbar(context.pageId, message.params)
          case 'resizeWindow': {
            const size = requirePanelSize(message.params)
            const bounds = frame.current?.getBoundingClientRect()
            if (!bounds || bounds.width <= 0 || bounds.height <= 0) throw new Error('PANEL_TARGET_UNAVAILABLE')
            // The plugin requests its own viewport; shell chrome belongs to the host.
            // A restored window needs its regular titlebar, even when it currently floats over fullscreen content.
            const titlebar = frame.current?.closest('.panel-window-shell')?.querySelector('.panel-window-titlebar')
            const viewport = document.documentElement.getBoundingClientRect()
            const chromeHeight = Math.max(viewport.height - bounds.height, titlebar?.getBoundingClientRect().height ?? 0)
            return api.resizeWindow(context.pageId, {
              ...size,
              width: size.width + (viewport.width - bounds.width),
              height: size.height + chromeHeight
            })
          }
          case 'complete': return api.complete(context.pageId, message.params.requestId, message.params.result ?? null, message.params.failed === true)
          case 'invoke':
            if (typeof message.params?.method !== 'string') throw new Error('Invalid plugin method.')
            return api.pluginInvoke(context.pageId, message.params.method, message.params.params as PanelJson)
          default: throw new Error('Unknown page request.')
        }
      }
      void run().then(result => reply(message.id, result), error => reply(message.id, null, String(error)))
    }
    port.start()
    const stopCommand = api.onCommand(command => { if (command.pageId === context.pageId) port.postMessage({ type: 'command', command }) })
    const stopCancel = api.onCancel(requestId => port.postMessage({ type: 'cancel', requestId }))
    const publishViewport = () => { if (alive) port.postMessage({ type: 'context', context: withViewport(current.current, frame.current) }) }
    const observer = new ResizeObserver(publishViewport)
    if (frame.current) observer.observe(frame.current)
    return () => { alive = false; observer.disconnect(); stopCommand(); stopCancel(); port.close() }
  }, [api, context.pageId, context.panelId, port])
  useEffect(() => { port?.postMessage({ type: 'context', context: withViewport(context, frame.current) }) }, [context, port])
  useLayoutEffect(() => {
    const url = new URL(context.pluginUrl!)
    const origin = url.protocol + '//' + url.host
    const connect = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin || event.data?.type !== 'anas:ready') return
      const channel = new MessageChannel()
      frame.current.contentWindow!.postMessage({ type: 'anas:connect' }, origin, [channel.port2])
      setPort(channel.port1)
    }
    window.addEventListener('message', connect)
    return () => window.removeEventListener('message', connect)
  }, [context.pluginUrl])
  return <iframe ref={frame} className="plugin-page" title={context.view.name} src={context.pluginUrl}
    sandbox="allow-scripts allow-same-origin allow-forms allow-downloads" />
}
