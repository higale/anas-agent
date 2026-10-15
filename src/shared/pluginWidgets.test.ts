import { expect, it } from 'vitest'
import { parsePluginManifest } from './plugins'
import { requirePluginWidgetContent, widgetMatchesModel } from './pluginWidgets'

const manifest = { version: 0, id: 'widget', name: 'Widget', plugin_version: '1.0.0', api_version: 2, backend: 'backend.cjs',
  widgets: [{ id: 'status', handler: 'status', location: 'sidebar.footer', actions: ['refresh'], model_hosts: ['api.minimaxi.com'] }] }
it('validates declarations and limits model matching to exact URL hostnames', () => {
  const widget = parsePluginManifest(manifest).widgets![0]
  expect(widgetMatchesModel(widget, 'https://api.minimaxi.com/anthropic')).toBe(true)
  expect(widgetMatchesModel(widget, 'https://api.minimaxi.com.example.com')).toBe(false)
  expect(widgetMatchesModel(widget)).toBe(false)
  expect(() => parsePluginManifest({ ...manifest, backend: undefined })).toThrow()
  expect(() => parsePluginManifest({ ...manifest, widgets: [...manifest.widgets, ...manifest.widgets] })).toThrow('Duplicate')
  expect(() => parsePluginManifest({ ...manifest, widgets: [{ ...manifest.widgets[0], id: undefined }] })).toThrow()
})
it('accepts bounded HTML snapshots and rejects missing or oversized content', () => {
  const content = { title: 'Quota', html: '<table><tr><td>Remaining</td><td>68%</td></tr></table>' }
  expect(requirePluginWidgetContent({ ...content, apiKey: 'discard' })).toEqual(content)
  expect(requirePluginWidgetContent(null)).toBeNull()
  for (const html of ['', 'x'.repeat(65537), '额'.repeat(22000), null]) {
    expect(() => requirePluginWidgetContent({ ...content, html })).toThrow()
  }
  expect(() => requirePluginWidgetContent({ title: '', html: '<p>Hi</p>' })).toThrow()
})
