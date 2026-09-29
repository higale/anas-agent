import { errorDetail } from '@shared/recovery'
import * as Dialog from '@radix-ui/react-dialog'
import { Check, CircleHelp, Wrench, X } from 'lucide-react'
import { useId, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'
import { customToolDefaults, type CustomToolDefinition, type CustomToolSave } from '@shared/customTools'
import { maxCommandTimeoutSeconds } from '@shared/commandShell'
import { CommitNumberInput } from '../CommitNumberInput'
import { CommitTextarea } from '../CommitTextField'
import { CheckboxField } from '../CheckboxField'
import { SegmentedControl } from '../SegmentedControl'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { ToolParameters } from './ToolParameters'

const exampleSchema = { type: 'object', properties: { title: { type: 'string', minLength: 1 } }, required: ['title'], additionalProperties: false }
export type CustomToolEditorSection = 'information' | 'parameters'

export function CustomToolEditor({ tool, initialSection = 'information', onClose, onSave }: {
  tool?: CustomToolDefinition
  initialSection?: CustomToolEditorSection
  onClose(): void
  onSave(tool: CustomToolSave): Promise<void>
}) {
  const { t } = useTranslation()
  const commandId = useId()
  const timeoutId = useId()
  const [initial] = useState<CustomToolSave>(() => tool ?? {
    ...customToolDefaults, name: '', description: '', inputSchema: exampleSchema
  })
  const [draft, setDraft] = useState(initial)
  const [schema, setSchema] = useState(() => JSON.stringify(initial.inputSchema, null, 2))
  const [timeoutDraft, setTimeoutDraft] = useState(() => initial.timeoutSeconds === 0 ? '' : String(initial.timeoutSeconds))
  const [section, setSection] = useState(initialSection)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [parameterBusy, setParameterBusy] = useState(false)
  const [parameterEditing, setParameterEditing] = useState(false)
  const [parameterDirty, setParameterDirty] = useState(false)
  const [discard, setDiscard] = useState(false)
  const pending = busy || parameterBusy
  const dirty = JSON.stringify(draft) !== JSON.stringify(initial) || schema !== JSON.stringify(initial.inputSchema, null, 2)
    || Number(timeoutDraft) !== initial.timeoutSeconds || parameterDirty
  const update = (value: Partial<CustomToolSave>) => setDraft((current) => ({ ...current, ...value }))
  function close() {
    if (pending) return
    if (dirty) setDiscard(true)
    else onClose()
  }
  async function save() {
    if (pending || parameterEditing) return
    let inputSchema: CustomToolSave['inputSchema']
    try { inputSchema = JSON.parse(schema) }
    catch { setSection('parameters'); setError(t('custom_tools.parameter_invalid_json')); return }
    setBusy(true)
    setError('')
    try {
      await onSave({ ...draft, inputSchema, timeoutSeconds: Number(timeoutDraft) })
      onClose()
    } catch (reason) { setError(errorDetail(reason)) }
    finally { setBusy(false) }
  }
  return <>
    <Dialog.Root open onOpenChange={(open) => { if (!open) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content className="ui-dialog ui-dialog-wide ui-dialog-fixed-footer ui-dialog-centered ui-dialog-resizable ui-popover custom-tool-editor"
          onPointerDownOutside={(event) => event.preventDefault()}>
          <div className="custom-tool-editor-header ui-dialog-header-group ui-form-section">
            <header className="ui-dialog-header">
              <div className="ui-dialog-icon"><Wrench size={18} /></div>
              <div>
                <Dialog.Title className="ui-dialog-title">{t(tool ? 'custom_tools.edit' : 'custom_tools.add')}</Dialog.Title>
                <Dialog.Description className="ui-dialog-description">{t('custom_tools.editor_hint')}</Dialog.Description>
              </div>
            </header>
            <SegmentedControl<CustomToolEditorSection> ariaLabel={t('custom_tools.editor_section')} value={section} disabled={pending}
              options={[{ value: 'information', label: t('custom_tools.information') }, { value: 'parameters', label: t('custom_tools.parameter_form') }]}
              onChange={setSection} />
          </div>
          <div className="ui-dialog-body">
            <div hidden={section !== 'information'}>
              <fieldset className="ui-form-section" disabled={pending} aria-label={t('custom_tools.information')}>
                <label className="ui-field-stack"><span>{t('custom_tools.name')}</span><input className="ui-input" value={draft.name} maxLength={64} placeholder="submit_result" onChange={(event) => update({ name: event.target.value })} /></label>
                <label className="ui-field-stack"><span>{t('custom_tools.description')}</span>
                  <CommitTextarea className="ui-textarea ui-autosize-textarea" rows={3} data-min-rows={3} data-max-rows={5} value={draft.description}
                    onCommit={(description) => update({ description })} onDraftChange={(description) => update({ description })} />
                </label>
                <div className="ui-field-stack">
                  <div className="ui-toolbar ui-toolbar-between">
                    <label className="ui-field-label" htmlFor={commandId}>{t('custom_tools.command')}</label>
                    <button className="ui-icon-button" type="button" aria-label={t('custom_tools.command_help')}
                      data-tooltip={t('custom_tools.protocol_hint', { args: '{{args}}', tool_dir: '{{tool_dir}}' })}><CircleHelp size={14} /></button>
                  </div>
                  <CommitTextarea id={commandId} className="ui-textarea ui-code-textarea ui-autosize-textarea" rows={3} data-min-rows={3} data-max-rows={5} value={draft.command}
                    onCommit={(command) => update({ command })} onDraftChange={(command) => update({ command })} />
                </div>
                <div className="ui-grid-auto ui-grid-centered" style={{ '--ui-grid-min-width': '19em' } as CSSProperties}>
                  <div className="ui-row" data-tooltip={t('custom_tools.timeout_hint')}><label className="ui-field-label" htmlFor={timeoutId}>{t('custom_tools.timeout')}</label>
                    <CommitNumberInput id={timeoutId} className="ui-input-short" min={0} max={maxCommandTimeoutSeconds} step={1} disabled={pending}
                      placeholder={t('settings.max_model_calls_unlimited')} value={timeoutDraft} normalizeDraft={(value) => value === '0' ? '' : value}
                      onCommit={setTimeoutDraft} onDraftChange={setTimeoutDraft} />
                  </div>
                  <CheckboxField checked={draft.interactive} onChange={(interactive) => update({ interactive })} label={t('custom_tools.interactive')}
                    tooltip={t('custom_tools.interactive_hint')} />
                </div>
              </fieldset>
            </div>
            <div hidden={section !== 'parameters'} inert={busy}>
              <ToolParameters value={schema} onChange={setSchema} onBusyChange={setParameterBusy}
                onEditingChange={setParameterEditing} onDirtyChange={setParameterDirty} />
            </div>
            {error && <div role="alert" className="custom-tool-editor-error"><p className="ui-status-danger">{t('custom_tools.update_failed')}</p><pre className="ui-code-block">{error}</pre></div>}
          </div>
          <footer className="ui-dialog-footer">
            {parameterEditing && <button className="ui-link-button custom-tool-editor-pending" type="button" disabled={pending}
              onClick={() => setSection('parameters')}>{t('custom_tools.parameter_finish')}</button>}
            <button className="ui-button ui-button-compact" type="button" disabled={pending} onClick={close}><X size={14} />{t('common.cancel')}</button>
            <button className="ui-button ui-button-compact ui-button-primary" type="button" disabled={pending || parameterEditing} onClick={() => void save()}><Check size={14} />{t('common.save')}</button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <ConfirmDialog request={discard ? { title: t('settings.file_discard_title'), description: t('settings.file_discard_hint'), onConfirm: onClose } : undefined}
      onClose={() => setDiscard(false)} />
  </>
}
