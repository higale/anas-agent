import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PanelPageApi, PanelPageContext, PanelJson } from '@shared/panelLifecycle'

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
          case 'context': return api.context(context.pageId)
          case 'escape': return api.escape(context.pageId)
          case 'ready': return api.ready(context.pageId)
          case 'failed': return api.failed(context.pageId)
          case 'toolbar': return api.setToolbar(context.pageId, message.params)
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
    port.postMessage({ type: 'context', context: current.current })
    return () => { alive = false; stopCommand(); stopCancel(); port.close() }
  }, [api, context.pageId, port])
  useEffect(() => { port?.postMessage({ type: 'context', context }) }, [context, port])
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
