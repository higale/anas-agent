import * as Dialog from '@radix-ui/react-dialog'
import { Save, SlidersHorizontal, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { resolveModelListEndpoint } from '@shared/modelListEndpoint'
import { SegmentedMultiSelect } from '../SegmentedMultiSelect'
import { CommitNumberInput } from '../CommitNumberInput'
import { CommitTextInput } from '../CommitTextField'
import { RangeField } from '../RangeField'
import { RefreshButton } from '../RefreshButton'
import { SearchableOptionPicker } from '../SearchableOptionPicker'
import {
  SETTINGS_CONTEXT_COMPRESSION_MAX,
  SETTINGS_CONTEXT_COMPRESSION_MIN,
  SETTINGS_RANGE_STEP_FINE,
  SETTINGS_TOKEN_STEP,
  UI_ICON_SIZE_MEDIUM,
  UI_ICON_SIZE_SMALL
} from '../uiConstants'
import {
  maxModelMaxContextTokens,
  maxModelMaxOutputTokens,
  minModelMaxContextTokens,
  minModelMaxOutputTokens,
  validateProviderModelDraft
} from './modelDraft'
import type { ModelDraft } from './modelDraft'
import { ModelParameterPresetsEditor } from './ModelParameterPresetsEditor'
import { ModelExtraParametersField } from './ModelExtraParametersField'

interface ModelDetailsDialogProps {
  candidates: string[]
  listLoading: boolean
  modelDraft: ModelDraft
  open: boolean
  onOpenChange(open: boolean): void
  onRefreshCandidates(): void | Promise<void>
  onSaveDetails(draft: ModelDraft): Promise<void>
}

export function ModelDetailsDialog({
  candidates,
  listLoading,
  modelDraft: initialDraft,
  open,
  onOpenChange,
  onRefreshCandidates,
  onSaveDetails
}: ModelDetailsDialogProps) {
  const { t } = useTranslation()
  const [modelDraft, setModelDraft] = useState(() => structuredClone(initialDraft))
  const draftRef = useRef(modelDraft)
  const savingRef = useRef(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string>()
  function onUpdateDraft(update: Partial<ModelDraft>): void {
    draftRef.current = { ...draftRef.current, ...update }
    setModelDraft(draftRef.current)
    setError(undefined)
  }
  async function save(): Promise<void> {
    if (savingRef.current) return
    // Flush normalization of the currently focused number/text control before validation.
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    const draft = draftRef.current
    const validationError = validateProviderModelDraft(draft, t)
    if (validationError) {
      setError(validationError)
      return
    }
    savingRef.current = true
    setSaving(true)
    setError(undefined)
    try {
      await onSaveDetails(draft)
      onOpenChange(false)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('settings.failed_save_model'))
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const tokenFieldId = useId()
  const [portalContainer, setPortalContainer] = useState<HTMLDivElement | null>(null)
  let modelListRequestReady = false
  try {
    modelListRequestReady = Boolean(resolveModelListEndpoint(modelDraft.baseUrl, modelDraft.modelListUrl))
  } catch {
    modelListRequestReady = false
  }

  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!savingRef.current) onOpenChange(next) }}>
      <Dialog.Portal>
        <Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content
          className="model-details-dialog ui-dialog ui-dialog-wide ui-dialog-fixed-footer ui-dialog-centered ui-popover"
          aria-describedby={undefined}
          onPointerDownOutside={(event) => event.preventDefault()}
          ref={setPortalContainer}
        >
          <header className="ui-dialog-header">
            <div className="ui-dialog-icon">
              <SlidersHorizontal size={18} />
            </div>
            <Dialog.Title asChild>
              <h2 className="ui-dialog-title">
                {modelDraft.displayName.trim() || modelDraft.model || t('settings.no_model_id')}
              </h2>
            </Dialog.Title>
            <SegmentedMultiSelect<'stream' | 'vision' | 'toolUse'> ariaLabel={t('settings.capabilities')}
              disabled={saving}
              options={[
                { value: 'stream', label: t('settings.stream_output'), checked: modelDraft.stream },
                { value: 'vision', label: t('settings.model_capability_vision'), checked: modelDraft.capabilities.vision },
                { value: 'toolUse', label: t('settings.model_capability_tool_use'), checked: modelDraft.capabilities.toolUse }
              ]}
              onChange={(value, checked) => {
                if (value === 'stream') onUpdateDraft({ stream: checked })
                else onUpdateDraft({ capabilities: { ...modelDraft.capabilities, [value]: checked } })
              }} />
          </header>

          <fieldset disabled={saving} className="model-details-dialog-content ui-dialog-body">
            <section className="ui-form-section">
              <div className="ui-grid-2">
                <label className="ui-field-stack">
                  <span>{t('settings.model_display_name')}</span>
                  <CommitTextInput
                    placeholder={t('common.optional')}
                    value={modelDraft.displayName}
                    onDraftChange={(displayName) => onUpdateDraft({ displayName })}
                    onCommit={(displayName) => onUpdateDraft({ displayName })}
                  />
                </label>
                <div className="ui-field-stack">
                  <span>{t('settings.model_id')}</span>
                  <SearchableOptionPicker
                    allowInput
                    ariaLabel={t('settings.model_id')}
                    emptyLabel={t('settings.no_model_id')}
                    footer={(
                      <div className="provider-model-picker-footer">
                        <RefreshButton
                          iconSize={UI_ICON_SIZE_MEDIUM}
                          label={t('settings.fetch_available_models')}
                          loading={listLoading}
                          onClick={() => void onRefreshCandidates()}
                          disabled={!modelDraft.baseUrl.trim() || !modelListRequestReady}
                          showLabel
                          variant="small"
                        />
                      </div>
                    )}
                    inputCommitMode="change"
                    inputPlaceholder={t('settings.model_id_placeholder')}
                    options={Array.from(new Set(candidates.filter(Boolean))).map((candidate) => ({
                      value: candidate,
                      label: candidate
                    }))}
                    portalContainer={portalContainer}
                    searchPlaceholder={t('settings.model_id')}
                    value={modelDraft.model}
                    onChange={(model) => onUpdateDraft({ model })}
                    onInputChange={(model) => onUpdateDraft({ model })}
                  />
                </div>
              </div>
              <div className="model-context-controls ui-grid-3">
                <div className="ui-field-stack">
                  <label className="ui-field-label" htmlFor={`${tokenFieldId}-context`}>{t('settings.max_context_tokens')}</label>
                  <CommitNumberInput
                    id={`${tokenFieldId}-context`}
                    min={minModelMaxContextTokens}
                    max={maxModelMaxContextTokens}
                    step={SETTINGS_TOKEN_STEP}
                    value={modelDraft.maxContextTokens}
                    onDraftChange={(maxContextTokens) => onUpdateDraft({ maxContextTokens })}
                    onCommit={(maxContextTokens) => onUpdateDraft({ maxContextTokens })}
                  />
                </div>
                <div className="ui-field-stack">
                  <label className="ui-field-label" htmlFor={`${tokenFieldId}-output`}>{t('settings.max_output_tokens')}</label>
                  <CommitNumberInput
                    id={`${tokenFieldId}-output`}
                    min={minModelMaxOutputTokens}
                    max={maxModelMaxOutputTokens}
                    normalizeDraft={(value) => value === '0' ? '' : value}
                    placeholder={t('settings.max_output_tokens_ignored')}
                    step={SETTINGS_TOKEN_STEP}
                    value={modelDraft.maxOutputTokens === '0' ? '' : modelDraft.maxOutputTokens}
                    onDraftChange={(value) => onUpdateDraft({ maxOutputTokens: value === '' ? '0' : value })}
                    onCommit={(value) => onUpdateDraft({ maxOutputTokens: value === '' ? '0' : value })}
                  />
                </div>
                <div className="ui-field-stack">
                  <RangeField
                    checked={modelDraft.contextCompressionEnabled}
                    disabled={saving}
                    label={t('settings.context_compression_threshold', {
                      percent: Math.round(modelDraft.contextCompressionThreshold * 100)
                    })}
                    min={SETTINGS_CONTEXT_COMPRESSION_MIN}
                    max={SETTINGS_CONTEXT_COMPRESSION_MAX}
                    step={SETTINGS_RANGE_STEP_FINE}
                    value={modelDraft.contextCompressionThreshold}
                    onChange={(contextCompressionThreshold) => onUpdateDraft({ contextCompressionThreshold })}
                    onCheckedChange={(contextCompressionEnabled) => onUpdateDraft({ contextCompressionEnabled })}
                  />
                </div>
              </div>
              <ModelExtraParametersField
                key={modelDraft.modelConfigId}
                value={modelDraft.parametersJson}
                protocol={modelDraft.protocol}
                portalContainer={portalContainer}
                onDraftChange={(parametersJson) => onUpdateDraft({ parametersJson })}
                onCommit={(parametersJson) => onUpdateDraft({ parametersJson })}
                placeholder='{"temperature":0.7}'
              />
            </section>
            <section className="ui-surface-flat">
              <ModelParameterPresetsEditor
                draft={modelDraft}
                onUpdate={onUpdateDraft}
              />
            </section>
          </fieldset>

          <footer className="model-details-dialog-footer ui-dialog-footer">
            {error && <span className="ui-dialog-footer-start ui-status-danger" role="alert">{error}</span>}
            <Dialog.Close asChild>
              <button className="ui-button" type="button" disabled={saving}>
                <X size={UI_ICON_SIZE_SMALL} />
                <span>{t('common.cancel')}</span>
              </button>
            </Dialog.Close>
            <button className="ui-button ui-button-primary" type="button" disabled={saving} onClick={() => void save()}>
              <Save size={UI_ICON_SIZE_SMALL} />
              <span>{t('common.save')}</span>
            </button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
