import { cloneElement, useId, type ReactNode } from 'react'
import Slider from '@rc-component/slider'
import { CheckboxField } from './CheckboxField'

interface RangeFieldProps {
  ariaLabel?: string
  className?: string
  disabled?: boolean
  label: ReactNode
  max: number
  min: number
  marks?: readonly { value: number; label?: string }[]
  step: number
  value: number
  formatValue?: (value: number) => string
  checked?: boolean
  onChange: (value: number) => void
  onCheckedChange?: (checked: boolean) => void
}

export function RangeField({
  ariaLabel,
  checked,
  className,
  disabled = false,
  label,
  max,
  min,
  marks,
  step,
  value,
  formatValue,
  onChange,
  onCheckedChange
}: RangeFieldProps) {
  const labelId = useId()
  const accessibleLabel = ariaLabel ?? (typeof label === 'string' ? label : undefined)
  const sliderMarks = marks && Object.fromEntries(marks
    .filter(mark => mark.value >= min && mark.value <= max)
    .map(mark => [mark.value, mark.label ?? <></>]))
  const range = (
    <div
      className="ui-range-control"
      data-disabled={disabled || checked === false || undefined}
      data-value-label={formatValue ? true : undefined}
    >
      <Slider
        prefixCls="ui-slider"
        ariaLabelForHandle={accessibleLabel}
        ariaLabelledByForHandle={accessibleLabel ? undefined : labelId}
        ariaValueTextFormatterForHandle={formatValue}
        handleRender={formatValue ? (handle, { value: handleValue }) => cloneElement(handle, {},
          <span className="ui-range-value" aria-hidden="true">{formatValue(handleValue)}</span>
        ) : undefined}
        disabled={disabled || checked === false}
        min={min}
        max={max}
        marks={sliderMarks}
        track={false}
        step={step}
        value={value}
        onChange={(nextValue) => onChange(nextValue as number)}
      />
    </div>
  )

  if (checked !== undefined && onCheckedChange) {
    return (
      <div className={['ui-range-row', className ?? ''].filter(Boolean).join(' ')}>
        <CheckboxField
          checked={checked}
          className="ui-checkbox-field-inline"
          label={<span id={labelId}>{label}</span>}
          onChange={onCheckedChange}
        />
        {range}
      </div>
    )
  }

  return (
    <div className={['ui-range-row', className ?? ''].filter(Boolean).join(' ')}>
      <span id={labelId}>{label}</span>
      {range}
    </div>
  )
}
