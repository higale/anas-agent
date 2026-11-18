import * as Dialog from '@radix-ui/react-dialog'
import { Check, Image, RotateCcw, X } from 'lucide-react'
import { useId, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { compactImageBytes, modelImageLimitFields, requireModelImageLimits, type ModelImageLimits } from '@shared/modelImageLimits'
import { CommitNumberInput } from '../CommitNumberInput'
import { SegmentedControl } from '../SegmentedControl'

export function ModelImageLimitsDialog({ value, onConfirm, onClose }: {
  value?: ModelImageLimits
  onConfirm(value: ModelImageLimits): void
  onClose(): void
}) {
  const { t } = useTranslation()
  const id = useId()
  const initial = () => Object.fromEntries(modelImageLimitFields.map(key => [key, value?.[key] === undefined ? '' : String(value[key])])) as Record<typeof modelImageLimitFields[number], string>
  const [draft, setDraft] = useState(initial)
  const draftRef = useRef(draft)
  const [basis, setBasis] = useState(value?.byteBasis ?? 'original')
  const [error, setError] = useState(false)
  const update = (key: typeof modelImageLimitFields[number], text: string) => {
    draftRef.current = { ...draftRef.current, [key]: text }
    setDraft(draftRef.current)
    setError(false)
  }
  function confirm() {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    try {
      const rules = requireModelImageLimits({
        ...Object.fromEntries(modelImageLimitFields.flatMap(key => draftRef.current[key].trim() === '' ? [] : [[key, Number(draftRef.current[key])]])),
        ...(draftRef.current.maxBytes.trim() ? { byteBasis: basis } : {})
      })
      onConfirm(rules)
      onClose()
    } catch { setError(true) }
  }
  return <Dialog.Root open onOpenChange={open => { if (!open) onClose() }}>
    <Dialog.Portal>
      <Dialog.Overlay className="ui-backdrop" />
      <Dialog.Content className="ui-dialog ui-dialog-fixed-footer ui-dialog-centered ui-popover" onPointerDownOutside={event => event.preventDefault()}>
        <header className="ui-dialog-header">
          <div className="ui-dialog-icon"><Image size={18} /></div>
          <Dialog.Title className="ui-dialog-title">{t('settings.image_limits')}</Dialog.Title>
        </header>
        <div className="ui-dialog-body ui-form-section">
          <Dialog.Description className="ui-text-muted">{t('settings.image_limits_hint')}</Dialog.Description>
          <div className="ui-grid-2" style={{ alignItems: 'start' }}>
            {modelImageLimitFields.map(key => <div className="ui-field-stack" key={key}>
              <label className="ui-field-label" htmlFor={`${id}-${key}`}>{t(`settings.image_limit_${key}`)}</label>
              <CommitNumberInput id={`${id}-${key}`} value={draft[key]} placeholder={t('settings.image_limits_unlimited')}
                integer={key !== 'maxAspectRatio'} min={key === 'maxCount' || key === 'maxBytes' ? 0 : 1}
                max={Number.MAX_SAFE_INTEGER} step={1}
                onDraftChange={text => update(key, text)} onCommit={text => update(key, text)} />
              {key === 'maxBytes' && draft.maxBytes !== '' && Number.isFinite(Number(draft.maxBytes))
                && <small className="ui-text-muted">{compactImageBytes(Number(draft.maxBytes))}</small>}
            </div>)}
          </div>
          <div className="ui-field-stack">
            <span>{t('settings.image_limits_byte_basis')}</span>
            <SegmentedControl<'original' | 'base64'> ariaLabel={t('settings.image_limits_byte_basis')} value={basis} onChange={setBasis}
              options={[{ value: 'original', label: t('settings.image_limits_original') }, { value: 'base64', label: t('settings.image_limits_base64') }]} />
            <small className="ui-text-muted">{t('settings.image_limits_bytes_hint')}</small>
          </div>
          <small className="ui-text-muted">{t('settings.image_limits_batch_hint')}</small>
          {error && <span className="ui-status-danger" role="alert">{t('settings.image_limits_invalid')}</span>}
        </div>
        <footer className="ui-dialog-footer">
          <button type="button" className="ui-button ui-dialog-footer-start" onClick={() => {
            draftRef.current = Object.fromEntries(modelImageLimitFields.map(key => [key, ''])) as typeof draft
            setDraft(draftRef.current); setBasis('original'); setError(false)
          }}><RotateCcw size={14} />{t('settings.image_limits_clear')}</button>
          <Dialog.Close asChild><button type="button" className="ui-button"><X size={14} />{t('common.cancel')}</button></Dialog.Close>
          <button type="button" className="ui-button ui-button-primary" onClick={confirm}><Check size={14} />{t('common.confirm')}</button>
        </footer>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>
}
