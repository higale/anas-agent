import { errorDetail } from '@shared/recovery'
import { FolderOpen, ListTree, Pencil, Plus, Trash2 } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppConfigSnapshot } from '@shared/types'
import type { ToolPackage, ToolRoot, ToolSnapshot } from '@shared/toolPackages'
import type { PackageFileNode, PackageFilePreview } from '@shared/packageFiles'
import { CustomToolEditor } from './CustomToolEditor'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { notice } from '../notice'
import { PackageSourceActions, PackageTreeRoot, PackageTreeItem, PackageFileTree, PackageFileViewer, packageNodeKey } from './PackageTree'

type Selection = { kind: 'all' } | { kind: 'root'; id: string } | { kind: 'tool'; id: string } | { kind: 'file'; id: string; file: PackageFileNode }

export function CustomToolsGroup({ tools, onConfigChange, catalogNavigation, catalogView, onSelectCustom }: {
  tools: ToolPackage[]; onConfigChange(config: AppConfigSnapshot): void
  catalogNavigation?: ReactNode; catalogView?: ReactNode; onSelectCustom?(): void
}) {
  const { t } = useTranslation()
  const [snapshot, setSnapshot] = useState<ToolSnapshot>()
  const [selection, setSelection] = useState<Selection>()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [children, setChildren] = useState<Record<string, PackageFileNode[]>>({})
  const [preview, setPreview] = useState<PackageFilePreview>()
  const [editing, setEditing] = useState<ToolPackage | 'new'>()
  const [deleting, setDeleting] = useState<ToolPackage>()
  const [removing, setRemoving] = useState<ToolRoot>()
  const [nameDraft, setNameDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const request = useRef(0)
  const selected = selection && 'id' in selection ? snapshot?.tools.find(tool => tool.id === selection.id) : undefined
  const root = selection?.kind === 'root' ? snapshot?.roots.find(root => root.id === selection.id) : undefined
  const showImport = !catalogView && (root?.source === 'user' || selected?.source === 'user')
  const external = snapshot?.roots.filter(root => root.source === 'external') ?? []
  const rootIndex = external.findIndex(item => item.id === root?.id)
  const peers = snapshot?.tools.filter(tool => tool.rootId === selected?.rootId) ?? []
  const index = peers.findIndex(tool => tool.id === selected?.id)
  const roots = [...(snapshot?.roots ?? [])].sort((a, b) => ({ system: 0, user: 1, project: 2, external: 3 }[a.source] - { system: 0, user: 1, project: 2, external: 3 }[b.source]))
  const rootLabel = (root: ToolRoot) => root.source === 'system' || root.source === 'user' ? t(`settings.skill_group_${root.source}`) : root.name

  useEffect(() => {
    let active = true
    const pendingRequest = request
    void window.gale.tools.get().then(value => {
      if (!active) return
      setSnapshot(value); setChildren({}); setPreview(undefined); request.current++; setError('')
    }).catch(reason => { if (active) setError(errorDetail(reason)) })
    return () => { active = false; pendingRequest.current++ }
  }, [tools])

  async function refresh() {
    const value = await window.gale.tools.get()
    setSnapshot(value); setChildren({}); setPreview(undefined); request.current++
    onConfigChange(await window.gale.tools.refresh())
  }
  async function mutate(action: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { if (await action() !== false) await refresh() }
    catch (reason) { setError(errorDetail(reason)) }
    finally { setBusy(false) }
  }
  function toggle(key: string) {
    setExpanded(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }
  function select(value: Selection) {
    request.current++; setPreview(undefined); setSelection(value); onSelectCustom?.()
    if (value.kind === 'tool') setExpanded(current => current.has('all') ? current : new Set([...current, snapshot?.tools.find(tool => tool.id === value.id)?.rootId ?? 'user']))
  }
  async function expandFiles(id: string, path?: string) {
    const revision = request.current
    try {
      const key = packageNodeKey(id, path)
      if (!children[key]) {
        const items = await window.gale.tools.listFiles(id, path)
        if (request.current !== revision) return
        setChildren(current => ({ ...current, [key]: items }))
      }
      toggle(`files:${key}`)
    } catch (reason) { setError(errorDetail(reason)) }
  }
  async function selectFile(id: string, file: PackageFileNode) {
    select({ kind: 'file', id, file })
    if (file.kind === 'directory' || file.linkDirectory) { await expandFiles(id, file.relativePath); return }
    const revision = request.current
    try {
      const value = await window.gale.tools.readFile(id, file.relativePath)
      if (revision === request.current) setPreview(value)
    } catch (reason) { if (revision === request.current) setError(errorDetail(reason)) }
  }
  function renderTool(tool: ToolPackage, showSource = false) {
    const isExpanded = expanded.has(`files:${packageNodeKey(tool.id)}`)
    return <PackageTreeItem key={tool.id} name={tool.name} depth={1} selected={selection?.kind === 'tool' && selection.id === tool.id && !catalogView}
      expanded={isExpanded} unavailable={Boolean(tool.error)} badge={[showSource ? rootLabel(roots.find(root => root.id === tool.rootId)!) : '', tool.error ? t('capabilities.inactive') : ''].filter(Boolean).join(' · ')}
      expandLabel={t(isExpanded ? 'custom_tools.collapse' : 'custom_tools.expand', { name: tool.name })}
      onExpand={() => void expandFiles(tool.id)} onSelect={() => select({ kind: 'tool', id: tool.id })}
      onDoubleClick={() => { if (tool.source === 'user' && tool.definition) setEditing(tool) }}>
      <PackageFileTree packageId={tool.id} depth={2} childrenByKey={children} expanded={expanded}
        selectedPath={selection?.kind === 'file' && selection.id === tool.id ? selection.file.relativePath : undefined}
        onSelect={file => void selectFile(tool.id, file)} />
    </PackageTreeItem>
  }
  function openButton(path: string, disabled = false) {
    return <button className="ui-button ui-button-compact" type="button" disabled={disabled} onClick={() => {
      void window.gale.files.showItemInFolder(path).catch(reason => setError(errorDetail(reason)))
    }}><FolderOpen size={14} />{t('common.open')}</button>
  }
  async function importDirectories() {
    const result = await window.gale.tools.importDirectories()
    if (result.status === 'cancelled') return false
    if (result.status === 'error') throw new Error(t(`custom_tools.import_error_${result.error.code}`, { name: result.error.name }) + (result.error.detail ? `: ${result.error.detail}` : ''))
    onConfigChange(result.config)
    select({ kind: 'tool', id: result.ids[0] })
    notice.success(t('custom_tools.imported', { count: result.ids.length }))
  }

  return <>
    <div className="ui-list-pane">
      <div className="ui-scroll-list settings-skill-tree">
        {catalogNavigation && <nav className="settings-tool-navigation" aria-label={t('settings.tools_page')}>{catalogNavigation}</nav>}
        <PackageSourceActions addLabel={t('custom_tools.add_directory')} importLabel={t('custom_tools.import')} refreshLabel={t('common.refresh')} disabled={busy}
          onAdd={() => void mutate(async () => (await window.gale.tools.addDirectory()).status !== 'cancelled')}
          onImport={showImport ? () => void mutate(importDirectories) : undefined} onRefresh={() => void mutate(async () => {})} />
        <PackageTreeRoot name={t('custom_tools.all')} count={snapshot?.tools.length ?? 0} expanded={expanded.has('all')} selected={!catalogView && selection?.kind === 'all'} icon={<ListTree size={15} />}
          onClick={() => { select({ kind: 'all' }); toggle('all') }}>{snapshot?.tools.map(tool => renderTool(tool, true))}</PackageTreeRoot>
        {roots.map(root => <PackageTreeRoot key={root.id} name={rootLabel(root)} count={snapshot?.tools.filter(tool => tool.rootId === root.id).length ?? 0}
          expanded={expanded.has(root.id)} selected={!catalogView && selection?.kind === 'root' && selection.id === root.id}
          onClick={() => { select({ kind: 'root', id: root.id }); setNameDraft(root.name); toggle(root.id) }}>
          {snapshot?.tools.filter(tool => tool.rootId === root.id).map(tool => renderTool(tool))}
        </PackageTreeRoot>)}
        {error && <div role="alert" className="ui-note ui-note-danger">{error}</div>}
      </div>
    </div>
    <div className="ui-editor settings-skill-viewer">
      {catalogView ?? <>
        <div className="ui-toolbar">
          <button className="ui-button ui-button-compact" disabled={busy} type="button" onClick={() => setEditing('new')}><Plus size={14} />{t('custom_tools.add')}</button>
        </div>
        {root && <>
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between"><div><strong>{rootLabel(root)}</strong><small>{root.path}</small></div><div className="ui-toolbar">
            {openButton(root.path, Boolean(root.error))}
            {root.source === 'external' && <>
              <button className="ui-button ui-button-compact" type="button" disabled={busy || rootIndex <= 0} aria-label={t('common.move_up')} onClick={() => void mutate(() => window.gale.tools.moveDirectory(root.id, -1))}>↑</button>
              <button className="ui-button ui-button-compact" type="button" disabled={busy || rootIndex >= external.length - 1} aria-label={t('common.move_down')} onClick={() => void mutate(() => window.gale.tools.moveDirectory(root.id, 1))}>↓</button>
              <button className="ui-button ui-button-compact ui-button-danger" disabled={busy} type="button" onClick={() => setRemoving(root)}><Trash2 size={14} />{t('custom_tools.remove_directory')}</button>
            </>}
          </div></div>
          {root.error && <div role="alert" className="ui-note ui-note-danger">{root.error}</div>}
          {root.source === 'external' && <form className="settings-skill-root-editor" onSubmit={event => { event.preventDefault(); void mutate(() => window.gale.tools.updateDirectory(root.id, nameDraft)) }}>
            <label className="ui-form-row ui-form-row-wide"><span>{t('settings.skill_directory_display_name')}</span><input className="ui-input" maxLength={100} value={nameDraft} onChange={event => setNameDraft(event.target.value)} /></label>
            <button className="ui-button ui-button-compact" type="submit" disabled={busy || !nameDraft.trim() || nameDraft.trim() === root.name}>{t('common.save')}</button>
          </form>}
        </>}
        {selected && selection?.kind === 'tool' && <>
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between"><strong>{selected.name}</strong><div className="ui-toolbar">
            {openButton(selected.directory)}
            {selected.source === 'user' && <>
              <button className="ui-button ui-button-compact" disabled={busy || !selected.definition} type="button" onClick={() => setEditing(selected)}><Pencil size={14} />{t('custom_tools.edit')}</button>
              <button className="ui-button ui-button-compact ui-button-danger" disabled={busy} type="button" onClick={() => setDeleting(selected)}><Trash2 size={14} />{t('custom_tools.delete')}</button>
            </>}
            <button className="ui-button ui-button-compact" disabled={busy || index <= 0} type="button" aria-label={t('common.move_up')} onClick={() => void mutate(() => window.gale.config.moveCustomTool(selected.id, -1))}>↑</button>
            <button className="ui-button ui-button-compact" disabled={busy || index >= peers.length - 1} type="button" aria-label={t('common.move_down')} onClick={() => void mutate(() => window.gale.config.moveCustomTool(selected.id, 1))}>↓</button>
          </div></div>
          <p>{selected.description}</p><small>{selected.directory}</small>
          {selected.error && <div role="alert" className="ui-note ui-note-danger">{selected.error}</div>}
          {selected.definition && <>
            <dl className="settings-skill-metadata"><dt>{t('custom_tools.command')}</dt><dd><code>{selected.definition.command}</code></dd>
              <dt>{t('custom_tools.timeout')}</dt><dd>{selected.definition.timeoutSeconds || t('settings.max_model_calls_unlimited')}</dd>
              <dt>{t('custom_tools.interactive')}</dt><dd>{t(selected.definition.interactive ? 'settings.enabled' : 'settings.disabled')}</dd></dl>
            <strong>{t('custom_tools.schema')}</strong><pre className="settings-skill-file-content">{JSON.stringify(selected.definition.inputSchema, null, 2)}</pre>
          </>}
        </>}
        {selection?.kind === 'all' && <strong>{t('custom_tools.all')}</strong>}
        <PackageFileViewer preview={preview} file={selection?.kind === 'file' ? selection.file : undefined} openButton={openButton} t={t} />
        {!selection && <div className="ui-empty-state">{t('custom_tools.select_item')}</div>}
      </>}
    </div>
    {editing && <CustomToolEditor key={editing === 'new' ? 'new' : editing.id} tool={editing === 'new' ? undefined : editing.definition} onClose={() => setEditing(undefined)} onSave={async tool => {
      const config = await window.gale.config.saveCustomTool(tool)
      setSnapshot(current => current ? { ...current, tools: config.customTools } : current)
      const id = tool.id ?? config.customTools.find(item => !tools.some(previous => previous.id === item.id))?.id
      if (id) select({ kind: 'tool', id })
      onConfigChange(config)
    }} />}
    <ConfirmDialog request={deleting ? { title: t('custom_tools.delete'), description: t('custom_tools.delete_hint', { name: deleting.name }), variant: 'danger',
      onConfirm: () => mutate(async () => { await window.gale.config.deleteCustomTool(deleting.id); setSelection(undefined) }) } : undefined} onClose={() => setDeleting(undefined)} />
    <ConfirmDialog request={removing ? { title: t('custom_tools.remove_directory'), description: t('custom_tools.remove_directory_hint'), variant: 'danger',
      onConfirm: () => mutate(async () => { await window.gale.tools.removeDirectory(removing.id); setSelection(undefined) }) } : undefined} onClose={() => setRemoving(undefined)} />
  </>
}
