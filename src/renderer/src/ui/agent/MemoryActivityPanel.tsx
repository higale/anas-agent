import { useEffect, useRef, useState } from 'react'
import { CircleAlert, LoaderCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { MemoryActivitySnapshot, MemoryJob } from '@shared/preferenceMemory'
import type { PanelPreferencesSnapshot } from '@shared/panels'
import { contentServices, panelApi } from '../panels/contentServices'
import { usePanelDisclosure, usePanelReady, usePanelScroll } from './PanelViewState'
import { MarkdownText } from '../chat/MarkdownText'
import { formatDateTime } from '../formatDateTime'
import { notice } from '../notice'
import { MemoryIcon } from '../MemoryIcon'
import { CheckboxField } from '../CheckboxField'
import { errorDetail } from '@shared/recovery'

function useMemoryActivity() {
  const [snapshot, setSnapshot] = useState<MemoryActivitySnapshot>()
  const [error, setError] = useState('')
  useEffect(() => {
    const api = contentServices().preferences
    if (!api) { setError('Memory activity is unavailable.'); return }
    let active = true, revision = 0
    const refresh = () => {
      const request = ++revision
      void api.activity().then(value => { if (active && revision === request) { setSnapshot(value); setError('') } },
        reason => { if (active && revision === request) setError(String(reason)) })
    }
    const unsubscribe = api.onChanged(refresh)
    refresh()
    return () => { active = false; unsubscribe() }
  }, [])
  return { snapshot, error }
}

export function MemoryActivityButton({ onOpen }: { onOpen(): void }) {
  const { t } = useTranslation(), { snapshot, error } = useMemoryActivity()
  const running = snapshot?.status === 'running', failed = Boolean(error) || snapshot?.status === 'failed' || snapshot?.status === 'unavailable'
  const Icon = running ? LoaderCircle : failed ? CircleAlert : MemoryIcon
  const label = `${t('agent.memory_activity')} · ${error || t(`memory_activity.${snapshot?.status ?? 'idle'}`)}`
  return <button type="button" className="ui-tool-button ui-tool-button-square" aria-label={label} data-tooltip={label}
    onClick={onOpen}>
    <Icon size={18} className={running ? 'memory-activity-spinning' : undefined} />
    {snapshot?.status === 'pending' && <span aria-hidden="true">·</span>}
  </button>
}

function MemoryJobDetails({ job }: { job: MemoryJob }) {
  const { t } = useTranslation()
  const callsDisclosure = usePanelDisclosure('memory-calls', false)
  const reported = job.calls.filter(call => call.inputTokens !== undefined && call.outputTokens !== undefined)
  const input = reported.reduce((sum, call) => sum + call.inputTokens!, 0)
  const output = reported.reduce((sum, call) => sum + call.outputTokens!, 0)
  return <div className="ui-editor">
    <h3>{job.title}</h3>
    <p role="status">{t(`memory_activity.${job.stage}`)} · {job.modelName || job.modelId || t('chat.clear_model_selection')}</p>
    <p className="ui-field-hint">{job.projectId} · {formatDateTime(job.createdAt)} · {t(`memory_activity.trigger_${job.trigger}`, { defaultValue: job.trigger })}</p>
    <p className="ui-field-hint">{t('memory_activity.source')}: {job.threadId}</p>
    {job.calls.length > 0 && <p>{reported.length ? t('memory_activity.usage_summary', {
      input, output, total: input + output, reported: reported.length, calls: job.calls.length
    }) : t('memory_activity.usage_unreported')}</p>}
    {job.error && <p role="alert" className="ui-status-danger">{job.error}</p>}
    {job.retryAt && job.stage === 'failed' && <p>{t('memory_activity.retry_at')}: {formatDateTime(new Date(job.retryAt).toISOString())}</p>}
    {job.candidates?.length === 0 && <p>{t('memory_activity.no_candidates')}</p>}
    {job.candidates?.map((candidate, index) => <div key={index} className="ui-note">
      <strong>{t(`memory_activity.${candidate.scope}`)} · {t(`memory_activity.${candidate.intent}`)}</strong>
      <p>{candidate.content}</p><blockquote>{candidate.evidence}</blockquote>
    </div>)}
    {job.changes.map(change => <section key={change.scope.kind}>
      <h4>{t(`memory_activity.${change.scope.kind}`)}</h4>
      {change.after.trim() ? <MarkdownText text={change.after} /> : <p>{t('settings.memory_document_empty')}</p>}
    </section>)}
    <details {...callsDisclosure}><summary>{t('memory_activity.calls')}</summary>
      {job.calls.map((call, index) => <section key={index}>
        <h4>{t(`memory_activity.${call.phase === 'extract' ? 'extracting' : 'consolidating'}`)}</h4>
        <p>{call.durationMs === undefined ? '…' : `${(call.durationMs / 1000).toFixed(1)} s`}
          {' · '}{call.inputTokens !== undefined && call.outputTokens !== undefined
            ? t('memory_activity.call_usage', { input: call.inputTokens, output: call.outputTokens })
            : t('memory_activity.usage_unreported')}</p>
        <details><summary>{t('memory_activity.input')}</summary><pre className="memory-activity-text">{call.input}</pre></details>
        <details><summary>{t('memory_activity.output')}</summary><pre className="memory-activity-text">{call.output ?? '…'}</pre></details>
      </section>)}
    </details>
  </div>
}

export function MemoryActivityPanel({ preferences }: { preferences: PanelPreferencesSnapshot }) {
  const { t } = useTranslation(), { snapshot, error } = useMemoryActivity()
  const [pendingVisibility, setPendingVisibility] = useState<boolean>()
  const [saved, setSaved] = useState<PanelPreferencesSnapshot>()
  const confirmed = saved && saved.revision > preferences.revision ? saved : preferences
  async function setTitlebarButton(visible: boolean) {
    setPendingVisibility(visible)
    try { setSaved(await panelApi().updatePreferences({ showMemoryActivityInTitlebar: visible })) }
    catch (reason) {
      notice.error(t('chat.failed_save_settings'), { description: errorDetail(reason) })
    } finally { setPendingVisibility(undefined) }
  }
  const root = useRef<HTMLDivElement>(null)
  const scroll = usePanelScroll(root, Boolean(snapshot))
  usePanelReady(Boolean(snapshot), Boolean(error))
  const job = snapshot?.job
  return <div ref={root} className="memory-activity-panel" onScroll={scroll}>
    <div className="ui-row">
      <p role="status">{error || t(`memory_activity.${snapshot?.status ?? 'idle'}`)}</p>
      <CheckboxField className="ui-checkbox-field-inline ui-push-end" checked={pendingVisibility ?? confirmed.showMemoryActivityInTitlebar} disabled={pendingVisibility !== undefined}
        label={t('memory_activity.titlebar_button')} onChange={visible => void setTitlebarButton(visible)} />
    </div>
    {snapshot?.error && <p role="alert">{snapshot.error}</p>}
    <p className="ui-field-hint">{t('memory_activity.delayed')}</p>
    {job ? <MemoryJobDetails key={job.id} job={job} /> : <p>{t('memory_activity.empty')}</p>}
  </div>
}
