import type { SelectedAttachment } from '@shared/types'
import { AttachmentGrid } from './AttachmentGrid'

interface ComposerAttachmentsProps {
  attachments: SelectedAttachment[]
  disabled?: boolean
  onConvertAttachmentToPath: (path: string) => Promise<void>
  onRemoveAttachment: (path: string) => void
  onToggleAttachmentContextPolicy: (path: string) => void
}

export function ComposerAttachments({
  attachments,
  disabled,
  onConvertAttachmentToPath,
  onRemoveAttachment,
  onToggleAttachmentContextPolicy
}: ComposerAttachmentsProps) {
  if (attachments.length === 0) return null

  return (
    <AttachmentGrid
      attachments={attachments}
      mode="composer"
      removalDisabled={disabled}
      onConvertAttachmentToPath={onConvertAttachmentToPath}
      onRemoveAttachment={onRemoveAttachment}
      onToggleContextPolicy={onToggleAttachmentContextPolicy}
    />
  )
}
