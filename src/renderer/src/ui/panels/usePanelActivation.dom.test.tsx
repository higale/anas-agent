import { render, fireEvent, cleanup } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import type { PanelPageApi } from '@shared/panelLifecycle'
import { usePanelActivation } from './usePanelActivation'

afterEach(cleanup)
it('tracks selection and interaction separately, preserving toolbar/menu focus and ignoring hover', () => {
  const setActivity = vi.fn(async () => {})
  const api = { setActivity } as unknown as PanelPageApi
  function Fixture({ id = 'a', visible = true }) {
    usePanelActivation(api, id, visible)
    return <><div data-panel-interaction={id}><button>Toolbar</button></div><input aria-label="Chat" />
      <div data-panel-interaction={id} role="menu"><button>Menu item</button></div></>
  }
  const ui = render(<Fixture />)
  expect(setActivity).toHaveBeenLastCalledWith('a', 'a')
  fireEvent.pointerDown(ui.getByLabelText('Chat'))
  expect(setActivity).toHaveBeenLastCalledWith('a', null)
  fireEvent.mouseOver(ui.getByText('Toolbar'))
  expect(setActivity).toHaveBeenLastCalledWith('a', null)
  fireEvent.pointerDown(ui.getByText('Toolbar'))
  fireEvent.focusIn(ui.getByText('Menu item'))
  expect(setActivity).toHaveBeenLastCalledWith('a', 'a')
  ui.rerender(<Fixture id="b" />)
  expect(setActivity).toHaveBeenLastCalledWith('b', 'b')
  window.dispatchEvent(new CustomEvent('panel-interaction', { detail: 'a' }))
  expect(setActivity).toHaveBeenLastCalledWith('b', 'b')
  fireEvent.focusIn(ui.getByLabelText('Chat'))
  window.dispatchEvent(new CustomEvent('panel-interaction', { detail: 'b' }))
  expect(setActivity).toHaveBeenLastCalledWith('b', 'b')
  ui.rerender(<Fixture id="b" visible={false} />)
  expect(setActivity).toHaveBeenLastCalledWith(null, null)
})
