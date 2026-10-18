function cssNumber(value: string, fallback = 0): number {
  const parsed = parseFloat(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function resizeAutosizeTextarea(textarea: HTMLTextAreaElement | null): void {
  if (!textarea || textarea.offsetParent === null) return
  const style = window.getComputedStyle(textarea)
  const verticalInsets = cssNumber(style.paddingTop) + cssNumber(style.paddingBottom)
    + cssNumber(style.borderTopWidth) + cssNumber(style.borderBottomWidth)
  const minRows = Number(textarea.dataset.minRows ?? 2) || 2
  const maxRows = Number(textarea.dataset.maxRows)
  const rowHeight = (rows: number) => `calc(${rows}lh + ${verticalInsets}px)`
  const maxHeight = textarea.dataset.maxHeight
  // Chromium sizes the content directly. Only configure bounds; measuring by
  // shrinking the live field changes the page's scroll range while typing.
  textarea.style.setProperty('--autosize-min-height', rowHeight(minRows))
  textarea.style.setProperty('--autosize-max-height', maxHeight === 'none' ? 'none'
    : maxHeight !== undefined ? `${Number(maxHeight) || 420}px`
      : maxRows > 0 ? rowHeight(Math.max(minRows, maxRows)) : '420px')
}

export function resizeAutosizeTextareasIn(root: ParentNode | null): void {
  root?.querySelectorAll<HTMLTextAreaElement>('textarea.ui-autosize-textarea').forEach(resizeAutosizeTextarea)
}
