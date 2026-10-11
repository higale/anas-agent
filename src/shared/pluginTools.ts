import { validateCustomToolSchema } from './customTools'
import type { PluginBackendCallContext, PluginViewOptions } from './plugins'

/** Static declarations never execute the plugin or resolve a page identity. */
export interface PluginToolDefinition {
  id: string
  description: string
  inputSchema: Record<string, unknown>
  handler: string
  effect: 'read' | 'idempotent' | 'confirm'
  timeoutSeconds: number
}

export interface ResolvedPluginTool extends PluginToolDefinition {
  pluginId: string
  name: string
}

export interface PluginToolContext {
  deadline: number
  signal: AbortSignal
  host: PluginBackendHost
}

export interface PluginBackendHost {
  openView(options: PluginViewOptions): Promise<void>
  moveView(options: { instanceId: string; location: 'sidebar' | 'window' }): Promise<void>
  getViews(): Promise<PluginBackendCallContext['views']>
  getSettings(): Promise<import('./pluginSettings').PluginSettingValues>
}

export type PluginContentResult = Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: 'image/png' | 'image/jpeg' }>

const localId = /^[a-z][a-z0-9_]{0,63}$/
export function pluginToolId(pluginId: string, id: string): string { return `${pluginId}:tool:${id}` }
/** Shared with capability lists so the displayed name is the model's exact name. */
export function pluginToolName(pluginId: string, id: string): string {
  return `plugin__${pluginId}__${id}`
}
export function isPluginSkillId(id: string): boolean { return /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:skill:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) }
export function pluginPromptId(pluginId: string, id: string): string { return `${pluginId}:prompt:${id}` }

export function validatePluginPromptSelection(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 2048 || value.some(id => typeof id !== 'string' || id.length > 136
    || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:prompt:[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new Error('Invalid plugin prompt selection.')
  return [...new Set(value)]
}

export function parsePluginTools(value: unknown, hasBackend = true): PluginToolDefinition[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 128 || (value.length > 0 && !hasBackend)) throw new Error('Plugin tools require a backend and at most 128 declarations.')
  const tools = value.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid plugin tool declaration.')
    const { id, handler, description, effect, timeout_seconds: timeout = 30 } = raw
    if (typeof id !== 'string' || !localId.test(id) || typeof handler !== 'string' || !localId.test(handler)) throw new Error('Invalid plugin tool ID or handler.')
    if (typeof description !== 'string' || !description.trim() || description.length > 8192) throw new Error('Invalid plugin tool description.')
    if (!['read', 'idempotent', 'confirm'].includes(effect)) throw new Error('Plugin tools must declare read, idempotent or confirm effects.')
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 3600) throw new Error('Plugin tool timeout must be 1–3600 seconds.')
    return { id, handler, description, effect, timeoutSeconds: timeout, inputSchema: validateCustomToolSchema(raw.input_schema) } as PluginToolDefinition
  })
  if (new Set(tools.map(tool => tool.id)).size !== tools.length) throw new Error('Duplicate plugin tool ID.')
  return tools
}

export function validatePluginToolSelection(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > 2048 || value.some(id => typeof id !== 'string' || id.length > 134 || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*:tool:[a-z][a-z0-9_]{0,63}$/.test(id))) throw new Error('Invalid plugin tool selection.')
  return [...new Set(value)]
}

export function pluginToolMetadata(value: unknown): Pick<ResolvedPluginTool, 'pluginId' | 'id' | 'effect'> | undefined {
  if (!value || typeof value !== 'object' || !('anasPluginTool' in value)) return
  const tool = value.anasPluginTool as ResolvedPluginTool | undefined
  if (tool && typeof tool.pluginId === 'string' && typeof tool.id === 'string' && ['read', 'idempotent', 'confirm'].includes(tool.effect)) return tool
}
