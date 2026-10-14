import { describe, expect, it } from 'vitest'
import { requirePanelToolbar } from './panelToolbar'

describe('plugin toolbar assets', () => {
  const toolbar = (icon: unknown) => ({ actions: [{ id: 'custom', label: 'Custom action', icon, pressed: false }] })
  it('accepts arbitrary package image names and preserves action state', () => {
    for (const path of ['assets/自定义 图标.svg', 'images/tool.png', 'action.webp']) {
      expect(requirePanelToolbar(toolbar(path))?.actions[0]).toEqual({
        id: 'custom', label: 'Custom action', icon: path, pressed: false, disabled: false
      })
    }
    expect(requirePanelToolbar(null)).toBeUndefined()
  })
  it('rejects old names, non-image paths and resources outside the plugin package', () => {
    for (const path of ['save', 'clipboard', '../save.svg', '/save.svg', 'assets/../save.svg', 'assets\\save.svg',
      'https://example.com/save.svg', 'anas-plugin://other/assets/save.svg', 'data:image/svg+xml,x', 'script.js', '', null]) {
      expect(() => requirePanelToolbar(toolbar(path))).toThrow()
    }
  })
})

it('validates menu items and resolves only executable enabled entries', async () => {
  const { findPanelToolbarAction } = await import('./panelToolbar')
  const value = { actions: [{ id: 'sizes', label: 'Window size', icon: 'assets/size.svg', description: 'Restores the window',
    items: [{ id: 'small', label: '1024 × 768', checked: true, separatorBefore: true }, { id: 'large', label: '1920 × 1080', disabled: true }] }] }
  const toolbar = requirePanelToolbar(value)
  expect(findPanelToolbarAction(toolbar, 'sizes')).toBeUndefined()
  expect(findPanelToolbarAction(toolbar, 'small')).toMatchObject({ checked: true, disabled: false, separatorBefore: true })
  expect(findPanelToolbarAction(toolbar, 'large')?.disabled).toBe(true)
  value.actions[0] = { ...value.actions[0], disabled: true } as typeof value.actions[number]
  expect(findPanelToolbarAction(requirePanelToolbar(value), 'small')?.disabled).toBe(true)
  for (const changes of [{ items: [] }, { items: [{ id: 'bad', label: 'Bad', separatorBefore: 'yes' }] }, { pressed: true }, { items: [{ id: 'sizes', label: 'Duplicate' }] },
    { items: [{ id: 'small', label: 'First' }, { id: 'small', label: 'Second' }] }, { items: [{ id: 'small', label: 'Bad', checked: 'yes' }] }]) {
    expect(() => requirePanelToolbar({ actions: [{ ...value.actions[0], ...changes }] })).toThrow()
  }
})
