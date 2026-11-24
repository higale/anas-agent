import { useState } from 'react'
import * as Dialog from '@radix-ui/react-dialog'
import { Settings } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { normalizeUsageSettings, usageEndpoint, type UsageSettings } from '@shared/usageMeter'
import { CheckboxField } from '../CheckboxField'

export function UsageSettingsField({ baseUrl, value, onChange }: {
  baseUrl: string; value: UsageSettings; onChange(value: UsageSettings): void
}) {
  const { t } = useTranslation()
  const endpoint = usageEndpoint(baseUrl)
  const settings = normalizeUsageSettings(value, baseUrl)
  const [draft, setDraft] = useState<UsageSettings>()
  const [visible, setVisible] = useState<string>()
  const extra = endpoint?.provider === 'tencent' || endpoint?.provider === 'bailian'
  const balanceKey = endpoint?.provider === 'tencent' ? 'tencentShowBalance' : 'bailianShowBalance'
  const fields = endpoint?.provider === 'tencent'
    ? [['tencentSecretId', 'SecretId'], ['tencentSecretKey', 'SecretKey']] as const
    : [['bailianAccessKeyId', 'AccessKey ID'], ['bailianAccessKeySecret', 'AccessKey Secret']] as const
  return <span className="ui-row usage-settings-actions">
    <CheckboxField checked={settings.enabled} disabled={!endpoint} label={t('usage.show')}
      tooltip={!endpoint ? t('usage.unsupported') : undefined}
      onChange={enabled => onChange({ ...settings, enabled })} />
    {extra && <button type="button" className="ui-tool-button" aria-label={t('usage.settings')} title={t('usage.settings')}
      onClick={() => { setVisible(undefined); setDraft({ ...settings }) }}><Settings size={16} /></button>}
    {extra && draft && <Dialog.Root open onOpenChange={open => { if (!open) setDraft(undefined) }}>
      <Dialog.Portal><Dialog.Overlay className="ui-backdrop" />
        <Dialog.Content className="ui-dialog ui-dialog-medium ui-dialog-font-scaled ui-dialog-centered ui-dialog-fixed-footer ui-popover"
          onPointerDownOutside={event => event.preventDefault()}>
          <header className="ui-dialog-header-group">
            <Dialog.Title>{t('usage.settings')}</Dialog.Title>
          </header>
          <div className="ui-dialog-body ui-form-section">
            <Dialog.Description asChild>
              <div className="ui-dialog-description ui-field-stack">
                {t(endpoint.provider === 'tencent' ? 'usage.tencent_help' : 'usage.bailian_help').split('\n').map(paragraph => <div key={paragraph}>{paragraph}</div>)}
              </div>
            </Dialog.Description>
            {fields.map(([key, label]) => <label className="ui-field-stack" key={key}>
              <span>{label}</span><input className="ui-input" value={draft[key]} maxLength={256}
                type={key.endsWith('Id') || visible === key ? 'text' : 'password'} autoComplete="off" spellCheck={false}
                onFocus={() => setVisible(key)} onBlur={() => setVisible(undefined)}
                onChange={event => setDraft({ ...draft, [key]: event.target.value })} />
            </label>)}
            <CheckboxField label={t('usage.show_balance')} checked={draft[balanceKey]}
              tooltip={t(endpoint.provider === 'tencent' ? 'usage.tencent_balance_help' : 'usage.balance_help')}
              onChange={showBalance => setDraft({ ...draft, [balanceKey]: showBalance })} />
          </div>
          <footer className="ui-dialog-footer">
            <button type="button" className="ui-button" onClick={() => setDraft(undefined)}>{t('common.cancel')}</button>
            <button type="button" className="ui-button ui-button-primary" onClick={() => { onChange({ ...draft, enabled: settings.enabled, displayMode: settings.displayMode }); setDraft(undefined) }}>{t('common.save')}</button>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>}
  </span>
}
