import { describe, expect, it } from 'vitest'
import { snapshotViewState, restoreViewState } from './panelViewSnapshot'
import { requirePanelJson } from '@shared/panelLifecycle'

describe('panel view snapshots', () => {
  it('preserves nested editor state, refs, absent selection and scroll without sharing mutable objects', () => {
    const state = new Map<string, unknown>([
      ['selected', undefined], ['scroll', { current: { top: 413, left: 18 } }],
      ['editors', new Map([['file', { view: { cursorState: [{ position: { lineNumber: 9, column: 2 } }] }, expanded: ['a', 'b'] }]])]
    ])
    const restored = restoreViewState(snapshotViewState(state))
    expect(restored).toEqual(state)
    expect(restored.get('scroll')).not.toBe(state.get('scroll'))
    expect(restored.get('editors')).toBeInstanceOf(Map)
  })
  it('rejects non-transferable and oversized plugin state rather than dropping it', () => {
    expect(() => requirePanelJson({ value: () => undefined })).toThrow('PANEL_STATE_INVALID')
    expect(() => requirePanelJson({ value: Infinity })).toThrow('PANEL_STATE_INVALID')
    expect(() => requirePanelJson('x'.repeat(1024 * 1024))).toThrow('PANEL_STATE_INVALID')
    expect(restoreViewState(null).size).toBe(0)
  })
})
