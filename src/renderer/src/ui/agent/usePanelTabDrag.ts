import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent, type RefObject } from 'react'
import type { WorkspacePanelTab } from './useWorkspacePanels'

interface DragPreview {
  viewId: string
  beforeViewId: string | null
  markerLeft: number
  outside: boolean
  canDetach: boolean
}

interface Options {
  scope: string
  enabled: boolean
  tabs: WorkspacePanelTab[]
  listRef: RefObject<HTMLDivElement | null>
  onReorder(viewId: string, beforeViewId: string | null): void
  onDetach(viewId: string): void
}

/** Keep a drag provisional until release; the main process owns committed order and placement. */
export function usePanelTabDrag(options: Options) {
  const [preview, setPreview] = useState<DragPreview | null>(null)
  const current = useRef(options)
  const session = useRef<{ viewId: string; scope: string; cancel(): void } | undefined>(undefined)
  useLayoutEffect(() => {
    current.current = options
    const drag = session.current
    if (drag && (!options.enabled || drag.scope !== options.scope
      || !options.tabs.some(tab => tab.id === drag.viewId && !tab.moving))) drag.cancel()
  }, [options])
  useEffect(() => () => session.current?.cancel(), [])

  function onPointerDown(event: PointerEvent<HTMLDivElement>): void {
    if (!event.isPrimary || event.button !== 0 || event.pointerType === 'touch' || !current.current.enabled) return
    const list = current.current.listRef.current
    const target = (event.target as Element).closest<HTMLElement>('[role="tab"][data-panel-id]')
    const viewId = target?.dataset.panelId
    if (!list || !target || !list.contains(target) || !viewId) return
    const tab = current.current.tabs.find(tab => tab.id === viewId)
    if (!tab || tab.moving) return
    session.current?.cancel()

    const { pointerId, clientX: startX, clientY: startY } = event
    let point = { x: startX, y: startY }
    let active = false
    let frame = 0
    let previousTime = 0
    let latest: DragPreview | null = null
    const abort = new AbortController()

    const measure = () => {
      const tab = current.current.tabs.find(item => item.id === viewId)
      const header = list.closest('.workspace-panels-titlebar')
      if (!target.isConnected || !header || !tab || tab.moving) { finish(false); return }
      if (!active) {
        if (Math.hypot(point.x - startX, point.y - startY) < 6) return
        active = true
        document.documentElement.classList.add('ui-tab-dragging')
      }
      const area = header.getBoundingClientRect()
      const bounds = list.getBoundingClientRect()
      const outside = point.x < area.left - 24 || point.x > area.right + 24
        || point.y < area.top - 24 || point.y > area.bottom + 24
      const targets = [...list.querySelectorAll<HTMLElement>('[role="tab"][data-panel-id]')]
        .filter(item => item.dataset.panelId !== viewId)
        .map(item => ({ id: item.dataset.panelId!, bounds: item.closest('.ui-tab-item')!.getBoundingClientRect() }))
      const before = targets.find(item => point.x < item.bounds.left + item.bounds.width / 2)
      const marker = before?.bounds.left ?? targets.at(-1)?.bounds.right ?? bounds.left
      latest = { viewId, beforeViewId: before?.id ?? null, outside, canDetach: tab.locations.includes('window'),
        markerLeft: Math.max(1, Math.min(bounds.width - 2, marker - bounds.left)) + list.scrollLeft }
      const next = latest
      setPreview(previous => previous && previous.viewId === next.viewId && previous.beforeViewId === next.beforeViewId
        && previous.markerLeft === next.markerLeft && previous.outside === next.outside && previous.canDetach === next.canDetach ? previous : next)
    }
    const tick = (time: number) => {
      if (session.current?.viewId !== viewId) return
      if (active && !latest?.outside) {
        const bounds = list.getBoundingClientRect()
        const edge = Math.min(24, bounds.width / 4)
        const speed = point.x < bounds.left + edge ? -Math.min(1, (bounds.left + edge - point.x) / edge)
          : point.x > bounds.right - edge ? Math.min(1, (point.x - bounds.right + edge) / edge) : 0
        list.scrollLeft += speed * Math.min(32, previousTime ? time - previousTime : 16) * 0.6
      }
      previousTime = time
      measure()
      if (session.current?.viewId === viewId) frame = requestAnimationFrame(tick)
    }
    function finish(commit: boolean): void {
      if (session.current?.viewId !== viewId) return
      session.current = undefined
      abort.abort()
      cancelAnimationFrame(frame)
      if (target!.hasPointerCapture(pointerId)) target!.releasePointerCapture(pointerId)
      document.documentElement.classList.remove('ui-tab-dragging')
      setPreview(null)
      if (!commit || !active || !latest) return
      if (latest.outside) {
        if (latest.canDetach) current.current.onDetach(viewId!)
      } else {
        const tabs = current.current.tabs
        const next = tabs[tabs.findIndex(tab => tab.id === viewId) + 1]?.id ?? null
        if (next !== latest.beforeViewId) current.current.onReorder(viewId!, latest.beforeViewId)
      }
    }
    const updatePoint = (event: globalThis.PointerEvent) => { point = { x: event.clientX, y: event.clientY } }
    window.addEventListener('pointermove', event => {
      if (event.pointerId !== pointerId) return
      if (!event.buttons) { finish(false); return }
      updatePoint(event); measure()
      if (active) event.preventDefault()
    }, { signal: abort.signal, passive: false })
    window.addEventListener('pointerup', event => {
      if (event.pointerId !== pointerId) return
      updatePoint(event); measure(); finish(true)
    }, { signal: abort.signal })
    window.addEventListener('pointercancel', event => { if (event.pointerId === pointerId) finish(false) }, { signal: abort.signal })
    target.addEventListener('lostpointercapture', () => finish(false), { signal: abort.signal })
    window.addEventListener('blur', () => finish(false), { signal: abort.signal })
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); finish(false)
    }, { signal: abort.signal, capture: true })
    session.current = { viewId, scope: current.current.scope, cancel: () => finish(false) }
    target.setPointerCapture(pointerId)
    frame = requestAnimationFrame(tick)
  }

  return { preview, onPointerDown }
}
