import { useState } from 'react'
import { ExternalLink, PackagePlus, Play, RefreshCw, Square, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PluginSummary } from '@shared/plugins'
import { errorDetail } from '@shared/recovery'
import { Checkbox } from '../Checkbox'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { notice } from '../notice'

export function PluginsSettings({ plugins, error, onRefresh, onOpen }: {
  plugins: PluginSummary[]; error?: string; onRefresh(): Promise<void>; onOpen(plugin: PluginSummary): void
}) {
  const { t } = useTranslation()
  const [selectedId, setSelectedId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<PluginSummary>()
  const selected = plugins.find(item => item.id === selectedId) ?? plugins[0]
  async function act(operation: () => Promise<unknown>) {
    setBusy(true)
    try { await operation(); await onRefresh() } catch (reason) { notice.error(t('plugins.operation_failed'), { description: errorDetail(reason) }) }
    finally { setBusy(false) }
  }
  return <>
    <aside className="ui-list-pane">
      <div className="ui-list-pane-header ui-toolbar">
        <button type="button" className="ui-tool-button ui-tool-button-square" aria-label={t('plugins.install')} data-tooltip={t('plugins.install')} disabled={busy}
          onClick={() => void act(async () => { const item = await window.gale.plugins.install(); if (item) setSelectedId(item.id) })}><PackagePlus size={18} /></button>
        <button type="button" className="ui-tool-button ui-tool-button-square" aria-label={t('common.refresh')} data-tooltip={t('common.refresh')} disabled={busy}
          onClick={() => void onRefresh()}><RefreshCw size={18} /></button>
      </div>
      <div className="ui-scroll-list" aria-label={t('plugins.title')}>
        {plugins.map(item => <button type="button" key={item.id} className={`ui-list-item${selected?.id === item.id ? ' active' : ''}`} aria-pressed={selected?.id === item.id}
          onClick={() => setSelectedId(item.id)}>{item.manifest?.name ?? item.id}</button>)}
      </div>
    </aside>
    <div className="ui-editor">
      {error && <div role="alert"><p>{t('plugins.load_failed')}</p><small>{error}</small></div>}
      {selected ? <div className="ui-form-section">
        <div className="ui-toolbar ui-toolbar-between">
          <strong>{selected.manifest?.name ?? selected.id}</strong>
          <div className="ui-row">
            <label className="ui-row"><Checkbox checked={selected.enabled} disabled={busy || Boolean(selected.error)} onChange={enabled => void act(() => window.gale.plugins.setEnabled(selected.id, enabled))} />{t('settings.enabled')}</label>
            <button type="button" className="ui-tool-button ui-tool-button-square" aria-label={t('plugins.uninstall')} data-tooltip={t('plugins.uninstall')} disabled={busy} onClick={() => setRemoving(selected)}><Trash2 size={16} /></button>
          </div>
        </div>
        <small className="ui-field-hint">{selected.id} · {selected.manifest?.pluginVersion}</small>
        <p>{selected.manifest?.description}</p>
        {(selected.error || selected.backendError) && <p role="alert">{selected.error ?? selected.backendError}</p>}
        <div className="ui-row">
          {selected.manifest?.ui && <>
            <button type="button" className="ui-button" disabled={busy || !selected.enabled || Boolean(selected.error)} onClick={() => onOpen(selected)}>{t('plugins.open_panel')}</button>
            <button type="button" className="ui-button" disabled={busy || !selected.enabled || Boolean(selected.error)} onClick={() => void act(() => window.gale.plugins.openWindow(selected.id))}><ExternalLink size={16} />{t('plugins.open_window')}</button>
          </>}
          {selected.manifest?.backend && <button type="button" className="ui-button" disabled={(busy && selected.backendStatus !== 'starting') || !selected.enabled || Boolean(selected.error)}
            onClick={() => void act(() => selected.backendStatus === 'running' || selected.backendStatus === 'starting'
              ? window.gale.plugins.stopBackend(selected.id) : window.gale.plugins.startBackend(selected.id))}>
            {selected.backendStatus === 'running' || selected.backendStatus === 'starting' ? <Square size={16} /> : <Play size={16} />}
            {t(selected.backendStatus === 'running' || selected.backendStatus === 'starting' ? 'plugins.stop_backend' : 'plugins.start_backend')}</button>}
        </div>
        <small className="ui-field-hint">{selected.manifest?.backend ? t(`plugins.backend_${selected.backendStatus}`) : t('plugins.no_backend')}</small>
      </div> : <div className="ui-empty-state">{t('plugins.empty')}</div>}
    </div>
    <ConfirmDialog request={removing ? { title: t('plugins.uninstall'), description: t('plugins.uninstall_hint', { name: removing.manifest?.name ?? removing.id }), variant: 'danger',
      onConfirm: () => act(() => window.gale.plugins.uninstall(removing.id)) } : undefined} onClose={() => setRemoving(undefined)} />
  </>
}
