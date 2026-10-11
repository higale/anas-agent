import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Pencil, X } from 'lucide-react'
import type { PluginSummary } from '@shared/plugins'
import { pluginSettingValues, type PluginSettingsSnapshot, type PluginSettingValues } from '@shared/pluginSettings'
import { errorDetail } from '@shared/recovery'
import { CheckboxField } from '../CheckboxField'
import { CommitNumberInput } from '../CommitNumberInput'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'

function PreferencesEditor({ plugin, initial, onClose, onSaved }: {
  plugin: PluginSummary; initial: PluginSettingsSnapshot; onClose(): void; onSaved(value: PluginSettingsSnapshot): void
}) {
  const { t } = useTranslation()
  // A catalog refresh must never replace the form or the user's draft during editing.
  const [fields] = useState(plugin.manifest!.settings!)
  const [snapshot, setSnapshot] = useState(initial)
  const [draft, setDraft] = useState<PluginSettingValues>(initial.values)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [discard, setDiscard] = useState(false)
  const [reload, setReload] = useState(false)
  const dirty = JSON.stringify(draft) !== JSON.stringify(snapshot.values)
  const update = (key: string, value: string | number | boolean) => setDraft(previous => ({ ...previous, [key]: value }))
  const close = () => { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
  async function save() {
    setBusy(true); setError('')
    try {
      const values = pluginSettingValues(fields, Object.fromEntries(fields.map(field => {
        const value = draft[field.key]
        return [field.key, field.type === 'number' ? (String(value).trim() ? Number(value) : NaN) : value]
      })), true)
      onSaved(await window.gale.plugins.invoke(plugin.id, 'settings.set', { values, revision: snapshot.revision }) as PluginSettingsSnapshot)
      onClose()
    } catch (reason) {
      const detail = errorDetail(reason)
      setError(detail.includes('Plugin settings changed.') ? t('plugins.settings_conflict') : detail)
    } finally { setBusy(false) }
  }
  async function refresh() {
    setBusy(true)
    try {
      // Close and reopen when the installed form changed; do not apply old field definitions to new values.
      const latest = await window.gale.plugins.invoke(plugin.id, 'settings.get') as PluginSettingsSnapshot
      if (JSON.stringify(fields) !== JSON.stringify(plugin.manifest?.settings)) { onSaved(latest); onClose(); return }
      setSnapshot(latest); setDraft(latest.values); setError('')
    } catch (reason) { setError(errorDetail(reason)) }
    finally { setBusy(false) }
  }
  return <>
    <Dialog.Root open onOpenChange={open => { if (!open) close() }}>
      <Dialog.Portal><Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content className="ui-dialog ui-dialog-medium ui-dialog-font-scaled ui-dialog-centered ui-dialog-fixed-footer ui-popover" onPointerDownOutside={event => event.preventDefault()}>
          <header className="ui-dialog-header-group">
          <Dialog.Title className="ui-dialog-title">{t('plugins.settings')}</Dialog.Title>
          <Dialog.Description className="ui-dialog-description">{plugin.manifest?.name}</Dialog.Description>
          </header>
          <div className="ui-dialog-body ui-form-section">
          <fieldset className="ui-form-section" disabled={busy || !plugin.enabled || Boolean(plugin.error)}>
            {fields.map(field => <div className="ui-field-stack" key={field.key}>
              {field.type === 'boolean' ? <CheckboxField checked={draft[field.key] === true} label={field.label} onChange={value => update(field.key, value)} /> : <>
                <label htmlFor={`plugin-setting-${field.key}`}>{field.label}</label>
                {field.type === 'enum' ? <SearchableOptionPicker ariaLabel={field.label} options={field.choices!} value={String(draft[field.key])}
                  emptyLabel={t('settings.no_options')} searchable={false} disabled={busy || !plugin.enabled} onChange={value => update(field.key, value)} />
                  : field.type === 'number' ? <CommitNumberInput id={`plugin-setting-${field.key}`} aria-label={field.label} integer={false}
                    value={String(draft[field.key])} min={field.minimum} max={field.maximum}
                    onCommit={value => update(field.key, value)} onDraftChange={value => update(field.key, value)} />
                    : <input id={`plugin-setting-${field.key}`} className="ui-input" value={String(draft[field.key])} maxLength={field.maxLength ?? 4096} onChange={event => update(field.key, event.target.value)} />}
              </>}
              {field.description && <small className="ui-field-hint">{field.description}</small>}
            </div>)}
          </fieldset>
          {error && <div role="alert" className="ui-note ui-note-danger"><p>{error}</p>
            <button type="button" className="ui-button" disabled={busy} onClick={() => dirty ? setReload(true) : void refresh()}>{t('common.refresh')}</button>
          </div>}
          </div>
          <footer className="ui-dialog-footer">
            <button type="button" className="ui-button" disabled={busy} onClick={close}><X size={14} />{t('common.cancel')}</button>
            <button type="button" className="ui-button ui-button-primary" disabled={busy || !dirty || !plugin.enabled || Boolean(plugin.error)} onClick={() => void save()}><Check size={14} />{t('common.save')}</button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <ConfirmDialog request={discard || reload ? { title: t('settings.file_discard_title'), description: t('settings.file_discard_hint'),
      onConfirm: reload ? refresh : onClose } : undefined} onClose={() => { setDiscard(false); setReload(false) }} />
  </>
}

export function PluginPreferences({ plugin }: { plugin: PluginSummary }) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<PluginSettingsSnapshot>()
  const [editing, setEditing] = useState<PluginSettingsSnapshot>()
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    void window.gale.plugins.invoke(plugin.id, 'settings.get').then(value => {
      if (active) { setSnapshot(value as PluginSettingsSnapshot); setError('') }
    }).catch(reason => { if (active) setError(errorDetail(reason)) })
    return () => { active = false }
  }, [plugin])
  return <div className="ui-form-section">
    <div className="ui-toolbar ui-toolbar-between"><strong>{t('plugins.settings')}</strong>
      <button type="button" className="ui-icon-button" aria-label={t('common.edit')} data-tooltip={t('common.edit')} disabled={!snapshot || Boolean(error) || !plugin.enabled}
        onClick={() => setEditing(snapshot)}><Pencil size={16} /></button>
    </div>
    {error && <p role="alert" className="ui-status-danger">{error}</p>}
    {snapshot && plugin.manifest?.settings?.map(field => <div className="ui-form-row ui-form-row-label-content" key={field.key}>
      <span>{field.label}</span><span>{field.type === 'boolean' ? t(snapshot.values[field.key] ? 'settings.enabled' : 'settings.disabled')
        : field.choices?.find(choice => choice.value === snapshot.values[field.key])?.label ?? String(snapshot.values[field.key])}</span>
    </div>)}
    {editing && <PreferencesEditor plugin={plugin} initial={editing} onClose={() => setEditing(undefined)} onSaved={setSnapshot} />}
  </div>
}
