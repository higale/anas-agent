import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react'
import { GripVertical, Maximize2, Minimize2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { PanelState } from '@shared/panels'
import { NoFocusButton } from '../NoFocusButton'
import { SquareArrowInDownLeft } from '../SquareArrowInDownLeft'
import { PluginIcon } from '../plugins/PluginIcon'
import { notice } from '../notice'
import { panelError } from './panelError'
import { PanelToolbar } from './PanelToolbar'

const edgeInset = 12

export function PanelWindowTitlebar({ view, fullScreen }: { view: PanelState; fullScreen: boolean }) {
  const { t } = useTranslation()
  const toolbar = useRef<HTMLDivElement>(null)
  const drag = useRef<{ pointerId: number; offsetX: number; handle: HTMLButtonElement } | null>(null)
  // A fraction of the available track keeps the toolbar in bounds after zoom or resize.
  const [position, setPosition] = useState(0.5)
  const [dragging, setDragging] = useState(false)
  const [moving, setMoving] = useState(false)
  const FullScreenIcon = fullScreen ? Minimize2 : Maximize2
  const fullScreenLabel = t(fullScreen ? 'panels.exit_fullscreen' : 'panels.enter_fullscreen')
  const finishDrag = useCallback(() => {
    const current = drag.current
    drag.current = null
    if (current?.handle.hasPointerCapture(current.pointerId)) current.handle.releasePointerCapture(current.pointerId)
    setDragging(false)
  }, [])
  useEffect(() => {
    window.addEventListener('blur', finishDrag)
    window.addEventListener('resize', finishDrag)
    return () => {
      window.removeEventListener('blur', finishDrag)
      window.removeEventListener('resize', finishDrag)
      finishDrag()
    }
  }, [fullScreen, finishDrag])
  const track = () => {
    const bounds = toolbar.current!.getBoundingClientRect()
    const parent = toolbar.current!.parentElement!.getBoundingClientRect()
    return { bounds, start: parent.left + edgeInset, width: Math.max(0, parent.width - bounds.width - 2 * edgeInset) }
  }
  const pointerMove = (event: PointerEvent<HTMLButtonElement>) => {
    const current = drag.current
    if (!current || current.pointerId !== event.pointerId) return
    event.preventDefault()
    const { start, width } = track()
    setPosition(width ? Math.max(0, Math.min(1, (event.clientX - current.offsetX - start) / width)) : 0.5)
  }
  const move = async () => {
    setMoving(true)
    try { await window.panelWindow.moveToSidebar() }
    catch (reason) { notice.error(panelError(reason, t)) }
    finally { setMoving(false) }
  }
  return <div ref={toolbar} className="panel-window-titlebar" data-floating={fullScreen} data-dragging={dragging}
    style={fullScreen ? { left: `calc(${position * 100}% + ${edgeInset * (1 - 2 * position)}px)`, transform: `translateX(${-position * 100}%)` } : undefined}>
    {fullScreen && <button type="button" className="ui-tool-button ui-tool-button-small panel-toolbar-grip"
      aria-label={t('panels.move_toolbar')} data-tooltip={dragging ? undefined : t('panels.move_toolbar')}
      onMouseDown={event => event.preventDefault()}
      onPointerDown={event => {
        if (event.button !== 0 || !event.isPrimary || drag.current) return
        event.preventDefault()
        drag.current = { pointerId: event.pointerId, offsetX: event.clientX - track().bounds.left, handle: event.currentTarget }
        event.currentTarget.setPointerCapture(event.pointerId)
        setDragging(true)
      }}
      onPointerMove={pointerMove}
      onPointerUp={event => { if (drag.current?.pointerId === event.pointerId) { pointerMove(event); finishDrag() } }}
      onPointerCancel={event => { if (drag.current?.pointerId === event.pointerId) finishDrag() }}
      onLostPointerCapture={finishDrag}
      onKeyDown={event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
        event.preventDefault()
        const width = track().width
        setPosition(value => event.key === 'Home' ? 0 : event.key === 'End' ? 1
          : Math.max(0, Math.min(1, value + (event.key === 'ArrowLeft' ? -24 : 24) / (width || 1))))
      }}><GripVertical size={16} aria-hidden="true" /></button>}
    {view.content.kind === 'plugin' && <PluginIcon icon={view.icon} />}
    <strong className="ui-truncate" title={view.name}>{view.name}</strong>
    <PanelToolbar view={view} onAction={id => {
      void window.panelWindow.invokeToolbarAction(id).catch(reason => notice.error(panelError(reason, t)))
    }} />
    {view.locations.includes('sidebar') && <NoFocusButton type="button" className="ui-tool-button ui-tool-button-small"
      aria-label={t('panels.move_sidebar')} data-tooltip={t('panels.move_sidebar')}
      disabled={moving || !!view.pendingLocation} onClick={() => void move()}>
      <SquareArrowInDownLeft size={16} aria-hidden="true" />
    </NoFocusButton>}
    {(fullScreen || document.documentElement.dataset.platform === 'win32') && <NoFocusButton type="button" className="ui-tool-button ui-tool-button-small"
      aria-label={fullScreenLabel} data-tooltip={fullScreenLabel}
      onClick={() => { void window.panelWindow.setFullScreen(!fullScreen).catch(reason => notice.error(panelError(reason, t))) }}>
      <FullScreenIcon size={16} aria-hidden="true" />
    </NoFocusButton>}
  </div>
}
