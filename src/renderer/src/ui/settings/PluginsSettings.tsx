import { useEffect, useEffectEvent, useRef, useState, type DragEvent } from 'react'
import { Download, Play, RefreshCw, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { pluginDisplayText, pluginHomePolicy, pluginIconSources, type PluginSummary, type PluginViewOptions, type PluginInstallPreview } from '@shared/plugins'
import { errorDetail } from '@shared/recovery'
import { CheckboxField } from '../CheckboxField'
import { SegmentedMultiSelect } from '../SegmentedMultiSelect'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { notice } from '../notice'
import { SegmentedControl } from '../SegmentedControl'
import { UI_ICON_SIZE_LARGE, UI_ICON_SIZE_SMALL } from '../uiConstants'
import { SettingsListActions } from './SettingsListActions'
import { SettingsAvailabilityBadge } from './SettingsAvailabilityBadge'
import { PluginIcon } from '../plugins/PluginIcon'
import { PluginPreferences } from './PluginPreferences'
import { PluginContributions } from './PluginContributions'
import { dataTransferHasFiles } from '../dragDrop'

function PluginLaunchSettings({ plugin, busy }: {
  plugin: PluginSummary; busy: boolean
}) {
  const { t } = useTranslation()
  const [location, setLocation] = useState<PluginViewOptions['location']>()
  const [error, setError] = useState<string>()
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  const readRevision = useRef(0)
  const policy = pluginHomePolicy(plugin.manifest!)
  useEffect(() => {
    if (pending.current) return
    let active = true
    const request = ++readRevision.current
    void window.gale.plugins.invoke(plugin.id, 'host.home').then(value => {
      if (active && request === readRevision.current) { setLocation((value as { location: PluginViewOptions['location'] }).location); setError(undefined) }
    }).catch(reason => { if (active && request === readRevision.current) setError(errorDetail(reason)) })
    return () => { active = false }
  }, [plugin])
  async function save(value: PluginViewOptions['location']) {
    if (pending.current) return
    pending.current = true
    readRevision.current++
    const previous = location
    setLocation(value)
    setSaving(true)
    try {
      await window.gale.plugins.invoke(plugin.id, 'data.set', { key: 'home_open_location', value })
      setError(undefined)
    } catch (reason) {
      setLocation(previous)
      notice.error(t('plugins.operation_failed'), { description: errorDetail(reason) })
    }
    finally { pending.current = false; setSaving(false) }
  }
  return <div className="ui-form-row ui-form-row-narrow ui-form-row-fit-control">
    <span><strong>{t('plugins.home_location')}</strong><small>{t('plugins.home_location_hint')}</small>
      {error && <small role="alert"><span className="ui-status-danger">{t('plugins.operation_failed')} {error}</span></small>}
    </span>
    <SegmentedControl ariaLabel={t('plugins.home_location')} value={location ?? ''}
      disabled={busy || !location || policy.locations.length === 1} busy={saving}
      options={policy.locations.map(value => ({ value, label: t(`plugins.home_${value}`) }))}
      onChange={value => void save(value as PluginViewOptions['location'])} />
  </div>
}

function PluginHeading({ plugin, busy, onRefresh }: { plugin: PluginSummary; busy: boolean; onRefresh(): Promise<void> }) {
  const { t, i18n } = useTranslation()
  const [iconFailed, setIconFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const pending = useRef(false)
  const [choices, setChoices] = useState({ enabled: plugin.enabled, showInTitlebar: plugin.showInTitlebar ?? false })
  useEffect(() => {
    if (!pending.current) setChoices({ enabled: plugin.enabled, showInTitlebar: plugin.showInTitlebar ?? false })
  }, [plugin.enabled, plugin.showInTitlebar])
  async function save(setting: 'enabled' | 'showInTitlebar', checked: boolean) {
    if (pending.current) return
    pending.current = true
    const previous = choices
    setChoices({ ...choices, [setting]: checked })
    setSaving(true)
    let saved = false
    try {
      if (setting === 'enabled') await window.gale.plugins.setEnabled(plugin.id, checked)
      else await window.gale.plugins.setShowInTitlebar(plugin.id, checked)
      saved = true
      await onRefresh()
    }
    catch (reason) {
      if (!saved) setChoices(previous)
      notice.error(t('plugins.operation_failed'), { description: errorDetail(reason) })
    }
    finally { pending.current = false; setSaving(false) }
  }
  return <>
    <div className="settings-detail-heading ui-toolbar ui-toolbar-between">
      <div>
        <strong className="plugin-label"><PluginIcon icon={pluginIconSources(plugin.id, plugin.manifest?.icon)} onError={() => setIconFailed(true)} />{pluginDisplayText(plugin, i18n.language)}</strong>
        <small>{[plugin.id, plugin.manifest?.pluginVersion].filter(Boolean).join(' · ')}</small>
      </div>
      <SegmentedMultiSelect<'enabled' | 'showInTitlebar'> ariaLabel={t('plugins.settings')} itemWidth="content"
        disabled={busy || Boolean(plugin.error)} busy={saving} options={[
          ...(plugin.manifest?.ui && !plugin.error ? [{ value: 'showInTitlebar' as const, label: t('plugins.show_in_titlebar'), checked: choices.showInTitlebar }] : []),
          { value: 'enabled', label: t('settings.enabled'), checked: choices.enabled }
        ]} onChange={(setting, checked) => void save(setting, checked)} />
    </div>
    {iconFailed && <div className="ui-note ui-note-danger" role="alert">{t('plugins.icon_failed')}</div>}
  </>
}

function PluginBackendStatus({ plugin, busy, onRefresh }: {
  plugin: PluginSummary; busy: boolean; onRefresh(): Promise<void>
}) {
  const { t } = useTranslation()
  const [pending, setPending] = useState<'start' | 'stop'>()
  const pendingAction = useRef<'start' | 'stop'>(undefined)
  const active = plugin.backendStatus === 'running' || plugin.backendStatus === 'starting'
  const actionBlocked = pending === 'stop' || (pending === 'start' && !active)
  async function changeBackend() {
    if (pendingAction.current === 'stop' || (pendingAction.current === 'start' && !active)) return
    const action = active ? 'stop' : 'start'
    pendingAction.current = action
    setPending(action)
    try {
      if (action === 'stop') await window.gale.plugins.stopBackend(plugin.id)
      else await window.gale.plugins.startBackend(plugin.id)
      await onRefresh()
    } catch (reason) { notice.error(t('plugins.operation_failed'), { description: errorDetail(reason) }) }
    finally {
      if (pendingAction.current === action) pendingAction.current = undefined
      setPending(current => current === action ? undefined : current)
    }
  }
  return <div className="ui-form-section ui-form-section-divided">
    <div className="ui-toolbar ui-toolbar-between">
      <small className="ui-field-hint">{plugin.manifest?.backend ? t(`plugins.backend_${plugin.backendStatus}`) : t('plugins.no_backend')}</small>
      {plugin.manifest?.backend && <button type="button" className="ui-button ui-button-compact"
        disabled={busy || !plugin.enabled || Boolean(plugin.error)} aria-disabled={actionBlocked || undefined} aria-busy={Boolean(pending) || undefined}
        onClick={() => void changeBackend()}>
        {active ? <Square size={UI_ICON_SIZE_SMALL} /> : <Play size={UI_ICON_SIZE_SMALL} />}
        {t(active ? 'plugins.stop_backend' : 'plugins.start_backend')}</button>}
    </div>
  </div>
}

export function PluginsSettings({ plugins, error, onRefresh, className = 'settings-workbench ui-workbench ui-grid-sidebar' }: {
  plugins: PluginSummary[]; error?: string; onRefresh(): Promise<void>; className?: string
}) {
  const { t, i18n } = useTranslation()
  const [selectedId, setSelectedId] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [removing, setRemoving] = useState<PluginSummary>()
  const [deleteData, setDeleteData] = useState(false)
  const [replacing, setReplacing] = useState<PluginInstallPreview>()
  const [section, setSection] = useState({ id: '', tab: 'overview' })
  const [dragActive, setDragActive] = useState(false)
  const dragDepth = useRef(0)
  const installing = useRef(false)
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
  const hasCapabilities = Boolean(selected?.manifest && (selected.manifest.tools.length || selected.manifest.skills?.length || selected.manifest.prompts?.length))
  const tabs = ['overview', ...(selected?.manifest?.settings?.length ? ['settings'] : [])]
  const tab = selected?.id === section.id && tabs.includes(section.tab) ? section.tab : 'overview'
  async function act(operation: () => Promise<unknown>) {
    setBusy(true)
    try { await operation(); await onRefresh() } catch (reason) { notice.error(t('plugins.operation_failed'), { description: errorDetail(reason) }) }
    finally { setBusy(false) }
  }
  function canInstall() { return !busy && !removing && !replacing && !installing.current && !pendingInstall.current }
  async function installPlugin(file?: File) {
    if (!canInstall()) return
    installing.current = true
    try {
      await act(async () => {
        const item = await window.gale.plugins.install(file)
        if (!item) return
        if ('replacement' in item) {
          if (!mounted.current) { await window.gale.plugins.cancelInstall(item.replacement.token); return }
          pendingInstall.current = item.replacement.token
          setDeleteData(false)
          setReplacing(item.replacement)
        } else if (mounted.current) setSelectedId(item.id)
      })
    } finally { installing.current = false }
  }
  function dragOver(event: DragEvent<HTMLElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    event.dataTransfer.dropEffect = canInstall() ? 'copy' : 'none'
    setDragActive(Boolean(canInstall()))
  }
  function drop(event: DragEvent<HTMLElement>) {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    dragDepth.current = 0
    setDragActive(false)
    if (!canInstall()) return
    const files = Array.from(event.dataTransfer.files)
    if (files.length !== 1) {
      notice.error(t('plugins.operation_failed'), { description: t('plugins.drop_one') })
      return
    }
    void installPlugin(files[0])
  }
  return <section className={`${className} plugin-settings`} aria-label={t('plugins.title')}
    onDragEnter={event => {
      if (!dataTransferHasFiles(event.dataTransfer)) return
      dragOver(event)
      dragDepth.current++
    }}
    onDragOver={dragOver}
    onDragLeave={event => {
      if (!dataTransferHasFiles(event.dataTransfer)) return
      event.preventDefault()
      event.stopPropagation()
      dragDepth.current = Math.max(0, dragDepth.current - 1)
      if (!dragDepth.current) setDragActive(false)
    }}
    onDrop={drop}>
    {dragActive && <div className="plugin-install-drop-hint" role="status"><span><Download size={UI_ICON_SIZE_LARGE} />{t('plugins.drop_hint')}</span></div>}
    <aside className="ui-list-pane">
      <div className="ui-list-pane-header">
        <SettingsListActions addLabel={t('plugins.install')} deleteLabel={t('plugins.uninstall')}
          canDelete={Boolean(selected && !selected.builtin)} canMoveDown={false} canMoveUp={false} disabled={busy}
          leading={<button type="button" className="ui-icon-button" aria-label={t('common.refresh')} data-tooltip={t('common.refresh')} disabled={busy}
            onClick={() => void onRefresh()}><RefreshCw size={UI_ICON_SIZE_LARGE} /></button>}
          onAdd={() => installPlugin()}
          onDelete={() => { if (selected) { setDeleteData(false); setRemoving(selected) } }} />
      </div>
      <div className="ui-scroll-list ui-list" aria-label={t('plugins.title')}>
        {plugins.map(item => {
          const name = pluginDisplayText(item, i18n.language)
          const failed = Boolean(item.error || item.backendError || item.languageErrors?.length)
          const state = item.backendStatus === 'running' ? 'running' : item.backendStatus === 'starting' ? 'pending' : undefined
          return <button type="button" key={item.id} className={`ui-list-item ui-list-item-split ui-list-item-compact${selected?.id === item.id ? ' active' : ''}`}
            aria-label={name} aria-pressed={selected?.id === item.id} data-tooltip={name} onClick={() => setSelectedId(item.id)}>
            <strong className="plugin-label"><PluginIcon icon={pluginIconSources(item.id, item.manifest?.icon)} /><span className="ui-truncate">{name}</span></strong>
            {failed || !item.enabled ? <SettingsAvailabilityBadge disabled={!item.enabled} error={failed} />
              : state && <em className={`ui-list-item-badge ${state === 'running' ? 'ui-badge-success' : 'ui-badge-warning'}`}>{t(`settings.${state}`)}</em>}
          </button>
        })}
      </div>
    </aside>
    <div className="ui-editor">
      {error && <div className="ui-note ui-note-danger" role="alert"><p>{t('plugins.load_failed')}</p><p>{error}</p></div>}
      {selected ? <>
        <PluginHeading key={JSON.stringify([selected.id, selected.manifest?.icon])} plugin={selected} busy={busy} onRefresh={onRefresh} />
        {tabs.length > 1 && <SegmentedControl ariaLabel={t('plugins.details')} value={tab}
          options={tabs.map(value => ({ value, label: t(`plugins.${value}`) }))} onChange={tab => setSection({ id: selected.id, tab })} />}
        {tab === 'overview' && <div className="ui-form-section">
        {selected.builtin && <small className="ui-field-hint">{t('plugins.builtin_hint')}</small>}
        {pluginDisplayText(selected, i18n.language, 'description') && <div className="ui-field-hint">{pluginDisplayText(selected, i18n.language, 'description').split('\n').map((line, index) => <div key={index}>{line || <br />}</div>)}</div>}
        {hasCapabilities && <small className="ui-field-hint">{t('plugins.contributions_count', { tools: selected.manifest?.tools.length ?? 0,
          skills: selected.manifest?.skills?.length ?? 0, prompts: selected.manifest?.prompts?.length ?? 0 })}</small>}
        {Boolean(selected.languageErrors?.length) && <div className="ui-note ui-note-danger" role="alert"><p>{t('plugins.language_failed')}</p>{selected.languageErrors?.map((message, index) => <p key={index}>{message}</p>)}</div>}
        {(selected.error || selected.backendError) && <div className="ui-note ui-note-danger" role="alert"><p>{selected.error ?? selected.backendError}</p></div>}
        {selected.manifest?.ui && !selected.error && <PluginLaunchSettings key={selected.id} plugin={selected} busy={busy} />}
        {selected.manifest && <PluginBackendStatus key={`backend:${selected.id}`} plugin={selected} busy={busy} onRefresh={onRefresh} />}
        <PluginContributions key={`contributions:${selected.id}`} plugin={selected} busy={busy} onRefresh={onRefresh} />
        </div>}
        {tab === 'settings' && <PluginPreferences key={selected.id} plugin={selected} />}
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
  </section>
}
