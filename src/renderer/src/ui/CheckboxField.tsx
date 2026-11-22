import { useId, type ReactNode } from 'react'
import { Checkbox, type CheckboxProps } from './Checkbox'

interface CheckboxFieldProps extends Omit<CheckboxProps, 'className'> {
  className?: string
  label: ReactNode
  tooltip?: string
  inactiveReason?: string
}

export function CheckboxField({
  checked,
  className,
  label,
  tooltip,
  inactiveReason,
  onChange,
  ...inputProps
}: CheckboxFieldProps) {
  const reasonId = useId()
  return (
    <label
      className={['ui-checkbox-field', className ?? ''].filter(Boolean).join(' ')}
      data-tooltip={[inactiveReason, tooltip].filter(Boolean).join('\n') || undefined}
    >
      <Checkbox
        {...inputProps}
        aria-describedby={[inputProps['aria-describedby'], inactiveReason ? reasonId : undefined].filter(Boolean).join(' ') || undefined}
        checked={checked}
        onChange={onChange}
      />
      <span className={`ui-checkbox-field-label${inactiveReason ? ' ui-resource-unavailable' : ''}`}>{label}</span>
      {inactiveReason && <span id={reasonId} hidden>{inactiveReason}</span>}
    </label>
  )
}
