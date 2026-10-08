import { join } from 'node:path'
import { pluginDisplayText, pluginHomePolicy, pluginPageUrl, type PluginSummary, type PluginViewOptions } from '@shared/plugins'
import type { PanelDefinition } from '../panels/panelViews'

export function pluginPanel(summary: PluginSummary, options: PluginViewOptions): PanelDefinition {
  return {
    ownerId: `plugin:${summary.id}`, reuse: 'location',
    content: { kind: 'plugin', pluginId: summary.id, instanceId: options.instanceId },
    location: options.location,
    locations: options.instanceId === 'main' ? pluginHomePolicy(summary.manifest!).locations : ['sidebar', 'window'],
    source: { kind: 'local', url: pluginPageUrl(summary.manifest!, options.instanceId) },
    preload: join(__dirname, '../preload/plugin.js'),
    name: language => options.title ?? pluginDisplayText(summary, language),
    moved: (contents, location) => contents.send('plugin:viewChanged', { instanceId: options.instanceId, location })
  }
}
