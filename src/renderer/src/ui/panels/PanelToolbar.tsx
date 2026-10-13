import { useLayoutEffect, useRef, useState } from 'react'
import * as DropdownMenu from '@radix-ui/react-dropdown-menu'
import { Check, MoreHorizontal } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PanelState } from '@shared/panels'
import { pluginIconSources } from '@shared/plugins'
import { NoFocusButton } from '../NoFocusButton'
import { SelectableIconButton } from '../SelectableIconButton'
import { PluginIcon } from '../plugins/PluginIcon'
import { DropdownMenuContent, DropdownMenuRoot, DropdownMenuTrigger } from '../DropdownMenuShell'

export function PanelToolbar({ view, onAction }: { view: PanelState; onAction(id: string): void }) {
  const { t } = useTranslation()
  const container = useRef<HTMLDivElement>(null)
  const measure = useRef<HTMLSpanElement>(null)
  const [layout, setLayout] = useState({ width: undefined as number | undefined, count: Infinity })
  const toolbar = view.toolbar
  const actionCount = toolbar?.actions.length ?? 0
  useLayoutEffect(() => {
    const element = container.current, probe = measure.current
    if (!element || !probe) return
    const update = () => {
      const buttonWidth = probe.getBoundingClientRect().width
      if (!buttonWidth || !element.clientWidth) return
      const gap = parseFloat(getComputedStyle(element).columnGap) || 0
      const width = actionCount * (buttonWidth + gap) - gap
      const count = width <= element.clientWidth + 0.5 ? actionCount
        : Math.max(0, Math.floor((element.clientWidth + gap) / (buttonWidth + gap)) - 1)
      setLayout(previous => previous.width === width && previous.count === count ? previous : { width, count })
    }
    update()
    const observer = new ResizeObserver(update)
    observer.observe(element)
    observer.observe(probe)
    return () => observer.disconnect()
  }, [actionCount])
  if (!toolbar || view.content.kind !== 'plugin') return null
  const pluginId = view.content.pluginId
  const icon = (path: string) => <PluginIcon icon={pluginIconSources(pluginId, path)} monochrome />
  const disabled = (action: typeof toolbar.actions[number]) => action.disabled || !!view.pendingActionId || !!view.pendingLocation || !!view.loading
  const overflow = toolbar.actions.slice(layout.count)
  return <>
    {toolbar.status && <span className="panel-toolbar-status ui-truncate" data-tone={toolbar.status.tone}
      role="status" title={toolbar.status.label}>{toolbar.status.label}</span>}
    {toolbar.actions.length > 0 && <div ref={container} className="panel-toolbar-actions" style={{ width: layout.width }} aria-busy={!!view.pendingActionId}>
      <span ref={measure} className="panel-toolbar-measure ui-tool-button-small" aria-hidden="true" />
      {toolbar.actions.slice(0, layout.count).map(action => {
        if (action.pressed !== undefined) return <SelectableIconButton key={action.id} icon={icon(action.icon)} iconSize={16}
          label={action.label} pressed={action.pressed} preserveFocus variant="toolbar" className="ui-tool-button-small"
          disabled={disabled(action)} onClick={() => onAction(action.id)} />
        return <NoFocusButton key={action.id} type="button" className="ui-tool-button ui-tool-button-small"
          aria-label={action.label} data-tooltip={action.label}
          disabled={disabled(action)}
          onClick={() => onAction(action.id)}>{icon(action.icon)}</NoFocusButton>
      })}
      {overflow.length > 0 && <DropdownMenuRoot>
        <DropdownMenuTrigger asChild><NoFocusButton type="button" className="ui-tool-button ui-tool-button-small"
          aria-label={t('common.more')} data-tooltip={t('common.more')}><MoreHorizontal size={16} aria-hidden="true" /></NoFocusButton></DropdownMenuTrigger>
        <DropdownMenu.Portal><DropdownMenuContent className="ui-menu ui-menu-list" align="end">
          {overflow.map(action => {
            const props = { className: 'ui-menu-item ui-menu-item-row', disabled: disabled(action), onSelect: () => onAction(action.id) }
            const content = <>{icon(action.icon)}<span>{action.label}</span></>
            return action.pressed === undefined
              ? <DropdownMenu.Item key={action.id} {...props}>{content}</DropdownMenu.Item>
              : <DropdownMenu.CheckboxItem key={action.id} {...props} checked={action.pressed}>{content}
                <DropdownMenu.ItemIndicator><Check size={14} aria-hidden="true" /></DropdownMenu.ItemIndicator>
              </DropdownMenu.CheckboxItem>
          })}
        </DropdownMenuContent></DropdownMenu.Portal>
      </DropdownMenuRoot>}
    </div>}
  </>
}
