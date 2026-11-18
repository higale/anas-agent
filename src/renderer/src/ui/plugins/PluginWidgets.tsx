import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { pluginDisplayText, type PluginSummary } from '@shared/plugins'
import { widgetMatchesModel, type PluginWidgetContent, type PluginWidgetDefinition } from '@shared/pluginWidgets'
import type { ResolvedModelConfig } from '@shared/types'
import { missingModelApiKeyEnvironmentVariable } from '@shared/modelConfig'
import { parseWidgetHtml, PluginWidgetHtml } from './PluginWidgetHtml'

function PluginWidget({ plugin, definition, model, active }: {
  plugin: PluginSummary; definition: PluginWidgetDefinition; model?: ResolvedModelConfig; active: boolean
}) {
  const { t, i18n } = useTranslation()
  const language = i18n.language
  const renderAction = definition.presentation?.render
  const legacyActive = renderAction ? undefined : active
  const legacyLanguage = renderAction ? undefined : language
  const legacyProviderName = renderAction ? undefined : model?.providerName
  // Registry/settings updates can recreate equivalent manifest arrays.
  const actionList = definition.actions.join(',')
  const displayList = definition.presentation?.actions.join(',') ?? ''
  const displayActions = useMemo(() => displayList ? displayList.split(',') : [], [displayList])
  const context = useMemo(() => ({ modelId: model?.id, providerId: model?.providerId, baseUrl: model?.baseUrl, apiKey: model?.apiKey,
    model: model?.model, legacyProviderName, legacyLanguage }), [model?.id, model?.providerId, model?.baseUrl, model?.apiKey, model?.model, legacyProviderName, legacyLanguage])
  type Content = (PluginWidgetContent & { fragment: DocumentFragment }) | null
  const [state, setState] = useState<{ context: object; content?: Content; busy: boolean; error?: string }>({ context, busy: true })
  const latest = useRef({ active, language, t })
  useLayoutEffect(() => { latest.current = { active, language, t } })
  const request = useRef<(action?: string) => void>(() => {})
  const onShow = useRef<() => void>(() => {})
  useEffect(() => {
    let disposed = false, pending = false, started = false, hasReply = false
    let requestedLanguage = latest.current.language, displayRevision = 0, settledDisplay = 0
    let displayWork: Promise<void> = Promise.resolve()
    const actions = actionList ? actionList.split(',') : []
    const visible = () => latest.current.active && document.visibilityState !== 'hidden'
    const report = (message: string) => {
      if (!disposed) setState(old => ({ context, content: old.context === context ? old.content : undefined, busy: pending, error: message }))
    }
    const failed = (reason: unknown) => {
      const name = missingModelApiKeyEnvironmentVariable(reason)
      report(name ? latest.current.t('settings.api_key_variable_missing', { name }) : latest.current.t('plugins.widget_failed'))
    }
    const show = (snapshot: PluginWidgetContent | null) => {
      if (disposed) return
      try {
        const content = snapshot ? { ...snapshot, fragment: parseWidgetHtml(snapshot.html, plugin.id, actions) } : null
        hasReply = true
        const busy = pending
        setState(old => ({ context, content: old.context === context && old.content && content && old.content.html === content.html && old.content.title === content.title ? old.content : content, busy }))
      } catch { report(latest.current.t('plugins.widget_invalid_html')) }
    }
    const read = (action?: string) => window.gale.plugins.readWidget(plugin.id, definition.id, model?.id, action)
    const redraw = (action: string) => {
      const revision = ++displayRevision
      // Keep preference writes in click order, independently of a slow provider call.
      displayWork = displayWork.then(async () => {
        if (disposed) return
        const snapshot = await read(action)
        if (revision === displayRevision) show(snapshot)
      }).catch(failed).finally(() => { settledDisplay = revision })
    }
    const load = async (action?: string) => {
      if (disposed || !visible() || pending) return
      pending = true
      started = true
      const revision = displayRevision, locale = latest.current.language
      setState(old => ({ context, content: old.context === context ? old.content : undefined, busy: true }))
      try {
        const snapshot = await read(action)
        if (disposed) return
        pending = false
        if (renderAction && (revision !== displayRevision || settledDisplay !== displayRevision || locale !== latest.current.language)) redraw(renderAction)
        else show(snapshot)
      } catch (reason) { pending = false; failed(reason) }
    }
    request.current = action => {
      if (action && displayActions.includes(action)) redraw(action)
      else void load(action)
    }
    const shown = () => {
      if (!visible()) return
      if (!started) void load()
      else if (renderAction && requestedLanguage !== latest.current.language && (hasReply || !pending)) redraw(renderAction)
      requestedLanguage = latest.current.language
    }
    onShow.current = shown
    shown()
    const timer = window.setInterval(() => { void load() }, 60_000)
    const visibleAgain = renderAction ? shown : () => { void load() }
    document.addEventListener('visibilitychange', visibleAgain)
    window.addEventListener('focus', visibleAgain)
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', visibleAgain); window.removeEventListener('focus', visibleAgain) }
  }, [plugin.id, plugin.backendStatus, definition.id, actionList, displayActions, renderAction, model?.id, context, legacyActive])
  useEffect(() => { onShow.current() }, [active, language])
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
    {content && <PluginWidgetHtml displayActions={displayActions} fragment={content.fragment} busy={busy} onAction={action => request.current(action)}
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
