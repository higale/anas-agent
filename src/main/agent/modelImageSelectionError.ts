import type { TFunction } from 'i18next'
import { modelImageFailureText, type ModelImageFailure } from '@shared/modelImageValidation'
import { modelImageFailureMessage } from '@shared/modelImageFailureMessage'
import { ModelSelectionError } from '../../runtime/errors'

type ImageSource = { name: string } | { ordinal: number; messageId?: string }

/** Keep runtime diagnostics readable; submission IPC translates the typed failure before Electron serializes it. */
export class ModelImageSelectionError extends ModelSelectionError {
  constructor(readonly failure: ModelImageFailure, readonly source?: ImageSource) {
    const detail = modelImageFailureText(failure)
    super(source
      ? 'name' in source ? `Attachment ${source.name}: ${detail}`
        : `Attachment image ${source.ordinal} in message ${source.messageId ?? 'current'}: ${detail} Change the attachment or model and send again.`
      : `${detail} Remove attachments or change the model image limits and send again.`)
  }

  localizedMessage(t: TFunction): string {
    const detail = modelImageFailureMessage(this.failure, t)
    if (!this.source) return t('chat.image_request_rejected', { detail })
    if ('name' in this.source) return t('chat.image_attachment_rejected', { name: this.source.name, detail })
    return t('chat.image_history_rejected', { ordinal: this.source.ordinal,
      message: this.source.messageId ?? t('chat.image_current_message'), detail })
  }
}
