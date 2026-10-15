import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { pluginDisplayText, type PluginSummary } from '@shared/plugins'
import { widgetMatchesModel, type PluginWidgetContent, type PluginWidgetDefinition } from '@shared/pluginWidgets'
import type { ResolvedModelConfig } from '@shared/types'
import { parseWidgetHtml, PluginWidgetHtml } from './PluginWidgetHtml'

function PluginWidget({ plugin, definition, model, active }: {
  plugin: PluginSummary; definition: PluginWidgetDefinition; model?: ResolvedModelConfig; active: boolean
}) {
  const { t, i18n } = useTranslation()
  const context = useMemo(() => ({ modelId: model?.id, baseUrl: model?.baseUrl, apiKey: model?.apiKey, model: model?.model, providerName: model?.providerName, language: i18n.language }), [model?.id, model?.baseUrl, model?.apiKey, model?.model, model?.providerName, i18n.language])
  // Undefined means no reply yet; null is an explicit request to hide the widget.
  const [state, setState] = useState<{ context: object; content: (PluginWidgetContent & { fragment: DocumentFragment }) | null | undefined; busy: boolean; error?: string }>({ context, content: undefined, busy: true })
  const request = useRef<(action?: string) => void>(() => {})
  useEffect(() => {
    let disposed = false, pending = false
    const load = async (action?: string) => {
      if (disposed || pending || !active || document.visibilityState === 'hidden') return
      pending = true
      setState(old => ({ context, content: old.context === context ? old.content : undefined, busy: true }))
      try {
        const snapshot = await window.gale.plugins.readWidget(plugin.id, definition.id, model?.id, action)
        if (disposed) return
        let content: (PluginWidgetContent & { fragment: DocumentFragment }) | null
        try { content = snapshot ? { ...snapshot, fragment: parseWidgetHtml(snapshot.html, plugin.id, definition.actions) } : null }
        catch {
          setState(old => ({ context, content: old.context === context ? old.content : undefined, busy: false, error: t('plugins.widget_invalid_html') }))
          return
        }
        setState(old => ({ context, content: old.context === context && old.content && content && old.content.html === content.html && old.content.title === content.title ? old.content : content, busy: false }))
      } catch {
        // Backend/network diagnostics must not accidentally expose connection credentials.
        if (!disposed) setState(old => ({ context, content: old.context === context ? old.content : undefined, busy: false, error: t('plugins.widget_failed') }))
      } finally { pending = false }
    }
    request.current = action => { void load(action) }
    void load()
    const timer = window.setInterval(() => { void load() }, 60_000)
    const visible = () => { void load() }
    document.addEventListener('visibilitychange', visible)
    window.addEventListener('focus', visible)
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visible); window.removeEventListener('focus', visible) }
  }, [plugin.id, plugin.backendStatus, definition.id, definition.actions, model?.id, context, active, t])
  if (!active) return null
  const current = state.context === context
  const content = current ? state.content : undefined
  const busy = !current || state.busy
  const error = current ? state.error : undefined
  if (content === null && !error) return null
  return <section className="plugin-widget" aria-label={content?.title ?? pluginDisplayText(plugin, i18n.language)} aria-busy={busy}>
    {!content && busy && <div className="ui-row ui-muted" role="status">
      <LoaderCircle className="agent-spin" size={14} aria-hidden="true" />
      <span className="ui-truncate">{pluginDisplayText(plugin, i18n.language)} · {t('common.loading')}…</span>
    </div>}
    {content && <PluginWidgetHtml fragment={content.fragment} busy={busy} onAction={action => request.current(action)}
      onLink={url => { void window.gale.app.openExternalUrl(url).catch(() => setState(old => ({ ...old, error: t('plugins.widget_failed') }))) }} />}
    {error && <small className="plugin-widget-error" role="status">{error}</small>}
    {!content && error && <button type="button" className="ui-button" disabled={busy}
      onClick={() => request.current()}>{t('common.refresh')}</button>}
  </section>
}

export function PluginWidgets({ plugins, model, active }: { plugins: PluginSummary[]; model?: ResolvedModelConfig; active: boolean }) {
  return <>{plugins.filter(plugin => plugin.enabled && !plugin.error).flatMap(plugin =>
    (plugin.manifest?.widgets ?? []).filter(widget => widget.location === 'sidebar.footer' && widgetMatchesModel(widget, model?.baseUrl))
      .map(definition => <PluginWidget key={`${plugin.id}:${definition.id}`} plugin={plugin} definition={definition} model={model} active={active} />))}</>
}
