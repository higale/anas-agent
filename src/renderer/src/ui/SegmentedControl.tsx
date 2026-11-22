import { useId, type CSSProperties, type ReactNode } from 'react'

interface SegmentedControlProps<T extends string> {
  ariaLabel: string
  options: ReadonlyArray<{ value: T; label: string; icon?: ReactNode; disabled?: boolean }>
  value: T
  onChange(value: T): void
  disabled?: boolean
  busy?: boolean
  /** Defaults to the longest label's width for every item. */
  itemWidth?: 'content' | 'equal'
  /** Minimum width of the whole control; numbers are pixels. Content may grow wider. */
  minWidth?: CSSProperties['minWidth']
}

export function SegmentedControl<T extends string>({ ariaLabel, options, value, onChange, disabled, busy, itemWidth = 'equal', minWidth }: SegmentedControlProps<T>) {
  const name = useId()
  return <div className="ui-segmented-control" role="radiogroup" aria-label={ariaLabel} aria-busy={busy || undefined} data-item-width={itemWidth} style={{ minWidth }}>
    {options.map(option => <label className="ui-segmented-option" key={option.value}>
      <input className="ui-visually-hidden" type="radio" name={name} value={option.value}
        checked={value === option.value} disabled={disabled || option.disabled}
        aria-disabled={busy || undefined} onChange={() => { if (!busy) onChange(option.value) }} />
      <span>{option.icon && <span className="ui-segmented-icon" aria-hidden="true">{option.icon}</span>}{option.label}</span>
    </label>)}
  </div>
}
