import { SettingsSelectionActions } from '../settings/SettingsListActions'
import { useEffect, useEffectEvent, useRef, useState, type FormEvent, type RefObject } from 'react'
import { Bot, ListTree } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { AppConfigSnapshot, McpToolStatus, RuntimeToolStatus, SkillSnapshot, SubagentConfig } from '@shared/types'
import type { SubagentRootSummary, SubagentDirectoryUpdate } from '@shared/subagentPackages'
import type { PackageFileNode, PackageFilePreview } from '@shared/packageFiles'
import { notice } from '../notice'
import { CommitTextInput } from '../CommitTextField'
import { ConfirmDialog } from '../dialogs/ConfirmDialog'
import { PackageList, PackageTreeRoot, PackageTreeItem, PackageFileTree, PackageFileViewer, packageNodeKey } from '../settings/PackageTree'
import { SettingsAvailabilityBadge } from '../settings/SettingsAvailabilityBadge'
import { PackageActions } from '../settings/PackageActions'
import { SubagentEditor } from './SubagentEditor'
import type { SubagentDraft } from './subagentDraft'

interface SubagentSettingsProps {
  actionsTarget: HTMLDivElement | null
  config: AppConfigSnapshot | undefined
  draft: SubagentDraft
  editingIndex?: number
  listRef: RefObject<HTMLDivElement | null>
  mcpStatus: McpToolStatus | undefined
  runtimeToolStatus: RuntimeToolStatus | undefined
  sectionClass: string
  skills: SkillSnapshot | undefined
  onRefresh: (importPackage?: boolean) => Promise<void>
  onAdd: () => void | Promise<void>
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onDelete: () => void | Promise<void>
  onEdit: (index: number) => void | Promise<void>
  onMove: (direction: -1 | 1) => void | Promise<void>
  onUpdate: (update: Partial<SubagentDraft>) => void
}
type Selection = { kind: 'all' | 'agent' } | { kind: 'root'; id: string } | { kind: 'file'; id: string; file: PackageFileNode }

export function SubagentSettings({ actionsTarget, config, draft, editingIndex, listRef, mcpStatus, runtimeToolStatus, sectionClass,
  skills, onRefresh, onAdd, onAutosizeInput, onDelete, onEdit, onMove, onUpdate }: SubagentSettingsProps) {
  const { t } = useTranslation()
  const [roots, setRoots] = useState<SubagentRootSummary[]>([])
  const [selection, setSelection] = useState<Selection>()
  const [removingRoot, setRemovingRoot] = useState<SubagentRootSummary>()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [children, setChildren] = useState<Record<string, PackageFileNode[]>>({})
  const [preview, setPreview] = useState<PackageFilePreview>()
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const requestRef = useRef(0)
  const agents = config?.subagents ?? []
  const selected = selection?.kind === 'agent' ? agents.find(agent => agent.index === editingIndex) : undefined
  const root = selection?.kind === 'root' ? roots.find(root => root.id === selection.id) : undefined
  const external = roots.filter(root => root.kind === 'external')
  const rootIndex = external.findIndex(item => item.id === root?.id)
  const selectedRoot = roots.find(item => selected?.id && item.agentIds.includes(selected.id))
  const selectedRootId = selectedRoot?.id
  const siblings = agents.filter(agent => agent.id && selectedRoot?.agentIds.includes(agent.id))
  const siblingIndex = siblings.findIndex(agent => agent.id === selected?.id)
  const sortedAgents = [...agents].sort((a, b) => roots.findIndex(root => root.agentIds.includes(a.id!)) - roots.findIndex(root => root.agentIds.includes(b.id!)) || a.index - b.index)
  const groupAgents = selection?.kind === 'all' ? sortedAgents : root ? agents.filter(agent => agent.id && root.agentIds.includes(agent.id)) : undefined
  const label = (root: SubagentRootSummary) => root.kind === 'external' ? root.name : t(`settings.skill_group_${root.kind}`)
  const report = (reason: unknown) => notice.error(`${t('settings.subagent_operation_failed')}: ${String(reason)}`, { id: 'settings-subagent-tree' })
  const reportCatalogError = useEffectEvent(report)
  const toggle = (key: string) => setExpanded(current => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next })
  function select(next?: Selection) { requestRef.current++; setPreview(undefined); setSelection(next) }

  useEffect(() => {
    let active = true
    void window.gale.config.listSubagentRoots().then(items => {
      if (active) setRoots(items)
    }).catch(reason => { if (active) reportCatalogError(reason) })
    return () => { active = false }
  }, [config?.subagents, revision])

  useEffect(() => () => { requestRef.current++ }, [])

  // Match Skills: selecting an item from the overview reveals its source in the tree.
  useEffect(() => {
    if (selection?.kind !== 'agent' || !selectedRootId) return
    setExpanded(current => current.has('all') ? current : new Set([...current, `root:${selectedRootId}`]))
  }, [selection, selected?.id, selectedRootId])

  // Mutations wait for any pending Agent autosave, and refresh both definition and source metadata.
  async function mutate(action: () => Promise<unknown>, after?: () => void) {
    if (busyRef.current) return
    busyRef.current = true; setBusy(true)
    try {
      await onRefresh()
      await action()
      await onRefresh()
      const items = await window.gale.config.listSubagentRoots()
      setRoots(items); setChildren({}); setExpanded(current => new Set([...current].filter(key => !key.startsWith('files:')))); setRevision(value => value + 1)
      if (selection?.kind === 'file') select({ kind: 'all' })
      after?.()
    } catch (reason) { report(reason) }
    finally { busyRef.current = false; setBusy(false) }
  }
  const updateRoot = (id: string, update: SubagentDirectoryUpdate) => mutate(() => window.gale.config.updateSubagentDirectory(id, update), () => {
    if ('remove' in update) select()
  })
  async function selectAgent(agent: SubagentConfig) {
    const request = ++requestRef.current
    try {
      await onEdit(agent.index)
      if (requestRef.current === request) { setPreview(undefined); setSelection({ kind: 'agent' }) }
    } catch (reason) { report(reason) }
  }
  async function expandFiles(id: string, path = '') {
    const key = packageNodeKey(id, path)
    try {
      if (!children[key]) {
        const files = await window.gale.config.listSubagentFiles(id, path)
        setChildren(current => ({ ...current, [key]: files }))
      }
      toggle(`files:${key}`)
    } catch (reason) { report(reason) }
  }
  async function selectFile(id: string, file: PackageFileNode) {
    const request = ++requestRef.current
    setPreview(undefined); setSelection({ kind: 'file', id, file })
    if (file.kind === 'directory' || file.linkDirectory) { await expandFiles(id, file.relativePath); return }
    try {
      const next = await window.gale.config.readSubagentFile(id, file.relativePath)
      if (requestRef.current === request) setPreview(next)
    } catch (reason) { if (requestRef.current === request) report(reason) }
  }
  function renderAgent(agent: SubagentConfig, showSource = false) {
    const id = agent.id!
    const isExpanded = expanded.has(`files:${packageNodeKey(id)}`)
    return <PackageTreeItem key={id} name={agent.name} depth={1} icon={<Bot size={14} />} expanded={isExpanded}
      selected={selected?.id === id} badge={showSource ? (() => { const source = roots.find(root => root.agentIds.includes(id)); return source ? label(source) : undefined })() : undefined}
      status={<SettingsAvailabilityBadge disabled={!agent.enabled} />}
      expandLabel={t(isExpanded ? 'settings.package_group_collapse' : 'settings.package_group_expand', { name: agent.name })}
      onExpand={() => void expandFiles(id)} onSelect={() => void selectAgent(agent)}>
      <PackageFileTree packageId={id} depth={2} childrenByKey={children} expanded={expanded}
        selectedPath={selection?.kind === 'file' && selection.id === id ? selection.file.relativePath : undefined}
        onSelect={file => void selectFile(id, file)} />
    </PackageTreeItem>
  }
  const showFolder = async (path: string) => { await window.gale.files.showItemInFolder(path) }

  return <section className={sectionClass}>
    <PackageActions resource="subagent" destination={t('settings.skill_group_user')} target={actionsTarget} disabled={busy || !config}
      addDirectory={{ label: t('settings.add_subagent_directory'), onClick: () => void mutate(() => window.gale.config.addSubagentDirectory()) }}
      create={{ label: t('settings.subagent_new'), onClick: () => void mutate(async () => onAdd(), () => select({ kind: 'agent' })) }}
      importLabel={t('settings.subagent_import_package')} onImport={() => void mutate(() => onRefresh(true), () => select({ kind: 'agent' }))} />
    <div className="ui-list-pane">
      <SettingsSelectionActions refreshLabel={t('common.refresh')}
        moveUpLabel={t('common.move_up')} moveDownLabel={t('common.move_down')} disabled={busy}
        deleteLabel={t(root?.kind === 'external' ? 'settings.remove_subagent_directory' : 'settings.subagent_delete')}
        targetName={root ? label(root) : selected?.name}
        onRefresh={() => void mutate(async () => {})}
        onMoveUp={root && rootIndex > 0 ? () => void updateRoot(root.id, { direction: -1 })
          : selected && !selected.builtIn && siblingIndex > 0 ? () => void mutate(async () => onMove(-1)) : undefined}
        onMoveDown={root && rootIndex >= 0 && rootIndex < external.length - 1 ? () => void updateRoot(root.id, { direction: 1 })
          : selected && !selected.builtIn && siblingIndex >= 0 && siblingIndex < siblings.length - 1 ? () => void mutate(async () => onMove(1)) : undefined}
        onDelete={root?.kind === 'external' ? () => setRemovingRoot(root)
          : selected && !selected.builtIn ? () => void onDelete() : undefined} />
      <div className="ui-scroll-list settings-skill-tree" ref={listRef}>
        <PackageTreeRoot name={t('settings.subagent_group_all')} count={agents.length} icon={<ListTree size={15} />}
          expanded={expanded.has('all')} selected={selection?.kind === 'all'}
          expandLabel={t(expanded.has('all') ? 'settings.package_group_collapse' : 'settings.package_group_expand', { name: t('settings.subagent_group_all') })}
          onExpand={() => toggle('all')} onSelect={() => select({ kind: 'all' })}>
          {sortedAgents.map(agent => renderAgent(agent, true))}
        </PackageTreeRoot>
        {roots.map(root => <PackageTreeRoot key={root.id} name={label(root)} source={root.kind} count={root.agentIds.length}
          icon={!root.available || root.errors.length ? <SettingsAvailabilityBadge disabled={false} error /> : undefined}
          expanded={expanded.has(`root:${root.id}`)} selected={selection?.kind === 'root' && selection.id === root.id}
          expandLabel={t(expanded.has(`root:${root.id}`) ? 'settings.package_group_collapse' : 'settings.package_group_expand', { name: label(root) })}
          onExpand={() => toggle(`root:${root.id}`)} onSelect={() => select({ kind: 'root', id: root.id })}>
          {agents.filter(agent => agent.id && root.agentIds.includes(agent.id)).map(agent => renderAgent(agent))}
        </PackageTreeRoot>)}
      </div>
    </div>
    <div className="ui-editor settings-skill-viewer">
      {groupAgents && <>
        <div className="settings-detail-heading ui-toolbar ui-toolbar-between">
          <div>{root ? <><button type="button" className="ui-link-button" disabled={!root.available} onClick={() => void showFolder(root.path)}>{label(root)}</button><small>{root.path}</small></> : <strong>{t('settings.subagent_group_all')}</strong>}</div>
        </div>
        {root?.kind === 'external' && <div className="settings-skill-root-editor">
          <label className="ui-form-row ui-form-row-wide"><span>{t('settings.skill_directory_display_name')}</span>
            <CommitTextInput key={root.id} preserveDirtyDraft className="ui-input" maxLength={100} value={root.name} disabled={busy}
              onCommit={name => { if (!name.trim()) { report(t('settings.subagent_directory_name_required')); return }; void updateRoot(root.id, { name }) }} /></label>
          <small>{t('settings.subagent_external_directory_hint')}</small>
        </div>}
        {root?.issue && <div className="ui-note ui-note-danger">{t(`settings.skill_root_${root.issue}`)}</div>}
        {root?.errors.map((error, index) => <div key={index} className="ui-note ui-note-danger">{error.path}: {error.message}</div>)}
        <PackageList label={t('settings.subagents')} emptyLabel={t('settings.subagent_empty')}
          onSelect={id => { const agent = agents.find(agent => agent.id === id); if (agent) void selectAgent(agent) }}
          items={groupAgents.map(agent => ({ id: agent.id!, name: agent.name, description: agent.description,
            detail: selection?.kind === 'all' ? agent.directory : undefined, status: <SettingsAvailabilityBadge disabled={!agent.enabled} /> }))} />
      </>}
      {selection?.kind === 'agent' && selected && <>
        <div className="settings-detail-heading ui-toolbar ui-toolbar-between">
          <button type="button" className="ui-link-button" onClick={() => { if (selected.directory) void showFolder(selected.directory) }}>{selected.name}</button>
        </div>
        <SubagentEditor key={`${draft.id}:${revision}`} config={config} customTools={config?.customTools} draft={draft} subagents={agents}
          mcpStatus={mcpStatus} mcpServers={config?.mcpServers} runtimeToolStatus={runtimeToolStatus} skills={skills}
          onAutosizeInput={onAutosizeInput} onUpdate={onUpdate} />
      </>}
      {selection?.kind === 'file' && <>
        <PackageFileViewer key={`${selection.id}:${selection.file.relativePath}`} preview={preview} file={selection.file} t={t} onOpen={showFolder}
        onSave={preview?.editable ? async update => {
          const id = selection.id, path = selection.file.relativePath
          await onRefresh()
          const saved = await window.gale.config.saveSubagentFile(id, path, update)
          await onRefresh()
          setPreview(saved); setRevision(value => value + 1)
        } : undefined} />
      </>}
      {!selection && <div className="ui-empty-state">{t('settings.select_subagent_tree_item')}</div>}
    </div>
    <ConfirmDialog request={removingRoot ? {
      title: t('settings.remove_subagent_directory_title', { name: removingRoot.name }),
      description: t('settings.remove_subagent_directory_description'),
      confirmText: t('common.remove'),
      variant: 'danger',
      onConfirm: () => updateRoot(removingRoot.id, { remove: true })
    } : undefined} onClose={() => setRemovingRoot(undefined)} />
  </section>
}
