import { ChevronDown, ChevronRight, File, FileCode2, Folder, FolderDown, FolderInput, Link2, RefreshCw, SquareChevronDown, SquareChevronRight } from 'lucide-react'
import type { ReactNode } from 'react'
import type { PackageFileNode, PackageFilePreview } from '@shared/packageFiles'

export function packageNodeKey(id: string, path = ''): string { return `${id}\0${path}` }

export function PackageTreeRoot({ name, count, expanded, selected, onClick, children, icon }: {
  name: string; count: number; expanded: boolean; selected: boolean; onClick(): void; children?: ReactNode; icon?: ReactNode
}) {
  return <div>
    <button className={`settings-skill-tree-row settings-skill-tree-root${selected ? ' active' : ''}`} type="button" aria-expanded={expanded} onClick={onClick}>
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
      {icon ?? <Folder size={15} />}<span className="settings-skill-tree-label">{name}</span><em>{count}</em>
    </button>
    {expanded && children}
  </div>
}

export function PackageTreeItem({ name, depth, selected, expanded, badge, linked, unavailable, highlighted, expandLabel, tooltip, onExpand, onSelect, onDoubleClick, children }: {
  name: string; depth: number; selected: boolean; expanded: boolean; badge?: string; linked?: boolean; unavailable?: boolean; highlighted?: boolean
  expandLabel: string; tooltip?: string; onExpand(): void; onSelect(): void; onDoubleClick?(): void; children?: ReactNode
}) {
  return <div>
    <div className={`settings-skill-tree-row settings-skill-tree-split${selected ? ' active' : ''}${unavailable ? ' settings-skill-tree-row-fully-unavailable' : ''}`} style={{ paddingLeft: 10 + depth * 16 }}>
      <button aria-expanded={expanded} aria-label={expandLabel} className="settings-skill-tree-toggle" type="button" onClick={onExpand}>
        {expanded ? <SquareChevronDown size={14} /> : <SquareChevronRight size={14} />}
      </button>
      <button className="settings-skill-tree-select" type="button" aria-pressed={selected} data-tooltip={tooltip}
        aria-label={tooltip ? [name, badge, tooltip].filter(Boolean).join(' · ') : undefined} onClick={onSelect} onDoubleClick={onDoubleClick}>
        {linked ? <Link2 size={14} /> : <Folder size={14} />}<span className={`settings-skill-tree-label${highlighted ? ' ui-text-success' : ''}`}>{name}</span>
        {badge && <em>{badge}</em>}
      </button>
    </div>
    {expanded && children}
  </div>
}

export function PackageFileTree({ packageId, parentPath, depth = 0, childrenByKey, expanded, selectedPath, onSelect }: {
  packageId: string; parentPath?: string; depth?: number; childrenByKey: Record<string, PackageFileNode[]>; expanded: Set<string>
  selectedPath?: string; onSelect(file: PackageFileNode): void
}): ReactNode {
  return (childrenByKey[packageNodeKey(packageId, parentPath)] ?? []).map(file => {
    const expandable = file.kind === 'directory' || file.linkDirectory
    const isExpanded = expanded.has(`files:${packageNodeKey(packageId, file.relativePath)}`)
    const Icon = file.kind === 'symlink' ? Link2 : expandable ? Folder : file.kind === 'text' ? FileCode2 : File
    return <div key={file.relativePath}>
      <button className={`settings-skill-tree-row${selectedPath === file.relativePath ? ' active' : ''}`} style={{ paddingLeft: 10 + depth * 16 }} type="button" onClick={() => onSelect(file)}>
        {expandable ? (isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />) : <span className="settings-skill-tree-spacer" />}
        <Icon size={14} /><span className="settings-skill-tree-label">{file.name}</span>
      </button>
      {expandable && isExpanded && <PackageFileTree {...{ packageId, childrenByKey, expanded, selectedPath, onSelect }} parentPath={file.relativePath} depth={depth + 1} />}
    </div>
  })
}

export function PackageFileViewer({ preview, file, openButton, t }: {
  preview?: PackageFilePreview; file?: PackageFileNode; openButton(path: string, disabled?: boolean): ReactNode; t(key: string): string
}) {
  if (preview) return <>
    <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between"><div><strong>{preview.name}</strong><small>{preview.relativePath}</small></div><div className="ui-row"><small>{preview.size} B</small>{openButton(preview.path)}</div></div>
    {preview.linkTarget && <div className="ui-note"><Link2 size={14} /> {preview.linkTarget} → {preview.resolvedPath}</div>}
    {preview.kind === 'text' ? <pre className="settings-skill-file-content">{preview.content}</pre> : <div className="ui-empty-state">{t('settings.skill_binary_preview_unavailable')}</div>}
  </>
  if (!file) return null
  return <>
    <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between"><div><strong>{file.name}</strong><small>{file.relativePath}</small></div>{openButton(file.path, file.kind === 'symlink' && !file.resolvedPath)}</div>
    {file.linkTarget && <div className="ui-note"><Link2 size={14} /> {file.linkTarget} → {file.resolvedPath ?? t('settings.skill_link_unavailable')}</div>}
    <div className="ui-empty-state">{t(file.kind === 'directory' || file.linkDirectory ? 'settings.skill_directory_preview' : 'settings.skill_file_preview_unavailable')}</div>
  </>
}

export function PackageSourceActions({ addLabel, importLabel, refreshLabel, disabled, onAdd, onImport, onRefresh }: {
  addLabel: string; importLabel: string; refreshLabel: string; disabled?: boolean
  onAdd(): void; onImport?: () => void; onRefresh(): void
}) {
  return <div className="ui-list-pane-header">
    <div className="ui-toolbar ui-toolbar-between">
      <button className="ui-button ui-button-compact" type="button" disabled={disabled} onClick={onAdd}><FolderInput size={14} />{addLabel}</button>
      <div className="ui-row">
        {onImport && <button className="ui-tool-button ui-tool-button-small" type="button" disabled={disabled} aria-label={importLabel} data-tooltip={importLabel} onClick={onImport}><FolderDown size={14} /></button>}
        <button className="ui-tool-button ui-tool-button-small" type="button" disabled={disabled} aria-label={refreshLabel} data-tooltip={refreshLabel} onClick={onRefresh}><RefreshCw size={14} /></button>
      </div>
    </div>
  </div>
}
