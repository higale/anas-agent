import * as Dialog from '@radix-ui/react-dialog'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Check, Maximize2, Minimize2, WrapText, X } from 'lucide-react'
import type { PackageFilePreview, PackageFileUpdate } from '@shared/packageFiles'
import { errorDetail } from '@shared/recovery'
import { CodeFileEditor } from '../CodeFileEditor'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { SelectableIconButton } from '../SelectableIconButton'

export function PackageFileEditDialog({ preview, onSave, onClose }: {
  preview: PackageFilePreview; onSave(update: PackageFileUpdate): Promise<void>; onClose(): void
}) {
  const { t } = useTranslation()
  const [draft, setDraft] = useState(preview.content ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const [wordWrap, setWordWrap] = useState(true)
  const [maximized, setMaximized] = useState(false)
  const dirty = draft !== preview.content
  function close() { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
  async function save() {
    setBusy(true); setError('')
    try {
      await onSave({ content: draft, revision: preview.revision!, resolvedPath: preview.resolvedPath })
      onClose()
    } catch (reason) { setError(errorDetail(reason)) }
    finally { setBusy(false) }
  }
  return <>
    <Dialog.Root open onOpenChange={open => { if (!open) close() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content className="ui-dialog ui-dialog-wide ui-dialog-centered ui-dialog-resizable ui-popover settings-file-edit-dialog" data-maximized={maximized} onPointerDownOutside={event => event.preventDefault()}>
          <header className="ui-toolbar ui-toolbar-between">
            <Dialog.Title className="ui-dialog-title">{preview.name}</Dialog.Title>
            <div className="ui-row">
              <SelectableIconButton Icon={WrapText} iconSize={16} label={t('settings.auto_wrap')} pressed={wordWrap} onClick={() => setWordWrap(value => !value)} />
              <SelectableIconButton Icon={Maximize2} PressedIcon={Minimize2} iconSize={16} label={t(maximized ? 'settings.file_restore_size' : 'settings.file_maximize')} pressed={maximized} onClick={() => setMaximized(value => !value)} />
            </div>
          </header>
          <Dialog.Description className="ui-dialog-description">{preview.resolvedPath}</Dialog.Description>
          <div className="settings-file-edit-body" inert={busy}><CodeFileEditor path={preview.path} content={preview.content ?? ''} onChange={setDraft} wordWrap={wordWrap} /></div>
          {error && <div role="alert" className="ui-note ui-note-danger">
            <p>{t('settings.file_save_failed')}</p><pre className="ui-code-block ui-code-block-compact">{error}</pre>
          </div>}
          <footer className="ui-dialog-footer">
            <button className="ui-button" type="button" disabled={busy} onClick={close}><X size={14} />{t('common.cancel')}</button>
            <button className="ui-button ui-button-primary" type="button" disabled={busy || !dirty} onClick={() => void save()}><Check size={14} />{t('common.save')}</button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    <ConfirmDialog request={discard ? {
      title: t('settings.file_discard_title'), description: t('settings.file_discard_hint'),
      onConfirm: onClose
    } : undefined} onClose={() => setDiscard(false)} />
  </>
}
