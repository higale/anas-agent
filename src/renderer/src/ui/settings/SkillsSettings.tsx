import { PackageList, PackageSourceActions, PackageTreeRoot, PackageTreeItem, PackageFileTree, PackageFileViewer, packageNodeKey as nodeKey } from './PackageTree'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FolderDown, ListTree, Trash2, Wand2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH, SKILL_SHORTCUT_ALIAS_MAX_LENGTH, SKILL_SHORTCUT_ALIAS_PATTERN } from '@shared/types'
import type { SkillAvailabilityUpdate, SkillFileNode, SkillFilePreview, SkillRootSummary, SkillRootUpdate, SkillSnapshot, SkillSummary } from '@shared/types'
import { CheckboxField } from '../CheckboxField'
import { CommitTextInput } from '../CommitTextField'
import { notice } from '../notice'
import { UI_ICON_SIZE_SMALL } from '../uiConstants'

interface Props {
  sectionClass: string
  skills?: SkillSnapshot
  onAddDirectory: () => void | Promise<void>
  onImportDirectories: () => void | Promise<void>
  onMoveDirectory: (rootId: string, direction: -1 | 1) => void | Promise<void>
  onRefresh: () => void | Promise<void>
  onUpdateDirectory: (rootId: string, update: SkillRootUpdate) => void | Promise<void>
  onRemoveDirectory: (root: SkillRootSummary) => void
  onUpdateScriptApproval: (skillId: string | undefined, enabled: boolean) => void | Promise<void>
  onUpdateAvailability: (skillId: string, update: SkillAvailabilityUpdate) => void | Promise<void>
}

type Selection =
  | { kind: 'all' }
  | { kind: 'root'; rootId: string }
  | { kind: 'skill'; skillId: string }
  | { kind: 'file'; skillId: string; relativePath: string }

export function SkillsSettings({
  sectionClass,
  skills,
  onAddDirectory,
  onImportDirectories,
  onMoveDirectory,
  onRefresh,
  onUpdateDirectory,
  onRemoveDirectory,
  onUpdateScriptApproval,
  onUpdateAvailability
}: Props) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [children, setChildren] = useState<Record<string, SkillFileNode[]>>({})
  const pendingRootUpdates = useRef(new Map<string, SkillRootUpdate>())
  const [selection, setSelection] = useState<Selection>()
  const [preview, setPreview] = useState<SkillFilePreview>()
  const previewRequestRef = useRef(0)
  const catalogIdentityRef = useRef('')
  const roots = useMemo(() => skills?.roots ?? [], [skills?.roots])
  const allSkills = useMemo(() => skills?.skills ?? [], [skills?.skills])
  const sortedSkills = useMemo(() => {
    const rootOrder = new Map(roots.map((root, index) => [root.id, index]))
    return [...allSkills].sort((left, right) => (
      (rootOrder.get(left.rootId) ?? Number.MAX_SAFE_INTEGER) - (rootOrder.get(right.rootId) ?? Number.MAX_SAFE_INTEGER)
      || left.name.localeCompare(right.name)
    ))
  }, [allSkills, roots])
  const rootById = useMemo(() => new Map(roots.map((root) => [root.id, root])), [roots])
  const skillById = useMemo(() => new Map(allSkills.map((skill) => [skill.id, skill])), [allSkills])
  const selectedRoot = selection?.kind === 'root' ? rootById.get(selection.rootId) : undefined
  const groupSkills = selection?.kind === 'all' ? sortedSkills
    : selectedRoot ? sortedSkills.filter(skill => skill.rootId === selectedRoot.id) : undefined
  const selectedSkill = selection?.kind === 'skill' || selection?.kind === 'file' ? skillById.get(selection.skillId) : undefined
  const selectedSkillIssue = selectedSkill?.loadError
  const selectedSkillIssueText = selectedSkillIssue
    ? t(`settings.skill_issue_${selectedSkillIssue.code}`, {
        name: selectedSkillIssue.name ?? '',
        expected: selectedSkillIssue.expected ?? ''
      })
    : undefined
  const selectedFile = selection?.kind === 'file'
    ? Object.entries(children)
        .filter(([key]) => key.startsWith(`${selection.skillId}\0`))
        .flatMap(([, files]) => files)
        .find((file) => file.relativePath === selection.relativePath)
    : undefined
  const externalRoots = roots.filter((root) => root.kind === 'external')

  useEffect(() => {
    const identity = JSON.stringify([
      [...rootById.values()].map(root => [root.id, root.path]),
      [...skillById.values()].map(skill => [skill.id, skill.dirPath])
    ])
    if (identity === catalogIdentityRef.current) return
    catalogIdentityRef.current = identity
    previewRequestRef.current += 1
    setChildren({})
    setExpanded(current => new Set([...current].filter(key => !key.startsWith('files:'))))
    setPreview(undefined)
    setSelection((current) => {
      if (!current) return undefined
      if (current.kind === 'all') return current
      if (current.kind === 'root') return rootById.has(current.rootId) ? current : undefined
      return skillById.has(current.skillId) ? current : undefined
    })
  }, [skills, rootById, skillById])

  function toggle(key: string): void {
    setExpanded((current) => {
      const next = new Set(current)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function clearPreview(): void {
    previewRequestRef.current += 1
    setPreview(undefined)
  }

  function selectSkill(skillId: string): void {
    const skill = skillById.get(skillId)
    if (!skill) return
    setSelection({ kind: 'skill', skillId })
    clearPreview()
    setExpanded(current => current.has('group:all') ? current : new Set([...current, `root:${skill.rootId}`]))
  }

  async function updateRoot(root: SkillRootSummary, patch: Partial<SkillRootUpdate>): Promise<void> {
    if (!root.removable) return
    const previous = pendingRootUpdates.current.get(root.id) ?? root
    const update = { ...previous, ...patch }
    const normalized = { name: update.name.trim(), shortcutAlias: update.shortcutAlias.trim() }
    if (!normalized.name || normalized.name.length > SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH
      || normalized.shortcutAlias.length > SKILL_SHORTCUT_ALIAS_MAX_LENGTH || !SKILL_SHORTCUT_ALIAS_PATTERN.test(normalized.shortcutAlias)) return
    if (normalized.name === previous.name && normalized.shortcutAlias === previous.shortcutAlias) return
    pendingRootUpdates.current.set(root.id, normalized)
    try { await onUpdateDirectory(root.id, normalized) }
    finally { if (pendingRootUpdates.current.get(root.id) === normalized) pendingRootUpdates.current.delete(root.id) }
  }

  async function showItemInFolder(path: string): Promise<void> {
    try {
      await window.gale.files.showItemInFolder(path)
    } catch {
      notice.error(t('settings.failed_open_skill_path'), { id: 'settings-skill-file-status' })
    }
  }

  async function expandFiles(skillId: string, relativePath?: string): Promise<void> {
    try {
      const key = nodeKey(skillId, relativePath)
      if (!children[key]) {
        const items = await window.gale.skills.listFiles(undefined, skillId, relativePath)
        setChildren((current) => ({ ...current, [key]: items }))
      }
      toggle(`files:${key}`)
    } catch {
      notice.error(t('settings.failed_read_skill_file'), { id: 'settings-skill-file-status' })
    }
  }

  async function selectFile(skillId: string, file: SkillFileNode): Promise<void> {
    const previewRequest = ++previewRequestRef.current
    if (file.kind === 'directory' || file.linkDirectory) {
      setSelection({ kind: 'file', skillId, relativePath: file.relativePath })
      setPreview(undefined)
      await expandFiles(skillId, file.relativePath)
      return
    }
    setSelection({ kind: 'file', skillId, relativePath: file.relativePath })
    try {
      const nextPreview = await window.gale.skills.readFile(undefined, skillId, file.relativePath)
      if (previewRequestRef.current === previewRequest) setPreview(nextPreview)
    } catch {
      if (previewRequestRef.current === previewRequest) {
        setPreview(undefined)
        notice.error(t('settings.failed_read_skill_file'), { id: 'settings-skill-file-status' })
      }
    }
  }

  function renderSkill(skill: SkillSummary, depth: number, showSource = false): ReactNode {
    const isExpanded = expanded.has(`files:${nodeKey(skill.id)}`)
    return <PackageTreeItem key={skill.id} name={skill.name} icon={<Wand2 size={14} aria-hidden="true" />} depth={depth}
      expanded={isExpanded} selected={selection?.kind === 'skill' && selection.skillId === skill.id}
      unavailable={!skill.modelAvailable && !skill.userAvailable} linked={skill.linked} highlighted={skill.scriptAutoApprove}
      badge={[showSource ? `@${skill.shortcutAlias}` : '', skill.loadError ? t('settings.skill_load_error_badge') : ''].filter(Boolean).join(' · ')}
      tooltip={skill.scriptAutoApprove ? t('settings.skill_scripts_auto_approve') : undefined}
      expandLabel={t(isExpanded ? 'settings.skill_collapse' : 'settings.skill_expand', { name: skill.name })}
      onExpand={() => void expandFiles(skill.id)} onSelect={() => selectSkill(skill.id)}>
      <PackageFileTree packageId={skill.id} depth={depth + 1} childrenByKey={children} expanded={expanded}
        selectedPath={selection?.kind === 'file' && selection.skillId === skill.id ? selection.relativePath : undefined}
        onSelect={file => void selectFile(skill.id, file)} />
    </PackageTreeItem>
  }

  function rootLabel(root: SkillRootSummary): string {
    return root.kind === 'system' || root.kind === 'user'
      ? t(`settings.skill_group_${root.kind}`)
      : root.name
  }

  function renderRoot(root: SkillRootSummary): ReactNode {
    const key = `root:${root.id}`
    const rootSkills = allSkills.filter(skill => skill.rootId === root.id)
    return <PackageTreeRoot key={root.id} name={rootLabel(root)} source={root.kind} count={rootSkills.length} expanded={expanded.has(key)}
      selected={selection?.kind === 'root' && selection.rootId === root.id}
      expandLabel={t(expanded.has(key) ? 'settings.package_group_collapse' : 'settings.package_group_expand', { name: rootLabel(root) })}
      onExpand={() => toggle(key)} onSelect={() => { setSelection({ kind: 'root', rootId: root.id }); clearPreview() }}>
      {rootSkills.map(skill => renderSkill(skill, 1))}
    </PackageTreeRoot>
  }

  const selectedExternalIndex = selectedRoot ? externalRoots.findIndex((root) => root.id === selectedRoot.id) : -1
  const rootIssue = selectedRoot?.issue === 'not_found'
    ? t('settings.skill_root_not_found')
    : selectedRoot?.issue === 'not_directory'
      ? t('settings.skill_root_not_directory')
      : t('settings.skill_root_unreadable')

  return (
    <section className={sectionClass}>
      <div className="ui-list-pane">
        <PackageSourceActions addLabel={t('settings.add_skill_directory')} refreshLabel={t('common.refresh')}
          moveUpLabel={t('common.move_up')} moveDownLabel={t('common.move_down')}
          onMoveUp={selectedRoot && selectedExternalIndex > 0 ? () => void onMoveDirectory(selectedRoot.id, -1) : undefined}
          onMoveDown={selectedRoot && selectedExternalIndex >= 0 && selectedExternalIndex < externalRoots.length - 1 ? () => void onMoveDirectory(selectedRoot.id, 1) : undefined}
          onAdd={() => void onAddDirectory()} onRefresh={() => {
            clearPreview(); setChildren({}); setExpanded(current => new Set([...current].filter(key => !key.startsWith('files:'))))
            void onRefresh()
          }} />
        <div className="ui-scroll-list settings-skill-tree">
          <PackageTreeRoot name={t('settings.skill_group_all')} count={allSkills.length} expanded={expanded.has('group:all')}
            selected={selection?.kind === 'all'} icon={<ListTree size={15} />}
            expandLabel={t(expanded.has('group:all') ? 'settings.package_group_collapse' : 'settings.package_group_expand', { name: t('settings.skill_group_all') })}
            onExpand={() => toggle('group:all')} onSelect={() => { setSelection({ kind: 'all' }); clearPreview() }}>
            {sortedSkills.map(skill => renderSkill(skill, 1, true))}
          </PackageTreeRoot>
          {roots.map((root) => renderRoot(root))}
        </div>
      </div>

      <div className="ui-editor settings-skill-viewer">
        {selection?.kind === 'all' && (
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between">
            <div><strong>{t('settings.skill_group_all')}</strong><small>{t('settings.skill_total', { count: allSkills.length })}</small></div>
          </div>
        )}

        {selectedRoot && <>
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between">
            <div><div className="ui-row"><button className="ui-link-button" type="button" disabled={!selectedRoot.available} data-tooltip={t('chat.show_in_folder')} onClick={() => void showItemInFolder(selectedRoot.path)}>{rootLabel(selectedRoot)}</button><small>@{selectedRoot.shortcutAlias}</small></div><small>{selectedRoot.path}</small></div>
            <div className="ui-toolbar">
              {selectedRoot.kind === 'user' && <button className="ui-icon-button" type="button" aria-label={t('settings.import_skill')} data-tooltip={t('settings.import_skill')} onClick={() => void onImportDirectories()}><FolderDown size={14} /></button>}
              {selectedRoot.removable && <>
                <button className="ui-button ui-button-compact ui-button-danger" type="button" onClick={() => onRemoveDirectory(selectedRoot)}>
                  <Trash2 size={UI_ICON_SIZE_SMALL} /> {t('settings.remove_skill_directory')}
                </button>
              </>}
            </div>
          </div>
          {!selectedRoot.available && <div className="ui-note ui-note-danger">{rootIssue}</div>}
          {selectedRoot.removable && (
            <div key={selectedRoot.id} className="settings-skill-root-editor">
              <label className="ui-form-row ui-form-row-wide">
                <span>{t('settings.skill_directory_display_name')}</span>
                <CommitTextInput
                  preserveDirtyDraft
                  className="ui-input"
                  maxLength={SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH}
                  value={selectedRoot.name}
                  onCommit={name => updateRoot(selectedRoot, { name })}
                />
              </label>
              <label className="ui-form-row ui-form-row-wide">
                <span>
                  {t('settings.skill_shortcut_alias')}
                  <small>{t('settings.skill_shortcut_alias_hint')}</small>
                </span>
                <CommitTextInput
                  preserveDirtyDraft
                  className="ui-input"
                  maxLength={SKILL_SHORTCUT_ALIAS_MAX_LENGTH}
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  value={selectedRoot.shortcutAlias}
                  onCommit={shortcutAlias => updateRoot(selectedRoot, { shortcutAlias })}
                />
              </label>
            </div>
          )}
        </>}

        {groupSkills && <PackageList label={t('settings.skills')} emptyLabel={t('settings.skill_group_empty')} onSelect={selectSkill}
          items={groupSkills.map(skill => ({
            id: skill.id, name: skill.name, description: skill.description,
            detail: selection?.kind === 'all' ? `${rootLabel(rootById.get(skill.rootId)!)} · ${skill.dirPath}` : undefined,
            status: skill.loadError ? t('settings.skill_load_error_badge')
              : !skill.modelAvailable && !skill.userAvailable ? t('capabilities.inactive') : undefined
          }))} />}

        {selectedSkill && !preview && selection?.kind === 'skill' && <>
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between">
            <div><button className="ui-link-button" type="button" disabled={selectedSkill.linked && !selectedSkill.resolvedDirPath}
              data-tooltip={t('chat.show_in_folder')} onClick={() => void showItemInFolder(selectedSkill.dirPath)}>{selectedSkill.name}</button></div>
            <div className="ui-toolbar">
              <CheckboxField checked={selectedSkill.modelAvailable} label={t('settings.skill_model_available')} onChange={(modelAvailable) => void onUpdateAvailability(selectedSkill.id, { modelAvailable })} />
              <CheckboxField checked={selectedSkill.userAvailable} label={t('settings.skill_user_available')} onChange={(userAvailable) => void onUpdateAvailability(selectedSkill.id, { userAvailable })} />
              <CheckboxField checked={selectedSkill.scriptAutoApprove} label={t('settings.skill_scripts_auto_approve')}
                onChange={enabled => void onUpdateScriptApproval(selectedSkill.id, enabled)} />
            </div>
          </div>
          {skills?.scriptAutoApprove && <small className="ui-field-hint">{t('settings.skill_scripts_auto_approve_global_active')}</small>}
          {selectedSkillIssue && <div className="ui-note ui-note-danger">{selectedSkillIssueText}{selectedSkillIssue.detail ? ` ${selectedSkillIssue.detail}` : ''}</div>}
          <p>{selectedSkill.description}</p>
          {selectedSkill.compatibility && <p><strong>{t('settings.skill_compatibility')}：</strong>{selectedSkill.compatibility}</p>}
          <dl className="settings-skill-metadata">
            <dt>{t('settings.skill_path')}</dt><dd><button className="ui-link-button" type="button"
              disabled={selectedSkill.linked && !selectedSkill.resolvedDirPath}
              onClick={() => void showItemInFolder(selectedSkill.dirPath)}>{selectedSkill.dirPath}</button></dd>
            <dt>{t('settings.skill_shortcut')}</dt><dd>{selectedSkill.shortcut ?? t('settings.skill_shortcut_unavailable')}</dd>
            {selectedSkill.linked && <><dt>{t('settings.skill_link_target')}</dt><dd>{selectedSkill.linkTarget}</dd><dt>{t('settings.skill_resolved_path')}</dt><dd>{selectedSkill.resolvedDirPath ?? t('settings.skill_link_unavailable')}</dd></>}
            {selectedSkill.modelShadowedBy && <><dt>{t('settings.skill_model_shadowed')}</dt><dd>{selectedSkill.modelShadowedBy}</dd></>}
            {selectedSkill.userShadowedBy && <><dt>{t('settings.skill_user_shadowed')}</dt><dd>{selectedSkill.userShadowedBy}</dd></>}
          </dl>
        </>}

        <PackageFileViewer key={preview?.path} onSave={preview ? async update => {
          const saved = await window.gale.skills.saveFile(undefined, preview.skillId, preview.relativePath, update)
          setPreview(saved)
          void onRefresh()
        } : undefined} preview={preview} file={selection?.kind === 'file' ? selectedFile : undefined} onOpen={showItemInFolder} t={t} />

        {!selection && <div className="ui-empty-state">{t('settings.select_skill_tree_item')}</div>}
      </div>
    </section>
  )
}
