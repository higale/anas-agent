import { createContext, useCallback, useContext, useLayoutEffect, useRef, useState } from 'react'
import type { Dispatch, ReactNode, RefObject, SetStateAction } from 'react'

export function createPanelReadiness() {
  const states = new Map<symbol, { ready: boolean; failed: boolean }>()
  const listeners = new Set<(failed: boolean) => void>()
  const notify = () => queueMicrotask(() => {
    const values = [...states.values()]
    const failed = values.some(value => value.failed)
    if (failed || values.every(value => value.ready)) for (const listener of listeners) listener(failed)
  })
  return {
    set(key: symbol, ready: boolean, failed: boolean) { states.set(key, { ready, failed }); notify() },
    remove(key: symbol) { states.delete(key); notify() },
    subscribe(listener: (failed: boolean) => void) { listeners.add(listener); notify(); return () => { listeners.delete(listener) } }
  }
}
const ReadinessContext = createContext<ReturnType<typeof createPanelReadiness> | undefined>(undefined)
export function usePanelReady(ready: boolean, failed = false) {
  const gate = useContext(ReadinessContext)
  const [key] = useState(() => Symbol())
  useLayoutEffect(() => { gate?.set(key, ready, failed) }, [gate, key, ready, failed])
  useLayoutEffect(() => () => gate?.remove(key), [gate, key])
}

const CheckpointContext = createContext<Set<() => void | Promise<void>> | undefined>(undefined)

const PanelViewContext = createContext<Map<string, unknown> | undefined>(undefined)

export function PanelViewState({ state, checkpoints, readiness, children }: { state?: Map<string, unknown>; checkpoints?: Set<() => void | Promise<void>>; readiness?: ReturnType<typeof createPanelReadiness>; children: ReactNode }) {
  const [local] = useState(() => state ?? new Map<string, unknown>())
  return <ReadinessContext.Provider value={readiness}><CheckpointContext.Provider value={checkpoints}><PanelViewContext.Provider value={state ?? local}>{children}</PanelViewContext.Provider></CheckpointContext.Provider></ReadinessContext.Provider>
}

/** View preferences only; model history continues to belong to the runtime. */
export function usePanelState<T>(key: string, initial: T | (() => T)): [T, Dispatch<SetStateAction<T>>] {
  const store = useContext(PanelViewContext)
  const [value, setValue] = useState<T>(() => store?.has(key) ? store.get(key) as T : typeof initial === 'function' ? (initial as () => T)() : initial)
  useLayoutEffect(() => { store?.set(key, value) }, [key, store, value])
  return [value, setValue]
}

export function usePanelScroll(ref: RefObject<HTMLElement | null>, ready: boolean, active = true, key = 'scrollTop') {
  const store = useContext(PanelViewContext)
  const restored = useRef(false)
  const saved = useRef((store?.get(key) as number | undefined) ?? 0)
  useLayoutEffect(() => {
    restored.current = false
    if (!active || !ready || !ref.current) return
    const element = ref.current
    const restore = () => {
      // A retained tab may finish loading while hidden. Restore only when it
      // has a layout; assigning scrollTop under display:none clamps it to zero.
      if (restored.current || !element.clientHeight || !element.clientWidth) return
      element.scrollTop = saved.current
      restored.current = true
    }
    restore()
    const observer = new ResizeObserver(restore)
    observer.observe(element)
    return () => observer.disconnect()
  }, [active, ready, ref])
  return useCallback(() => {
    if (!active || !ready || !restored.current || !ref.current?.clientHeight || !ref.current.clientWidth) return
    saved.current = ref.current.scrollTop
    store?.set(key, saved.current)
  }, [active, ready, ref, store, key])
}

export function usePanelRef<T>(key: string, initial: T) {
  const store = useContext(PanelViewContext)
  const local = useRef(initial)
  const ref = store?.has(key) ? store.get(key) as typeof local : local
  useLayoutEffect(() => { store?.set(key, ref) }, [key, ref, store])
  return ref
}

export function usePanelDisclosure(key: string, defaultOpen: boolean, trackOpen = false) {
  const store = useContext(PanelViewContext)
  const [open, setOpen] = usePanelState(`expanded:${key}`, defaultOpen)
  return store || trackOpen ? { open, onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => setOpen(event.currentTarget.open) }
    : { open: defaultOpen || undefined }
}

export function usePanelCheckpoint(save: () => void | Promise<void>) {
  const checkpoints = useContext(CheckpointContext)
  const latest = useRef(save); latest.current = save
  useLayoutEffect(() => {
    const snapshot = () => latest.current()
    checkpoints?.add(snapshot)
    return () => { checkpoints?.delete(snapshot) }
  }, [checkpoints])
}
