import { errorDetail } from '@shared/recovery'
import { ArrowDown, ArrowUp, FolderDown, ListTree, Pencil, Plus, Trash2, Wrench } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { AppConfigSnapshot } from '@shared/types'
import type { ToolLoadError, ToolPackage, ToolRoot, ToolSnapshot } from '@shared/toolPackages'
import type { PackageFileNode, PackageFilePreview } from '@shared/packageFiles'
import { getCustomToolCommandFile } from '@shared/customTools'
import { CustomToolEditor, type CustomToolEditorSection } from './CustomToolEditor'
import { ToolParameters } from './ToolParameters'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { CommitTextInput } from '../CommitTextField'
import { notice } from '../notice'
import { PackageList, PackageSourceActions, PackageTreeRoot, PackageTreeItem, PackageFileTree, PackageFileViewer, packageNodeKey } from './PackageTree'

const toolNoticeId = 'settings-tool-status'

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
  const [editing, setEditing] = useState<(ToolPackage | { rootId: string }) & { initialSection?: CustomToolEditorSection }>()
  const [deleting, setDeleting] = useState<ToolPackage>()
  const [removing, setRemoving] = useState<ToolRoot>()
  const [creating, setCreating] = useState<{ tool: ToolPackage; path: string }>()
  const [busy, setBusy] = useState(false)
  const tree = useRef<HTMLDivElement>(null)
  const request = useRef(0)
  const catalogIdentity = useRef('')
  const showingCatalog = Boolean(catalogView)
  const selected = selection && 'id' in selection ? snapshot?.tools.find(tool => tool.id === selection.id) : undefined
  const commandFile = selected?.definition ? getCustomToolCommandFile(selected.definition.command) : undefined
  const root = selection?.kind === 'root' ? snapshot?.roots.find(root => root.id === selection.id) : undefined
  const groupTools = selection?.kind === 'all' ? snapshot?.tools ?? []
    : root ? snapshot?.tools.filter(tool => tool.rootId === root.id) ?? [] : undefined
  const external = snapshot?.roots.filter(root => root.source === 'external') ?? []
  const rootIndex = external.findIndex(item => item.id === root?.id)
  const peers = snapshot?.tools.filter(tool => tool.rootId === selected?.rootId) ?? []
  const index = peers.findIndex(tool => tool.id === selected?.id)
  const roots = [...(snapshot?.roots ?? [])].sort((a, b) => ({ system: 0, user: 1, project: 2, external: 3 }[a.source] - { system: 0, user: 1, project: 2, external: 3 }[b.source]))
  const rootLabel = (root: ToolRoot) => root.source === 'system' || root.source === 'user' ? t(`settings.skill_group_${root.source}`) : root.name
  const loadErrorText = (error: ToolLoadError) => [
    t(`custom_tools.load_error_${error.code}`), error.path,
    ['invalid_json', 'invalid_definition', 'read_failed'].includes(error.code) ? error.detail : undefined
  ].filter(Boolean).join('\n')
  const renderLoadError = (error: ToolLoadError) => <div role="alert" className="ui-note ui-note-danger">
    {loadErrorText(error).split('\n').map((line, index) => <p key={index}>{line}</p>)}
  </div>

  useEffect(() => {
    let active = true
    const pendingRequest = request
    void window.gale.tools.get().then(value => {
      if (!active) return
      setSnapshot(value); notice.dismiss(toolNoticeId)
      const identity = JSON.stringify([value.roots.map(root => [root.id, root.path]), value.tools.map(tool => [tool.id, tool.directory])])
      if (identity !== catalogIdentity.current) {
        catalogIdentity.current = identity
        setChildren({}); setPreview(undefined); request.current++
        setExpanded(current => new Set([...current].filter(key => !key.startsWith('files:'))))
      }
    }).catch(reason => { if (active) notice.error(errorDetail(reason), { id: toolNoticeId }) })
    return () => { active = false; pendingRequest.current++; notice.dismiss(toolNoticeId) }
  }, [tools])

  useEffect(() => {
    if (!showingCatalog) return
    request.current++
    notice.dismiss(toolNoticeId)
  }, [showingCatalog])

  useEffect(() => {
    if (selection?.kind === 'file') tree.current?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [selection])

  async function refresh() {
    request.current++; notice.dismiss(toolNoticeId)
    const value = await window.gale.tools.get()
    setSnapshot(value); setChildren({}); setPreview(undefined); request.current++
    setExpanded(current => new Set([...current].filter(key => !key.startsWith('files:'))))
    onConfigChange(await window.gale.tools.refresh())
  }
  async function mutate(action: () => Promise<unknown>) {
    setBusy(true); notice.dismiss(toolNoticeId)
    try { if (await action() !== false) await refresh() }
    catch (reason) { notice.error(errorDetail(reason), { id: toolNoticeId }) }
    finally { setBusy(false) }
  }
  function toggle(key: string) {
    setExpanded(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  }
  function select(value: Selection, toolRootId?: string) {
    request.current++; notice.dismiss(toolNoticeId); setPreview(undefined); setSelection(value); onSelectCustom?.()
    if (value.kind === 'tool') {
      const rootId = toolRootId ?? snapshot?.tools.find(tool => tool.id === value.id)?.rootId
      if (rootId) setExpanded(current => current.has('all') ? current : new Set([...current, rootId]))
    }
  }
  async function expandFiles(id: string, path?: string) {
    notice.dismiss(toolNoticeId)
    const revision = request.current
    try {
      const key = packageNodeKey(id, path)
      if (!children[key]) {
        const items = await window.gale.tools.listFiles(id, path)
        if (request.current !== revision) return
        setChildren(current => ({ ...current, [key]: items }))
      }
      toggle(`files:${key}`)
    } catch (reason) { if (revision === request.current) notice.error(errorDetail(reason), { id: toolNoticeId }) }
  }
  async function selectFile(id: string, file: PackageFileNode) {
    select({ kind: 'file', id, file })
    if (file.kind === 'directory' || file.linkDirectory) { await expandFiles(id, file.relativePath); return }
    const revision = request.current
    try {
      const value = await window.gale.tools.readFile(id, file.relativePath)
      if (revision === request.current) setPreview(value)
    } catch (reason) { if (revision === request.current) notice.error(errorDetail(reason), { id: toolNoticeId }) }
  }
  async function locateCommandFile(tool: ToolPackage, path: string) {
    const revision = ++request.current
    notice.dismiss(toolNoticeId)
    const loaded: Record<string, PackageFileNode[]> = {}
    const parents: string[] = []
    let parent: string | undefined
    let file: PackageFileNode | undefined
    const parts = path.split('/')
    try {
      const exists = await window.gale.tools.fileExists(tool.id, path)
      if (request.current !== revision) return
      if (!exists) {
        if (tool.source === 'system') notice.error(t('custom_tools.command_file_missing', { path }), { id: toolNoticeId })
        else setCreating({ tool, path })
        return
      }
      for (const [index, name] of parts.entries()) {
        const key = packageNodeKey(tool.id, parent)
        const nodes = await window.gale.tools.listFiles(tool.id, parent)
        if (request.current !== revision) return
        loaded[key] = nodes
        parents.push(`files:${key}`)
        file = nodes.find(node => node.name === name)
        if (!file) {
          const matches = nodes.filter(node => node.name.toLowerCase() === name.toLowerCase())
          if (matches.length === 1) file = matches[0]
        }
        if (!file) {
          notice.error(t('custom_tools.command_file_unlisted'), { id: toolNoticeId, description: path })
          return
        }
        if (index < parts.length - 1 && file.kind !== 'directory' && !file.linkDirectory) {
          notice.error(t('custom_tools.load_error_not_directory'), { id: toolNoticeId, description: file.relativePath })
          return
        }
        parent = file.relativePath
      }
      if (!file) return
      if (file.kind === 'directory' || file.linkDirectory) {
        notice.error(t('custom_tools.load_error_not_file'), { id: toolNoticeId, description: path })
        return
      }
      setChildren(current => ({ ...current, ...loaded }))
      setExpanded(current => new Set([...current, tool.rootId, ...parents]))
      await selectFile(tool.id, file)
    } catch (reason) {
      if (request.current === revision) notice.error(t('custom_tools.command_file_failed'), { id: toolNoticeId, description: errorDetail(reason) })
    }
  }
  async function createCommandFile(tool: ToolPackage, path: string) {
    const revision = ++request.current
    setBusy(true)
    try {
      await window.gale.tools.createFile(tool.id, path)
      if (request.current === revision) await locateCommandFile(tool, path)
    } catch (reason) {
      if (request.current === revision) notice.error(t('custom_tools.command_file_create_failed'), { id: toolNoticeId, description: errorDetail(reason) })
    } finally { setBusy(false) }
  }
  function renderTool(tool: ToolPackage, showSource = false) {
    const isExpanded = expanded.has(`files:${packageNodeKey(tool.id)}`)
    return <PackageTreeItem key={tool.id} name={tool.name} icon={<Wrench size={14} aria-hidden="true" />} depth={1} selected={selection?.kind === 'tool' && selection.id === tool.id && !catalogView}
      expanded={isExpanded} unavailable={Boolean(tool.error)} badge={[showSource ? rootLabel(roots.find(root => root.id === tool.rootId)!) : '', tool.error ? t('capabilities.inactive') : ''].filter(Boolean).join(' · ')}
      expandLabel={t(isExpanded ? 'custom_tools.collapse' : 'custom_tools.expand', { name: tool.name })}
      onExpand={() => void expandFiles(tool.id)} onSelect={() => select({ kind: 'tool', id: tool.id })}
      onDoubleClick={() => { if ((tool.source === 'user' || tool.source === 'external') && tool.definition) setEditing(tool) }}>
      <PackageFileTree packageId={tool.id} depth={2} childrenByKey={children} expanded={expanded}
        selectedPath={selection?.kind === 'file' && selection.id === tool.id ? selection.file.relativePath : undefined}
        onSelect={file => void selectFile(tool.id, file)} />
    </PackageTreeItem>
  }
  async function showItemInFolder(path: string): Promise<void> {
    await window.gale.files.showItemInFolder(path).catch(reason => notice.error(errorDetail(reason), { id: toolNoticeId }))
  }
  async function importDirectories(rootId: string) {
    const result = await window.gale.tools.importDirectories(rootId)
    if (result.status === 'cancelled') return false
    if (result.status === 'error') throw new Error([
      t(`custom_tools.import_error_${result.error.code}`, { name: result.error.name }),
      result.error.issue ? loadErrorText(result.error.issue) : result.error.detail
    ].filter(Boolean).join('\n'))
    onConfigChange(result.config)
    select({ kind: 'tool', id: result.ids[0] }, rootId)
    notice.success(t('custom_tools.imported', { count: result.ids.length }))
  }

  return <>
    <div className="ui-list-pane">
      <div className="ui-scroll-list settings-skill-tree" ref={tree}>
        {catalogNavigation && <nav className="settings-tool-navigation" aria-label={t('settings.tools_page')}>{catalogNavigation}</nav>}
        <PackageSourceActions addLabel={t('custom_tools.add_directory')} refreshLabel={t('common.refresh')} disabled={busy}
          moveUpLabel={t('common.move_up')} moveDownLabel={t('common.move_down')}
          onMoveUp={!catalogView && root && rootIndex > 0 ? () => void mutate(() => window.gale.tools.moveDirectory(root.id, -1)) : undefined}
          onMoveDown={!catalogView && root && rootIndex >= 0 && rootIndex < external.length - 1 ? () => void mutate(() => window.gale.tools.moveDirectory(root.id, 1)) : undefined}
          onAdd={() => void mutate(async () => (await window.gale.tools.addDirectory()).status !== 'cancelled')}
          onRefresh={() => void mutate(async () => {})} />
        <PackageTreeRoot name={t('custom_tools.all')} count={snapshot?.tools.length ?? 0} expanded={expanded.has('all')} selected={!catalogView && selection?.kind === 'all'} icon={<ListTree size={15} />}
          expandLabel={t(expanded.has('all') ? 'settings.package_group_collapse' : 'settings.package_group_expand', { name: t('custom_tools.all') })}
          onExpand={() => toggle('all')} onSelect={() => select({ kind: 'all' })}>{snapshot?.tools.map(tool => renderTool(tool, true))}</PackageTreeRoot>
        {roots.map(root => <PackageTreeRoot key={root.id} name={rootLabel(root)} source={root.source} count={snapshot?.tools.filter(tool => tool.rootId === root.id).length ?? 0}
          expanded={expanded.has(root.id)} selected={!catalogView && selection?.kind === 'root' && selection.id === root.id}
          expandLabel={t(expanded.has(root.id) ? 'settings.package_group_collapse' : 'settings.package_group_expand', { name: rootLabel(root) })}
          onExpand={() => toggle(root.id)} onSelect={() => select({ kind: 'root', id: root.id })}>
          {snapshot?.tools.filter(tool => tool.rootId === root.id).map(tool => renderTool(tool))}
        </PackageTreeRoot>)}
      </div>
    </div>
    <div className="ui-editor settings-skill-viewer">
      {catalogView ?? <>
        {root && <>
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between"><div><button className="ui-link-button" type="button" disabled={Boolean(root.error)} data-tooltip={t('chat.show_in_folder')} onClick={() => void showItemInFolder(root.path)}>{rootLabel(root)}</button><small>{root.path}</small></div><div className="ui-toolbar">
            {(root.source === 'user' || root.source === 'external') && <>
              <button className="ui-icon-button" type="button" disabled={busy} aria-label={t('custom_tools.add')} data-tooltip={t('custom_tools.add')} onClick={() => setEditing({ rootId: root.id })}><Plus size={14} /></button>
              <button className="ui-icon-button" type="button" disabled={busy} aria-label={t('custom_tools.import')} data-tooltip={t('custom_tools.import')} onClick={() => void mutate(() => importDirectories(root.id))}><FolderDown size={14} /></button>
            </>}
            {root.source === 'external' && <>
              <button className="ui-button ui-button-compact ui-button-danger" disabled={busy} type="button" onClick={() => setRemoving(root)}><Trash2 size={14} />{t('custom_tools.remove_directory')}</button>
            </>}
          </div></div>
          {root.error && renderLoadError(root.error)}
          {root.source === 'external' && <div key={root.id} className="settings-skill-root-editor">
            <label className="ui-form-row ui-form-row-wide"><span>{t('settings.skill_directory_display_name')}</span>
              <CommitTextInput preserveDirtyDraft className="ui-input" maxLength={100} value={root.name} disabled={busy} onCommit={name => {
                const normalized = name.trim()
                if (normalized && normalized !== root.name) return mutate(() => window.gale.tools.updateDirectory(root.id, normalized))
              }} />
            </label>
          </div>}
        </>}
        {selected && selection?.kind === 'tool' && <>
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between"><div><button className="ui-link-button" type="button" data-tooltip={t('chat.show_in_folder')} onClick={() => void showItemInFolder(selected.directory)}>{selected.name}</button></div><div className="ui-toolbar">
            {(selected.source === 'user' || selected.source === 'external') && <>
              <button className="ui-icon-button" disabled={busy || !selected.definition} type="button" aria-label={t('custom_tools.edit_information')} data-tooltip={t('custom_tools.edit_information')} onClick={() => setEditing(selected)}><Pencil size={14} /></button>
              <button className="ui-icon-button ui-button-danger" disabled={busy} type="button" aria-label={t('custom_tools.delete')} data-tooltip={t('custom_tools.delete')} onClick={() => setDeleting(selected)}><Trash2 size={14} /></button>
            </>}
            <button className="ui-icon-button" disabled={busy || index <= 0} type="button" aria-label={t('common.move_up')} data-tooltip={t('common.move_up')} onClick={() => void mutate(() => window.gale.config.moveCustomTool(selected.id, -1))}><ArrowUp size={14} /></button>
            <button className="ui-icon-button" disabled={busy || index >= peers.length - 1} type="button" aria-label={t('common.move_down')} data-tooltip={t('common.move_down')} onClick={() => void mutate(() => window.gale.config.moveCustomTool(selected.id, 1))}><ArrowDown size={14} /></button>
          </div></div>
          <p>{selected.description}</p>
          {selected.error && renderLoadError(selected.error)}
          <dl className="settings-skill-metadata">
            <dt>{t('custom_tools.path')}</dt><dd><button className="ui-link-button" type="button" data-tooltip={t('chat.show_in_folder')}
              onClick={() => void showItemInFolder(selected.directory)}>{selected.directory}</button></dd>
            {selected.definition && <>
              <dt>{t('custom_tools.command')}</dt><dd><code>{commandFile ? <>
                {selected.definition.command.slice(0, commandFile.start)}<button className="ui-link-button settings-tool-command-link" type="button" disabled={busy}
                  data-tooltip={t('custom_tools.command_file_locate')} onClick={() => void locateCommandFile(selected, commandFile.relativePath)}>
                  {selected.definition.command.slice(commandFile.start, commandFile.end)}</button>{selected.definition.command.slice(commandFile.end)}
              </> : selected.definition.command}</code></dd>
              <dt>{t('custom_tools.timeout')}</dt><dd>{selected.definition.timeoutSeconds || t('settings.max_model_calls_unlimited')}</dd>
              <dt>{t('custom_tools.interactive')}</dt><dd>{t(selected.definition.interactive ? 'settings.enabled' : 'settings.disabled')}</dd>
            </>}
          </dl>
          {selected.definition && <ToolParameters key={selected.id} value={JSON.stringify(selected.definition.inputSchema, null, 2)} disabled={busy}
            onEdit={selected.source === 'user' || selected.source === 'external' ? () => setEditing({ ...selected, initialSection: 'parameters' }) : undefined} />}
        </>}
        {selection?.kind === 'all' && <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between">
          <strong>{t('custom_tools.all')}</strong>
        </div>}
        {groupTools && <PackageList label={t('custom_tools.title')} emptyLabel={t('custom_tools.group_empty')}
          onSelect={id => select({ kind: 'tool', id })} items={groupTools.map(tool => ({
            id: tool.id, name: tool.name, description: tool.description,
            detail: selection?.kind === 'all' ? `${rootLabel(roots.find(root => root.id === tool.rootId)!)} · ${tool.directory}` : undefined,
            status: tool.error ? t('capabilities.inactive') : undefined
          }))} />}
        <PackageFileViewer key={preview?.path} onSave={preview && selected ? async update => {
          const saved = await window.gale.tools.saveFile(selected.id, preview.relativePath, update)
          setPreview(saved)
          void window.gale.tools.get().then(setSnapshot).catch(reason => notice.error(errorDetail(reason), { id: toolNoticeId }))
          void window.gale.tools.refresh().then(onConfigChange).catch(reason => notice.error(errorDetail(reason), { id: toolNoticeId }))
        } : undefined} preview={preview} file={selection?.kind === 'file' ? selection.file : undefined} onOpen={showItemInFolder} t={t} />
        {!selection && <div className="ui-empty-state">{t('custom_tools.select_item')}</div>}
      </>}
    </div>
    {editing && <CustomToolEditor key={'id' in editing ? editing.id : editing.rootId} tool={'id' in editing ? editing.definition : undefined} initialSection={editing.initialSection} onClose={() => setEditing(undefined)} onSave={async tool => {
      const config = await window.gale.config.saveCustomTool({ ...tool, rootId: editing.rootId })
      setSnapshot(current => current ? { ...current, tools: config.customTools } : current)
      const id = tool.id ?? config.customTools.find(item => item.rootId === editing.rootId && item.name === tool.name.trim() && !snapshot?.tools.some(previous => previous.id === item.id))?.id
      if (id) select({ kind: 'tool', id }, editing.rootId)
      onConfigChange(config)
    }} />}
    <ConfirmDialog request={creating ? { title: t('custom_tools.command_file_create'),
      description: t('custom_tools.command_file_create_hint', { path: `${creating.tool.directory}/${creating.path}` }),
      confirmText: t('custom_tools.command_file_create'), onConfirm: () => createCommandFile(creating.tool, creating.path)
    } : undefined} onClose={() => setCreating(undefined)} />
    <ConfirmDialog request={deleting ? { title: t('custom_tools.delete'), description: t('custom_tools.delete_hint', { name: deleting.name, path: deleting.directory }), variant: 'danger',
      onConfirm: () => mutate(async () => { await window.gale.config.deleteCustomTool(deleting.id); setSelection(undefined) }) } : undefined} onClose={() => setDeleting(undefined)} />
    <ConfirmDialog request={removing ? { title: t('custom_tools.remove_directory'), description: t('custom_tools.remove_directory_hint'), variant: 'danger',
      onConfirm: () => mutate(async () => { await window.gale.tools.removeDirectory(removing.id); setSelection(undefined) }) } : undefined} onClose={() => setRemoving(undefined)} />
  </>
}
