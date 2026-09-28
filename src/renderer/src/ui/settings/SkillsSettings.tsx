import { PackageSourceActions, PackageTreeRoot, PackageTreeItem, PackageFileTree, PackageFileViewer, packageNodeKey as nodeKey } from './PackageTree'
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { FolderOpen, ListTree, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH, SKILL_SHORTCUT_ALIAS_MAX_LENGTH, SKILL_SHORTCUT_ALIAS_PATTERN } from '@shared/types'
import type { SkillAvailabilityUpdate, SkillFileNode, SkillFilePreview, SkillRootSummary, SkillRootUpdate, SkillSnapshot, SkillSummary } from '@shared/types'
import { CheckboxField } from '../CheckboxField'
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
  const [rootDrafts, setRootDrafts] = useState<Record<string, SkillRootUpdate>>({})
  const [selection, setSelection] = useState<Selection>()
  const [preview, setPreview] = useState<SkillFilePreview>()
  const previewRequestRef = useRef(0)
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
  const selectedRootDraft = selectedRoot
    ? rootDrafts[selectedRoot.id] ?? { name: selectedRoot.name, shortcutAlias: selectedRoot.shortcutAlias }
    : undefined
  const selectedRootDraftValid = Boolean(
    selectedRootDraft?.name.trim()
    && selectedRootDraft.name.trim().length <= SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH
    && selectedRootDraft.shortcutAlias.trim().length <= SKILL_SHORTCUT_ALIAS_MAX_LENGTH
    && SKILL_SHORTCUT_ALIAS_PATTERN.test(selectedRootDraft.shortcutAlias.trim())
  )
  const selectedRootDraftDirty = Boolean(
    selectedRoot
    && selectedRootDraft
    && (selectedRootDraft.name.trim() !== selectedRoot.name || selectedRootDraft.shortcutAlias.trim() !== selectedRoot.shortcutAlias)
  )
  const selectedSkill = selection?.kind === 'skill' || selection?.kind === 'file' ? skillById.get(selection.skillId) : undefined
  const showImport = selectedRoot?.kind === 'user' || selectedSkill?.source === 'user'
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
    previewRequestRef.current += 1
    setChildren({})
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

  async function updateRoot(event: FormEvent<HTMLFormElement>, root: SkillRootSummary): Promise<void> {
    event.preventDefault()
    if (!root.removable || !selectedRootDraftValid) return
    const update = rootDrafts[root.id] ?? { name: root.name, shortcutAlias: root.shortcutAlias }
    const normalized = { name: update.name.trim(), shortcutAlias: update.shortcutAlias.trim() }
    if (normalized.name === root.name && normalized.shortcutAlias === root.shortcutAlias) return
    setRootDrafts((current) => ({ ...current, [root.id]: normalized }))
    await onUpdateDirectory(root.id, normalized)
  }

  async function showItemInFolder(path: string): Promise<void> {
    try {
      await window.gale.files.showItemInFolder(path)
    } catch {
      notice.error(t('settings.failed_open_skill_path'), { id: 'settings-skill-file-status' })
    }
  }

  function openButton(path: string, disabled = false): ReactNode {
    return (
      <button className="ui-button ui-button-compact" disabled={disabled} type="button" onClick={() => void showItemInFolder(path)}>
        <FolderOpen size={UI_ICON_SIZE_SMALL} />
        <span>{t('common.open')}</span>
      </button>
    )
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
    return <PackageTreeItem key={skill.id} name={skill.name} depth={depth}
      expanded={isExpanded} selected={selection?.kind === 'skill' && selection.skillId === skill.id}
      unavailable={!skill.modelAvailable && !skill.userAvailable} linked={skill.linked} highlighted={skill.scriptAutoApprove}
      badge={[showSource ? `@${skill.shortcutAlias}` : '', skill.loadError ? t('settings.skill_load_error_badge') : ''].filter(Boolean).join(' · ')}
      tooltip={skill.scriptAutoApprove ? t('settings.skill_scripts_auto_approve') : undefined}
      expandLabel={t(isExpanded ? 'settings.skill_collapse' : 'settings.skill_expand', { name: skill.name })}
      onExpand={() => void expandFiles(skill.id)} onSelect={() => { setSelection({ kind: 'skill', skillId: skill.id }); clearPreview() }}>
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
    return <PackageTreeRoot key={root.id} name={rootLabel(root)} count={rootSkills.length} expanded={expanded.has(key)}
      selected={selection?.kind === 'root' && selection.rootId === root.id}
      onClick={() => { setSelection({ kind: 'root', rootId: root.id }); clearPreview(); toggle(key) }}>
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
        <PackageSourceActions addLabel={t('settings.add_skill_directory')} importLabel={t('settings.import_skill')} refreshLabel={t('common.refresh')}
          onAdd={() => void onAddDirectory()} onImport={showImport ? () => void onImportDirectories() : undefined} onRefresh={() => void onRefresh()} />
        <div className="ui-scroll-list settings-skill-tree">
          <PackageTreeRoot name={t('settings.skill_group_all')} count={allSkills.length} expanded={expanded.has('group:all')}
            selected={selection?.kind === 'all'} icon={<ListTree size={15} />}
            onClick={() => { setSelection({ kind: 'all' }); clearPreview(); toggle('group:all') }}>
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
            <div><strong>{rootLabel(selectedRoot)}</strong><small>{selectedRoot.path}</small></div>
            <div className="ui-toolbar">
              {openButton(selectedRoot.path, !selectedRoot.available)}
              {selectedRoot.removable && <>
                <button className="ui-button ui-button-compact" disabled={selectedExternalIndex <= 0} type="button" onClick={() => void onMoveDirectory(selectedRoot.id, -1)}>↑</button>
                <button className="ui-button ui-button-compact" disabled={selectedExternalIndex < 0 || selectedExternalIndex >= externalRoots.length - 1} type="button" onClick={() => void onMoveDirectory(selectedRoot.id, 1)}>↓</button>
                <button className="ui-button ui-button-compact ui-button-danger" type="button" onClick={() => onRemoveDirectory(selectedRoot)}>
                  <Trash2 size={UI_ICON_SIZE_SMALL} /> {t('settings.remove_skill_directory')}
                </button>
              </>}
            </div>
          </div>
          {!selectedRoot.available && <div className="ui-note ui-note-danger">{rootIssue}</div>}
          {selectedRoot.removable && selectedRootDraft && (
            <form className="settings-skill-root-editor" onSubmit={(event) => void updateRoot(event, selectedRoot)}>
              <label className="ui-form-row ui-form-row-wide">
                <span>{t('settings.skill_directory_display_name')}</span>
                <input
                  className="ui-input"
                  maxLength={SKILL_ROOT_DISPLAY_NAME_MAX_LENGTH}
                  value={selectedRootDraft.name}
                  onChange={(event) => setRootDrafts((current) => ({
                    ...current,
                    [selectedRoot.id]: { ...selectedRootDraft, name: event.target.value }
                  }))}
                />
              </label>
              <label className="ui-form-row ui-form-row-wide">
                <span>
                  {t('settings.skill_shortcut_alias')}
                  <small>{t('settings.skill_shortcut_alias_hint')}</small>
                </span>
                <input
                  className="ui-input"
                  maxLength={SKILL_SHORTCUT_ALIAS_MAX_LENGTH}
                  pattern="[a-z0-9]+(?:-[a-z0-9]+)*"
                  value={selectedRootDraft.shortcutAlias}
                  onChange={(event) => setRootDrafts((current) => ({
                    ...current,
                    [selectedRoot.id]: { ...selectedRootDraft, shortcutAlias: event.target.value }
                  }))}
                />
              </label>
              <div className="settings-skill-root-editor-actions">
                <button className="ui-button ui-button-compact" disabled={!selectedRootDraftValid || !selectedRootDraftDirty} type="submit">
                  {t('common.save')}
                </button>
              </div>
            </form>
          )}
          <dl className="settings-skill-metadata">
            <dt>{t('settings.skill_source')}</dt><dd>{selectedRoot.kind}</dd>
            {!selectedRoot.removable && <><dt>{t('settings.skill_shortcut_alias')}</dt><dd>@{selectedRoot.shortcutAlias}</dd></>}
          </dl>
        </>}

        {selectedSkill && !preview && selection?.kind === 'skill' && <>
          <div className="settings-skill-viewer-heading ui-toolbar ui-toolbar-between">
            <div><strong>{selectedSkill.name}</strong></div>
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

        <PackageFileViewer preview={preview} file={selection?.kind === 'file' ? selectedFile : undefined} openButton={openButton} t={t} />

        {!selection && <div className="ui-empty-state">{t('settings.select_skill_tree_item')}</div>}
      </div>
    </section>
  )
}
