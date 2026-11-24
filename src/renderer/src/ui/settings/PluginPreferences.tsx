import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Pencil, X } from 'lucide-react'
import { pluginDisplayText, type PluginSummary } from '@shared/plugins'
import { pluginSettingValues, type PluginSettingsSnapshot, type PluginSettingValues } from '@shared/pluginSettings'
import { errorDetail } from '@shared/recovery'
import { CheckboxField } from '../CheckboxField'
import { CommitNumberInput } from '../CommitNumberInput'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'

function PreferencesEditor({ plugin, title, initial, onClose, onSaved }: {
  plugin: PluginSummary; title: string; initial: PluginSettingsSnapshot; onClose(): void; onSaved(value: PluginSettingsSnapshot): void
}) {
  const { t, i18n } = useTranslation()
  // A catalog refresh must never replace the form or the user's draft during editing.
  const [fields] = useState(plugin.manifest!.settings!)
  const [snapshot, setSnapshot] = useState(initial)
  const [draft, setDraft] = useState<PluginSettingValues>(initial.values)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const pending = useRef(false)
  const [discard, setDiscard] = useState(false)
  const [reload, setReload] = useState(false)
  const [hoveredField, setHoveredField] = useState<string>()
  const [focusedField, setFocusedField] = useState<string>()
  const dirty = JSON.stringify(draft) !== JSON.stringify(snapshot.values)
  const update = (key: string, value: string | number | boolean) => { if (!pending.current) setDraft(previous => ({ ...previous, [key]: value })) }
  const close = () => { if (!pending.current) { if (dirty) setDiscard(true); else onClose() } }
  async function save() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
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
    } finally { pending.current = false; setBusy(false) }
  }
  async function refresh() {
    if (pending.current) return
    pending.current = true
    setBusy(true)
    try {
      // Close and reopen when the installed form changed; do not apply old field definitions to new values.
      const latest = await window.gale.plugins.invoke(plugin.id, 'settings.get') as PluginSettingsSnapshot
      if (JSON.stringify(fields) !== JSON.stringify(plugin.manifest?.settings)) { onSaved(latest); onClose(); return }
      setSnapshot(latest); setDraft(latest.values); setError('')
    } catch (reason) { setError(errorDetail(reason)) }
    finally { pending.current = false; setBusy(false) }
  }
  return <>
    <Dialog.Root open onOpenChange={open => { if (!open) close() }}>
      <Dialog.Portal><Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content className="ui-dialog ui-dialog-medium ui-dialog-font-scaled ui-dialog-centered ui-dialog-fixed-footer ui-popover" aria-busy={busy || undefined} onPointerDownOutside={event => event.preventDefault()}>
          <header className="ui-dialog-header-group">
          <Dialog.Title className="ui-dialog-title">{title}</Dialog.Title>
          <Dialog.Description className="ui-dialog-description">{pluginDisplayText(plugin, i18n.language)}</Dialog.Description>
          </header>
          <div className="ui-dialog-body ui-form-section">
          <fieldset className="ui-form-section" inert={busy} disabled={!plugin.enabled || Boolean(plugin.error)}>
            {fields.map(field => <div className="ui-field-stack" key={field.key}>
              {field.type === 'boolean' ? <CheckboxField checked={draft[field.key] === true} label={field.label} onChange={value => update(field.key, value)} /> : <>
                <label htmlFor={`plugin-setting-${field.key}`}>{field.label}</label>
                {field.type === 'enum' ? <SearchableOptionPicker ariaLabel={field.label} options={field.choices!} value={String(draft[field.key])}
                  emptyLabel={t('settings.no_options')} searchable={false} disabled={!plugin.enabled} onChange={value => update(field.key, value)} />
                  : field.type === 'number' ? <CommitNumberInput id={`plugin-setting-${field.key}`} aria-label={field.label} integer={false}
                    value={String(draft[field.key])} min={field.minimum} max={field.maximum}
                    onCommit={value => update(field.key, value)} onDraftChange={value => update(field.key, value)} />
                    : <input id={`plugin-setting-${field.key}`} className="ui-input" value={String(draft[field.key])} maxLength={field.maxLength ?? 4096}
                      type={field.type === 'password' && hoveredField !== field.key && focusedField !== field.key ? 'password' : 'text'}
                      autoComplete={field.type === 'password' ? 'off' : undefined} spellCheck={field.type === 'password' ? false : undefined}
                      onMouseEnter={() => setHoveredField(field.key)} onMouseLeave={() => setHoveredField(undefined)}
                      onFocus={() => setFocusedField(field.key)} onBlur={() => setFocusedField(undefined)}
                      onChange={event => update(field.key, event.target.value)} />}
              </>}
              {field.description && <small className="ui-field-hint">{field.description}</small>}
            </div>)}
          </fieldset>
          {error && <div role="alert" className="ui-note ui-note-danger"><p>{error}</p>
            <button type="button" className="ui-button" aria-disabled={busy || undefined} onClick={() => { if (!pending.current) { if (dirty) setReload(true); else void refresh() } }}>{t('common.refresh')}</button>
          </div>}
          </div>
          <footer className="ui-dialog-footer">
            <button type="button" className="ui-button" aria-disabled={busy || undefined} onClick={close}><X size={14} />{t('common.cancel')}</button>
            <button type="button" className="ui-button ui-button-primary" disabled={!dirty || !plugin.enabled || Boolean(plugin.error)} aria-disabled={busy || undefined} onClick={() => void save()}><Check size={14} />{t('common.save')}</button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <ConfirmDialog request={discard || reload ? { title: t('settings.file_discard_title'), description: t('settings.file_discard_hint'),
      onConfirm: reload ? refresh : onClose } : undefined} onClose={() => { setDiscard(false); setReload(false) }} />
  </>
}

export function PluginPreferences({ plugin }: { plugin: PluginSummary }) {
  const { t, i18n } = useTranslation()
  const [snapshot, setSnapshot] = useState<PluginSettingsSnapshot>()
  const [editing, setEditing] = useState<PluginSettingsSnapshot>()
  const [error, setError] = useState('')
  const readRevision = useRef(0)
  const title = pluginDisplayText(plugin, i18n.language, 'settingsTitle') || t('plugins.settings')
  const saved: string[] = [], empty: string[] = []
  if (snapshot) for (const field of plugin.manifest?.settings ?? []) {
    const value = snapshot.values[field.key]
    const filled = typeof value === 'string' ? Boolean(value.trim()) : value !== undefined
    if (filled) saved.push(field.label)
    else empty.push(field.label)
  }
  useEffect(() => {
    let active = true
    const request = ++readRevision.current
    void window.gale.plugins.invoke(plugin.id, 'settings.get').then(value => {
      if (active && request === readRevision.current) { setSnapshot(value as PluginSettingsSnapshot); setError('') }
    }).catch(reason => { if (active && request === readRevision.current) setError(errorDetail(reason)) })
    return () => { active = false }
  }, [plugin])
  return <div className="ui-form-section">
    <div className="ui-toolbar ui-toolbar-between"><strong>{title}</strong>
      <button type="button" className="ui-icon-button" aria-label={t('common.edit')} data-tooltip={t('common.edit')} disabled={!snapshot || Boolean(error) || !plugin.enabled}
        onClick={() => setEditing(snapshot)}><Pencil size={16} /></button>
    </div>
    {error && <p role="alert" className="ui-status-danger">{error}</p>}
    {!error && saved.length > 0 && <p className="ui-field-hint">{t('plugins.settings_saved_fields', { fields: saved.join(t('plugins.settings_field_separator')) })}</p>}
    {!error && empty.length > 0 && <p className="ui-field-hint">{t('plugins.settings_empty_fields', { fields: empty.join(t('plugins.settings_field_separator')) })}</p>}
    {editing && <PreferencesEditor plugin={plugin} title={title} initial={editing} onClose={() => setEditing(undefined)} onSaved={value => { readRevision.current++; setSnapshot(value) }} />}
  </div>
}
