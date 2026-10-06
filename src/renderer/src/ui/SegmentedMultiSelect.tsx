import type { CSSProperties } from 'react'
import { Check, Circle } from 'lucide-react'

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
    {options.map(option => {
      const Icon = option.checked ? Check : Circle
      return <label className="ui-segmented-option" key={option.value}>
        <input className="ui-visually-hidden" type="checkbox" value={option.value} aria-label={option.ariaLabel}
          checked={option.checked} disabled={disabled || option.disabled}
          onChange={event => onChange(option.value, event.currentTarget.checked)} />
        <span><Icon className="ui-segmented-check" aria-hidden="true" />{option.label}</span>
      </label>
    })}
  </div>
}
