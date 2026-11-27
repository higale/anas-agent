import * as Tabs from '@radix-ui/react-tabs'
import * as Dialog from '@radix-ui/react-dialog'
import { Folder, FolderPlus, Plus, Save, X } from 'lucide-react'
import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { DragEvent, FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  isDefaultWorkspaceProject,
  type AppConfigSnapshot,
  type Project,
  type ProjectCreateRequest,
  type ProjectIconColor,
  type ProjectIconName,
  type ProjectModelSelection
} from '@shared/types'
import { findProviderModelConfig } from '@shared/modelConfig'
import { unwrapProjectResult } from '@shared/projectOperation'
import { getAvailableProjectName } from '@shared/projectName'
import { projectErrorDescription } from './projectErrorDescription'
import { defaultCapabilities, defaultProjectSettings, defaultRestrictSubagents, removeEmptyMissingMcpSelections } from '@shared/agentCapabilities'
import type { SkillSnapshot, McpToolStatus, RuntimeToolStatus } from '@shared/types'
import { CapabilityEditor } from '../CapabilityEditor'
import { notice } from '../notice'
import { CheckboxField } from '../CheckboxField'
import { CheckboxButton } from '../CheckboxButton'
import type { AgentAccessMode } from '@shared/agentTypes'
import { ComposerAccessPicker } from '../chat/ComposerAccessPicker'
import { ModelPicker } from '../model/ModelPicker'
import { ModelParameterPresetPicker } from '../model/ModelParameterPresetPicker'
import { projectDraftModelSelection } from '@shared/draftModelSelection'
import { dataTransferHasFiles } from '../dragDrop'
import { ProjectAppearancePicker } from './ProjectAppearancePicker'
import { ProjectPromptPreviews } from './ProjectPromptPreviews'
import { compressionPromptError, COMPRESSION_PROMPT_MAX_LENGTH, summaryPromptForLanguage } from '@shared/summaryPrompt'
import { getLanguageOptions, resolveLanguagePreference } from '../../i18n'
import type { ToolSnapshot } from '@shared/toolPackages'

interface ProjectDialogProps {
  open: boolean
  project?: Project
  projects?: Project[]
  config?: AppConfigSnapshot
  currentModelSelection?: ProjectModelSelection
  onClose: () => void
  onSave: (request: ProjectCreateRequest) => Promise<Project>
}

export function ProjectDialog({ open, project, projects = [], config, currentModelSelection, onClose, onSave }: ProjectDialogProps) {
  const { t } = useTranslation()
  const nameInputId = useId()
  const [name, setName] = useState('')
  const [icon, setIcon] = useState<ProjectIconName>()
  const [iconData, setIconData] = useState<string>()
  const [iconEmoji, setIconEmoji] = useState<string>()
  const [iconColor, setIconColor] = useState<ProjectIconColor>()
  const [projectTools, setProjectTools] = useState<ToolSnapshot>()
  const [sourceFolders, setSourceFolders] = useState<string[]>([])
  const [defaultDirectory, setDefaultDirectory] = useState('')
  const [skillDirectories, setSkillDirectories] = useState<string[]>([])
  const [toolDirectories, setToolDirectories] = useState<string[]>([])
  const [choosingTools, setChoosingTools] = useState(false)
  const [choosingSkills, setChoosingSkills] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [compressionPrompt, setCompressionPrompt] = useState('')
  const [promptTab, setPromptTab] = useState('project')
  const compressionError = compressionPromptError(compressionPrompt)
  const [codingMode, setCodingMode] = useState(defaultProjectSettings.codingMode)
  const [capabilities, setCapabilities] = useState(() => structuredClone(defaultCapabilities))
  const [restrictSubagents, setRestrictSubagents] = useState(defaultRestrictSubagents)
  const [skills, setSkills] = useState<SkillSnapshot>()
  const [mcpStatus, setMcpStatus] = useState<McpToolStatus>()
  const [runtimeToolStatus, setRuntimeToolStatus] = useState<RuntimeToolStatus>()
  const [accessMode, setAccessMode] = useState<AgentAccessMode>('smart_approval')
  const [modelConfigId, setModelConfigId] = useState<string>()
  const [modelParameterPresetId, setModelParameterPresetId] = useState<string | null>()
  const [iconPending, setIconPending] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dragActive, setDragActive] = useState(false)
  const nameInputRef = useRef<HTMLInputElement | null>(null)
  const dragDepthRef = useRef(0)
  const editing = Boolean(project)
  const defaultWorkspace = project ? isDefaultWorkspaceProject(project) : false
  const selection = projectDraftModelSelection(config?.providers, { modelConfigId, modelParameterPresetId })
  const selectedModel = findProviderModelConfig(config?.providers ?? [], selection?.modelConfigId)
  const draft = useMemo<ProjectCreateRequest>(() => {
    const preferences = {
      name: name.trim(),
      ...(icon ? { icon } : {}),
      ...(iconData ? { iconData } : {}),
      ...(iconEmoji ? { iconEmoji } : {}),
      ...(iconColor ? { iconColor } : {}),
      ...(modelConfigId ? { modelConfigId, modelParameterPresetId } : {})
    }
    return { ...preferences, sourceFolders, skillDirectories, toolDirectories,
        capabilities: config ? removeEmptyMissingMcpSelections(capabilities, new Set(config.mcpServers.map((server) => server.id))) : capabilities,
        restrictSubagents, prompt, codingMode, ...(accessMode !== 'smart_approval' ? { accessMode } : {}), ...(compressionPrompt.trim() ? { compressionPrompt } : {}) }
  }, [accessMode, capabilities, codingMode, compressionPrompt, config, icon, iconColor, iconData, iconEmoji, modelConfigId,
    modelParameterPresetId, name, prompt, restrictSubagents, sourceFolders, skillDirectories, toolDirectories])

  useEffect(() => {
    if (!open) return
    const selectedCodingMode = project?.codingMode ?? defaultProjectSettings.codingMode
    setName(project?.name ?? '')
    setIcon(project?.icon)
    setIconData(project?.iconData)
    setIconEmoji(project?.iconEmoji)
    setIconColor(project?.iconColor)
    setSourceFolders(project ? project.sourceFolders : [])
    setSkillDirectories(project ? project.skillDirectories ?? [] : [])
    setToolDirectories(project ? project.toolDirectories ?? [] : [])
    setPrompt(project?.prompt ?? defaultProjectSettings.prompt)
    setCodingMode(selectedCodingMode)
    setCapabilities(structuredClone(project ? project.capabilities : defaultCapabilities))
    setRestrictSubagents(project ? project.restrictSubagents : defaultRestrictSubagents)
    setAccessMode(project ? project.accessMode ?? 'smart_approval' : 'smart_approval')
    setModelConfigId(project?.modelConfigId)
    setModelParameterPresetId(project?.modelParameterPresetId)
    setCompressionPrompt(project ? project.compressionPrompt ?? '' : '')
    setPromptTab('project')
    setBusy(false)
    dragDepthRef.current = 0
    setDragActive(false)
  }, [open, project])

  // Saving can acknowledge an optimistic setting without changing its value.
  // Re-read the effective path when that settings snapshot is replaced.
  useEffect(() => {
    if (!open) return
    let disposed = false
    void window.gale.projects.getDefaultDirectory().then(directory => {
      if (!disposed) setDefaultDirectory(directory)
    }).catch(reason => {
      if (!disposed) notice.error(t('chat.failed_load_app'), { description: projectErrorDescription(reason, t) })
    })
    return () => { disposed = true }
  }, [open, config?.settings, t])

  function loadDefaultCompressionPrompt(): void {
    const code = resolveLanguagePreference(config?.settings.language)
    const name = getLanguageOptions().find(language => language.code === code)?.name ?? code
    setCompressionPrompt(summaryPromptForLanguage({ code, name }, codingMode))
  }

  useEffect(() => {
    if (!open) return
    let disposed = false
    let receivedMcpStatus = false
    setMcpStatus(undefined)
    setRuntimeToolStatus(undefined)
    const unsubscribe = window.gale.mcp.onStatus((status) => {
      receivedMcpStatus = true
      if (!disposed) setMcpStatus(status)
    })
    void Promise.all([window.gale.mcp.status(), window.gale.app.getRuntimeTools()])
      .then(([mcp, tools]) => {
        if (disposed) return
        if (!receivedMcpStatus) setMcpStatus(mcp ?? undefined)
        setRuntimeToolStatus(tools)
      }).catch((reason) => { if (!disposed) notice.error(t('chat.failed_load_app'), { description: projectErrorDescription(reason, t) }) })
    return () => { disposed = true; unsubscribe() }
  }, [open, project?.id, t])

  useEffect(() => {
    if (!open) return
    let disposed = false
    setSkills(undefined)
    void window.gale.skills.get(project?.id, skillDirectories)
      .then((snapshot) => { if (!disposed) setSkills(snapshot) })
      .catch((reason) => { if (!disposed) notice.error(t('chat.failed_load_app'), { description: projectErrorDescription(reason, t) }) })
    return () => { disposed = true }
  }, [open, project?.id, skillDirectories, t])
  useEffect(() => {
    let cancelled = false
    setProjectTools(undefined)
    if (open) void window.gale.tools.get(project?.id, toolDirectories).then(snapshot => {
      if (!cancelled) setProjectTools(snapshot)
    }).catch(error => { if (!cancelled) notice.error(t('custom_tools.update_failed'), { description: String(error) }) })
    return () => { cancelled = true }
  }, [open, project?.id, toolDirectories, config?.customTools, t])


  function appendSourceFolders(folders: string[]): void {
    setSourceFolders((current) => Array.from(new Set([...current, ...folders])))
  }

  function setPrimarySourceFolder(folder: string): void {
    setSourceFolders((current) => [folder, ...current.filter((item) => item !== folder)])
  }

  async function chooseDirectories(kind: 'skill' | 'tool'): Promise<void> {
    const setChoosing = kind === 'skill' ? setChoosingSkills : setChoosingTools
    const setDirectories = kind === 'skill' ? setSkillDirectories : setToolDirectories
    setChoosing(true)
    try {
      const selected = unwrapProjectResult(await (kind === 'skill'
        ? window.gale.projects.chooseSkillDirectories() : window.gale.projects.chooseToolDirectories()))
      if (selected.length) setDirectories(current => [...new Set([...current, ...selected])])
    } catch (reason) {
      notice.error(t(`project.failed_choose_${kind}_directories`), { description: projectErrorDescription(reason, t) })
    } finally { setChoosing(false) }
  }

  async function chooseSourceFolders(): Promise<void> {
    try {
      const selected = unwrapProjectResult(await window.gale.projects.chooseSourceFolders())
      if (selected.length === 0) return
      appendSourceFolders(selected)
    } catch (reason) {
      notice.error(t('project.failed_choose_folders'), { description: projectErrorDescription(reason, t) })
    }
  }

  function handleDragEnter(event: DragEvent<HTMLDivElement>): void {
    if (busy || !dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current += 1
    setDragActive(true)
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>): void {
    if (busy || !dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    event.dataTransfer.dropEffect = 'copy'
    setDragActive(true)
  }

  function handleDragLeave(event: DragEvent<HTMLDivElement>): void {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)
    if (dragDepthRef.current === 0) setDragActive(false)
  }

  async function handleDrop(event: DragEvent<HTMLDivElement>): Promise<void> {
    if (!dataTransferHasFiles(event.dataTransfer)) return
    event.preventDefault()
    dragDepthRef.current = 0
    setDragActive(false)
    if (busy) return
    const droppedFiles = Array.from(event.dataTransfer.files)
    if (droppedFiles.length === 0) return
    try {
      const selected = unwrapProjectResult(await window.gale.projects.fromDroppedFiles(droppedFiles))
      appendSourceFolders(selected)
    } catch (reason) {
      notice.error(t('project.failed_drop_folders'), { description: projectErrorDescription(reason, t) })
    }
  }

  async function handleSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    if (compressionError || iconPending) return
    if (busy) return
    setBusy(true)
    try {
      await onSave(draft)
      onClose()
    } catch (reason) {
      notice.error(t(editing ? 'project.failed_update' : 'project.failed_create'), { description: projectErrorDescription(reason, t) })
      setBusy(false)
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(nextOpen) => { if (!nextOpen && !busy) onClose() }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content
          asChild
          className="ui-dialog ui-dialog-medium ui-dialog-font-scaled ui-dialog-centered ui-dialog-safe-area ui-dialog-fixed-footer ui-popover project-dialog ui-dialog-split"
          onPointerDownOutside={(event) => event.preventDefault()}
          onOpenAutoFocus={(event) => {
            if (!defaultWorkspace) {
              event.preventDefault()
              nameInputRef.current?.focus({ preventScroll: true })
            }
          }}
        >
          <form onSubmit={(event) => void handleSubmit(event)}>
            <div className="ui-dialog-body ui-dialog-panes">
              <div className="ui-dialog-pane ui-dialog-pane-fill">
                <div className="ui-form-section ui-form-section-fill">
                  <header className="ui-dialog-header project-dialog-header">
                    <ProjectAppearancePicker
                      key={project?.id ?? 'new'}
                      disabled={busy}
                      onPendingChange={setIconPending}
                      iconData={iconData}
                      onChangeImage={setIconData}
                      emoji={iconEmoji}
                      onChangeEmoji={setIconEmoji}
                      color={iconColor}
                      icon={icon}
                      onChangeColor={setIconColor}
                      onChangeIcon={setIcon}
                    />
                    <div>
                      <div className="project-dialog-title-row">
                        <Dialog.Title asChild>
                          <h2 className="ui-dialog-title">{t(editing ? 'project.edit_title' : 'project.create_title')}</h2>
                        </Dialog.Title>
                        {defaultWorkspace && <span className="project-default-badge">{t('common.default')}</span>}
                      </div>
                      <Dialog.Description asChild>
                        <p className="ui-dialog-description">
                          {t(defaultWorkspace ? 'project.edit_default_description' : editing ? 'project.edit_description' : 'project.create_description')}
                        </p>
                      </Dialog.Description>
                    </div>
                    {open && <ProjectPromptPreviews project={draft} projectId={project?.id} settings={config?.settings}
                      currentModelSelection={currentModelSelection} disabled={busy} />}
                  </header>

                  <div className="ui-field-stack">
                    <label className="ui-field-label" htmlFor={nameInputId}>{t('project.name')}</label>
                    <input
                      className="ui-input"
                      id={nameInputId}
                      ref={nameInputRef}
                      value={name}
                      readOnly={defaultWorkspace}
                      maxLength={80}
                      onChange={(event) => setName(event.target.value)}
                      placeholder={getAvailableProjectName(projects, t('project.untitled_name_prefix'), project?.id)}
                    />
                  </div>

                  <Tabs.Root value={promptTab} onValueChange={setPromptTab}
                    className="ui-field-stack ui-field-stack-fill project-prompt-tabs">
                    <div className="ui-toolbar ui-toolbar-between">
                      <Tabs.List className="ui-tab-list" aria-label={t('project.prompt_tabs')}>
                        {(['project', 'compression'] as const).map(tab => <div key={tab} className="ui-tab-item" data-active={promptTab === tab}>
                          <Tabs.Trigger className="ui-tab-trigger" value={tab} disabled={busy}>
                            {t(tab === 'project' ? 'project.project_prompt' : 'settings.view_context_compression_prompt')}
                          </Tabs.Trigger>
                        </div>)}
                      </Tabs.List>
                      {promptTab === 'compression' && <button type="button" className="ui-button ui-button-compact"
                        disabled={busy} onClick={loadDefaultCompressionPrompt}>{t('project.load_default_prompt')}</button>}
                    </div>
                    <Tabs.Content value="project" tabIndex={-1} className="ui-tab-content ui-field-stack ui-field-stack-fill">
                      <textarea aria-label={t('project.project_prompt')} className="ui-textarea ui-textarea-fixed ui-code-textarea ui-textarea-wrap" value={prompt}
                        maxLength={50_000} rows={2} disabled={busy} onChange={(event) => setPrompt(event.target.value)} />
                    </Tabs.Content>
                    <Tabs.Content value="compression" tabIndex={-1} className="ui-tab-content ui-field-stack ui-field-stack-fill">
                      <textarea aria-label={t('settings.view_context_compression_prompt')} className="ui-textarea ui-textarea-fixed ui-code-textarea ui-textarea-wrap"
                        value={compressionPrompt} maxLength={COMPRESSION_PROMPT_MAX_LENGTH} rows={2} disabled={busy}
                        placeholder={t('project.compression_prompt_placeholder')} aria-invalid={Boolean(compressionError)}
                        onChange={event => setCompressionPrompt(event.target.value)} />
                      <div className={compressionError ? 'ui-field-hint ui-status-danger' : 'ui-field-hint'}>
                        {t(compressionError ? 'project.compression_prompt_invalid' : 'project.compression_prompt_hint')}
                      </div>
                    </Tabs.Content>
                  </Tabs.Root>

                  <section className="ui-field-stack">
                    <div className="ui-row-between">
                      <span className="ui-field-label">{t('project.source_folders')}</span>
                    </div>

                    <div
                      className={dragActive ? 'project-folders drag-active' : 'project-folders'}
                      data-empty={sourceFolders.length === 0 ? true : undefined}
                      onDragEnter={handleDragEnter}
                      onDragOver={handleDragOver}
                      onDragLeave={handleDragLeave}
                      onDrop={(event) => void handleDrop(event)}
                    >
                      {sourceFolders.length > 0 && <div className="project-folder-list">
                        {sourceFolders.map((folder, index) => (
                          <div
                            className="project-folder-item"
                            data-multiple={sourceFolders.length > 1 ? true : undefined}
                            key={folder}
                          >
                            <Folder size={15} />
                            <span className="ui-truncate" title={folder}>{folder}</span>
                            {sourceFolders.length > 1 && (index === 0 ? (
                              <span className="project-folder-primary-badge">{t('project.primary_folder')}</span>
                            ) : (
                              <button
                                className="project-folder-set-primary"
                                type="button"
                                disabled={busy}
                                onClick={() => setPrimarySourceFolder(folder)}
                              >
                                {t('project.set_primary_folder')}
                              </button>
                            ))}
                            <button
                              className="ui-icon-button"
                              type="button"
                              disabled={busy}
                              aria-label={t('project.remove_folder', { folder })}
                              onClick={() => setSourceFolders((folders) => folders.filter((item) => item !== folder))}
                            >
                              <X size={14} />
                            </button>
                          </div>
                        ))}
                      </div>}
                      <button
                        className="project-folder-add"
                        type="button"
                        aria-label={t(dragActive ? 'project.drop_folders' : 'project.add_folders')}
                        onClick={() => void chooseSourceFolders()}
                        disabled={busy}
                      >
                        <span className="project-folder-add-label">
                          <FolderPlus size={18} />
                          <span>{t(dragActive ? 'project.drop_folders' : 'project.add_folders')}</span>
                        </span>
                        {sourceFolders.length === 0 && <span className="project-folder-item" data-default>
                          <span className="ui-truncate" title={defaultDirectory}>{t('project.default_directory_hint', {
                            directory: defaultDirectory || t('settings.project_default_directory')
                          })}</span>
                        </span>}
                      </button>
                    </div>
                  </section>
                  <div className="ui-row">
                    <ComposerAccessPicker modal disabled={busy} accessMode={accessMode} onChange={setAccessMode} />
                    <div className="composer-model-selection-group ui-push-end">
                      <ModelPicker
                        modal
                        providers={config?.providers}
                        selectedId={selection?.modelConfigId}
                        defaultModelId={config?.defaultModelId}
                        disabled={busy || !config}
                        onClear={() => {
                          setModelConfigId(undefined)
                          setModelParameterPresetId(undefined)
                        }}
                        onSelect={(id) => {
                          setModelConfigId(id)
                          setModelParameterPresetId(findProviderModelConfig(config?.providers ?? [], id)?.defaultParameterPresetId ?? null)
                        }}
                      />
                      <ModelParameterPresetPicker
                        modal
                        disabled={busy}
                        model={selectedModel}
                        selectedId={selection?.modelParameterPresetId ?? undefined}
                        onSelect={setModelParameterPresetId}
                      />
                    </div>
                  </div>
                </div>
              </div>
              <section className="ui-dialog-pane ui-form-section" aria-label={t('settings.capabilities')}>
                <h3 className="ui-dialog-title">{t('settings.capabilities')}</h3>
                <CapabilityEditor customTools={projectTools?.tools} customToolRoots={projectTools?.roots} value={capabilities} skills={skills} mcpStatus={mcpStatus} mcpServers={config?.mcpServers} runtimeToolStatus={runtimeToolStatus} disabled={busy}
                  subagents={config?.subagents ?? []} restrictSubagents={restrictSubagents}
                  onChange={setCapabilities}
                  projectTools={{
                    disabled: choosingTools,
                    onAddDirectories: () => void chooseDirectories('tool'),
                    onRemoveDirectory: path => setToolDirectories(current => current.filter(directory => directory !== path))
                  }}
                  projectSkills={{
                    disabled: choosingSkills,
                    onAddDirectories: () => void chooseDirectories('skill'),
                    onRemoveDirectory: path => setSkillDirectories(current => current.filter(directory => directory !== path))
                  }}
                  onEnableAll={(capabilities) => { setCapabilities(capabilities); setRestrictSubagents(false) }}
                  toolbarEnd={<CheckboxButton label={t('capabilities.restrict_subagents')} checked={restrictSubagents} disabled={busy}
                    tooltip={t('capabilities.restrict_subagents_hint')} onChange={setRestrictSubagents} />} />
              </section>
            </div>

            <footer className="ui-dialog-footer">
              <div className="ui-row ui-row-lg ui-dialog-footer-start">
                <CheckboxField className="ui-checkbox-field-inline" checked={codingMode} disabled={busy}
                  label={t('project.coding_mode')} onChange={setCodingMode} />
              </div>
              <Dialog.Close asChild>
                <button className="ui-button ui-button-compact" type="button" disabled={busy}>
                  <X size={14} />
                  <span>{t('common.cancel')}</span>
                </button>
              </Dialog.Close>
              <button
                className="ui-button ui-button-compact ui-button-primary"
                type="submit"
                disabled={busy || iconPending || Boolean(compressionError)}
              >
                {editing ? <Save size={14} /> : <Plus size={14} />}
                <span>{t(editing ? 'common.save' : 'project.create')}</span>
              </button>
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
