import * as Dialog from '@radix-ui/react-dialog'
import { useCallback, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { usePanelCheckpoint, usePanelState } from '../agent/PanelViewState'
import { useTranslation } from 'react-i18next'
import { Check, Maximize2, Minimize2, WrapText, X } from 'lucide-react'
import type { PackageFilePreview, PackageFileUpdate } from '@shared/packageFiles'
import { errorDetail } from '@shared/recovery'
import { CodeFileEditor } from '../CodeFileEditor'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { notice } from '../notice'
import { SelectableIconButton } from '../SelectableIconButton'

export function PackageFileEditDialog({ preview, onSave, onClose, saveDisabled, savedContent, review, inlineDraft }: {
  preview: PackageFilePreview; onSave(update: PackageFileUpdate): Promise<void | 'conflict'>; onClose(): void
  saveDisabled?: boolean; savedContent?: string; review?: ReactNode
  inlineDraft?: { text: string; onChange(text: string): void }
}) {
  const { t } = useTranslation()
  const [localDraft, setDraft] = useState(preview.content ?? '')
  const draft = inlineDraft?.text ?? localDraft
  // Dock the same editor in either view so resizing preserves Monaco's selection and undo history.
  const [editorHost] = useState(() => {
    if (!inlineDraft) return null
    const host = document.createElement('div')
    host.className = 'settings-file-edit-body'
    return host
  })
  const attachEditor = useCallback((slot: HTMLDivElement | null) => {
    if (slot && editorHost) slot.appendChild(editorHost)
  }, [editorHost])
  const pending = useRef<Promise<void> | undefined>(undefined)
  const saved = useRef(false)
  usePanelCheckpoint(async reason => {
    if (pending.current) {
      await pending.current
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
    }
    if (reason === 'close' && !saved.current && draft !== (savedContent ?? preview.content)) {
      notice.info(t('settings.memory_finish_edit'))
      return false
    }
  })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [discard, setDiscard] = useState(false)
  const [wordWrap, setWordWrap] = usePanelState('fileEditWrap', true)
  const [maximized, setMaximized] = useState(false)
  const dirty = draft !== preview.content
  function close() { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
  async function save() {
    setBusy(true); setError('')
    try {
      const result = await onSave({ content: draft, revision: preview.revision!, resolvedPath: preview.resolvedPath })
      if (result !== 'conflict') { saved.current = true; onClose() }
    } catch (reason) { setError(errorDetail(reason)) }
    finally { setBusy(false) }
  }
  const inline = Boolean(inlineDraft) && !maximized
  const Title = inline ? 'h3' : Dialog.Title
  const Description = inline ? 'p' : Dialog.Description
  const editor = <CodeFileEditor path={preview.path} content={inlineDraft?.text ?? preview.content ?? ''} onChange={inlineDraft?.onChange ?? setDraft} wordWrap={wordWrap} />
  const body = <>
    <header className="ui-toolbar ui-toolbar-between">
      <Title className="ui-dialog-title">{preview.name}</Title>
      <div className="ui-row">
        <SelectableIconButton Icon={WrapText} iconSize={16} label={t('settings.auto_wrap')} pressed={wordWrap} onClick={() => setWordWrap(value => !value)} />
        <SelectableIconButton Icon={Maximize2} PressedIcon={Minimize2} iconSize={16} label={t(maximized ? 'settings.file_restore_size' : 'settings.file_maximize')} pressed={maximized} onClick={() => setMaximized(value => !value)} />
      </div>
    </header>
    <Description className="ui-dialog-description">{preview.resolvedPath}</Description>
    {review}
    <div className="settings-file-edit-body" inert={busy} ref={attachEditor}>{editorHost ? null : editor}</div>
    {error && <div role="alert" className="ui-note ui-note-danger">
      <p>{t('settings.file_save_failed')}</p><pre className="ui-code-block ui-code-block-compact">{error}</pre>
    </div>}
    <footer className="ui-dialog-footer">
      <button className="ui-button" type="button" disabled={busy} onClick={close}><X size={14} />{t('common.cancel')}</button>
      <button className="ui-button ui-button-primary" type="button" disabled={busy || saveDisabled || draft === (savedContent ?? preview.content)} onClick={() => { pending.current = save().finally(() => { pending.current = undefined }) }}><Check size={14} />{t('common.save')}</button>
    </footer>
  </>
  return <>
    {editorHost && createPortal(editor, editorHost)}
    {inline ? <section className="settings-inline-file-editor" aria-label={preview.name}>{body}</section> : <Dialog.Root open onOpenChange={open => {
      if (!open && inlineDraft) setMaximized(false)
      else if (!open) close()
    }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content className="ui-dialog ui-dialog-wide ui-dialog-centered ui-dialog-resizable ui-popover settings-file-edit-dialog" data-maximized={maximized} onPointerDownOutside={event => event.preventDefault()}>{body}</Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>}
    <ConfirmDialog request={discard ? {
      title: t('settings.file_discard_title'), description: t('settings.file_discard_hint'),
      onConfirm: onClose
    } : undefined} onClose={() => setDiscard(false)} />
  </>
}
