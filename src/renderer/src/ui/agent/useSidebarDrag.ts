import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent, type PointerEvent, type RefObject } from 'react'
import type { SidebarReorderRequest } from '@shared/sidebarOrder'

interface DragPreview {
  request: SidebarReorderRequest
  top: number
  left: number
  width: number
}

/** One provisional vertical drag interaction for project headings and conversation rows. */
export function useSidebarDrag(
  listRef: RefObject<HTMLElement | null>,
  onReorder?: (request: SidebarReorderRequest) => void
) {
  const [preview, setPreview] = useState<DragPreview | null>(null)
  const callback = useRef(onReorder)
  const session = useRef<{ cancel(): void } | undefined>(undefined)
  const suppressClick = useRef(false)
  useLayoutEffect(() => { callback.current = onReorder }, [onReorder])
  useEffect(() => () => session.current?.cancel(), [])

  function onPointerDown(event: PointerEvent<HTMLElement>): void {
    suppressClick.current = false
    if (!callback.current || !event.isPrimary || event.button !== 0 || event.pointerType === 'touch') return
    const list = listRef.current
    const handle = (event.target as Element).closest<HTMLElement>('[data-sidebar-drag-handle]')
    const source = handle?.closest<HTMLElement>('[data-sidebar-sort-id]')
    if (!list || !handle || !source || !list.contains(source)) return
    const { sidebarSortId: id, sidebarSortKind: kind, sidebarSortGroup: groupId, sidebarSortPinned: pinned } = source.dataset
    if (!id || (kind !== 'project' && kind !== 'thread') || !groupId) return
    session.current?.cancel()
    const { pointerId, clientX: startX, clientY: startY } = event
    let point = { x: startX, y: startY }
    let active = false
    let frame = 0
    let previousTime = 0
    let latest: DragPreview | null = null
    const abort = new AbortController()
    const sameGroup = (item: HTMLElement) => item.dataset.sidebarSortKind === kind
      && item.dataset.sidebarSortGroup === groupId && item.dataset.sidebarSortPinned === pinned
    const groupItems = () => [...list.querySelectorAll<HTMLElement>('[data-sidebar-sort-id]')].filter(sameGroup)
    const updatePreview = (next: DragPreview | null) => {
      latest = next
      setPreview(previous => previous?.request.beforeId === next?.request.beforeId && previous?.top === next?.top
        && previous?.left === next?.left && previous?.width === next?.width ? previous : next)
    }
    const measure = () => {
      if (!source.isConnected || !handle.isConnected || !sameGroup(source) || !callback.current) { finish(false); return }
      if (!active) {
        if (Math.hypot(point.x - startX, point.y - startY) < 6) return
        active = true
        source.dataset.sidebarDragging = 'true'
        document.documentElement.classList.add('ui-sidebar-dragging')
      }
      const bounds = list.getBoundingClientRect()
      const hit = document.elementFromPoint(point.x, point.y)?.closest<HTMLElement>(`[data-sidebar-sort-kind="${kind}"]`)
      if (point.x < bounds.left || point.x > bounds.right || point.y < bounds.top || point.y > bounds.bottom
        || !hit || !list.contains(hit) || !sameGroup(hit) || hit === source) { updatePreview(null); return }
      const items = groupItems()
      const targetBounds = hit.getBoundingClientRect()
      const after = point.y >= targetBounds.top + targetBounds.height / 2
      const beforeId = after ? items[items.indexOf(hit) + 1]?.dataset.sidebarSortId ?? null : hit.dataset.sidebarSortId!
      const currentNext = items[items.indexOf(source) + 1]?.dataset.sidebarSortId ?? null
      if (beforeId === id || beforeId === currentNext) { updatePreview(null); return }
      updatePreview({ request: { kind, groupId, pinned: pinned === 'true', id, beforeId },
        top: Math.max(bounds.top, Math.min(bounds.bottom, after ? targetBounds.bottom : targetBounds.top)),
        left: targetBounds.left, width: targetBounds.width })
    }
    const tick = (time: number) => {
      if (!session.current) return
      const bounds = list.getBoundingClientRect()
      if (active && point.x >= bounds.left && point.x <= bounds.right && point.y >= bounds.top && point.y <= bounds.bottom) {
        const edge = Math.min(28, bounds.height / 4)
        const speed = point.y < bounds.top + edge ? -(bounds.top + edge - point.y) / edge
          : point.y > bounds.bottom - edge ? (point.y - bounds.bottom + edge) / edge : 0
        list.scrollTop += speed * Math.min(32, previousTime ? time - previousTime : 16) * 0.6
      }
      previousTime = time
      measure()
      if (session.current) frame = requestAnimationFrame(tick)
    }
    function finish(commit: boolean): void {
      if (!session.current) return
      session.current = undefined
      abort.abort()
      cancelAnimationFrame(frame)
      if (handle!.hasPointerCapture(pointerId)) handle!.releasePointerCapture(pointerId)
      delete source!.dataset.sidebarDragging
      document.documentElement.classList.remove('ui-sidebar-dragging')
      setPreview(null)
      if (active) {
        // Escape can precede pointerup by an arbitrary delay. Keep suppressing
        // this gesture's click until it arrives or a new pointer gesture starts.
        suppressClick.current = true
      }
      if (commit && active && latest) callback.current?.(latest.request)
    }
    window.addEventListener('pointermove', event => {
      if (event.pointerId !== pointerId) return
      if (!event.buttons) { finish(false); return }
      point = { x: event.clientX, y: event.clientY }; measure()
      if (active) event.preventDefault()
    }, { signal: abort.signal, passive: false })
    window.addEventListener('pointerup', event => {
      if (event.pointerId !== pointerId) return
      point = { x: event.clientX, y: event.clientY }; measure(); finish(true)
    }, { signal: abort.signal })
    window.addEventListener('pointercancel', event => { if (event.pointerId === pointerId) finish(false) }, { signal: abort.signal })
    handle.addEventListener('lostpointercapture', () => finish(false), { signal: abort.signal })
    window.addEventListener('blur', () => finish(false), { signal: abort.signal })
    window.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return
      event.preventDefault(); event.stopPropagation(); finish(false)
    }, { signal: abort.signal, capture: true })
    session.current = { cancel: () => finish(false) }
    handle.setPointerCapture(pointerId)
    frame = requestAnimationFrame(tick)
  }

  function onClickCapture(event: MouseEvent<HTMLElement>): void {
    if (suppressClick.current) {
      suppressClick.current = false
      event.preventDefault(); event.stopPropagation()
    }
  }

  return { preview, onPointerDown, onClickCapture }
}
