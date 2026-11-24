/** Both variants keep their layout boxes, avoiding resize oscillation. */
export function observeAdaptiveText(root: ParentNode): () => void {
  const rows = [...root.querySelectorAll<HTMLElement>('.ui-adaptive-text')].flatMap(container => {
    const full = container.querySelector<HTMLElement>(':scope > [data-full-text]')
    const short = container.querySelector<HTMLElement>(':scope > [data-short-text]')
    return full && short ? [{ container, full, short }] : []
  })
  const fit = () => {
    for (const { container, full, short } of rows) {
      const condensed = full.scrollWidth > container.clientWidth
      container.toggleAttribute('data-condensed', condensed)
      full.setAttribute('aria-hidden', String(condensed))
      short.setAttribute('aria-hidden', String(!condensed))
    }
  }
  const observer = rows.length ? new ResizeObserver(fit) : undefined
  for (const { container, full } of rows) { observer!.observe(container); observer!.observe(full) }
  document.fonts?.addEventListener('loadingdone', fit)
  fit()
  return () => { observer?.disconnect(); document.fonts?.removeEventListener('loadingdone', fit) }
}
