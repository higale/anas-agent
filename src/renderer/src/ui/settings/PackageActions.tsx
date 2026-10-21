import { createPortal } from 'react-dom'
import { FolderDown, FolderInput, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'

/** Shared page actions for skills, tools, and subagent packages. */
export function PackageActions({ resource, destination, disabled, create, importLabel, onImport, addDirectory, target }: {
  resource: 'skill' | 'tool' | 'subagent'
  destination: string
  disabled?: boolean
  create?: { label: string; onClick(): void }
  importLabel: string
  onImport(): void
  addDirectory: { label: string; onClick(): void }
  target?: HTMLElement | null
}) {
  const { t } = useTranslation()
  const values = { resource: t(`settings.package_kind_${resource}`), destination }
  const actions = <>
    {create && <button className="ui-button" type="button" disabled={disabled}
      data-tooltip={t('settings.package_new_hint', values)} onClick={create.onClick}>
      <Plus size={14} aria-hidden="true" />{create.label}
    </button>}
    <button className="ui-button" type="button" disabled={disabled}
      data-tooltip={t('settings.package_import_hint', values)} onClick={onImport}>
      <FolderDown size={14} aria-hidden="true" />{importLabel}
    </button>
    <button className="ui-button" type="button" disabled={disabled}
      data-tooltip={t('settings.package_add_directory_hint', values)} onClick={addDirectory.onClick}>
      <FolderInput size={14} aria-hidden="true" />{addDirectory.label}
    </button>
  </>
  return target === undefined ? actions : target ? createPortal(actions, target) : null
}
