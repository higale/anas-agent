import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { GlobalTooltip } from './GlobalTooltip'
import type { NativeTooltipApi } from '@shared/nativeTooltip'

afterEach(() => {
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'windowControlsOverlay')
})

function fixture(placement = 'top', visible = true, native?: NativeTooltipApi) {
  const overlay = Object.assign(new EventTarget(), { visible, getTitlebarAreaRect: () => new DOMRect(0, 0, 800, 36) })
  Object.defineProperty(navigator, 'windowControlsOverlay', { configurable: true, value: overlay })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return this.classList.contains('panel-slot') ? new DOMRect(0, 36, 1024, 700)
      : this.getAttribute('role') === 'tooltip' ? new DOMRect(0, 0, 160, 30) : new DOMRect(800, 55, 28, 28)
  })
  render(<><GlobalTooltip native={native} /><div className="panel-slot" ref={node => { if (node) node.checkVisibility = () => true }} />
    <button data-tooltip="Fold unchanged regions" data-tooltip-placement={placement}>Fold</button></>)
  fireEvent.focusIn(screen.getByRole('button'))
  return overlay
}

it('flips a top tooltip below its trigger when native caption controls occupy the space above', () => {
  fixture()
  const tip = screen.getByRole('tooltip')
  expect(Number.parseFloat(tip.style.top)).toBeGreaterThan(83)
})

it('keeps right-side tooltips outside a resized native titlebar overlay', () => {
  const overlay = fixture('right')
  overlay.getTitlebarAreaRect = () => new DOMRect(0, 0, 800, 80)
  act(() => { overlay.dispatchEvent(new Event('geometrychange')) })
  expect(Number.parseFloat(screen.getByRole('tooltip').style.top)).toBeGreaterThan(80)
})

it('can place a tooltip above its trigger when there is no visible native overlay', () => {
  fixture('top', false)
  expect(Number.parseFloat(screen.getByRole('tooltip').style.top)).toBeLessThan(55)
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
})

it('uses a separate native surface over a panel and dismisses it before executing a click', () => {
  const setTooltip = vi.fn().mockResolvedValue(undefined)
  fixture('top', true, { setTooltip })
  expect(setTooltip).toHaveBeenLastCalledWith(expect.objectContaining({ label: 'Fold unchanged regions',
    bounds: expect.objectContaining({ width: 160, height: 30 }) }))
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument()
  fireEvent.pointerDown(screen.getByRole('button'))
  expect(setTooltip).toHaveBeenLastCalledWith(null)
})
