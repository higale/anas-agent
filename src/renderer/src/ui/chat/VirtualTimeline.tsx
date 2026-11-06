import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import type { FollowOutputState } from './followOutput'
import { scrollLayoutEvent } from './ScrollBoundaryNavigation'

export interface TimelineRow {
  key: string
  content: ReactNode
  className?: string
  parentKey?: string
  estimatedHeight?: number
  activityKey?: string
}
interface Layout { keys: string[]; offsets: number[]; total: number }
function rowAt(offsets: number[], position: number) {
  let lower = 0, upper = Math.max(0, offsets.length - 1)
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2)
    if (offsets[middle] <= position) lower = middle
    else upper = middle - 1
  }
  return lower
}

function MeasuredRow({ row, measure }: { row: TimelineRow; measure(key: string, height: number): void }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const element = ref.current!
    const observer = new ResizeObserver(() => {
      if (element.getClientRects().length) measure(row.key, element.getBoundingClientRect().height)
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [row.key, measure])
  return <div ref={ref} data-timeline-row={row.key} data-timeline-parent={row.parentKey} data-activity-item={row.activityKey}
    className={`timeline-row ${row.className ?? ''}`} style={{ display: 'flow-root' }}>{row.content}</div>
}

/** One layout owner per scroll panel. Metadata is complete; only mounted rows
 * are virtual. A request cannot move this viewport because it has no scroll API. */
export function VirtualTimeline({ rows, panelRef, followOutput, resetKey }: {
  rows: TimelineRow[]; panelRef: RefObject<HTMLElement | null>; followOutput: FollowOutputState; resetKey?: string
}) {
  const root = useRef<HTMLDivElement>(null)
  const heights = useRef(new Map<string, number>())
  const [measured, setMeasured] = useState(0)
  const [viewport, setViewport] = useState({ top: 0, height: 800 })
  const layout = useMemo<Layout>(() => {
    let total = 0
    const offsets = rows.map(row => { const top = total; total += heights.current.get(row.key) ?? row.estimatedHeight ?? 40; return top })
    return { keys: rows.map(row => row.key), offsets, total }
  // Heights mutate in ResizeObserver callbacks; the counter invalidates this cached layout.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, measured])
  const latest = useRef({ layout, rows }); latest.current = { layout, rows }
  const anchor = useRef<{ key: string; offset: number; index: number; parent?: string; keys: string[] } | undefined>(undefined)
  const measure = useCallback((key: string, height: number) => {
    const previous = heights.current.get(key)
    if (height >= 0 && (previous === undefined || Math.abs(previous - height) > 0.5)) {
      heights.current.set(key, height); setMeasured(value => value + 1)
    }
  }, [])
  const origin = useCallback(() => {
    const panel = panelRef.current, element = root.current
    return panel && element ? element.getBoundingClientRect().top - panel.getBoundingClientRect().top + panel.scrollTop : 0
  }, [panelRef])
  const capture = useCallback(() => {
    const panel = panelRef.current
    if (!panel?.clientHeight || !root.current?.getClientRects().length) return
    const { layout: current, rows: entries } = latest.current
    const top = Math.max(0, panel.scrollTop - origin()), index = rowAt(current.offsets, top)
    anchor.current = current.keys[index] ? { key: current.keys[index], offset: top - current.offsets[index], index,
      parent: entries[index]?.parentKey, keys: current.keys } : undefined
    setViewport(previous => Math.abs(previous.top - top) < 0.5 && previous.height === panel.clientHeight ? previous : { top, height: panel.clientHeight })
  }, [origin, panelRef])
  useLayoutEffect(() => {
    heights.current.clear(); anchor.current = undefined
  }, [resetKey])
  const restore = useCallback(() => {
    const panel = panelRef.current, saved = anchor.current, current = latest.current.layout
    if (!panel?.clientHeight || !root.current?.getClientRects().length) return
    if (followOutput.current) panel.scrollTop = panel.scrollHeight
    else if (saved) {
      let index = current.keys.indexOf(saved.key), offset = saved.offset
      if (index < 0) {
        offset = 0
        index = saved.parent ? current.keys.indexOf(saved.parent) : -1
        for (let distance = 1; index < 0 && distance <= saved.keys.length; distance++) {
          index = current.keys.indexOf(saved.keys[saved.index - distance])
          if (index < 0) index = current.keys.indexOf(saved.keys[saved.index + distance])
        }
      }
      if (index >= 0) {
        const height = (current.offsets[index + 1] ?? current.total) - current.offsets[index]
        // A shrinking detail can invalidate its saved internal position while
        // keeping the same row identity. Return to that row, not a later one.
        if (offset >= height) offset = 0
        panel.scrollTop = origin() + current.offsets[index] + offset
      }
    }
    panel.dispatchEvent(new Event(scrollLayoutEvent)); capture()
  }, [capture, followOutput, origin, panelRef])
  // Parent DOM refs attach after child layout effects. Subscribe after the
  // complete commit so initial mounting cannot permanently miss its panel.
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    let frame: number | undefined
    const scroll = () => { capture() }
    const resize = new ResizeObserver(() => {
      if (frame !== undefined) return
      frame = requestAnimationFrame(() => {
        frame = undefined
        restore()
      })
    })
    panel.addEventListener('scroll', scroll, { passive: true }); resize.observe(panel)
    restore()
    return () => { panel.removeEventListener('scroll', scroll); resize.disconnect(); if (frame !== undefined) cancelAnimationFrame(frame) }
  }, [capture, restore, panelRef])
  useLayoutEffect(() => {
    restore()
    const keys = new Set(layout.keys)
    for (const key of heights.current.keys()) if (!keys.has(key)) heights.current.delete(key)
  }, [layout, restore])
  const top = followOutput.current ? Math.max(0, layout.total - viewport.height) : viewport.top
  let start = rowAt(layout.offsets, Math.max(0, top - viewport.height))
  // Empty status rows share the next row's offset. Mount them at the visible
  // boundary too, so a later loading/error state can grow and be measured.
  while (start > 0 && layout.offsets[start - 1] === layout.offsets[start]) start--
  const end = Math.min(rows.length, rowAt(layout.offsets, top + viewport.height * 2) + 1)
  const before = layout.offsets[start] ?? 0, after = end < rows.length ? layout.total - layout.offsets[end] : 0
  return <div ref={root} className="virtual-timeline" style={{ overflowAnchor: 'none' }}>
    <div aria-hidden style={{ height: before }} />
    {rows.slice(start, end).map(row => <MeasuredRow key={row.key} row={row} measure={measure} />)}
    <div aria-hidden style={{ height: after }} />
  </div>
}
