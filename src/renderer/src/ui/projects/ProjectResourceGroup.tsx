import type { ReactNode } from 'react'
import { FolderOpen, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { notice } from '../notice'
import { UI_ICON_SIZE_NAV, UI_ICON_SIZE_SMALL } from '../uiConstants'
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
  return <button type="button" className="ui-tool-button ui-tool-button-square" disabled={disabled}
    aria-label={label} data-tooltip={label} onClick={onAddDirectories}>
    <svg width={UI_ICON_SIZE_NAV} height={UI_ICON_SIZE_NAV} viewBox="0 -50 1138 1138" fill="currentColor" aria-hidden="true">
      <path d="M168.413867 119.466667a48.9472 48.9472 0 0 0-48.9472 48.9472v700.8256a48.9472 48.9472 0 0 0 48.9472 48.9472H969.386667a48.9472 48.9472 0 0 0 48.9472-48.9472V318.600533a48.9472 48.9472 0 0 0-48.9472-48.9472H518.826667a51.2 51.2 0 0 1-42.5984-22.801066L391.304533 119.466667H168.413867zM61.371733 61.44c28.398933-28.398933 66.901333-44.373333 107.042134-44.373333h250.2656a51.2 51.2 0 0 1 42.5984 22.801066L546.2016 167.253333H969.386667a151.3472 151.3472 0 0 1 151.3472 151.3472v550.638934A151.3472 151.3472 0 0 1 969.386667 1020.586667H168.413867A151.3472 151.3472 0 0 1 17.066667 869.239467V168.413867c0-40.1408 15.9744-78.6432 44.373333-107.042134z m507.426134 356.078933a51.2 51.2 0 0 1 51.2 51.2v98.986667h99.191466a51.2 51.2 0 0 1 0 102.4H619.997867v98.986667a51.2 51.2 0 0 1-102.4 0v-98.986667H418.816a51.2 51.2 0 1 1 0-102.4h98.781867v-98.986667a51.2 51.2 0 0 1 51.2-51.2z" />
    </svg>
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
export function ProjectResourceGroup<T extends { rootId: string }>({ kind, roots, items, disabled, onRemoveDirectory, renderItem, onSelectionChange, isAllSelected, selectionDisabled }: Omit<ProjectDirectoryControls, 'onAddDirectories'> & {
  kind: 'skill' | 'tool'
  roots: ResourceRoot[]
  items: T[]
  renderItem(item: T): ReactNode
  onSelectionChange?(items: T[], checked: boolean): void
  isAllSelected?(items: T[]): boolean
  selectionDisabled?: boolean
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
  return <>{roots.map((root, index) => <CapabilityResourceGroup key={root.id} divider={index === 0}
    label={`${t('settings.skill_group_project')} - ${root.name}`} ariaLabel={root.path} tooltip={root.path}
    inactiveReason={root.error}
    allSelected={isAllSelected?.(items.filter(item => item.rootId === root.id))}
    onSelectionChange={onSelectionChange ? checked => onSelectionChange(items.filter(item => item.rootId === root.id), checked) : undefined}
    selectionDisabled={disabled || selectionDisabled || !items.some(item => item.rootId === root.id)}
    count={items.filter(item => item.rootId === root.id).length} actions={rootActions(root)}>
    <div className="ui-grid-auto">{items.filter(item => item.rootId === root.id).map(renderItem)}</div>
  </CapabilityResourceGroup>)}</>
}
