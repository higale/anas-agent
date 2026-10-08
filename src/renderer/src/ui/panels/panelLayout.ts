import type { PanelBounds } from '@shared/panels'

// Native views sit above the renderer. Their bounds exclude host controls, and
// overlapping host popovers temporarily hide the view without unloading it.
export function panelBounds(slot: HTMLElement | null): PanelBounds | null {
  if (!slot || document.documentElement.classList.contains('ui-resizing')) return null
  const rect = slot.getBoundingClientRect()
  if (!slot.checkVisibility() || rect.width <= 0 || rect.height <= 0) return null
  const overlays = document.querySelectorAll<HTMLElement>(
    '.ui-backdrop[data-state="open"], [role="dialog"][data-state="open"]:not(.workspace-panels-drawer), [role="alertdialog"][data-state="open"], [data-radix-popper-content-wrapper], [data-sonner-toast], .attachment-lightbox, .zoom-hud'
  )
  for (const overlay of overlays) {
    if (!overlay.checkVisibility()) continue
    const bounds = overlay.getBoundingClientRect()
    if (bounds.width > 0 && bounds.height > 0 && bounds.left < rect.right && bounds.right > rect.left && bounds.top < rect.bottom && bounds.bottom > rect.top) return null
  }
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
}

export function observePanelLayout(measure: () => void): () => void {
  let request = 0
  const update = () => { request = 0; measure() }
  const schedule = () => { if (!request) request = requestAnimationFrame(update) }
  const resize = new ResizeObserver(schedule)
  const trackSlots = () => {
    resize.disconnect()
    resize.observe(document.documentElement)
    for (const slot of document.querySelectorAll('.panel-slot, .panel-window-slot')) resize.observe(slot)
    schedule()
  }
  const mutations = new MutationObserver(trackSlots)
  mutations.observe(document.body, { childList: true, subtree: true, attributes: true,
    attributeFilter: ['style', 'class', 'hidden', 'data-state', 'data-panel-request'] })
  const rootMutations = new MutationObserver(update)
  rootMutations.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] })
  window.addEventListener('resize', schedule)
  window.addEventListener('scroll', schedule, true)
  // Deliver the hide request as soon as a splitter captures the pointer.
  document.addEventListener('pointerdown', update)
  trackSlots()
  return () => {
    cancelAnimationFrame(request); resize.disconnect(); mutations.disconnect(); rootMutations.disconnect()
    window.removeEventListener('resize', schedule); window.removeEventListener('scroll', schedule, true)
    document.removeEventListener('pointerdown', update)
  }
}
