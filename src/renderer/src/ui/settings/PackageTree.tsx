import { ArrowDown, ArrowUp, Box, ChevronRight, File, FileCode2, Folder, FolderInput, Link2, Pencil, RefreshCw, SquareChevronDown, SquareChevronRight, UserRound } from 'lucide-react'
import { useRef, useState, type ReactNode } from 'react'
import type { PackageFileNode, PackageFilePreview, PackageFileUpdate } from '@shared/packageFiles'
import { CodeFileEditor } from '../CodeFileEditor'
import { SegmentedControl } from '../SegmentedControl'
import { PackageFileEditDialog } from './PackageFileEditDialog'
import { MarkdownText } from '../chat/MarkdownText'
import { localFilePathFromHref } from '../chat/localFileLinks'

export function packageNodeKey(id: string, path = ''): string { return `${id}\0${path}` }

export function PackageList({ items, label, emptyLabel, onSelect }: {
  items: readonly { id: string; name: string; description?: string; detail?: string; status?: string }[]
  label: string; emptyLabel: string; onSelect(id: string): void
}) {
  if (!items.length) return <div className="ui-empty-state ui-empty-state-compact">{emptyLabel}</div>
  return <div className="ui-list ui-list-compact" role="list" aria-label={label}>
    {items.map(item => <div role="listitem" key={item.id}>
      <button className="ui-list-item ui-list-item-split" type="button" onClick={() => onSelect(item.id)}>
        <span>
          <strong>{item.name}</strong>
          {item.description && <small>{item.description}</small>}
          {item.detail && <small>{item.detail}</small>}
          {item.status && <small>{item.status}</small>}
        </span>
        <ChevronRight size={14} aria-hidden="true" />
      </button>
    </div>)}
  </div>
}

export function PackageTreeRoot({ name, count, expanded, selected, onSelect, onExpand, expandLabel, children, icon, source }: {
  name: string; count: number; expanded: boolean; selected: boolean; onSelect(): void; onExpand(): void; expandLabel: string; children?: ReactNode; icon?: ReactNode
  source?: 'system' | 'user' | 'project' | 'external'
}) {
  const SourceIcon = source === 'system' ? Box : source === 'user' ? UserRound : Folder
  return <div>
    <div className={`settings-skill-tree-row settings-skill-tree-split settings-skill-tree-root${selected ? ' active' : ''}`}>
      <button className="settings-skill-tree-toggle" type="button" aria-expanded={expanded} aria-label={expandLabel} onClick={onExpand}>
        {expanded ? <SquareChevronDown size={14} /> : <SquareChevronRight size={14} />}
      </button>
      <button className="settings-skill-tree-select" type="button" aria-pressed={selected} onClick={onSelect}>
        {icon ?? <SourceIcon size={15} className="settings-package-source-icon" data-source={source} aria-hidden="true" />}<span className="settings-skill-tree-label">{name}</span><em>{count}</em>
      </button>
    </div>
    {expanded && children}
  </div>
}

export function PackageTreeItem({ name, icon, depth, selected, expanded, badge, linked, unavailable, highlighted, expandLabel, tooltip, onExpand, onSelect, onDoubleClick, children }: {
  name: string; icon: ReactNode; depth: number; selected: boolean; expanded: boolean; badge?: string; linked?: boolean; unavailable?: boolean; highlighted?: boolean
  expandLabel: string; tooltip?: string; onExpand(): void; onSelect(): void; onDoubleClick?(): void; children?: ReactNode
}) {
  return <div>
    <div className={`settings-skill-tree-row settings-skill-tree-split${selected ? ' active' : ''}${unavailable ? ' settings-skill-tree-row-fully-unavailable' : ''}`} style={{ paddingLeft: 10 + depth * 16 }}>
      <button aria-expanded={expanded} aria-label={expandLabel} className="settings-skill-tree-toggle" type="button" onClick={onExpand}>
        {expanded ? <SquareChevronDown size={14} /> : <SquareChevronRight size={14} />}
      </button>
      <button className="settings-skill-tree-select" type="button" aria-pressed={selected} data-tooltip={tooltip}
        aria-label={tooltip ? [name, badge, tooltip].filter(Boolean).join(' · ') : undefined} onClick={onSelect} onDoubleClick={onDoubleClick}>
        {linked ? <Link2 size={14} /> : icon}<span className={`settings-skill-tree-label${highlighted ? ' ui-text-success' : ''}`}>{name}</span>
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
      <button className={`settings-skill-tree-row${selectedPath === file.relativePath ? ' active' : ''}`} aria-current={selectedPath === file.relativePath ? 'true' : undefined} style={{ paddingLeft: 10 + depth * 16 }} type="button" onClick={() => onSelect(file)}>
        {expandable ? (isExpanded ? <SquareChevronDown size={14} /> : <SquareChevronRight size={14} />) : <span className="settings-skill-tree-spacer" />}
        <Icon size={14} /><span className="settings-skill-tree-label">{file.name}</span>
      </button>
      {expandable && isExpanded && <PackageFileTree {...{ packageId, childrenByKey, expanded, selectedPath, onSelect }} parentPath={file.relativePath} depth={depth + 1} />}
    </div>
  })
}

export function PackageFileViewer({ preview, file, onOpen, t, onSave }: {
  preview?: PackageFilePreview; file?: PackageFileNode; onOpen(path: string): void | Promise<void>; t(key: string): string
  onSave?(update: PackageFileUpdate): Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [source, setSource] = useState(false)
  const markdown = preview?.kind === 'text' && /\.(md|markdown)$/i.test(preview.name)
  if (preview) return <>
    <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between"><div><button className="ui-link-button" type="button" data-tooltip={t('chat.show_in_folder')} onClick={() => void onOpen(preview.path)}>{preview.relativePath}</button></div><div className="ui-row">
      {preview.kind === 'text' && preview.editable && preview.revision && onSave && <button className="ui-icon-button" type="button" aria-label={t('common.edit')} data-tooltip={t('common.edit')} onClick={() => setEditing(true)}><Pencil size={14} /></button>}
      {markdown && <SegmentedControl ariaLabel={t('settings.file_view_mode')} value={source ? 'source' : 'preview'}
        options={[{ value: 'preview', label: t('settings.file_preview') }, { value: 'source', label: t('settings.file_source') }]}
        onChange={value => setSource(value === 'source')} />}
    </div></div>
    {preview.linkTarget && <div className="ui-note"><Link2 size={14} /> {preview.linkTarget} → {preview.resolvedPath}</div>}
    {markdown && !source ? <PackageMarkdownPreview preview={preview} t={t} /> : preview.kind === 'text' ? <CodeFileEditor key={`${preview.path}:${preview.revision ?? preview.content}`} path={preview.path} content={preview.content ?? ''} /> : <div className="ui-empty-state">{t('settings.skill_binary_preview_unavailable')}</div>}
    {editing && onSave && <PackageFileEditDialog preview={preview} onSave={onSave} onClose={() => setEditing(false)} />}
  </>
  if (!file) return null
  return <>
    <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between"><div><button className="ui-link-button" type="button" data-tooltip={t('chat.show_in_folder')} disabled={file.kind === 'symlink' && !file.resolvedPath} onClick={() => void onOpen(file.path)}>{file.relativePath}</button></div></div>
    {file.linkTarget && <div className="ui-note"><Link2 size={14} /> {file.linkTarget} → {file.resolvedPath ?? t('settings.skill_link_unavailable')}</div>}
    <div className="ui-empty-state">{t(file.kind === 'directory' || file.linkDirectory ? 'settings.skill_directory_preview' : 'settings.skill_file_preview_unavailable')}</div>
  </>
}

function PackageMarkdownPreview({ preview, t }: { preview: PackageFilePreview; t(key: string): string }) {
  const root = useRef<HTMLDivElement>(null)
  const text = preview.content ?? ''
  const metadata = /^\uFEFF?---[ \t]*\r?\n((?:[^\n]*\n)*?)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text)
  return <div className="settings-package-markdown" ref={root}>
    {metadata && <details className="settings-package-metadata"><summary>{t('settings.file_metadata')}</summary><pre>{metadata[1].trimEnd()}</pre></details>}
    <MarkdownText text={metadata ? text.slice(metadata[0].length) : text} documentPath={preview.resolvedPath} onNavigate={async href => {
      if (href.startsWith('#')) {
        const id = `document-${decodeURIComponent(href.slice(1))}`
        Array.from(root.current?.querySelectorAll<HTMLElement>('[id]') ?? []).find(element => element.id === id)?.scrollIntoView({ block: 'start' })
      } else {
        const path = localFilePathFromHref(href)
        if (path) await window.gale.files.showItemInFolder(path)
        else await window.gale.app.openExternalUrl(href)
      }
    }} />
  </div>
}

export function PackageSourceActions({ addLabel, refreshLabel, moveUpLabel, moveDownLabel, disabled, onAdd, onRefresh, onMoveUp, onMoveDown }: {
  addLabel: string; refreshLabel: string; moveUpLabel: string; moveDownLabel: string; disabled?: boolean
  onAdd(): void; onRefresh(): void; onMoveUp?: () => void; onMoveDown?: () => void
}) {
  return <div className="ui-list-pane-header">
    <div className="ui-toolbar ui-toolbar-between">
      <button className="ui-button ui-button-compact" type="button" disabled={disabled} onClick={onAdd}><FolderInput size={14} />{addLabel}</button>
      <div className="ui-row">
        <button className="ui-icon-button" type="button" disabled={disabled || !onMoveUp} aria-label={moveUpLabel} data-tooltip={moveUpLabel} onClick={onMoveUp}><ArrowUp size={14} /></button>
        <button className="ui-icon-button" type="button" disabled={disabled || !onMoveDown} aria-label={moveDownLabel} data-tooltip={moveDownLabel} onClick={onMoveDown}><ArrowDown size={14} /></button>
        <button className="ui-icon-button" type="button" disabled={disabled} aria-label={refreshLabel} data-tooltip={refreshLabel} onClick={onRefresh}><RefreshCw size={14} /></button>
      </div>
    </div>
  </div>
}
