import { useId, useState, type ReactNode } from 'react'
import { ChevronRight, Folder } from 'lucide-react'
import { UI_ICON_SIZE_MEDIUM, UI_ICON_SIZE_SMALL } from './uiConstants'

/** Capability sources and their directories share disclosure behavior and header actions. */
export function CapabilityResourceGroup({ label, ariaLabel = label, count, actions, fullWidthDivider = false, tooltip, children }: {
  label: string
  ariaLabel?: string
  count: ReactNode
  actions?: ReactNode
  fullWidthDivider?: boolean
  tooltip?: string
  children: ReactNode
}) {
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  return <section className={`ui-form-section ui-capability-resource-group${fullWidthDivider ? ' ui-capability-resource-group-full-divider' : ''}`} aria-label={ariaLabel}>
    <div className="ui-row">
      <button type="button" className="ui-disclosure-trigger ui-row" aria-label={label}
        aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
        <Folder size={UI_ICON_SIZE_MEDIUM} aria-hidden="true" />
        <span className="ui-truncate" data-tooltip={tooltip}>{label}</span><small>{count}</small>
        <ChevronRight className="ui-disclosure-chevron" size={UI_ICON_SIZE_SMALL} aria-hidden="true" />
      </button>
      {actions}
    </div>
    <div id={contentId} hidden={!expanded}><div className="ui-form-section">{children}</div></div>
  </section>
}
