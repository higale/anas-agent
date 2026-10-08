import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { nativeTitlebarBottom, windowControlsOverlay } from './floatingViewport'
import { tooltipStyleProperties, type NativeTooltip, type NativeTooltipApi } from '@shared/nativeTooltip'

const tooltipOffset = 7
const tooltipShowDelayMs = 450
const viewportPadding = 12

type TooltipPlacement = 'top' | 'right'

interface TooltipRect {
  bottom: number
  height: number
  left: number
  right: number
  top: number
  width: number
}

interface TooltipState {
  label: string
  placement: TooltipPlacement
  rect: TooltipRect
}

interface TooltipPosition {
  left: number
  top: number
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function rectFromElement(element: HTMLElement): TooltipRect {
  const rect = element.getBoundingClientRect()
  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width
  }
}

function tooltipTargetFromEventTarget(target: EventTarget | null): HTMLElement | null {
  if (!(target instanceof Element)) return null
  const element = target.closest<HTMLElement>('[data-tooltip]')
  if (!element) return null
  if (element.hasAttribute('disabled') || element.getAttribute('aria-disabled') === 'true') return null
  const label = element.dataset.tooltip?.trim()
  return label ? element : null
}

function tooltipPlacement(element: HTMLElement): TooltipPlacement {
  return element.dataset.tooltipPlacement === 'right' ? 'right' : 'top'
}

function computePosition(state: TooltipState, tooltip: HTMLElement): TooltipPosition {
  const tooltipRect = tooltip.getBoundingClientRect()
  const maxLeft = window.innerWidth - viewportPadding - tooltipRect.width
  const maxTop = window.innerHeight - viewportPadding - tooltipRect.height
  const minTop = Math.max(viewportPadding, nativeTitlebarBottom() + tooltipOffset)

  if (state.placement === 'right') {
    const rightLeft = state.rect.right + tooltipOffset
    const leftLeft = state.rect.left - tooltipOffset - tooltipRect.width
    const left = rightLeft + tooltipRect.width <= window.innerWidth - viewportPadding
      ? rightLeft
      : leftLeft >= viewportPadding
        ? leftLeft
        : state.rect.left + state.rect.width / 2 - tooltipRect.width / 2
    return {
      left: clamp(left, viewportPadding, maxLeft),
      top: clamp(state.rect.top + state.rect.height / 2 - tooltipRect.height / 2, minTop, maxTop)
    }
  }

  const top = state.rect.top - tooltipOffset - tooltipRect.height
  const bottom = state.rect.bottom + tooltipOffset
  const preferredTop = top >= minTop ? top : bottom
  return {
    left: clamp(state.rect.left + state.rect.width / 2 - tooltipRect.width / 2, viewportPadding, maxLeft),
    top: clamp(preferredTop, minTop, maxTop)
  }
}

export function GlobalTooltip({ native }: { native?: NativeTooltipApi } = {}) {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null)
  const [position, setPosition] = useState<TooltipPosition | null>(null)
  const [nativePresentation, setNativePresentation] = useState<NativeTooltip | null>(null)
  const tooltipRef = useRef<HTMLDivElement | null>(null)
  const activeTargetRef = useRef<HTMLElement | null>(null)
  const pendingTargetRef = useRef<HTMLElement | null>(null)
  const showTimerRef = useRef<number | undefined>(undefined)

  useEffect(() => {
    function clearShowTimer(): void {
      if (showTimerRef.current !== undefined) {
        window.clearTimeout(showTimerRef.current)
        showTimerRef.current = undefined
      }
      pendingTargetRef.current = null
    }

    function showTooltip(element: HTMLElement): void {
      clearShowTimer()
      activeTargetRef.current = element
      setTooltip({
        label: element.dataset.tooltip?.trim() ?? '',
        placement: tooltipPlacement(element),
        rect: rectFromElement(element)
      })
    }

    function scheduleTooltip(element: HTMLElement): void {
      if (activeTargetRef.current === element) return
      clearShowTimer()
      pendingTargetRef.current = element
      showTimerRef.current = window.setTimeout(() => {
        if (pendingTargetRef.current === element && element.isConnected) showTooltip(element)
      }, tooltipShowDelayMs)
    }

    function hideTooltip(element?: HTMLElement | null): void {
      if (element && activeTargetRef.current !== element) return
      clearShowTimer()
      activeTargetRef.current = null
      setTooltip(null)
      setPosition(null)
      setNativePresentation(null)
    }

    function refreshTooltip(): void {
      const target = activeTargetRef.current
      if (!target?.isConnected) {
        hideTooltip()
        return
      }
      const label = target.dataset.tooltip?.trim()
      if (!label) {
        hideTooltip(target)
        return
      }
      setTooltip({
        label,
        placement: tooltipPlacement(target),
        rect: rectFromElement(target)
      })
    }

    function handlePointerOver(event: PointerEvent): void {
      const target = tooltipTargetFromEventTarget(event.target)
      if (target) scheduleTooltip(target)
    }

    function handlePointerOut(event: PointerEvent): void {
      const pendingTarget = pendingTargetRef.current
      if (pendingTarget) {
        const movingInsidePendingTarget = event.relatedTarget instanceof Node && pendingTarget.contains(event.relatedTarget)
        if (!movingInsidePendingTarget) clearShowTimer()
      }
      const activeTarget = activeTargetRef.current
      if (!activeTarget) return
      if (event.relatedTarget instanceof Node && activeTarget.contains(event.relatedTarget)) return
      hideTooltip(activeTarget)
    }

    function handleFocusIn(event: FocusEvent): void {
      const target = tooltipTargetFromEventTarget(event.target)
      if (target) showTooltip(target)
    }

    function handleFocusOut(event: FocusEvent): void {
      const activeTarget = activeTargetRef.current
      if (!activeTarget) return
      if (event.relatedTarget instanceof Node && activeTarget.contains(event.relatedTarget)) return
      hideTooltip(activeTarget)
    }

    function handleKeyDown(event: KeyboardEvent): void {
      if (event.key === 'Escape' || event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) hideTooltip()
    }
    const dismiss = () => hideTooltip()

    document.addEventListener('pointerover', handlePointerOver, true)
    document.addEventListener('pointerout', handlePointerOut, true)
    document.addEventListener('focusin', handleFocusIn, true)
    document.addEventListener('focusout', handleFocusOut, true)
    document.addEventListener('keydown', handleKeyDown, true)
    document.addEventListener('pointerdown', dismiss, true)
    document.addEventListener('contextmenu', dismiss, true)
    window.addEventListener('blur', dismiss)
    window.addEventListener('scroll', refreshTooltip, true)
    window.addEventListener('resize', refreshTooltip)
    const overlay = windowControlsOverlay()
    overlay?.addEventListener('geometrychange', refreshTooltip)
    return () => {
      clearShowTimer()
      document.removeEventListener('pointerover', handlePointerOver, true)
      document.removeEventListener('pointerout', handlePointerOut, true)
      document.removeEventListener('focusin', handleFocusIn, true)
      document.removeEventListener('focusout', handleFocusOut, true)
      document.removeEventListener('keydown', handleKeyDown, true)
      document.removeEventListener('pointerdown', dismiss, true)
      document.removeEventListener('contextmenu', dismiss, true)
      window.removeEventListener('blur', dismiss)
      window.removeEventListener('scroll', refreshTooltip, true)
      window.removeEventListener('resize', refreshTooltip)
      overlay?.removeEventListener('geometrychange', refreshTooltip)
    }
  }, [])

  useLayoutEffect(() => {
    if (!tooltip || !tooltipRef.current) return
    const element = tooltipRef.current
    const next = computePosition(tooltip, element)
    const { width, height } = element.getBoundingClientRect()
    const overlapsNativeView = native && Array.from(document.querySelectorAll<HTMLElement>('.panel-slot, .panel-window-slot')).some(slot => {
      if (!slot.checkVisibility()) return false
      const rect = slot.getBoundingClientRect()
      return rect.width > 0 && rect.height > 0 && next.left < rect.right && next.left + width > rect.left
        && next.top < rect.bottom && next.top + height > rect.top
    })
    setPosition(next)
    setNativePresentation(overlapsNativeView ? {
      label: tooltip.label, bounds: { x: next.left, y: next.top, width, height },
      styles: Object.fromEntries(tooltipStyleProperties.map(key => [key, getComputedStyle(element).getPropertyValue(key)])) as NativeTooltip['styles']
    } : null)
  }, [tooltip, native])

  useEffect(() => {
    if (!native) return
    void native.setTooltip(nativePresentation).catch(error => console.error('Tooltip display failed.', error))
    return () => { void native.setTooltip(null).catch(() => undefined) }
  }, [native, nativePresentation])

  if (!tooltip) return null

  return createPortal(
    <div
      ref={tooltipRef}
      className="ui-floating-tooltip ui-global-tooltip"
      role="tooltip"
      style={{
        left: position?.left ?? -9999,
        top: position?.top ?? -9999,
        visibility: position && !nativePresentation ? 'visible' : 'hidden'
      }}
    >
      {tooltip.label}
    </div>,
    document.body
  )
}
