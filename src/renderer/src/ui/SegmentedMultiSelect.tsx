import type { CSSProperties } from 'react'
import { CheckboxField } from './CheckboxField'

interface SegmentedMultiSelectProps<T extends string> {
  ariaLabel: string
  options: ReadonlyArray<{ value: T; label: string; ariaLabel?: string; checked: boolean; disabled?: boolean }>
  onChange(value: T, checked: boolean): void
  disabled?: boolean
  itemWidth?: 'content' | 'equal'
  minWidth?: CSSProperties['minWidth']
}

export function SegmentedMultiSelect<T extends string>({ ariaLabel, options, onChange, disabled, itemWidth = 'equal', minWidth }: SegmentedMultiSelectProps<T>) {
  return <div className="ui-segmented-control" role="group" aria-label={ariaLabel} data-selection="multiple" data-item-width={itemWidth} style={{ minWidth }}>
    {options.map(option => <CheckboxField className="ui-segmented-option" key={option.value}
      value={option.value} label={option.label} aria-label={option.ariaLabel}
      checked={option.checked} disabled={disabled || option.disabled}
      onChange={checked => onChange(option.value, checked)} />)}
  </div>
}
