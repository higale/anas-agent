import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import i18next from 'i18next'
import { requirePanelSize, type PanelPageApi, type PanelPageContext, type PanelJson, type PanelSize } from '@shared/panelLifecycle'
import { notice } from '../notice'
import { panelError } from './panelError'

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
  const refreshConstraints = useRef<() => void>(() => {})
  useEffect(() => {
    if (!port) return
    let alive = true
    let maximum: PanelSize['maximumSize'], layoutKey = '', sizing = 0, revision = 0
    const measure = () => {
      const bounds = frame.current?.getBoundingClientRect()
      if (!bounds || bounds.width <= 0 || bounds.height <= 0) return
      const titlebar = frame.current?.closest('.panel-window-shell')?.querySelector('.panel-window-titlebar')
      const viewport = document.documentElement.getBoundingClientRect()
      const width = viewport.width - bounds.width
      const height = Math.max(viewport.height - bounds.height, titlebar?.getBoundingClientRect().height ?? 0)
      return { bounds, width, height, key: JSON.stringify([window.devicePixelRatio, width, height]) }
    }
    const resize = async (size: PanelSize) => {
      const layout = measure(), request = size.maximumSize !== undefined ? ++revision : revision
      if (!layout) throw new Error('PANEL_TARGET_UNAVAILABLE')
      sizing++
      try {
        await api.resizeWindow(context.pageId, {
          ...size,
          ...(size.maximumSize ? { maximumSize: { width: size.maximumSize.width + layout.width, height: size.maximumSize.height + layout.height } } : {}),
          width: size.width + layout.width, height: size.height + layout.height
        })
        if (request === revision) {
          if (size.maximumSize !== undefined) maximum = size.maximumSize
          layoutKey = layout.key
        }
      } finally { sizing-- }
    }
    const refreshMaximum = () => {
      const page = current.current
      if (!alive || sizing || !maximum || page.location !== 'window' || page.phase !== 'active' || page.view.pendingLocation) return
      const layout = measure()
      if (!layout || layout.key === layoutKey) return
      layoutKey = layout.key
      // Preserve the current viewport when zoom/chrome changes; only shrink it
      // if the new ceiling requires it. A user border resize must never refit.
      void resize({ width: Math.min(layout.bounds.width, maximum.width), height: Math.min(layout.bounds.height, maximum.height), maximumSize: maximum })
        .then(refreshMaximum).catch(reason => {
          if (alive && current.current.phase === 'active' && !current.current.view.pendingLocation) notice.error(panelError(reason, i18next.t))
        })
    }
    refreshConstraints.current = refreshMaximum
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
            await resize(size)
            refreshMaximum()
            return
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
    const stopPointerLeave = api.onPointerLeave(pageId => {
      if (pageId === context.pageId) port.postMessage({ type: 'pointer-leave' })
    })
    const publishViewport = () => {
      if (alive) port.postMessage({ type: 'context', context: withViewport(current.current, frame.current) })
      refreshMaximum()
    }
    const observer = new ResizeObserver(publishViewport)
    if (frame.current) observer.observe(frame.current)
    return () => { alive = false; refreshConstraints.current = () => {}; observer.disconnect(); stopCommand(); stopCancel(); stopPointerLeave(); port.close() }
  }, [api, context.pageId, context.panelId, port])
  useEffect(() => {
    port?.postMessage({ type: 'context', context: withViewport(context, frame.current) })
    refreshConstraints.current()
  }, [context, port])
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
