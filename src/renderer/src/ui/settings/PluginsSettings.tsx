import { useEffect, useEffectEvent, useRef, useState } from 'react'
import { ExternalLink, PanelRight, Play, RefreshCw, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { pluginDisplayText, pluginHomePolicy, pluginIconSources, type PluginSummary, type PluginViewOptions, type PluginInstallPreview } from '@shared/plugins'
import { errorDetail } from '@shared/recovery'
import { CheckboxField } from '../CheckboxField'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { notice } from '../notice'
import { SegmentedControl } from '../SegmentedControl'
import { UI_ICON_SIZE_LARGE, UI_ICON_SIZE_SMALL } from '../uiConstants'
import { SettingsListActions } from './SettingsListActions'
import { PluginIcon } from '../plugins/PluginIcon'

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
      {error && <small role="alert"><span className="ui-status-danger">{t('plugins.operation_failed')} {error}</span></small>}
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

function PluginHeading({ plugin, busy, onEnabledChange }: { plugin: PluginSummary; busy: boolean; onEnabledChange(enabled: boolean): void }) {
  const { t, i18n } = useTranslation()
  const [iconFailed, setIconFailed] = useState(false)
  return <>
    <div className="settings-detail-heading ui-toolbar ui-toolbar-between">
      <div>
        <strong className="plugin-label"><PluginIcon icon={pluginIconSources(plugin.id, plugin.manifest?.icon)} onError={() => setIconFailed(true)} />{pluginDisplayText(plugin, i18n.language)}</strong>
        <small>{[plugin.id, plugin.manifest?.pluginVersion].filter(Boolean).join(' · ')}</small>
      </div>
      <CheckboxField checked={plugin.enabled} disabled={busy || Boolean(plugin.error)} label={t('settings.enabled')} onChange={onEnabledChange} />
    </div>
    {iconFailed && <div className="ui-note ui-note-danger" role="alert">{t('plugins.icon_failed')}</div>}
  </>
}

export function PluginsSettings({ plugins, error, onRefresh, onOpen }: {
  plugins: PluginSummary[]; error?: string; onRefresh(): Promise<void>; onOpen(plugin: PluginSummary): void
}) {
  const { t, i18n } = useTranslation()
  const [selectedId, setSelectedId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<PluginSummary>()
  const [deleteData, setDeleteData] = useState(false)
  const [replacing, setReplacing] = useState<PluginInstallPreview>()
  const pendingInstall = useRef<string | undefined>(undefined)
  const mounted = useRef(true)
  const cancelPendingInstall = useEffectEvent(() => {
    const token = pendingInstall.current
    pendingInstall.current = undefined
    if (token) void window.gale.plugins.cancelInstall(token).catch(reason => notice.error(t('plugins.operation_failed'), { description: errorDetail(reason) }))
  })
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false; cancelPendingInstall() }
  }, [])
  useEffect(() => {
    if (!replacing) cancelPendingInstall()
  }, [replacing])
  const selected = plugins.find(item => item.id === selectedId) ?? plugins[0]
  async function act(operation: () => Promise<unknown>) {
    setBusy(true)
    try { await operation(); await onRefresh() } catch (reason) { notice.error(t('plugins.operation_failed'), { description: errorDetail(reason) }) }
    finally { setBusy(false) }
  }
  return <>
    <aside className="ui-list-pane">
      <div className="ui-list-pane-header">
        <SettingsListActions addLabel={t('plugins.install')} deleteLabel={t('plugins.uninstall')}
          canDelete={Boolean(selected)} canMoveDown={false} canMoveUp={false} disabled={busy}
          leading={<button type="button" className="ui-icon-button" aria-label={t('common.refresh')} data-tooltip={t('common.refresh')} disabled={busy}
            onClick={() => void onRefresh()}><RefreshCw size={UI_ICON_SIZE_LARGE} /></button>}
          onAdd={() => act(async () => {
            const item = await window.gale.plugins.install()
            if (!item) return
            if ('replacement' in item) {
              if (!mounted.current) { await window.gale.plugins.cancelInstall(item.replacement.token); return }
              pendingInstall.current = item.replacement.token
              setDeleteData(false)
              setReplacing(item.replacement)
            } else setSelectedId(item.id)
          })}
          onDelete={() => { if (selected) { setDeleteData(false); setRemoving(selected) } }} />
      </div>
      <div className="ui-scroll-list ui-list" aria-label={t('plugins.title')}>
        {plugins.map(item => {
          const name = pluginDisplayText(item, i18n.language)
          const failed = Boolean(item.error || item.backendError || item.languageErrors?.length)
          const state = failed ? 'error' : !item.enabled ? 'disabled'
            : item.backendStatus === 'running' ? 'running' : item.backendStatus === 'starting' ? 'pending' : undefined
          return <button type="button" key={item.id} className={`ui-list-item ui-list-item-split ui-list-item-compact${selected?.id === item.id ? ' active' : ''}`}
            aria-label={name} aria-pressed={selected?.id === item.id} data-tooltip={name} onClick={() => setSelectedId(item.id)}>
            <strong className="plugin-label"><PluginIcon icon={pluginIconSources(item.id, item.manifest?.icon)} /><span className="ui-truncate">{name}</span></strong>
            {state && <em className={`ui-list-item-badge${failed ? ' ui-badge-danger' : state === 'running' ? ' ui-badge-success' : state === 'pending' ? ' ui-badge-warning' : ''}`}>{t(`settings.${state}`)}</em>}
          </button>
        })}
      </div>
    </aside>
    <div className="ui-editor">
      {error && <div className="ui-note ui-note-danger" role="alert"><p>{t('plugins.load_failed')}</p><p>{error}</p></div>}
      {selected ? <>
        <PluginHeading key={JSON.stringify([selected.id, selected.manifest?.icon])} plugin={selected} busy={busy}
          onEnabledChange={enabled => void act(() => window.gale.plugins.setEnabled(selected.id, enabled))} />
        {pluginDisplayText(selected, i18n.language, 'description') && <div className="ui-field-hint">{pluginDisplayText(selected, i18n.language, 'description')}</div>}
        {Boolean(selected.languageErrors?.length) && <div className="ui-note ui-note-danger" role="alert"><p>{t('plugins.language_failed')}</p>{selected.languageErrors?.map((message, index) => <p key={index}>{message}</p>)}</div>}
        {(selected.error || selected.backendError) && <div className="ui-note ui-note-danger" role="alert"><p>{selected.error ?? selected.backendError}</p></div>}
        {selected.manifest?.ui && selected.enabled && !selected.error && <PluginHomeLocation key={selected.id} plugin={selected} busy={busy} act={act} />}
        {selected.manifest && <div className="ui-form-section ui-form-section-divided">
          <div className="ui-toolbar">
            {selected.manifest.ui && <>
              <button type="button" className="ui-button ui-button-compact" disabled={busy || !selected.enabled || Boolean(selected.error) || !pluginHomePolicy(selected.manifest).locations.includes('sidebar')} onClick={() => onOpen(selected)}><PanelRight size={UI_ICON_SIZE_SMALL} />{t('plugins.open_panel')}</button>
              <button type="button" className="ui-button ui-button-compact" disabled={busy || !selected.enabled || Boolean(selected.error) || !pluginHomePolicy(selected.manifest).locations.includes('window')} onClick={() => void act(() => window.gale.plugins.openWindow(selected.id))}><ExternalLink size={UI_ICON_SIZE_SMALL} />{t('plugins.open_window')}</button>
            </>}
            {selected.manifest.backend && <button type="button" className="ui-button ui-button-compact" disabled={(busy && selected.backendStatus !== 'starting') || !selected.enabled || Boolean(selected.error)}
              onClick={() => void act(() => selected.backendStatus === 'running' || selected.backendStatus === 'starting'
                ? window.gale.plugins.stopBackend(selected.id) : window.gale.plugins.startBackend(selected.id))}>
              {selected.backendStatus === 'running' || selected.backendStatus === 'starting' ? <Square size={UI_ICON_SIZE_SMALL} /> : <Play size={UI_ICON_SIZE_SMALL} />}
              {t(selected.backendStatus === 'running' || selected.backendStatus === 'starting' ? 'plugins.stop_backend' : 'plugins.start_backend')}</button>}
          </div>
          <small className="ui-field-hint">{selected.manifest.backend ? t(`plugins.backend_${selected.backendStatus}`) : t('plugins.no_backend')}</small>
        </div>}
      </> : <div className="ui-empty-state">{t('plugins.empty')}</div>}
    </div>
    <ConfirmDialog request={replacing ? { title: t('plugins.replace'),
      description: t('plugins.replace_hint', { name: replacing.installed ? pluginDisplayText(replacing.installed, i18n.language) : replacing.incoming.name, id: replacing.incoming.id }),
      confirmText: t('plugins.replace'),
      onConfirm: () => {
        pendingInstall.current = undefined
        return act(async () => { const item = await window.gale.plugins.confirmInstall(replacing.token, deleteData); setSelectedId(item.id) })
      } } : undefined} onClose={() => setReplacing(undefined)}>
      <div className="ui-form-section">
        <div className="ui-form-row ui-form-row-label-content"><span>{t('plugins.installed_version')}</span><strong>{replacing?.installed?.manifest?.pluginVersion ?? t('plugins.version_unknown')}</strong></div>
        <div className="ui-form-row ui-form-row-label-content"><span>{t('plugins.incoming_version')}</span><strong>{replacing?.incoming.pluginVersion}</strong></div>
        <CheckboxField checked={deleteData} onChange={setDeleteData} label={t('plugins.delete_data')} />
        <small className="ui-field-hint">{t('plugins.delete_data_hint')}</small>
      </div>
    </ConfirmDialog>
    <ConfirmDialog request={removing ? { title: t('plugins.uninstall'), description: t('plugins.uninstall_hint', { name: pluginDisplayText(removing, i18n.language) }), variant: 'danger',
      onConfirm: () => act(() => window.gale.plugins.uninstall(removing.id, deleteData)) } : undefined} onClose={() => setRemoving(undefined)}>
      <div className="ui-form-section">
        <CheckboxField checked={deleteData} onChange={setDeleteData} label={t('plugins.delete_data')} />
        <small className="ui-field-hint">{t('plugins.delete_data_hint')}</small>
      </div>
    </ConfirmDialog>
  </>
}
