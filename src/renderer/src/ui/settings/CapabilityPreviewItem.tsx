import { useId } from 'react'
import { Checkbox } from '../Checkbox'

export function CapabilityPreviewItem({ name, checked, disabled, busy, description, inactiveReason, onChange, onPreview }: {
  name: string
  checked: boolean
  disabled?: boolean
  busy?: boolean
  description?: string
  inactiveReason?: string
  onChange(checked: boolean): void
  onPreview(): void
}) {
  const reasonId = useId()
  return <div className="ui-row settings-capability-preview-item">
    <Checkbox aria-label={name} checked={checked} disabled={disabled}
      aria-disabled={busy || undefined} aria-busy={busy || undefined}
      aria-describedby={inactiveReason ? reasonId : undefined}
      onChange={checked => { if (!busy) onChange(checked) }} />
    <button type="button" className="settings-tool-catalog-row"
      data-tooltip={[inactiveReason, description].filter(Boolean).join('\n') || undefined}
      onClick={onPreview}>
      <code className={`settings-tool-catalog-name ui-tool-name${inactiveReason ? ' ui-resource-unavailable' : ''}`}>{name}</code>
    </button>
    {inactiveReason && <span id={reasonId} hidden>{inactiveReason}</span>}
  </div>
}
