import type { ReactNode } from 'react'
import { FolderOpen, Plus, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { notice } from '../notice'
import { UI_ICON_SIZE_SMALL } from '../uiConstants'
import { CapabilityResourceGroup } from '../CapabilityResourceGroup'

interface ResourceRoot { id: string; name: string; path: string; available: boolean; error?: string }
export interface ProjectDirectoryControls {
  disabled?: boolean
  onAddDirectories(): void
  onRemoveDirectory(path: string): void
}

export function ProjectDirectoryAddButton({ kind, disabled, onAddDirectories }: Pick<ProjectDirectoryControls, 'disabled' | 'onAddDirectories'> & { kind: 'skill' | 'tool' }) {
  const { t } = useTranslation()
  const label = t(`project.add_${kind}_directories`)
  return <button type="button" className="ui-icon-button" disabled={disabled}
    aria-label={label} data-tooltip={label} onClick={onAddDirectories}>
    <Plus size={UI_ICON_SIZE_SMALL} aria-hidden="true" />
  </button>
}

function ResourceFolder({ root, kind }: { root: ResourceRoot; kind: 'skill' | 'tool' }) {
  const { t } = useTranslation()
  const label = t(`project.open_${kind}s_folder`)
  async function openFolder(): Promise<void> {
    try {
      await window.gale.files.openDirectory(root.path)
    } catch {
      notice.error(t(`project.failed_open_${kind}s_folder`))
    }
  }
  return <button className="ui-icon-button" type="button" aria-label={label}
    data-tooltip={label + '\n' + root.path} disabled={!root.available} onClick={() => void openFolder()}>
    <FolderOpen size={UI_ICON_SIZE_SMALL} aria-hidden="true" />
  </button>
}

/** Project references share directory actions; resource rows keep their own controls. */
export function ProjectResourceGroup<T extends { rootId: string }>({ kind, roots, items, disabled, onRemoveDirectory, renderItem }: Omit<ProjectDirectoryControls, 'onAddDirectories'> & {
  kind: 'skill' | 'tool'
  roots: ResourceRoot[]
  items: T[]
  renderItem(item: T): ReactNode
}) {
  const { t } = useTranslation()
  function rootActions(root: ResourceRoot) {
    return <>
      <ResourceFolder root={root} kind={kind} />
      <button type="button" className="ui-icon-button" disabled={disabled}
        aria-label={t(`project.remove_${kind}_directory`)} data-tooltip={t(`project.remove_${kind}_directory`)} onClick={() => onRemoveDirectory(root.path)}>
        <X size={UI_ICON_SIZE_SMALL} aria-hidden="true" />
      </button>
    </>
  }
  return <>{roots.map(root => <CapabilityResourceGroup key={root.id}
    label={`${t('settings.skill_group_project')} - ${root.name}`} ariaLabel={root.path} tooltip={root.path}
    count={items.filter(item => item.rootId === root.id).length} actions={rootActions(root)}>
    {root.error && <div role="alert" className="ui-field-hint ui-status-danger">{root.path}: {root.error}</div>}
    {items.filter(item => item.rootId === root.id).map(renderItem)}
  </CapabilityResourceGroup>)}</>
}
