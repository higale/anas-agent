import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { SegmentedControl } from './SegmentedControl'
import { notice } from './notice'

interface ResourceNameProps { name: string; description?: string; directory?: string; highlighted?: boolean }

export function CapabilityResourceName({ name, description, directory, highlighted }: ResourceNameProps) {
  const { t } = useTranslation()
  async function openDirectory(path: string) {
    try {
      await window.gale.files.openDirectory(path)
    } catch {
      notice.error(t('capabilities.failed_open_directory'))
    }
  }
  const text = <code className={highlighted ? 'ui-text-success' : undefined}>{name}</code>
  return directory
    ? <button type="button" className="ui-link-button ui-truncate"
        data-tooltip={[description, t('capabilities.open_directory'), directory].filter(Boolean).join('\n')}
        onClick={() => void openDirectory(directory)}>{text}</button>
    : <span className="ui-truncate" data-tooltip={description}>{text}</span>
}

export function CapabilityResourceRow({ status, children, controls, ...name }: ResourceNameProps & {
  status?: ReactNode; children?: ReactNode; controls: ReactNode
}) {
  return <div className="ui-capability-resource">
    <span className="ui-field-stack"><span className="ui-row"><CapabilityResourceName {...name} />{status}</span>{children}</span>
    {controls}
  </div>
}

export function CapabilityResourceToggle({ label, enabled, disabled, onChange }: {
  label: string; enabled: boolean; disabled?: boolean; onChange(enabled: boolean): void
}) {
  const { t } = useTranslation()
  return <SegmentedControl ariaLabel={label} value={enabled ? 'on' : 'off'} disabled={disabled}
    options={[{ value: 'on', label: t('capabilities.on') }, { value: 'off', label: t('capabilities.off') }]}
    onChange={value => onChange(value === 'on')} />
}
