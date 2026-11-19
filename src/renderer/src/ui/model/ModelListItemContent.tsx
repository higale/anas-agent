import { Eye, FileText } from 'lucide-react'
import { ToolsIcon } from '../ToolsIcon'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import type { ProviderModelConfig } from '@shared/types'
import { hasModelImageLimits } from '@shared/modelImageLimits'
import { ModelParameterPresetBadge } from './ModelParameterPresetBadge'
import { modelImageLimitsSummary } from './modelImageLimitsSummary'

const compactTokens = new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })

export function ModelListItemContent({ model, nameAccessory, hideCapabilityTooltips = false }: {
  model: ProviderModelConfig
  nameAccessory?: ReactNode
  hideCapabilityTooltips?: boolean
}) {
  const { t } = useTranslation()
  const imageLimitsConfigured = hasModelImageLimits(model.imageLimits)
  const visionLabel = `${t('settings.model_capability_vision')}: ${t('common.on')}`
  return (
    <span className="model-item-copy ui-copy-stack">
      <span className="ui-row">
        <span className="model-item-name ui-truncate">
          {model.displayName.trim() || model.model.trim() || t('settings.no_model_id')}
        </span>
        {nameAccessory}
      </span>
      <small className="model-item-details ui-row">
        <span className="ui-truncate">
          {compactTokens.format(model.maxContextTokens)} · {model.maxOutputTokens > 0 ? compactTokens.format(model.maxOutputTokens) : '—'}
          {' · '}{model.contextCompressionEnabled ? `${Math.round(model.contextCompressionThreshold * 100)}%` : '—'}
        </span>
        <span className="model-item-capabilities ui-row">
          {[
            { Icon: FileText, label: t('chat.model_non_streaming'), visible: !model.stream },
            { Icon: Eye, label: imageLimitsConfigured ? `${visionLabel} · ${t('chat.model_vision_limited')}` : visionLabel,
              tooltip: `${visionLabel}\n${modelImageLimitsSummary(model.imageLimits, t)}`,
              className: imageLimitsConfigured ? 'model-vision-limited' : undefined, visible: model.capabilities.vision },
            { Icon: ToolsIcon, label: `${t('settings.model_capability_tool_use')}: ${t('common.on')}`, visible: model.capabilities.toolUse }
          ].filter(({ visible }) => visible).map(({ Icon, label, tooltip = label, className }) => (
            <span key={label} className="ui-status-icon" aria-label={label} data-tooltip={hideCapabilityTooltips ? undefined : tooltip}>
              <Icon size={13} className={className} aria-hidden="true" />
            </span>
          ))}
          <ModelParameterPresetBadge mode={model.parameterPresetMode} presetCount={model.parameterPresets?.length ?? 0} />
        </span>
      </small>
    </span>
  )
}
