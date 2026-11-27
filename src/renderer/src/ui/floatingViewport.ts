import { useCallback, useSyncExternalStore, type RefObject } from 'react'
import { TITLEBAR_ACTION_MENU_POSITION, UI_POPOVER_COLLISION_PADDING } from './uiConstants'

interface WindowControlsOverlay extends EventTarget {
  readonly visible: boolean
  getTitlebarAreaRect(): DOMRect
}

export function windowControlsOverlay(): WindowControlsOverlay | undefined {
  return (navigator as Navigator & { windowControlsOverlay?: WindowControlsOverlay }).windowControlsOverlay
}

export function nativeTitlebarBottom(): number {
  const overlay = windowControlsOverlay()
  return overlay?.visible ? overlay.getTitlebarAreaRect().bottom : 0
}

function subscribe(onChange: () => void): () => void {
  const overlay = windowControlsOverlay()
  overlay?.addEventListener('geometrychange', onChange)
  window.addEventListener('resize', onChange)
  return () => {
    overlay?.removeEventListener('geometrychange', onChange)
    window.removeEventListener('resize', onChange)
  }
}

type CollisionPadding = number | Partial<Record<'top' | 'right' | 'bottom' | 'left', number>>

export function useFloatingCollisionPadding(padding: CollisionPadding = 0): CollisionPadding {
  const titlebarBottom = useSyncExternalStore(subscribe, nativeTitlebarBottom)
  if (titlebarBottom === 0) return padding
  const sides = typeof padding === 'number'
    ? { top: padding, right: padding, bottom: padding, left: padding }
    : padding
  // Native caption buttons are outside the DOM. Keep Radix's collision viewport
  // below them, using CSS-pixel geometry that follows window zoom and resizing.
  return { ...sides, top: titlebarBottom + (sides.top ?? 0) }
}

export function useMenuCollisionProps(padding: CollisionPadding = UI_POPOVER_COLLISION_PADDING) {
  // Safe bounds take priority over staying attached to a button or pointer
  // inside the native titlebar. Both menu types must be free to shift away.
  return { collisionPadding: useFloatingCollisionPadding(padding), sticky: 'always' as const }
}

export function useTitlebarMenuPosition(trigger: RefObject<HTMLElement | null>) {
  const subscribeToPosition = useCallback((onChange: () => void) => {
    const unsubscribe = subscribe(onChange)
    const observer = new ResizeObserver(onChange)
    if (trigger.current) observer.observe(trigger.current)
    return () => { unsubscribe(); observer.disconnect() }
  }, [trigger])
  const sideOffset = useSyncExternalStore(subscribeToPosition, () => {
    const bottom = trigger.current?.getBoundingClientRect().bottom
    return bottom === undefined ? TITLEBAR_ACTION_MENU_POSITION.sideOffset : Math.max(
      TITLEBAR_ACTION_MENU_POSITION.sideOffset,
      nativeTitlebarBottom() + UI_POPOVER_COLLISION_PADDING - bottom
    )
  })
  return { ...TITLEBAR_ACTION_MENU_POSITION, sideOffset }
}
