import { useId, type ReactNode } from 'react'
import { CapabilityGroupActions } from './CapabilityGroupActions'

/** Inner resource groups remain visible whenever their top-level capability section is open. */
export function CapabilityResourceGroup({ label, ariaLabel = label, count, actions, divider = false, tooltip, inactiveReason, onSelectionChange, allSelected = false, selectionDisabled, children }: {
  label: string
  ariaLabel?: string
  count: ReactNode
  actions?: ReactNode
  divider?: boolean
  tooltip?: string
  inactiveReason?: string
  onSelectionChange?(checked: boolean): void
  allSelected?: boolean
  selectionDisabled?: boolean
  children: ReactNode
}) {
  const reasonId = useId()
  return <section className={`ui-form-section ui-capability-resource-group${divider ? ' ui-capability-resource-group-divider' : ''}`} aria-label={ariaLabel} aria-describedby={inactiveReason ? reasonId : undefined}>
    {inactiveReason && <span id={reasonId} hidden>{inactiveReason}</span>}
    <div className="ui-row">
      <div className="ui-row">
        <span className={`ui-truncate${inactiveReason ? ' ui-resource-unavailable' : ''}`} data-tooltip={[inactiveReason, tooltip].filter(Boolean).join('\n') || undefined}>{label}</span><small>{count}</small>
        {onSelectionChange && <CapabilityGroupActions allSelected={allSelected} disabled={selectionDisabled} onChange={onSelectionChange} />}
      </div>
      {actions}
    </div>
    <div className="ui-form-section">{children}</div>
  </section>
}
