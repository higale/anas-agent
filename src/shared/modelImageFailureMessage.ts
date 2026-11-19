import type { TFunction } from 'i18next'
import type { ModelImageFailure } from './modelImageValidation'

export function modelImageFailureMessage(failure: ModelImageFailure, t: TFunction): string {
  switch (failure.code) {
    case 'invalid_base64': return t('chat.image_invalid_base64')
    case 'unreadable_dimensions': return t('chat.image_unreadable_dimensions', failure)
    case 'max_bytes': return failure.basis === 'base64'
      ? t('chat.image_max_base64_bytes', failure) : t('chat.image_max_original_bytes', failure)
    case 'min_short_side': return t('chat.image_min_short_side', failure)
    case 'max_long_side': return t('chat.image_max_long_side', failure)
    case 'max_pixels': return t('chat.image_max_pixels', failure)
    case 'max_aspect_ratio': return t('chat.image_max_aspect_ratio', failure)
    case 'max_count': return t('chat.image_max_count', failure)
  }
}
