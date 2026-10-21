import { useState, type DragEvent, type FormEvent, type RefObject } from 'react'
import { PanelLeftOpen, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  AppAvatarImage,
  AppConfigSnapshot,
  AppProfileUpdate,
  AppSettings,
  LanguagePackSummary,
  McpToolStatus,
  ModelProviderConfigDetail,
  Project,
  RuntimeToolStatus,
  SkillAvailabilityUpdate,
  SkillRootSummary,
  SkillRootUpdate,
  SkillSnapshot,
  SpeechReplyConfig,
  StorageUsageValue
} from '@shared/types'
import type { ModelDraft } from '../model/modelDraft'
import { ModelSettings } from '../model/ModelSettings'
import type { McpDraft } from '../mcp/mcpDraft'
import { McpSettings } from '../mcp/McpSettings'
import { ChatModeSettings } from './ChatModeSettings'
import { EnvironmentSettingsSections } from './EnvironmentSettingsSections'
import { DeveloperHttpTraceSettings } from './DeveloperHttpTraceSettings'
import { DeveloperActions } from './DeveloperActions'
import { GeneralSettingsSections } from './GeneralSettingsSections'
import { LogSettings } from './LogSettings'
import { MemorySettings } from './MemorySettings'
import { SegmentedMultiSelect } from '../SegmentedMultiSelect'
import { formatDateTime } from '../formatDateTime'
import { SkillsSettings } from './SkillsSettings'
import { PackageActions } from './PackageActions'
import type { SubagentDraft } from '../subagent/subagentDraft'
import { SubagentSettings } from '../subagent/SubagentSettings'
import { settingsTabs, type SettingsTab } from './settingsTabs'
import { ToolsSettings } from './ToolsSettings'
import { PluginsSettings } from './PluginsSettings'
import type { PluginSummary } from '@shared/plugins'
import type { MemorySettingsState } from './useMemorySettingsState'

interface SettingsScreenProps {
  plugins: PluginSummary[]
  pluginError?: string
  onRefreshPlugins(): Promise<void>
  onConfigChange(config: AppConfigSnapshot): void
  activeTab: SettingsTab
  avatar: AppAvatarImage | null
  avatarDragActive: boolean
  backupDir?: string
  config: AppConfigSnapshot | undefined
  dataDirectoryUsage?: StorageUsageValue
  developerHttpTraceEnabled: boolean
  developerHttpTraceUsage?: StorageUsageValue
  developerHttpTraceUsageLoading: boolean
  editingMcpIndex?: number
  editingModelIndex?: number
  editingProvider?: ModelProviderConfigDetail
  editingProviderModelIndex?: number
  envDraft: string
  envPath?: string
  error?: string
  languageOptions: LanguagePackSummary[]
  mcpDraft: McpDraft
  mcpListRef: RefObject<HTMLDivElement | null>
  mcpReloadingFailed: boolean
  mcpRuntimeEnabled: boolean
  mcpStatus: McpToolStatus | undefined
  runtimeToolStatus: RuntimeToolStatus | undefined
  subagentDraft: SubagentDraft
  subagentListRef: RefObject<HTMLDivElement | null>
  editingSubagentIndex?: number
  memory: MemorySettingsState
  modelCandidates: string[]
  modelDraft: ModelDraft
  modelListLoading: boolean
  modelListRef: RefObject<HTMLDivElement | null>
  projects: Project[]
  settingsContentRef: RefObject<HTMLDivElement | null>
  sidebarVisible: boolean
  skills: SkillSnapshot | undefined
  systemLanguage: string
  storageUsageLoading: boolean
  onAddMcpServer: () => void | Promise<void>
  onRefreshSubagents: (importPackage?: boolean) => Promise<void>
  onAddSubagent: () => void | Promise<void>
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onAvatarDragEnter: (event: DragEvent<HTMLButtonElement>) => void
  onAvatarDragLeave: (event: DragEvent<HTMLButtonElement>) => void
  onAvatarDragOver: (event: DragEvent<HTMLButtonElement>) => void
  onAvatarDrop: (event: DragEvent<HTMLButtonElement>) => void | Promise<void>
  onBackupDataDirectory: () => void | Promise<void>
  onEditAvatar: () => void | Promise<void>
  onClearAvatar: () => void | Promise<void>
  onCreateModel: (templateId?: string) => void | Promise<void>
  onAddProviderModels: (models: string[]) => boolean | void | Promise<boolean | void>
  onDeleteMcpServer: () => void | Promise<void>
  onDeleteSubagent: () => void | Promise<void>
  onDeleteModel: () => void | Promise<void>
  onDeleteProviderModel: () => boolean | void | Promise<boolean | void>
  onAddSkillDirectory: () => void | Promise<void>
  onImportSkills: () => Promise<string | undefined>
  onEditMcpServer: (index: number) => void | Promise<void>
  onEditSubagent: (index: number) => void
  onEditModel: (index: number) => void | Promise<void>
  onMoveMcpServer: (direction: -1 | 1) => void | Promise<void>
  onMoveSubagent: (direction: -1 | 1) => void | Promise<void>
  onMoveModel: (direction: -1 | 1) => void | Promise<void>
  onMoveProviderModel: (direction: -1 | 1) => void | Promise<void>
  onSelectProviderModel: (index: number) => boolean | void | Promise<boolean | void>
  onOpenEnvFile: () => void | Promise<void>
  onOpenDataCleanup: () => void
  onOpenDataDirectory: () => void | Promise<void>
  onOpenDeveloperHttpTraceDirectory: () => void | Promise<void>
  onOpenLogDirectory: () => void | Promise<void>
  onOpenRuntimeLogViewer: () => void | Promise<void>
  onRefreshModelCandidates: () => void | Promise<void>
  onReloadFailedMcpServers: () => void | Promise<void>
  onRestoreDataDirectory: () => void | Promise<void>
  onSaveLanguage: (language: string) => void | Promise<void>
  onSaveProfile: (profile: AppProfileUpdate) => void | Promise<void>
  onSaveSettings: (settings: Partial<AppSettings>) => void | Promise<void>
  onDeveloperHttpTraceEnabledChange: (enabled: boolean) => void | Promise<void>
  onSaveSpeechReply: (settings: Partial<SpeechReplyConfig>) => void | Promise<void>
  onMoveSkillDirectory: (rootId: string, direction: -1 | 1) => void | Promise<void>
  onRefreshSkills: () => void | Promise<void>
  onUpdateSkillDirectory: (rootId: string, update: SkillRootUpdate) => void | Promise<void>
  onRemoveSkillDirectory: (root: SkillRootSummary) => void
  onToggleSidebar: () => void | Promise<void>
  onUpdateEnvDraft: (value: string) => void
  onUpdateMcpDraft: (update: Partial<McpDraft>) => void
  onUpdateSubagentDraft: (update: Partial<SubagentDraft>) => void
  onUpdateModelDraft: (update: Partial<ModelDraft>) => void
  onSaveModelDetails: (draft: ModelDraft) => Promise<void>
  onUpdateSkillScriptApproval: (skillId: string | undefined, enabled: boolean) => void | Promise<void>
  onUpdateSkillAvailability: (skillId: string, update: SkillAvailabilityUpdate) => void | Promise<void>
}

function settingsSectionClass(activeTab: SettingsTab, tab: SettingsTab, extra = ''): string {
  return ['settings-section', 'ui-page-section', 'ui-surface', extra, activeTab === tab ? '' : 'settings-section-hidden'].filter(Boolean).join(' ')
}

export function SettingsScreen({
  plugins, pluginError, onRefreshPlugins,
  onConfigChange,
  activeTab,
  avatar,
  avatarDragActive,
  backupDir,
  config,
  dataDirectoryUsage,
  developerHttpTraceEnabled,
  developerHttpTraceUsage,
  developerHttpTraceUsageLoading,
  editingMcpIndex,
  editingModelIndex,
  editingProvider,
  editingProviderModelIndex,
  envDraft,
  envPath,
  error,
  languageOptions,
  mcpDraft,
  mcpListRef,
  mcpReloadingFailed,
  mcpRuntimeEnabled,
  mcpStatus,
  runtimeToolStatus,
  subagentDraft,
  subagentListRef,
  editingSubagentIndex,
  memory,
  modelCandidates,
  modelDraft,
  modelListLoading,
  modelListRef,
  projects,
  settingsContentRef,
  sidebarVisible,
  skills,
  systemLanguage,
  storageUsageLoading,
  onAddMcpServer,
  onAddSubagent,
  onRefreshSubagents,
  onAutosizeInput,
  onAvatarDragEnter,
  onAvatarDragLeave,
  onAvatarDragOver,
  onAvatarDrop,
  onBackupDataDirectory,
  onEditAvatar,
  onClearAvatar,
  onCreateModel,
  onAddProviderModels,
  onDeleteMcpServer,
  onDeleteSubagent,
  onDeleteModel,
  onDeleteProviderModel,
  onAddSkillDirectory,
  onImportSkills,
  onEditMcpServer,
  onEditSubagent,
  onEditModel,
  onMoveMcpServer,
  onMoveSubagent,
  onMoveModel,
  onMoveProviderModel,
  onSelectProviderModel,
  onOpenEnvFile,
  onOpenDataCleanup,
  onOpenDataDirectory,
  onOpenDeveloperHttpTraceDirectory,
  onOpenLogDirectory,
  onOpenRuntimeLogViewer,
  onRefreshModelCandidates,
  onReloadFailedMcpServers,
  onRestoreDataDirectory,
  onSaveLanguage,
  onSaveProfile,
  onSaveSettings,
  onDeveloperHttpTraceEnabledChange,
  onSaveSpeechReply,
  onMoveSkillDirectory,
  onRefreshSkills,
  onUpdateSkillDirectory,
  onRemoveSkillDirectory,
  onToggleSidebar,
  onUpdateEnvDraft,
  onUpdateMcpDraft,
  onUpdateSubagentDraft,
  onUpdateModelDraft,
  onSaveModelDetails,
  onUpdateSkillScriptApproval,
  onUpdateSkillAvailability
}: SettingsScreenProps) {
  const { t } = useTranslation()
  const [skillToReveal, setSkillToReveal] = useState<string>()
  const [packageActionsTarget, setPackageActionsTarget] = useState<HTMLDivElement | null>(null)
  const sectionClass = (tab: SettingsTab, extra = ''): string => settingsSectionClass(activeTab, tab, extra)
  const sidebarLabel = t('chat.show_sidebar')
  const activeTabDefinition = settingsTabs.find((tab) => tab.id === activeTab)
  const pageDescription = activeTab === 'mcp' && mcpStatus
      ? t('settings.mcp_status_summary', { servers: mcpStatus.servers.length, tools: mcpStatus.toolNames.length, checkedAt: formatDateTime(mcpStatus.checkedAt) })
      : undefined

  return (
    <main className="workspace workspace-workbench settings-workspace ui-main" aria-label={t('settings.title')}>
      <header className="topbar settings-topbar ui-main">
        {!sidebarVisible && (
          <button
            className="topbar-sidebar-toggle ui-tool-button ui-tool-button-square"
            type="button"
            aria-label={sidebarLabel}
            data-tooltip={sidebarLabel}
            onClick={() => void onToggleSidebar()}
          >
            <PanelLeftOpen size={18} />
          </button>
        )}
      </header>
      <div className="settings-content workspace-content-scroll ui-content ui-content-scroll ui-layer-content" ref={settingsContentRef}>
          <header className="settings-page-header">
            <div className="ui-copy-stack">
              <h1 className="settings-page-title">{activeTabDefinition ? t(activeTabDefinition.labelKey) : ''}</h1>
              {pageDescription && <div className="ui-field-hint">{pageDescription}</div>}
            </div>
            {(activeTab === 'subagents' || activeTab === 'tools') && <div className="ui-toolbar" ref={setPackageActionsTarget} />}
            {activeTab === 'mcp' && <div className="ui-toolbar">
              <button className="ui-button" type="button" disabled={!config}
                data-tooltip={t('settings.new_mcp_server')} onClick={() => void onAddMcpServer()}>
                <Plus size={14} aria-hidden="true" />{t('settings.new_mcp_server')}
              </button>
            </div>}
            {activeTab === 'skills' && <div className="ui-toolbar">
              <PackageActions resource="skill" destination={t('settings.skill_group_user')} disabled={!skills}
                addDirectory={{ label: t('settings.add_skill_directory'), onClick: () => void onAddSkillDirectory() }}
                importLabel={t('settings.import_skill')} onImport={async () => {
                  const importedId = await onImportSkills()
                  if (importedId) setSkillToReveal(importedId)
                }} />
              <SegmentedMultiSelect ariaLabel={t('settings.skill_scripts_auto_approve_all')}
                disabled={!skills}
                options={[{ value: 'scriptAutoApprove', label: t('settings.skill_scripts_auto_approve_all'), checked: skills?.scriptAutoApprove ?? false }]}
                onChange={(_value, enabled) => void onUpdateSkillScriptApproval(undefined, enabled)} />
            </div>}
          </header>
          {error && <div className="settings-error" role="alert">{error}</div>}
          {activeTab === 'general' && (
            <GeneralSettingsSections
              className={sectionClass('general')}
              profile={{
                avatarDataUri: avatar?.dataUri,
                avatarDragActive,
                customAvatar: avatar?.source === 'custom',
                profile: config?.settings.profile,
                onAvatarDragEnter, onAvatarDragLeave, onAvatarDragOver, onAvatarDrop,
                onEditAvatar, onClearAvatar, onProfileChange: onSaveProfile
              }}
              appearance={{
                languageOptions,
                languageValue: config?.settings.language ?? systemLanguage,
                systemLanguage,
                themeValue: config?.settings.theme,
                fontSizeValue: config?.settings.fontSize,
                chatContentWidthValue: config?.settings.chatContentWidth,
                onSaveLanguage,
                onSaveTheme: (theme) => onSaveSettings({ theme }),
                onSaveFontSize: (fontSize) => onSaveSettings({ fontSize }),
                onSaveChatContentWidth: (chatContentWidth) => onSaveSettings({ chatContentWidth })
              }}
              data={{
                backupDir, dataDirectoryUsage, storageUsageLoading,
                onBackupDataDirectory, onOpenDataCleanup, onOpenDataDirectory, onRestoreDataDirectory
              }}
            />
          )}
          {activeTab === 'chatMode' && (
            <section className={sectionClass('chatMode')}>
              <ChatModeSettings
                settings={config?.settings}
                speechReply={config?.settings.speechReply}
                onChange={onSaveSettings}
                onSpeechReplyChange={onSaveSpeechReply}
              />
            </section>
          )}
          {activeTab === 'environment' && (
            <EnvironmentSettingsSections
              envDraft={envDraft}
              envPath={envPath}
              settings={config?.settings}
              sectionClass={sectionClass}
              onAutosizeInput={onAutosizeInput}
              onOpenEnvFile={onOpenEnvFile}
              onSaveSettings={onSaveSettings}
              onUpdateEnvDraft={onUpdateEnvDraft}
            />
          )}
          {activeTab === 'subagents' && (
            <SubagentSettings
              actionsTarget={packageActionsTarget}
              config={config}
              draft={subagentDraft}
              editingIndex={editingSubagentIndex}
              listRef={subagentListRef}
              mcpStatus={mcpStatus}
              runtimeToolStatus={runtimeToolStatus}
              sectionClass={sectionClass('subagents', 'settings-workbench ui-workbench ui-grid-sidebar')}
              skills={skills}
              onAdd={onAddSubagent}
              onRefresh={onRefreshSubagents}
              onAutosizeInput={onAutosizeInput}
              onDelete={onDeleteSubagent}
              onEdit={onEditSubagent}
              onMove={onMoveSubagent}
              onUpdate={onUpdateSubagentDraft}
            />
          )}
          {activeTab === 'memory' && (
            <MemorySettings
              draft={memory.draft}
              items={memory.result.items}
              kind={memory.kind}
              listRef={memory.memoryListRef}
              projects={projects.filter((project) => project.kind === 'workspace')}
              query={memory.query}
              saving={memory.saving}
              scope={memory.scope}
              sectionClass={sectionClass('memory', 'settings-workbench ui-workbench ui-grid-sidebar')}
              selectedId={memory.selectedId}
              total={memory.result.total}
              onAutosizeInput={onAutosizeInput}
              onDelete={memory.deleteMemory}
              onKindChange={memory.setKind}
              onNew={memory.startNewMemory}
              onQueryChange={memory.setQuery}
              onSave={memory.saveMemory}
              onScopeChange={memory.setScope}
              onSelect={memory.selectMemory}
              onUpdateDraft={memory.updateMemoryDraft}
            />
          )}

          {activeTab === 'dev' && (
            <>
              <section className={sectionClass('dev')}>
                <DeveloperActions />
              </section>
              <section className={sectionClass('dev')}>
                <DeveloperHttpTraceSettings
                  enabled={developerHttpTraceEnabled}
                  storageUsageLoading={developerHttpTraceUsageLoading}
                  usage={developerHttpTraceUsage}
                  onChange={onDeveloperHttpTraceEnabledChange}
                  onOpenDirectory={onOpenDeveloperHttpTraceDirectory}
                />
              </section>
              <section className={sectionClass('dev')}>
                <LogSettings
                  settings={config?.settings}
                  onChange={onSaveSettings}
                  onOpenLogDirectory={onOpenLogDirectory}
                  onOpenRuntimeLogViewer={onOpenRuntimeLogViewer}
                />
              </section>
            </>
          )}

          {activeTab === 'model' && (
            <ModelSettings
              candidates={modelCandidates}
              config={config}
              editingModelIndex={editingModelIndex}
              editingProvider={editingProvider}
              editingProviderModelIndex={editingProviderModelIndex}
              listLoading={modelListLoading}
              listRef={modelListRef}
              modelDraft={modelDraft}
              sectionClass={sectionClass('model', 'settings-workbench ui-workbench ui-grid-sidebar')}
              onAddProviderModels={onAddProviderModels}
              onCreateModel={onCreateModel}
              onDeleteModel={onDeleteModel}
              onDeleteProviderModel={onDeleteProviderModel}
              onEditModel={onEditModel}
              onMoveModel={onMoveModel}
              onMoveProviderModel={onMoveProviderModel}
              onSelectProviderModel={onSelectProviderModel}
              onRefreshCandidates={onRefreshModelCandidates}
              onUpdateDraft={onUpdateModelDraft}
              onSaveDetails={onSaveModelDetails}
            />
          )}

          {activeTab === 'mcp' && (
            <McpSettings
              config={config}
              editingIndex={editingMcpIndex}
              listRef={mcpListRef}
              mcpDraft={mcpDraft}
              reloadingFailed={mcpReloadingFailed}
              runtimeEnabled={mcpRuntimeEnabled}
              sectionClass={sectionClass('mcp', 'settings-workbench ui-workbench ui-grid-sidebar')}
              status={mcpStatus}
              onAutosizeInput={onAutosizeInput}
              onDeleteServer={onDeleteMcpServer}
              onEditServer={onEditMcpServer}
              onMoveServer={onMoveMcpServer}
              onReloadFailedServers={onReloadFailedMcpServers}
              onUpdateDraft={onUpdateMcpDraft}
            />
          )}

          {activeTab === 'plugins' && <PluginsSettings className={sectionClass('plugins', 'settings-workbench ui-workbench ui-grid-sidebar')}
            plugins={plugins} error={pluginError} onRefresh={onRefreshPlugins} />}
          {activeTab === 'tools' && (
            <section className={sectionClass('tools', 'settings-workbench ui-workbench ui-grid-sidebar')}>
              <ToolsSettings
                actionsTarget={packageActionsTarget}
                plugins={plugins}
                pluginError={pluginError}
                customTools={config?.customTools ?? []}
                onConfigChange={onConfigChange}
                mcpServers={config?.mcpServers ?? []}
                mcpStatus={mcpStatus}
                runtimeToolStatus={runtimeToolStatus}
              />
            </section>
          )}

          {activeTab === 'skills' && (
            <SkillsSettings
              sectionClass={sectionClass('skills', 'settings-workbench ui-workbench ui-grid-sidebar')}
              skills={skills}
              revealSkillId={skillToReveal}
              onSkillRevealed={() => setSkillToReveal(undefined)}
              onMoveDirectory={onMoveSkillDirectory}
              onRefresh={onRefreshSkills}
              onUpdateDirectory={onUpdateSkillDirectory}
              onRemoveDirectory={onRemoveSkillDirectory}
              onUpdateScriptApproval={onUpdateSkillScriptApproval}
              onUpdateAvailability={onUpdateSkillAvailability}
            />
          )}
      </div>
    </main>
  )
}
