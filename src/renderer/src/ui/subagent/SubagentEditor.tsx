import { useId, type FormEvent } from 'react'
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
import { UI_TEXTAREA_ROWS_COMPACT } from '../uiConstants'
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
  onUpdate
}: SubagentEditorProps) {
  const { t } = useTranslation()
  const identifierId = useId()
  const selectedModel = findProviderModelConfig(config?.providers ?? [], draft.modelConfigId)
  const selectedPreset = draft.modelParameterPresetId === undefined
    ? selectedModel?.defaultParameterPresetId : draft.modelParameterPresetId
  if (draft.builtIn) return <div className="ui-form-section settings-subagent-editor">
    <CheckboxField checked={draft.enabled} label={t('settings.enabled')} onChange={enabled => onUpdate({ enabled })} />
    <div className="ui-field-stack">
      <span className="ui-field-label">{t('settings.subagent_identifier')}</span>
      <div>{draft.name}</div>
      <small>{t('settings.subagent_inherit_model')}</small>
    </div>
    <div className="ui-field-stack">
      <span className="ui-field-label">{t('settings.subagent_selection_description')}</span>
      <div>{draft.description}</div>
    </div>
    <div className="ui-note">{t('settings.subagent_builtin_readonly_hint')}</div>
  </div>
  return (
    <div className="ui-form-section settings-subagent-editor">
      <div className="ui-toolbar ui-toolbar-between">
        <CheckboxField
          checked={draft.enabled}
          label={t('settings.enabled')}
          onChange={(enabled) => onUpdate({ enabled })}
        />
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

      </div>

      <CapabilityEditor customTools={customTools} value={draft.capabilities} subagent skills={skills} mcpStatus={mcpStatus} mcpServers={mcpServers} runtimeToolStatus={runtimeToolStatus}
        subagents={subagents} subagentId={draft.id}
        onChange={(capabilities) => onUpdate({ capabilities })} />
    </div>
  )
}
