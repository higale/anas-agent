/** Content menus and editors get first refusal; only unhandled Escape reaches the host. */
export function installPanelEscapeHandler(escape: () => void): () => void {
  const handle = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || event.defaultPrevented || event.isComposing || event.keyCode === 229 || event.repeat
      || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return
    escape()
  }
  window.addEventListener('keydown', handle)
  return () => window.removeEventListener('keydown', handle)
}
