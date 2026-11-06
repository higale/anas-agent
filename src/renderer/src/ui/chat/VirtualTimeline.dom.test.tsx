import { act, fireEvent, render } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VirtualTimeline, type TimelineRow } from './VirtualTimeline'

let hidden = false
const observers = new Set<ResizeObserverCallback>(), frames: FrameRequestCallback[] = []
const tops = new WeakMap<Element, number>()
function height(element: Element): number {
  if (element.hasAttribute('data-timeline-row')) {
    const measured = Number.parseFloat((element.firstElementChild as HTMLElement)?.style.height)
    return Number.isFinite(measured) ? measured : 40
  }
  if ((element as HTMLElement).style?.height) return Number.parseFloat((element as HTMLElement).style.height)
  return [...element.children].reduce((sum, child) => sum + height(child), 0)
}
const measure = () => act(() => {
  for (const observer of observers) observer([], {} as ResizeObserver)
  for (const callback of frames.splice(0)) callback(0)
})
beforeEach(() => {
  hidden = false; observers.clear(); frames.length = 0
  vi.stubGlobal('ResizeObserver', class {
    constructor(private callback: ResizeObserverCallback) {}
    observe() { observers.add(this.callback) }
    disconnect() { observers.delete(this.callback) }
  })
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.push(callback); return frames.length })
  vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function (this: HTMLElement) { return !hidden && this.className === 'test-panel' ? 300 : 0 })
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function (this: HTMLElement) { return hidden ? 0 : height(this) })
  vi.spyOn(Element.prototype, 'getClientRects').mockImplementation(function (this: Element) { return (hidden ? [] : [this.getBoundingClientRect()]) as unknown as DOMRectList })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const panel = this.closest('.test-panel'), top = panel && panel !== this ? -(tops.get(panel) ?? 0) : 0
    return { top, left: 0, right: 800, bottom: top + height(this), width: 800, height: height(this), x: 0, y: top, toJSON() {} }
  })
  vi.spyOn(Element.prototype, 'scrollTop', 'get').mockImplementation(function (this: Element) { return tops.get(this) ?? 0 })
  vi.spyOn(Element.prototype, 'scrollTop', 'set').mockImplementation(function (this: Element, value: number) {
    tops.set(this, Math.max(0, Math.min(value, height(this) - 300)))
  })
})
afterEach(() => { vi.unstubAllGlobals() })
const row = (index: number, size = 40): TimelineRow => ({ key: String(index), content: <div style={{ height: size }}>{`row ${index}`}</div>, estimatedHeight: size })
function harness(rows: TimelineRow[], following = false) {
  const panelRef = createRef<HTMLDivElement>(), followOutput = { current: following }
  const content = (rows: TimelineRow[]) => <div className="test-panel" ref={panelRef}><VirtualTimeline rows={rows} panelRef={panelRef} followOutput={followOutput} /></div>
  const view = render(content(rows)); measure()
  return { ...view, panel: panelRef.current!, update: (rows: TimelineRow[]) => { view.rerender(content(rows)); measure() } }
}

describe('one virtual timeline per panel', () => {
  it.each([false, true])('mounts a leading zero-height status so later errors remain visible (following: %s)', following => {
    const status = { key: 'status', estimatedHeight: 0, content: <div style={{ height: 0 }} /> }
    const view = harness([status, row(1)], following)
    view.update([{ ...status, content: <div role="alert" style={{ height: 40 }}>Directory read failed</div> }, row(1)])
    expect(view.getByRole('alert')).toHaveTextContent('Directory read failed')
    expect(view.getByText('row 1')).toBeInTheDocument()
  })
  it('mounts only the viewport and preserves the same row when older messages prepend', () => {
    const rows = Array.from({ length: 5000 }, (_, index) => row(index)), view = harness(rows)
    expect(view.container.querySelectorAll('[data-timeline-row]').length).toBeLessThan(50)
    act(() => { view.panel.scrollTop = 5000; fireEvent.scroll(view.panel) }); measure()
    expect(view.getByText('row 125')).toBeInTheDocument()
    view.update([row(-2), row(-1), ...rows])
    expect(view.panel.scrollTop).toBe(5080)
    expect(view.getByText('row 125')).toBeInTheDocument()
  })
  it('corrects a measured height above the reading anchor without following the tail', () => {
    const rows = Array.from({ length: 500 }, (_, index) => row(index)), view = harness(rows)
    act(() => { view.panel.scrollTop = 5000; fireEvent.scroll(view.panel) }); measure()
    view.update(rows.map((entry, index) => index === 120 ? row(index, 80) : entry))
    expect(view.panel.scrollTop).toBe(5040)
  })
  it.each([[40, 0], [1500, 1200]])('preserves a valid reading offset when a long detail shrinks to %s', (size, expected) => {
    const rows = [row(0, 2000), ...Array.from({ length: 100 }, (_, index) => row(index + 1))], view = harness(rows)
    act(() => { view.panel.scrollTop = 1200; fireEvent.scroll(view.panel) }); measure()
    view.update([row(0, size), ...rows.slice(1)])
    expect(view.panel.scrollTop).toBe(expected)
    expect(view.getByText('row 0')).toBeInTheDocument()
  })
  it('moves a removed member anchor to its surviving parent when a group collapses', () => {
    const head = Array.from({ length: 20 }, (_, index) => row(index)), parent = row(20)
    const children = Array.from({ length: 100 }, (_, index) => ({ ...row(index + 21), parentKey: parent.key }))
    const tail = Array.from({ length: 50 }, (_, index) => row(index + 121)), view = harness([...head, parent, ...children, ...tail])
    act(() => { view.panel.scrollTop = 2000; fireEvent.scroll(view.panel) }); measure()
    view.update([...head, parent, ...tail])
    expect(view.panel.scrollTop).toBe(800)
  })
  it('restores a hidden panel against its updated directory without overwriting the anchor', () => {
    const rows = Array.from({ length: 500 }, (_, index) => row(index)), view = harness(rows)
    act(() => { view.panel.scrollTop = 5000; fireEvent.scroll(view.panel) }); measure()
    hidden = true; view.update([row(-1), ...rows])
    expect(view.panel.scrollTop).toBe(5000)
    hidden = false; measure()
    expect(view.panel.scrollTop).toBe(5040)
  })
  it('follows the new last row even when removal and insertion leave total height unchanged', () => {
    const rows = Array.from({ length: 500 }, (_, index) => row(index)), view = harness(rows, true)
    expect(view.getByText('row 499')).toBeInTheDocument()
    view.update([...rows.slice(1), row(500)])
    expect(view.getByText('row 500')).toBeInTheDocument()
    expect(view.panel.scrollTop).toBe(view.panel.scrollHeight - view.panel.clientHeight)
  })
})
