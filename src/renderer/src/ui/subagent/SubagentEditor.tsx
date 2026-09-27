import { useId, type FormEvent } from 'react'
import { RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type {
  AppConfigSnapshot,
  McpServerConfigDetail,
  McpToolStatus,
  RuntimeToolStatus,
  SkillSnapshot,
  SubagentConfig
} from '@shared/types'
import { findProviderModelConfig } from '@shared/modelConfig'
import { ModelPicker } from '../model/ModelPicker'
import { ModelParameterPresetPicker } from '../model/ModelParameterPresetPicker'
import { CheckboxField } from '../CheckboxField'
import { CommitTextInput, CommitTextarea } from '../CommitTextField'
import { UI_ICON_SIZE_SMALL, UI_TEXTAREA_ROWS_COMPACT } from '../uiConstants'
import { CapabilityEditor } from '../CapabilityEditor'
import type { SubagentDraft } from './subagentDraft'

interface SubagentEditorProps {
  config?: AppConfigSnapshot
  customTools?: import('@shared/toolPackages').ToolPackage[]
  draft: SubagentDraft
  subagents?: readonly SubagentConfig[]
  mcpStatus: McpToolStatus | undefined
  mcpServers?: McpServerConfigDetail[]
  runtimeToolStatus: RuntimeToolStatus | undefined
  skills: SkillSnapshot | undefined
  onAutosizeInput: (event: FormEvent<HTMLTextAreaElement>) => void
  onRestore: () => void
  onUpdate: (update: Partial<SubagentDraft>) => void
}

export function SubagentEditor({
  config,
  customTools,
  draft,
  subagents = [],
  mcpStatus,
  mcpServers,
  runtimeToolStatus,
  skills,
  onAutosizeInput,
  onRestore,
  onUpdate
}: SubagentEditorProps) {
  const { t } = useTranslation()
  const identifierId = useId()
  const promptId = useId()
  const selectedModel = findProviderModelConfig(config?.providers ?? [], draft.modelConfigId)
  const selectedPreset = draft.modelParameterPresetId === undefined
    ? selectedModel?.defaultParameterPresetId : draft.modelParameterPresetId
  return (
    <div className="ui-editor settings-subagent-editor">
      <div className="ui-toolbar ui-toolbar-between">
        <CheckboxField
          checked={draft.enabled}
          label={t('settings.subagent_default_enabled')}
          onChange={(enabled) => onUpdate({ enabled })}
        />
        {draft.builtIn && (
          <button
            className="ui-button ui-button-compact"
            type="button"
            onClick={onRestore}
          >
            <RefreshCw size={UI_ICON_SIZE_SMALL} />
            <span>{t('settings.restore_default')}</span>
          </button>
        )}
      </div>

      <div className="ui-form-section">
        <div className="ui-field-stack">
          <div className="ui-toolbar ui-toolbar-between">
            <label className="ui-field-label" htmlFor={identifierId}>{t('settings.subagent_identifier')}</label>
            <div className="composer-model-selection-group">
              <ModelPicker providers={config?.providers} selectedId={draft.modelConfigId}
                defaultModelId={config?.defaultModelId} disabled={!config}
                emptyLabel={t('settings.subagent_inherit_model')} clearLabel={t('settings.subagent_inherit_model')}
                onClear={() => onUpdate({ modelConfigId: undefined, modelParameterPresetId: undefined })}
                onSelect={(modelConfigId) => onUpdate({ modelConfigId,
                  modelParameterPresetId: findProviderModelConfig(config?.providers ?? [], modelConfigId)?.defaultParameterPresetId ?? null })} />
              {draft.modelConfigId && <ModelParameterPresetPicker disabled={!config} model={selectedModel}
                selectedId={selectedPreset ?? undefined} onSelect={(modelParameterPresetId) => onUpdate({ modelParameterPresetId })} />}
            </div>
          </div>
          <CommitTextInput
            id={identifierId}
            disabled={draft.builtIn}
            value={draft.name}
            onCommit={(name) => onUpdate({ name: name.trim() })}
          />
          <small>{t('settings.subagent_identifier_hint')}</small>
        </div>
        <label className="ui-field-stack">
          <span>{t('settings.subagent_selection_description')}</span>
          <CommitTextarea
            className="ui-autosize-textarea ui-code-textarea"
            data-max-height="none"
            rows={UI_TEXTAREA_ROWS_COMPACT}
            value={draft.description}
            onInput={onAutosizeInput}
            onCommit={(description) => onUpdate({ description })}
          />
          <small>{t('settings.subagent_selection_description_hint')}</small>
        </label>
        <div className="ui-field-stack">
          <label className="ui-field-label" htmlFor={promptId}>{t('settings.subagent_system_prompt')}</label>
          <CommitTextarea
            id={promptId}
            className="ui-autosize-textarea ui-code-textarea"
            data-max-height="none"
            rows={5}
            value={draft.systemPrompt}
            onInput={onAutosizeInput}
            onCommit={(systemPrompt) => onUpdate({ systemPrompt })}
          />
        </div>
      </div>

      <CapabilityEditor customTools={customTools} value={draft.capabilities} subagent skills={skills} mcpStatus={mcpStatus} mcpServers={mcpServers} runtimeToolStatus={runtimeToolStatus}
        subagents={subagents}
        onChange={(capabilities) => onUpdate({ capabilities })} />
    </div>
  )
}
