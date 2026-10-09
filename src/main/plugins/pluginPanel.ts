import { pluginDisplayText, pluginHomePolicy, pluginIconSources, pluginPageUrl, requirePluginView, type PluginSummary, type PluginViewOptions, type PluginBackendCallContext } from '@shared/plugins'
import type { PanelState } from '@shared/panels'
import type { PanelDefinition } from '../panels/panelPages'

export function pluginBackendContext(id: string, panels: PanelState[], caller?: PanelState): PluginBackendCallContext {
  const views = panels.flatMap(panel => panel.content.kind === 'plugin' && panel.content.pluginId === id
    ? [{ panelId: panel.viewId, instanceId: panel.content.instanceId, location: panel.location }] : [])
  // The snapshot includes loading/moving panels and uses their stable identity.
  const source = caller && views.find(view => view.panelId === caller.viewId)
  if (caller && !source) throw new Error('Plugin caller page closed before its request started.')
  return { caller: source ? { panelId: source.panelId, instanceId: source.instanceId } : null, views }
}

export function pluginMoveTarget(id: string, panels: PanelState[], caller: PanelState | undefined, location: unknown, instanceId?: unknown): PanelState {
  if (!caller || caller.content.kind !== 'plugin' || caller.content.pluginId !== id) throw new Error('Invalid plugin view move.')
  pluginBackendContext(id, panels, caller)
  const target = requirePluginView({ instanceId: instanceId === undefined ? caller.content.instanceId : instanceId, location })
  const panel = panels.find(panel => panel.content.kind === 'plugin' && panel.content.pluginId === id && panel.content.instanceId === target.instanceId)
  if (!panel) throw new Error('Plugin view is not open.')
  return panel
}

export function pluginPanel(summary: PluginSummary, options: PluginViewOptions): PanelDefinition {
  return {
    ownerId: `plugin:${summary.id}`,
    content: { kind: 'plugin', pluginId: summary.id, instanceId: options.instanceId },
    location: options.location,
    locations: options.instanceId === 'main' ? pluginHomePolicy(summary.manifest!).locations : ['sidebar', 'window'],
    pluginUrl: pluginPageUrl(summary.manifest!, options.instanceId),
    icon: pluginIconSources(summary.id, options.icon ?? summary.manifest?.icon),
    name: language => options.title ?? pluginDisplayText(summary, language)
  }
}
