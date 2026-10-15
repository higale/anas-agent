import { useLayoutEffect, useRef } from 'react'
import { pluginIconSources, requirePluginIconPath } from '@shared/plugins'
import baseStyles from '../../styles/base.css?inline'
import sharedStyles from '../../styles/ui-primitives.css?inline'
import widgetStyles from '../../styles/plugin-widget-content.css?inline'
import { connectShadowTooltips } from '../GlobalTooltip'

/** Static fragments use host CSS and declared actions; full scripted pages use plugin UI entries. */
export function parseWidgetHtml(html: string, pluginId: string, actions: string[]): DocumentFragment {
  const template = document.createElement('template')
  template.innerHTML = html
  const elements = template.content.querySelectorAll('*')
  if (elements.length > 1000) throw new Error('Widget HTML exceeds the element budget.')
  for (const element of elements) {
    if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml' || element.localName.includes('-')
      || /^(script|style|link|base|meta|iframe|object|embed|template|form|font|center|marquee)$/.test(element.localName)) {
      throw new Error('Widget HTML must be a static fragment using host styles.')
    }
    for (const { name } of element.attributes) {
      if (name === 'style' || name.startsWith('on') || ['is', 'srcdoc', 'srcset', 'form', 'formaction', 'popover', 'color', 'bgcolor', 'face'].includes(name)) {
        throw new Error('Widget HTML cannot declare scripts, styles or form navigation.')
      }
    }
    if (element.hasAttribute('title')) {
      if (!element.hasAttribute('data-tooltip')) element.setAttribute('data-tooltip', element.getAttribute('title')!)
      element.removeAttribute('title')
    }
    if (element.hasAttribute('data-action')) {
      if (element.localName !== 'button' || !actions.includes(element.getAttribute('data-action')!)) throw new Error('Widget action must be a declared button action.')
    }
    if (element instanceof HTMLButtonElement) {
      element.type = 'button'
      if (!['ui-button', 'ui-icon-button', 'ui-tool-button', 'ui-link-button'].some(name => element.classList.contains(name))) element.classList.add('ui-button')
    }
    if (element instanceof HTMLImageElement && element.hasAttribute('src')) {
      // Reuse the package image route; paths belong to this plugin, not the app document.
      element.src = pluginIconSources(pluginId, requirePluginIconPath(element.getAttribute('src')))!.light
      element.draggable = false
    } else if (element.hasAttribute('src')) {
      throw new Error('Widget resources must be package images.')
    }
    if (element.hasAttribute('href')) {
      const url = new URL(element.getAttribute('href')!)
      if (element.localName !== 'a' || !['https:', 'http:', 'mailto:'].includes(url.protocol)) throw new Error('Invalid widget link.')
    }
  }
  return template.content
}

export function PluginWidgetHtml({ fragment, busy, onAction, onLink }: {
  fragment: DocumentFragment; busy: boolean; onAction(action: string): void; onLink(url: string): void
}) {
  const host = useRef<HTMLDivElement>(null)
  const controls = useRef(new Map<HTMLButtonElement, boolean>())
  const callbacks = useRef({ busy, onAction, onLink })
  useLayoutEffect(() => { callbacks.current = { busy, onAction, onLink } })
  useLayoutEffect(() => {
    const element = host.current!
    const root = element.shadowRoot ?? element.attachShadow({ mode: 'open' })
    const disconnectTooltips = connectShadowTooltips(root)
    const focusedAction = root.activeElement?.getAttribute('data-action')
    const style = document.createElement('style')
    style.textContent = baseStyles + sharedStyles + widgetStyles
    root.replaceChildren(style, fragment.cloneNode(true))
    const adaptiveText = [...root.querySelectorAll<HTMLElement>('.ui-adaptive-text')].flatMap(container => {
      const full = container.querySelector<HTMLElement>(':scope > [data-full-text]')
      const short = container.querySelector<HTMLElement>(':scope > [data-short-text]')
      return full && short ? [{ container, full, short }] : []
    })
    const fitText = () => {
      for (const { container, full, short } of adaptiveText) {
        const condensed = full.scrollWidth > container.clientWidth
        container.toggleAttribute('data-condensed', condensed)
        full.setAttribute('aria-hidden', String(condensed))
        short.setAttribute('aria-hidden', String(!condensed))
      }
    }
    // Both variants retain their layout boxes, so choosing one cannot cause resize oscillation.
    const observer = adaptiveText.length ? new ResizeObserver(fitText) : undefined
    for (const { container, full } of adaptiveText) { observer!.observe(container); observer!.observe(full) }
    document.fonts?.addEventListener('loadingdone', fitText)
    fitText()
    controls.current = new Map([...root.querySelectorAll<HTMLButtonElement>('button[data-action]')].map(button => [button, button.disabled]))
    for (const [button, disabled] of controls.current) {
      button.disabled = disabled || callbacks.current.busy
      if (button.dataset.action === focusedAction && !button.disabled) button.focus()
    }
    const click = (event: Event) => {
      if (event instanceof MouseEvent && event.button > 1) return
      const target = event.target instanceof Element ? event.target : null
      const button = target?.closest<HTMLButtonElement>('button[data-action]')
      const link = target?.closest<HTMLAnchorElement>('a[href]')
      if (button) {
        event.preventDefault()
        if (!callbacks.current.busy && !button.disabled) callbacks.current.onAction(button.dataset.action!)
      } else if (link) {
        event.preventDefault()
        callbacks.current.onLink(link.href)
      }
    }
    root.addEventListener('click', click)
    root.addEventListener('auxclick', click)
    return () => {
      observer?.disconnect()
      document.fonts?.removeEventListener('loadingdone', fitText)
      disconnectTooltips()
      root.removeEventListener('click', click)
      root.removeEventListener('auxclick', click)
    }
  }, [fragment])
  useLayoutEffect(() => {
    for (const [button, disabled] of controls.current) button.disabled = busy || disabled
  }, [busy])
  return <div ref={host} className="plugin-widget-html" aria-busy={busy} />
}
