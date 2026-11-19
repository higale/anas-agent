import type { TFunction } from 'i18next'
import { hasModelImageLimits, modelImageLimitFields, type ModelImageLimits } from '@shared/modelImageLimits'

export function modelImageLimitsSummary(limits: ModelImageLimits | undefined, t: TFunction): string {
  if (!hasModelImageLimits(limits)) return t('settings.image_limits_unconfigured')
  const lines = modelImageLimitFields.flatMap(key => {
    const value = limits?.[key]
    if (value === undefined) return []
    const label = t(`settings.image_limit_${key}`)
    return [key === 'maxBytes'
      ? t('settings.image_limit_summary_bytes', { label, value,
        basis: t(limits?.byteBasis === 'base64' ? 'settings.image_limits_base64' : 'settings.image_limits_original') })
      : t('settings.image_limit_summary_value', { label, value })]
  })
  return [t('settings.image_limits'), ...lines].join('\n')
}
