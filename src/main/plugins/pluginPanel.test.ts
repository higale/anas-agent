import { describe, expect, it } from 'vitest'
import { parsePluginManifest, requirePluginView, type PluginSummary } from '@shared/plugins'
import { pluginPanel, pluginBackendContext, pluginMoveTarget } from './pluginPanel'
import type { PanelState } from '@shared/panels'

const raw = { version: 0, id: 'test', name: 'Test', plugin_version: '1.0.0', api_version: 2, ui: 'index.html' }
const summary = (icon?: unknown): PluginSummary => ({ id: raw.id, enabled: true, backendStatus: 'stopped', manifest: parsePluginManifest({ ...raw, icon }) })

it('backend context includes only the plugin’s live stable panels, including pending pages', () => {
  const home: PanelState = { viewId: 'home', content: { kind: 'plugin', pluginId: 'test', instanceId: 'main' }, location: 'sidebar', locations: ['sidebar', 'window'], name: 'Home', loading: false }
  const loading: PanelState = { ...home, viewId: 'connection', content: { kind: 'plugin', pluginId: 'test', instanceId: 'server' }, location: 'window', loading: true }
  const other: PanelState = { ...home, viewId: 'other', content: { kind: 'plugin', pluginId: 'other', instanceId: 'main' } }
  const context = pluginBackendContext('test', [home, loading, other], home)
  expect(context).toEqual({ caller: { panelId: 'home', instanceId: 'main' }, views: [
    { panelId: 'home', instanceId: 'main', location: 'sidebar' }, { panelId: 'connection', instanceId: 'server', location: 'window' }
  ] })
  expect(pluginBackendContext('test', [loading]).caller).toBeNull()
  expect(() => pluginBackendContext('test', [loading], home)).toThrow('closed')
})

describe('plugin page icons', () => {
  it('uses the default icon for home and ordinary pages, with optional theme-specific overrides', () => {
    const plugin = summary('assets/远程桌面.svg')
    const options = requirePluginView({ instanceId: 'main', location: 'sidebar' })
    const home = pluginPanel(plugin, options)
    expect(home.icon?.light).toBe('anas-plugin://test/_anas/icon/assets/%E8%BF%9C%E7%A8%8B%E6%A1%8C%E9%9D%A2.svg')
    expect(home.icon?.dark).toBe(home.icon?.light)
    expect(pluginPanel(plugin, { ...options, instanceId: 'connection' }).icon).toEqual(home.icon)
    const connection = pluginPanel(plugin, requirePluginView({ ...options, icon: { light: 'light.png', dark: 'dark.webp' } }))
    expect(connection.icon).toEqual({ light: 'anas-plugin://test/_anas/icon/light.png', dark: 'anas-plugin://test/_anas/icon/dark.webp' })
    expect(pluginPanel(summary(), options).icon).toBeUndefined()
  })

  it.each(['../outside.svg', '/absolute.svg', 'https://example.com/image.svg', 'script.js', {}, { light: 'light.svg' }])('rejects invalid icon declarations: %j', icon => {
    expect(() => summary(icon)).toThrow()
    expect(() => requirePluginView({ instanceId: 'one', location: 'window', icon })).toThrow()
  })
})

it('moves only a live instance of the calling plugin and retains the current-page default', () => {
  const home: PanelState = { viewId: 'home', content: { kind: 'plugin', pluginId: 'test', instanceId: 'main' }, location: 'sidebar', locations: ['sidebar', 'window'], name: 'Home', loading: false }
  const desktop: PanelState = { ...home, viewId: 'desktop', content: { kind: 'plugin', pluginId: 'test', instanceId: 'server' }, location: 'window' }
  const other: PanelState = { ...desktop, viewId: 'other', content: { kind: 'plugin', pluginId: 'other', instanceId: 'server' } }
  expect(pluginMoveTarget('test', [home, other, desktop], home, 'window')).toBe(home)
  expect(pluginMoveTarget('test', [home, other, desktop], home, 'sidebar', 'server')).toBe(desktop)
  expect(() => pluginMoveTarget('test', [home, other], home, 'sidebar', 'server')).toThrow('not open')
  expect(() => pluginMoveTarget('test', [desktop], home, 'sidebar', 'server')).toThrow('closed')
  for (const instance of [null, 123, '', '../server']) expect(() => pluginMoveTarget('test', [home, desktop], home, 'sidebar', instance)).toThrow()
  expect(() => pluginMoveTarget('test', [home, desktop], home, 'invalid', 'server')).toThrow()
})
