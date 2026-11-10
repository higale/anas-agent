import { CheckboxField } from './CheckboxField'

export function CheckboxButton({ label, checked, disabled, tooltip, onChange }: {
  label: string; checked: boolean; disabled?: boolean; tooltip?: string; onChange(checked: boolean): void
}) {
  return <CheckboxField className="ui-checkbox-button" label={label} checked={checked}
    disabled={disabled} tooltip={tooltip} onChange={onChange} />
}
