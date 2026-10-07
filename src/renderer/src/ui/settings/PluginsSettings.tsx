import { useEffect, useState } from 'react'
import { ExternalLink, PackagePlus, Play, RefreshCw, Square, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { pluginDisplayText, pluginHomePolicy, type PluginSummary, type PluginViewOptions } from '@shared/plugins'
import { errorDetail } from '@shared/recovery'
import { Checkbox } from '../Checkbox'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { notice } from '../notice'
import { SegmentedControl } from '../SegmentedControl'

function PluginHomeLocation({ plugin, busy, act }: {
  plugin: PluginSummary; busy: boolean; act(operation: () => Promise<unknown>): Promise<void>
}) {
  const { t } = useTranslation()
  const [location, setLocation] = useState<PluginViewOptions['location']>()
  const [error, setError] = useState<string>()
  const policy = pluginHomePolicy(plugin.manifest!)
  useEffect(() => {
    let active = true
    void window.gale.plugins.invoke(plugin.id, 'host.home').then(value => {
      if (active) { setLocation((value as { location: PluginViewOptions['location'] }).location); setError(undefined) }
    }).catch(reason => { if (active) { setLocation(undefined); setError(errorDetail(reason)) } })
    return () => { active = false }
  }, [plugin])
  return <div className="ui-form-row ui-form-row-narrow ui-form-row-fit-control">
    <span><strong>{t('plugins.home_location')}</strong><small>{t('plugins.home_location_hint')}</small>
      {error && <small role="alert">{t('plugins.operation_failed')} {error}</small>}
    </span>
    <SegmentedControl ariaLabel={t('plugins.home_location')} value={location ?? ''}
      disabled={busy || !location || policy.locations.length === 1}
      options={policy.locations.map(value => ({ value, label: t(`plugins.home_${value}`) }))}
      onChange={value => void act(async () => {
        await window.gale.plugins.invoke(plugin.id, 'data.set', { key: 'home_open_location', value })
        setLocation(value as PluginViewOptions['location'])
      })} />
  </div>
}

export function PluginsSettings({ plugins, error, onRefresh, onOpen }: {
  plugins: PluginSummary[]; error?: string; onRefresh(): Promise<void>; onOpen(plugin: PluginSummary): void
}) {
  const { t, i18n } = useTranslation()
  const [selectedId, setSelectedId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<PluginSummary>()
  const [deleteData, setDeleteData] = useState(false)
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
          onClick={() => setSelectedId(item.id)}>{pluginDisplayText(item, i18n.language)}</button>)}
      </div>
    </aside>
    <div className="ui-editor">
      {error && <div role="alert"><p>{t('plugins.load_failed')}</p><small>{error}</small></div>}
      {selected ? <div className="ui-form-section">
        <div className="ui-toolbar ui-toolbar-between">
          <strong>{pluginDisplayText(selected, i18n.language)}</strong>
          <div className="ui-row">
            <label className="ui-row"><Checkbox checked={selected.enabled} disabled={busy || Boolean(selected.error)} onChange={enabled => void act(() => window.gale.plugins.setEnabled(selected.id, enabled))} />{t('settings.enabled')}</label>
            <button type="button" className="ui-tool-button ui-tool-button-square" aria-label={t('plugins.uninstall')} data-tooltip={t('plugins.uninstall')} disabled={busy} onClick={() => { setDeleteData(false); setRemoving(selected) }}><Trash2 size={16} /></button>
          </div>
        </div>
        <small className="ui-field-hint">{selected.id} · {selected.manifest?.pluginVersion}</small>
        <p>{pluginDisplayText(selected, i18n.language, 'description')}</p>
        {Boolean(selected.languageErrors?.length) && <p role="alert">{t('plugins.language_failed')}<small>{selected.languageErrors?.join('\n')}</small></p>}
        {(selected.error || selected.backendError) && <p role="alert">{selected.error ?? selected.backendError}</p>}
        {selected.manifest?.ui && selected.enabled && !selected.error && <PluginHomeLocation key={selected.id} plugin={selected} busy={busy} act={act} />}
        <div className="ui-row">
          {selected.manifest?.ui && <>
            <button type="button" className="ui-button" disabled={busy || !selected.enabled || Boolean(selected.error) || !pluginHomePolicy(selected.manifest).locations.includes('sidebar')} onClick={() => onOpen(selected)}>{t('plugins.open_panel')}</button>
            <button type="button" className="ui-button" disabled={busy || !selected.enabled || Boolean(selected.error) || !pluginHomePolicy(selected.manifest).locations.includes('window')} onClick={() => void act(() => window.gale.plugins.openWindow(selected.id))}><ExternalLink size={16} />{t('plugins.open_window')}</button>
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
    <ConfirmDialog request={removing ? { title: t('plugins.uninstall'), description: t('plugins.uninstall_hint', { name: pluginDisplayText(removing, i18n.language) }), variant: 'danger',
      onConfirm: () => act(() => window.gale.plugins.uninstall(removing.id, deleteData)) } : undefined} onClose={() => setRemoving(undefined)}>
      <div className="ui-form-section">
        <label className="ui-row"><Checkbox checked={deleteData} onChange={setDeleteData} />{t('plugins.delete_data')}</label>
        <small className="ui-field-hint">{t('plugins.delete_data_hint')}</small>
      </div>
    </ConfirmDialog>
  </>
}
