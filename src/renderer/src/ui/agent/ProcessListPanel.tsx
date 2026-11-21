import { useEffect, useRef, useState } from 'react'
import { RefreshCw, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ProcessCallGroup, ObservedProcess } from '@shared/processes'
import { contentServices } from '../panels/contentServices'
import { panelError } from '../panels/panelError'
import { usePanelReady, usePanelScroll } from './PanelViewState'

export function ProcessListPanel({ threadId, visible = true }: { threadId: string; visible?: boolean }) {
  const { t } = useTranslation()
  const [calls, setCalls] = useState<ProcessCallGroup[]>([])
  const [loaded, setLoaded] = useState(false), [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0), [pages, setPages] = useState(1)
  const [more, setMore] = useState(false), [busy, setBusy] = useState(false), [stopping, setStopping] = useState('')
  const root = useRef<HTMLDivElement>(null)
  const scroll = usePanelScroll(root, loaded)
  usePanelReady(loaded, Boolean(error))
  useEffect(() => {
    if (!visible && loaded) return
    let active = true, timer: ReturnType<typeof setTimeout> | undefined
    const read = async () => {
      setBusy(true)
      try {
        const result: ProcessCallGroup[] = []
        let cursor: string | undefined
        for (let page = 0; page < pages; page++) {
          const value = await contentServices().agent.processes.list({ threadId, ...(cursor ? { cursor } : {}) })
          if (!active) return
          result.push(...value.calls); cursor = value.nextCursor
          if (!cursor) break
        }
        if (active) {
          setCalls(result.sort((a, b) => b.createdAt.localeCompare(a.createdAt)))
          setMore(Boolean(cursor)); setLoaded(true); setError('')
        }
      } catch (reason) { if (active) setError(panelError(reason, t)) }
      finally {
        if (active) { setBusy(false); if (visible) timer = setTimeout(() => { void read() }, 2000) }
      }
    }
    void read()
    return () => { active = false; if (timer) clearTimeout(timer) }
  }, [threadId, visible, refresh, pages, loaded, t])

  async function terminate(call: ProcessCallGroup, process: ObservedProcess) {
    setStopping(`${call.callId}:${process.pid}:${process.birth}`)
    try {
      await contentServices().agent.processes.terminate({ threadId, callId: call.callId, process })
      setRefresh(value => value + 1)
    } catch (reason) { setError(panelError(reason, t)) }
    finally { setStopping('') }
  }
  const shown = calls.map(call => ({ ...call, processes: call.snapshot.processes.filter(process => process.status !== 'exited') }))
    .filter(call => call.processes.length > 0)
  return <div ref={root} className="process-list-panel" onScroll={scroll} aria-label={t('agent.process_list')}>
    <div className="ui-row">
      <span className="ui-field-hint">{t('process_list.hint')}</span>
      <button type="button" className="ui-tool-button ui-tool-button-square ui-push-end" disabled={busy}
        aria-label={t('process_list.refresh')} data-tooltip={t('process_list.refresh')} onClick={() => setRefresh(value => value + 1)}><RefreshCw size={16} /></button>
    </div>
    {error && <p role="alert" className="ui-status-danger">{loaded && `${t('process_list.stale')} `}{error}</p>}
    {!loaded && !error && <p role="status">{t('common.loading')}</p>}
    {loaded && shown.length === 0 && <p role="status">{t('process_list.empty')}</p>}
    {shown.map(call => <section key={call.callId} className="process-list-call">
      <strong>{call.summary}</strong>
      <p className="ui-field-hint">{t(`process_list.call_${call.status}`, { defaultValue: call.status })}</p>
      <details><summary>{t('process_list.command')}</summary><pre>{call.command}</pre></details>
      {call.snapshot.error && <p role="status">{call.snapshot.error}</p>}
      <ul className="process-list-items">
        {call.processes.map(process => <li key={`${process.pid}:${process.birth}`}>
          <div className="ui-row">
            <span className="ui-truncate" title={process.name}>{process.name}</span>
            <span className="ui-field-hint">PID {process.pid}</span>
            <button type="button" className="ui-tool-button ui-tool-button-square ui-push-end"
              disabled={Boolean(stopping) || Boolean(error) || process.status !== 'running'}
              aria-label={`${t('process_list.terminate')} ${process.name} (${process.pid})`} data-tooltip={t('process_list.stop_hint')}
              onClick={() => void terminate(call, process)}><Square size={14} /></button>
          </div>
          <div className="ui-field-hint">{t(`process_list.${process.role}`)} · {t(`process_list.${process.status}`)}
            {process.startedAt && ` · ${t('process_list.duration', { seconds: Math.max(0, Math.floor((Date.now() - Date.parse(process.startedAt)) / 1000)) })}`}
            {stopping === `${call.callId}:${process.pid}:${process.birth}` && ` · ${t('process_list.terminating')}`}
          </div>
        </li>)}
      </ul>
    </section>)}
    {more && <button type="button" className="ui-button" disabled={busy} onClick={() => setPages(value => value + 1)}>{t('process_list.more')}</button>}
  </div>
}
