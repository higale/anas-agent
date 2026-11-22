import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { UI_ICON_SIZE_SMALL } from './uiConstants'
import { CapabilityGroupActions } from './CapabilityGroupActions'
import { SegmentedControl } from './SegmentedControl'

export type CapabilityMode = 'all' | 'custom' | 'off'

export function CapabilitySection({ label, selected, total, countSuffix, reason, actions, mode, disabled, onChange, onSelectionChange, allSelected = selected === total, selectionDisabled, children }: {
  label: string; selected: number; total: number; countSuffix?: ReactNode; reason?: string
  mode: CapabilityMode; disabled?: boolean; onChange(mode: CapabilityMode): void
  actions?: ReactNode; children: ReactNode
  onSelectionChange?(checked: boolean): void
  allSelected?: boolean; selectionDisabled?: boolean
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  return <section className="ui-form-section ui-capability-section" aria-label={label}>
    <div className="ui-form-row ui-form-row-inline">
      <div className="ui-row">
        <button className="ui-disclosure-trigger ui-row" type="button" aria-label={label}
          data-tooltip={reason} aria-describedby={reason ? `${contentId}-reason` : undefined}
          aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
          <span className={reason ? 'ui-resource-unavailable' : undefined}>{label}</span><small>{selected}/{total}{countSuffix}</small>
          <ChevronRight className="ui-disclosure-chevron" size={UI_ICON_SIZE_SMALL} aria-hidden="true" />
        </button>
        {mode === 'custom' && onSelectionChange && <CapabilityGroupActions allSelected={allSelected}
          disabled={disabled || (selectionDisabled ?? total === 0)} onChange={onSelectionChange} />}
        {actions}
      </div>
      {reason && <span id={`${contentId}-reason`} hidden>{reason}</span>}
      <SegmentedControl ariaLabel={label} value={mode} disabled={disabled}
        options={(['all', 'custom', 'off'] as const).map(value => ({ value, label: t(`capabilities.${value}`) }))}
        onChange={onChange} />
    </div>
    <div id={contentId} hidden={!expanded}>{children}</div>
  </section>
}
