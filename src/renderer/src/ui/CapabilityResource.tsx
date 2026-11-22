import { CheckboxField } from './CheckboxField'

export function CapabilityResourceRow({ name, description, directory, inactiveReason, label = name, enabled, disabled, onChange }: {
  name: string; description?: string; directory?: string; inactiveReason?: string
  label?: string; enabled: boolean; disabled?: boolean; onChange(enabled: boolean): void
}) {
  return <div className="ui-field-stack">
    <CheckboxField className="ui-checkbox-field-inline" aria-label={label} checked={enabled} disabled={disabled} onChange={onChange}
      inactiveReason={inactiveReason} tooltip={[description, directory].filter(Boolean).join('\n')} label={name} />
  </div>
}
