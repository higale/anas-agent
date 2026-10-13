import { useEffect, useLayoutEffect, useRef } from 'react'
import type { PanelPageApi } from '@shared/panelLifecycle'
import { notice } from '../notice'

/** Focus belongs to a panel region, including its tabs, toolbar and portaled menus. */
export function usePanelActivation(api: PanelPageApi, activeId: string | undefined, visible: boolean) {
  const selection = useRef<string | null>(null)
  const interaction = useRef<string | null>(null)
  const publish = useRef(() => {})
  publish.current = () => {
    void api.setActivity(selection.current, interaction.current === selection.current ? interaction.current : null)
      .catch(error => notice.error(String(error)))
  }
  useLayoutEffect(() => {
    const next = visible ? activeId ?? null : null
    if (selection.current !== next) interaction.current = next
    selection.current = next
    publish.current()
  }, [activeId, visible, api])
  useEffect(() => {
    const observe = (event: Event) => {
      const target = event.target
      if (!(target instanceof Element)) return
      const panel = target.closest<HTMLElement>('[data-panel-interaction]')?.dataset.panelInteraction ?? null
      interaction.current = panel
      publish.current()
    }
    const fromFrame = (event: Event) => {
      const id = (event as CustomEvent).detail
      if (id !== selection.current) return
      interaction.current = id
      publish.current()
    }
    document.addEventListener('pointerdown', observe, true)
    document.addEventListener('focusin', observe, true)
    window.addEventListener('panel-interaction', fromFrame)
    return () => {
      document.removeEventListener('pointerdown', observe, true)
      document.removeEventListener('focusin', observe, true)
      window.removeEventListener('panel-interaction', fromFrame)
      void api.setActivity(null, null).catch(() => { /* Window/page host is retiring. */ })
    }
  }, [api])
}
