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
