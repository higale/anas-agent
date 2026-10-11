import * as Dialog from '@radix-ui/react-dialog'
import { Braces, ClipboardCopy, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { notice } from '../notice'
import { UI_ICON_SIZE_SMALL } from '../uiConstants'

export function ContentPreviewDialog({ title, description, copyText, children, onClose }: {
  title: string; description: string; copyText?: string; children: ReactNode; onClose(): void
}) {
  const { t } = useTranslation()
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(copyText ?? '')
      notice.success(t('chat.message_copied'))
    } catch { notice.error(t('chat.failed_copy_message')) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="ui-backdrop" />
      <Dialog.Content className="ui-dialog ui-dialog-wide ui-dialog-centered ui-popover settings-code-preview-dialog">
        <header className="ui-dialog-header">
          <div className="ui-dialog-icon"><Braces size={18} /></div>
          <div>
            <Dialog.Title asChild><h2 className="ui-dialog-title">{title}</h2></Dialog.Title>
            <Dialog.Description asChild><p className="ui-dialog-description">{description}</p></Dialog.Description>
          </div>
        </header>
        <div className="settings-code-preview-content">{children}</div>
        <footer className="ui-dialog-footer">
          <button className="ui-icon-button" type="button" aria-label={t('common.copy')} data-tooltip={t('common.copy')}
            disabled={!copyText} onClick={() => void copy()}><ClipboardCopy size={UI_ICON_SIZE_SMALL} /></button>
          <Dialog.Close asChild>
            <button className="ui-icon-button" type="button" aria-label={t('common.close')} data-tooltip={t('common.close')}><X size={UI_ICON_SIZE_SMALL} /></button>
          </Dialog.Close>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
