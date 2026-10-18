import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ModelApiKeyEnvironmentVariable, ModelProviderConfigDetail } from '@shared/types'
import { modelApiKeyEnvironmentName } from '@shared/modelConfig'
import { CommitTextInput } from '../CommitTextField'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import { ModelDetailsDialog } from './ModelDetailsDialog'
import { ModelExtraParametersField } from './ModelExtraParametersField'
import { providerConfigToDraft, type ModelDraft } from './modelDraft'
import { providerProtocolLabels } from './providerProtocol'
import { ProviderModelAddDialog } from './ProviderModelAddDialog'
import { ProviderIconField } from './ProviderIconField'
import { ProviderModelList } from './ProviderModelList'

interface ModelEditorProps {
  candidates: string[]
  listLoading: boolean
  modelDraft: ModelDraft
  provider?: ModelProviderConfigDetail
  selectedModelIndex?: number
  onAddProviderModels?: (models: string[]) => boolean | void | Promise<boolean | void>
  onDeleteProviderModel?: () => boolean | void | Promise<boolean | void>
  onMoveProviderModel?: (direction: -1 | 1) => void | Promise<void>
  onSelectProviderModel?: (index: number) => boolean | void | Promise<boolean | void>
  onRefreshCandidates: () => void | Promise<void>
  onUpdateDraft: (update: Partial<ModelDraft>) => void
  onSaveDetails: (draft: ModelDraft) => Promise<void>
}

export function ModelEditor({
  candidates,
  listLoading,
  modelDraft,
  provider,
  selectedModelIndex,
  onAddProviderModels,
  onDeleteProviderModel,
  onMoveProviderModel,
  onSelectProviderModel,
  onRefreshCandidates,
  onUpdateDraft,
  onSaveDetails
}: ModelEditorProps) {
  const { t } = useTranslation()
  const [apiKeyVariables, setApiKeyVariables] = useState<ModelApiKeyEnvironmentVariable[]>([])
  const [apiKeyVariablesLoading, setApiKeyVariablesLoading] = useState(false)
  const [apiKeyVariablesFailed, setApiKeyVariablesFailed] = useState(false)
  const apiKeyVariablesRequest = useRef(0)
  const [modelAddOpen, setModelAddOpen] = useState(false)
  const [modelDetailsOpen, setModelDetailsOpen] = useState(false)
  const [newModel, setNewModel] = useState(false)
  const providerOptions = [
    { value: 'openai_responses', label: providerProtocolLabels.openai_responses },
    { value: 'openai_chat_completions', label: providerProtocolLabels.openai_chat_completions },
    { value: 'anthropic_messages', label: providerProtocolLabels.anthropic_messages }
  ]

  useEffect(() => () => { apiKeyVariablesRequest.current += 1 }, [])

  async function loadApiKeyVariables(): Promise<void> {
    const request = ++apiKeyVariablesRequest.current
    setApiKeyVariables([])
    setApiKeyVariablesLoading(true)
    setApiKeyVariablesFailed(false)
    try {
      const variables = await window.gale.app.listApiKeyEnvironmentVariables()
      if (request === apiKeyVariablesRequest.current) setApiKeyVariables(variables)
    } catch {
      if (request === apiKeyVariablesRequest.current) setApiKeyVariablesFailed(true)
    } finally {
      if (request === apiKeyVariablesRequest.current) setApiKeyVariablesLoading(false)
    }
  }

  async function addProviderModel(): Promise<boolean> {
    setNewModel(true)
    setModelDetailsOpen(true)
    return true
  }

  function openModelAddDialog(): void {
    setModelAddOpen(true)
    if (candidates.length === 0 && !listLoading) void onRefreshCandidates()
  }

  async function selectProviderModel(index: number): Promise<void> {
    if (index !== selectedModelIndex) await onSelectProviderModel?.(index)
  }

  async function editProviderModel(index: number): Promise<void> {
    if (index !== selectedModelIndex) {
      const selected = await onSelectProviderModel?.(index)
      if (selected === false) return
    }
    setNewModel(false)
    setModelDetailsOpen(true)
  }

  return (
    <div className="ui-editor">
      <div className="ui-form-section" data-settings-group="provider">
        <div className="ui-grid-2">
          <div className="provider-name-field">
            <ProviderIconField
              key={modelDraft.providerId}
              iconData={modelDraft.iconData}
              baseUrl={modelDraft.baseUrl}
              onChange={(iconData) => onUpdateDraft({ iconData })}
            />
            <label className="ui-field-stack">
              <span>{t('settings.name')}</span>
              <CommitTextInput value={modelDraft.name} onCommit={(name) => onUpdateDraft({ name })} />
            </label>
          </div>
          <div className="ui-field-stack">
            <span>{t('settings.provider')}</span>
            <SearchableOptionPicker
              ariaLabel={t('settings.provider')}
              emptyLabel={t('settings.no_options')}
              options={providerOptions}
              searchable={false}
              value={modelDraft.protocol}
              onChange={(protocol) => onUpdateDraft({ protocol: protocol as ModelDraft['protocol'] })}
            />
          </div>
        </div>
        <label className="ui-field-stack">
          <span>{t('settings.base_url')}</span>
          <CommitTextInput
            value={modelDraft.baseUrl}
            onCommit={(baseUrl) => onUpdateDraft({ baseUrl })}
            placeholder="https://..."
          />
        </label>
        <div className="ui-field-stack">
          <span>{t('settings.api_key')}</span>
          <SearchableOptionPicker
            allowInput
            caseSensitive
            ariaLabel={t('settings.api_key')}
            searchable={false}
            inputCommitMode="blur"
            value={modelDraft.apiKey}
            onChange={(apiKey) => onUpdateDraft({ apiKey })}
            onOpenChange={(open) => { if (open) void loadApiKeyVariables() }}
            inputPlaceholder={t('settings.api_key_placeholder')}
            inputType={(value, focused) => focused || modelApiKeyEnvironmentName(value) ? 'text' : 'password'}
            emptyLabel={apiKeyVariablesLoading ? t('common.loading') : apiKeyVariablesFailed
              ? t('settings.api_key_variables_failed') : t('settings.api_key_variables_empty')}
            options={apiKeyVariables.map(variable => {
              const label = variable.name.trim() === variable.name ? variable.name : JSON.stringify(variable.name)
              return {
                value: '${' + variable.name + '}',
                label: variable.hasValue ? label : `${label} (${t('settings.api_key_variable_empty')})`,
                group: variable.source === 'envFile' ? '.env' : t('settings.system_environment_variables')
              }
            })}
          />
        </div>
        <ModelExtraParametersField
          key={modelDraft.providerId}
          value={modelDraft.providerParametersJson}
          protocol={modelDraft.protocol}
          onCommit={(providerParametersJson) => onUpdateDraft({ providerParametersJson })}
          placeholder='{"reasoning_split":true}'
        />
      </div>

      <div className="ui-form-section ui-form-section-divided" data-settings-group="models">
        {provider && (
          <ProviderModelList
            provider={provider}
            selectedIndex={selectedModelIndex}
            onAdd={openModelAddDialog}
            onDelete={() => void onDeleteProviderModel?.()}
            onEdit={editProviderModel}
            onMove={onMoveProviderModel ?? (() => undefined)}
            onModelListSettingsChange={onUpdateDraft}
            onSelect={selectProviderModel}
          />
        )}
      </div>

      {provider && (
        <>
          <ProviderModelAddDialog
            baseUrl={modelDraft.baseUrl}
            candidates={candidates}
            configuredModelIds={provider.models.map((model) => model.model)}
            listLoading={listLoading}
            modelListUrl={modelDraft.modelListUrl}
            open={modelAddOpen}
            protocol={modelDraft.protocol}
            onAddBlank={addProviderModel}
            onAddSelected={onAddProviderModels ?? (() => false)}
            onModelListSettingsChange={onUpdateDraft}
            onOpenChange={setModelAddOpen}
            onRefreshCandidates={onRefreshCandidates}
          />
          {modelDetailsOpen && (
            <ModelDetailsDialog
              candidates={candidates}
              listLoading={listLoading}
              modelDraft={newModel ? providerConfigToDraft(provider) : modelDraft}
              open
              onOpenChange={setModelDetailsOpen}
              onRefreshCandidates={onRefreshCandidates}
              onSaveDetails={onSaveDetails}
            />
          )}
        </>
      )}
    </div>
  )
}
