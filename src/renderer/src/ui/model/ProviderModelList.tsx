import { Pencil, Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ModelProviderConfigDetail } from '@shared/types'
import { NoFocusButton } from '../NoFocusButton'
import { SettingsSelectionButtons } from '../settings/SettingsListActions'
import { UI_ICON_SIZE_LARGE } from '../uiConstants'
import { ModelListUrlPopover } from './ModelListUrlPopover'
import { ModelListItemContent } from './ModelListItemContent'
import type { ModelListSettingsUpdate } from './ModelListUrlPopover'

interface ProviderModelListProps {
  provider: ModelProviderConfigDetail
  selectedIndex?: number
  onAdd(): void | Promise<void>
  onDelete(): void | Promise<void>
  onEdit(index: number): void | Promise<void>
  onMove(direction: -1 | 1): void | Promise<void>
  onModelListSettingsChange(update: ModelListSettingsUpdate): void
  onSelect(index: number): void | Promise<void>
}

export function ProviderModelList({
  provider,
  selectedIndex,
  onAdd,
  onDelete,
  onEdit,
  onMove,
  onModelListSettingsChange,
  onSelect
}: ProviderModelListProps) {
  const { t } = useTranslation()
  const selectedPosition = provider.models.findIndex(model => model.index === selectedIndex)
  const selectedModel = provider.models[selectedPosition]
  const selectedName = selectedModel ? selectedModel.displayName.trim() || selectedModel.model.trim() || t('settings.no_model_id') : undefined

  return (
    <div className="provider-model-list ui-field-stack">
      <div className="ui-toolbar ui-toolbar-between">
        <span className="provider-model-list-heading">
          <strong>{t('settings.provider_models')}</strong>
          <ModelListUrlPopover
            baseUrl={provider.baseUrl}
            modelListUrl={provider.modelListUrl}
            protocol={provider.protocol}
            onChange={onModelListSettingsChange}
          />
        </span>
        <div className="ui-row">
          <button className="ui-icon-button" type="button" aria-label={t('settings.add_provider_model')}
            data-tooltip={t('settings.add_provider_model')} onClick={() => void onAdd()}><Plus size={14} /></button>
          <SettingsSelectionButtons moveUpLabel={t('common.move_up')} moveDownLabel={t('common.move_down')}
            deleteLabel={t('settings.delete_model')} targetName={selectedName}
            onMoveUp={selectedPosition > 0 ? () => void onMove(-1) : undefined}
            onMoveDown={selectedPosition >= 0 && selectedPosition < provider.models.length - 1 ? () => void onMove(1) : undefined}
            onDelete={selectedModel ? () => void onDelete() : undefined} />
        </div>
      </div>
      <div className="provider-model-options ui-list ui-list-compact ui-list-framed" role="listbox" aria-label={t('settings.provider_models')}>
        {provider.models.length === 0 && (
          <div className="ui-empty-state ui-empty-state-compact">{t('settings.no_models_configured')}</div>
        )}
        {provider.models.map((model) => {
          const name = model.displayName.trim() || model.model.trim() || t('settings.no_model_id')
          const selected = model.index === selectedIndex
          return (
            <div
              className={selected
                ? 'provider-model-item ui-list-item ui-list-item-row ui-list-item-action-host ui-list-item-active active'
                : 'provider-model-item ui-list-item ui-list-item-row ui-list-item-action-host'}
              key={model.id}
            >
              <button
                aria-selected={selected}
                aria-label={name}
                className="provider-model-select ui-list-item-main"
                onClick={() => void onSelect(model.index)}
                onDoubleClick={() => void onEdit(model.index)}
                role="option"
                type="button"
              >
                <ModelListItemContent model={model} />
              </button>
              <div className="ui-list-item-action-wrap">
                <NoFocusButton
                  aria-label={`${t('settings.edit_model')}: ${name}`}
                  className="ui-list-item-action ui-tool-button"
                  data-tooltip={t('settings.edit_model')}
                  onClick={() => void onEdit(model.index)}
                  type="button"
                >
                  <Pencil size={UI_ICON_SIZE_LARGE} />
                </NoFocusButton>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
