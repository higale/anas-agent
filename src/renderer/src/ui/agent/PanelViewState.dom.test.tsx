import { useRef } from 'react'
import { act, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PanelViewState, usePanelScroll } from './PanelViewState'

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('retained panel scroll restoration', () => {
  it('waits for layout and ignores scroll events while a tab is hidden', () => {
    let resize!: () => void, visible = false
    const disconnect = vi.fn()
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback }
      observe() {} disconnect = disconnect
    })
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => visible ? 100 : 0)
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => visible ? 200 : 0)
    const state = new Map<string, unknown>([['scrollTop', 300]])
    function Content() {
      const ref = useRef<HTMLDivElement>(null), onScroll = usePanelScroll(ref, true)
      return <div ref={ref} onScroll={onScroll} data-testid="scroll" />
    }
    const view = render(<PanelViewState state={state}><Content /></PanelViewState>)
    const element = view.getByTestId('scroll')
    expect(element.scrollTop).toBe(0)
    fireEvent.scroll(element)
    expect(state.get('scrollTop')).toBe(300)
    act(() => { visible = true; resize() })
    expect(element.scrollTop).toBe(300)
    element.scrollTop = 450; fireEvent.scroll(element)
    act(resize)
    expect(element.scrollTop).toBe(450)
    expect(state.get('scrollTop')).toBe(450)
    visible = false; element.scrollTop = 0; fireEvent.scroll(element)
    expect(state.get('scrollTop')).toBe(450)
    view.unmount()
    expect(disconnect).toHaveBeenCalledOnce()
  })
})
