import { useTranslation } from 'react-i18next'
import { UI_ICON_SIZE_NAV } from './uiConstants'

/** Select the whole group, or clear it when all selectable entries are selected. */
export function CapabilityGroupActions({ allSelected, disabled, busy = false, onChange }: {
  allSelected: boolean; disabled?: boolean; busy?: boolean; onChange(checked: boolean): void
}) {
  const { t } = useTranslation()
  const title = t(allSelected ? 'capabilities.clear_group_all' : 'capabilities.select_group_all')
  return <span className="ui-row ui-capability-group-actions">
    <button type="button" className="ui-tool-button ui-tool-button-small"
      disabled={disabled} aria-disabled={busy || undefined} aria-busy={busy || undefined}
      aria-label={title} data-tooltip={title} onClick={() => { if (!busy) onChange(!allSelected) }}>
      <svg width={UI_ICON_SIZE_NAV} height={UI_ICON_SIZE_NAV} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M11 5h11M11 12h11M11 19h11" />
        <path d="m2 5 2 2 4-4m-6 9 2 2 4-4m-6 9 2 2 4-4" />
      </svg>
    </button>
  </span>
}
