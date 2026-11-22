import { Fragment, type CSSProperties, type ReactNode } from 'react'
import { CheckboxField } from './CheckboxField'

interface SegmentedMultiSelectProps<T extends string> {
  ariaLabel: string
  options: ReadonlyArray<{ value: T; label: string; ariaLabel?: string; checked: boolean; disabled?: boolean; accessory?: ReactNode }>
  onChange(value: T, checked: boolean): void
  disabled?: boolean
  busy?: boolean
  itemWidth?: 'content' | 'equal'
  minWidth?: CSSProperties['minWidth']
}

export function SegmentedMultiSelect<T extends string>({ ariaLabel, options, onChange, disabled, busy, itemWidth = 'equal', minWidth }: SegmentedMultiSelectProps<T>) {
  return <div className="ui-segmented-control" role="group" aria-label={ariaLabel} aria-busy={busy || undefined} data-selection="multiple" data-item-width={itemWidth} style={{ minWidth }}>
    {options.map(option => <Fragment key={option.value}><CheckboxField className="ui-segmented-option" key={option.value}
      value={option.value} label={option.label} aria-label={option.ariaLabel}
      checked={option.checked} disabled={disabled || option.disabled}
      aria-disabled={busy || undefined}
      onChange={checked => { if (!busy) onChange(option.value, checked) }} />{option.accessory && <span className="ui-segmented-accessory">{option.accessory}</span>}</Fragment>)}
  </div>
}
