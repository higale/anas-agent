import { useId } from 'react'

interface SegmentedControlProps<T extends string> {
  ariaLabel: string
  options: ReadonlyArray<{ value: T; label: string; disabled?: boolean }>
  value: T
  onChange(value: T): void
  disabled?: boolean
  /** Defaults to the longest label's width for every item. */
  itemWidth?: 'content' | 'equal'
}

export function SegmentedControl<T extends string>({ ariaLabel, options, value, onChange, disabled, itemWidth = 'equal' }: SegmentedControlProps<T>) {
  const name = useId()
  return <div className="ui-segmented-control" role="radiogroup" aria-label={ariaLabel} data-item-width={itemWidth}>
    {options.map(option => <label className="ui-segmented-option" key={option.value}>
      <input className="ui-visually-hidden" type="radio" name={name} value={option.value}
        checked={value === option.value} disabled={disabled || option.disabled}
        onChange={() => onChange(option.value)} />
      <span>{option.label}</span>
    </label>)}
  </div>
}
