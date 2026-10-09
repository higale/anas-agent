import { List, Pause, Play, RefreshCw, Save, Settings, Square, Unplug, X } from 'lucide-react'
import type { PanelState } from '@shared/panels'
import { NoFocusButton } from '../NoFocusButton'

const icons = { unplug: Unplug, x: X, 'refresh-cw': RefreshCw, play: Play, pause: Pause, square: Square, settings: Settings, save: Save, list: List }

export function PanelToolbar({ view, onAction }: { view: PanelState; onAction(id: string): void }) {
  const toolbar = view.toolbar
  if (!toolbar) return null
  return <>
    {toolbar.status && <span className="panel-toolbar-status ui-truncate" data-tone={toolbar.status.tone}
      role="status" title={toolbar.status.label}>{toolbar.status.label}</span>}
    {toolbar.actions.length > 0 && <div className="panel-toolbar-actions" aria-busy={!!view.pendingActionId}>
      {toolbar.actions.map(action => {
        const Icon = icons[action.icon]
        return <NoFocusButton key={action.id} type="button" className="ui-tool-button ui-tool-button-small"
          aria-label={action.label} data-tooltip={action.label}
          disabled={action.disabled || !!view.pendingActionId || !!view.pendingLocation || !!view.loading}
          onClick={() => onAction(action.id)}><Icon size={16} aria-hidden="true" /></NoFocusButton>
      })}
    </div>}
  </>
}
