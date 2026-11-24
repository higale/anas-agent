import { observeAdaptiveText } from '../adaptiveText'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Gauge, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { normalizeUsageSettings, type UsageContent, type UsageSettings } from '@shared/usageMeter'
import type { ResolvedModelConfig } from '@shared/types'

export function usageDetails(content: UsageContent, language: string): string {
  return [content.title, ...(content.notes ?? []), ...(content.detailGroups ?? []).map(group => [group.summary, group.text].filter(Boolean).join('\n')),
    ...content.lines.map(line => [line.label + ' ' + line.value, line.description, line.detail, line.explanation,
      ...(line.breakdown ?? []).map(item => `${item.label}: ${item.value}`)].filter(Boolean).join('\n')),
    content.updatedAt === undefined ? undefined : `${language.startsWith('zh') ? '更新于' : 'Updated'}: ${new Date(content.updatedAt).toLocaleString(language)}`,
    content.notice, content.error].filter(Boolean).join('\n\n')
}

export function UsageMeterContent({ content, language, compact, busy, onRefresh, onToggle, onSettings }: {
  content: UsageContent; language: string; compact: boolean; busy?: boolean; onRefresh(): void; onToggle(): void; onSettings(): void
}) {
  const root = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => root.current ? observeAdaptiveText(root.current) : undefined, [content, compact])
  const zh = language.startsWith('zh')
  const details = usageDetails(content, language)
  const toggle = compact ? (zh ? '展开用量详情' : 'Show usage details') : (zh ? '收起用量详情' : 'Collapse usage details')
  const status = [content.notice, content.error].filter(Boolean).join('\n')
  const summary = content.lines.map(line => `${line.compactLabel === 'CNY' ? '￥' : line.compactLabel} ${line.value}`).join(' · ') || content.emptyLabel || (zh ? '暂无用量数据' : 'Usage unavailable')
  return <div ref={root} className="ui-stack ui-stack-tight">
    <header className="ui-row-between">
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- Keyboard focus must expose the same read-only details as hover. */}
      <span className="ui-row ui-row-tight ui-truncate" data-tooltip={details} tabIndex={0} aria-label={details}>
        {compact && <Gauge size={16} aria-hidden="true" />}
        {compact ? content.lines.length > 0 && content.lines.every(line => line.progress !== undefined)
          ? <span className="ui-numeric ui-adaptive-text"><span data-full-text>{summary}</span><span data-short-text>{content.lines.map(line => line.value).join(' · ')}</span></span>
          : <span className="ui-numeric ui-truncate">{summary}</span> : content.title}
      </span>
      <span className="ui-row ui-row-tight">
        {compact && status && <span role="status" data-tooltip={status} aria-label={status}>!</span>}
        <button type="button" className="ui-tool-button ui-tool-button-small" disabled={busy} onClick={onRefresh}
          data-tooltip={zh ? '立即刷新' : 'Refresh now'} aria-label={zh ? '立即刷新' : 'Refresh now'}><RefreshCw size={14} className={busy ? 'agent-spin' : undefined} /></button>
        <button type="button" className="ui-tool-button ui-tool-button-small" onClick={onToggle} data-tooltip={toggle} aria-label={toggle} aria-expanded={!compact}>
          {compact ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
      </span>
    </header>
    {!compact && <>
      {content.lines.map((line, index) => <section key={index} data-tooltip={line.detail}>
        <div className="ui-row-between ui-muted"><span>{line.label}</span><span className="ui-numeric">{line.value}</span></div>
        {line.progress !== undefined && <progress aria-label={line.label} max={1} value={line.progress} />}
        {line.description && <small className="ui-field-hint">{line.description}</small>}
      </section>)}
      {!content.lines.length && !content.error && <p className="ui-field-hint">{content.emptyLabel}</p>}
      {content.notes?.map((note, index) => <small key={index} className="ui-field-hint">{note}</small>)}
      {status && <p className="ui-field-hint" role="status">{status}</p>}
    </>}
    {content.configurationRequired && <button type="button" className="ui-button" onClick={onSettings}>{zh ? '配置' : 'Configure'}</button>}
  </div>
}

export function UsageMeter({ model, usage, active, onSettings, onDisplayMode }: {
  model?: ResolvedModelConfig; usage?: UsageSettings; active: boolean; onSettings(): void; onDisplayMode(mode: 'compact' | 'detailed'): Promise<void>
}) {
  const { i18n, t } = useTranslation()
  const settings = normalizeUsageSettings(usage, model?.baseUrl ?? '')
  const enabled = active && settings.enabled
  const identity = JSON.stringify([model?.id, model?.baseUrl, model?.apiKey, model?.model, settings.enabled, settings.tencentSecretId, settings.tencentSecretKey, settings.tencentShowBalance, settings.bailianAccessKeyId, settings.bailianAccessKeySecret, settings.bailianShowBalance])
  const latest = useRef({ t, language: i18n.language })
  latest.current = { t, language: i18n.language }
  const redraw = useRef<() => void>(() => {})
  const [state, setState] = useState<{ identity: string; content?: UsageContent | null; busy: boolean }>({ identity, busy: false })
  const refresh = useRef<() => void>(() => {})
  useEffect(() => {
    let disposed = false, pending = false
    async function read(force = false, presentationOnly = false) {
      if (!enabled || !model?.id || pending || document.visibilityState === 'hidden') return
      pending = true
      setState(old => ({ identity, content: old.identity === identity ? old.content : undefined, busy: true }))
      try {
        const language = latest.current.language
        let content = await window.gale.usage.read(model.id, force, presentationOnly)
        if (language !== latest.current.language && !disposed) content = await window.gale.usage.read(model.id, false, true)
        if (!disposed) setState({ identity, content, busy: false })
      } catch {
        if (!disposed) setState({ identity, content: { title: latest.current.t('usage.title'), lines: [], error: latest.current.t('usage.failed') }, busy: false })
      } finally { pending = false }
    }
    refresh.current = () => { void read(true) }
    redraw.current = () => { void read(false, true) }
    const shown = () => { void read() }
    shown()
    const timer = window.setInterval(shown, 60_000)
    document.addEventListener('visibilitychange', shown)
    return () => { disposed = true; clearInterval(timer); document.removeEventListener('visibilitychange', shown) }
  }, [identity, enabled, model?.id])
  useEffect(() => { redraw.current() }, [i18n.language])
  if (!enabled) return null
  const content = state.identity === identity ? state.content : undefined
  if (content === null) return null
  return <section className="usage-meter" aria-label={t('usage.title')} aria-busy={state.busy}>
    <UsageMeterContent content={content ?? { title: t('usage.title'), lines: [], emptyLabel: t('common.loading') }} language={i18n.language}
      compact={settings.displayMode === 'compact'} busy={state.busy} onRefresh={() => refresh.current()}
      onToggle={() => { void onDisplayMode(settings.displayMode === 'compact' ? 'detailed' : 'compact').catch(() => setState({ identity, busy: false, content: { title: latest.current.t('usage.title'), lines: [], error: latest.current.t('usage.failed') } })) }} onSettings={onSettings} />
  </section>
}
