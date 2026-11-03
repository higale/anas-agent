import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { PreferenceFile } from '@shared/preferenceMemory'
import type { PackageFilePreview } from '@shared/packageFiles'
import { PackageFileViewer } from './settings/PackageTree'
import { PackageFileEditDialog } from './settings/PackageFileEditDialog'
import { contentServices } from './panels/contentServices'
import { usePanelDraft, usePanelReady } from './agent/PanelViewState'

export function PreferenceMemoryDocument({ projectId }: { projectId?: string }) {
  const { t } = useTranslation()
  const [document, setDocument] = useState<PreferenceFile>()
  const [edit, setEdit] = usePanelDraft<{ initial: PackageFilePreview; base: string; text: string }>('memoryEdit')
  const revision = useRef(0)
  const refreshAfterWrite = useRef<() => void>(undefined)
  const [readError, setReadError] = useState('')
  usePanelReady(Boolean(document), Boolean(readError))
  useEffect(() => {
    let active = true
    function refresh() {
      const request = ++revision.current
      void contentServices().preferences.read(projectId ? { kind: 'project', projectId } : { kind: 'global' }).then(value => {
        if (active && request === revision.current) { setDocument(value); setReadError('') }
      }, reason => { if (active && request === revision.current) setReadError(String(reason)) })
    }
    const stop = contentServices().preferences.onChanged(refresh)
    refreshAfterWrite.current = refresh
    refresh()
    return () => { active = false; refreshAfterWrite.current = undefined; stop() }
  }, [projectId])

  const preview: PackageFilePreview | undefined = document && {
    name: 'MEMORY.md', relativePath: 'MEMORY.md', kind: 'text', path: document.path, resolvedPath: document.path,
    revision: document.hash, content: document.content, editable: !readError,
    size: new TextEncoder().encode(document.content).length
  }
  const conflict = edit && document && edit.base !== document.hash
  return <div className="ui-form-section">
    {readError && <p role="alert">{readError}</p>}
    {!document && !readError && <span role="status" className="ui-field-hint">{t('common.loading')}</span>}
    {preview && document && <div hidden={Boolean(edit)} className={edit ? undefined : 'ui-form-section memory-file-view'}>
      <PackageFileViewer preview={preview} t={t} foldMetadata={false} emptyText={t('settings.memory_document_empty')}
        onEdit={() => setEdit({ initial: preview, base: document.hash, text: document.content })} />
    </div>}
    {edit && document && <PackageFileEditDialog preview={edit.initial} onClose={() => setEdit(current => current === edit ? undefined : current)}
      inlineDraft={{ text: edit.text, onChange: text => setEdit(current => current && { ...current, text }) }}
      savedContent={document.content} saveDisabled={Boolean(conflict || readError)}
      review={readError ? <p role="alert">{readError}</p> : conflict && <div role="alert" className="ui-note">
        <p>{t('settings.memory_conflict')}</p>
        <pre className="ui-code-block ui-code-block-compact">{document.content || t('settings.memory_document_empty')}</pre>
        <button type="button" className="ui-button" onClick={() => setEdit({ ...edit, base: document.hash })}>{t('settings.memory_reviewed')}</button>
      </div>}
      onSave={async ({ content }) => {
        const beforeSave = ++revision.current
        const result = await contentServices().preferences.save(document.scope, edit.base, content)
        setDocument(result.document)
        // An intervening notification may describe a later publication than this IPC response.
        if (revision.current !== beforeSave) refreshAfterWrite.current?.()
        if (result.status === 'conflict') return 'conflict'
      }} />}
  </div>
}
