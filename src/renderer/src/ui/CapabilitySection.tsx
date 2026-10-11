import { useId, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { SegmentedControl } from './SegmentedControl'
import { UI_ICON_SIZE_SMALL } from './uiConstants'

export type CapabilityMode = 'all' | 'custom' | 'off'

export function CapabilitySection({ label, title, count, mode, disabled = false, reason, onChange, children }: {
  label: string; title?: ReactNode; count?: ReactNode; mode: CapabilityMode; disabled?: boolean; reason?: string
  onChange(mode: CapabilityMode): void; children: ReactNode
}) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const contentId = useId()
  const heading = <>{title ?? <span>{label}</span>}{count !== undefined && <small>{count}</small>}
    {reason && <span className="ui-badge" data-tooltip={reason}>{t('capabilities.inactive')}</span>}</>
  return <section className="ui-form-section ui-capability-section" aria-label={label}>
    <div className="ui-form-row ui-form-row-inline">
      {mode === 'custom' ? <button className="ui-disclosure-trigger ui-row" type="button" aria-label={label}
        aria-expanded={expanded} aria-controls={contentId} onClick={() => setExpanded(value => !value)}>
        {heading}<ChevronRight className="ui-disclosure-chevron" size={UI_ICON_SIZE_SMALL} aria-hidden="true" />
      </button> : <div className="ui-row">{heading}</div>}
      <SegmentedControl<CapabilityMode> ariaLabel={label} value={mode} disabled={disabled}
        options={(['all', 'custom', 'off'] as const).map(value => ({ value, label: t(`capabilities.${value}`) }))}
        onChange={onChange} />
    </div>
    {mode === 'custom' && <div id={contentId} hidden={!expanded}>{children}</div>}
  </section>
}
