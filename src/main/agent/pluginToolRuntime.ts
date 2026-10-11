import { DynamicStructuredTool } from '@langchain/core/tools'
import { requirePluginJson } from '@shared/plugins'
import type { ResolvedPluginTool } from '@shared/pluginTools'
import { invokePluginTool } from '../plugins/pluginRuntime'
import { PluginCallError } from '../plugins/pluginBackend'
import { currentToolExecution } from './toolExecutionContext'
import { armCurrentAgentToolEffect } from './toolEffectScope'

export function createPluginTools(definitions: readonly ResolvedPluginTool[], options: {
  preview: boolean
}) {
  return definitions.map(definition => new DynamicStructuredTool({
    name: definition.name,
    description: definition.description,
    schema: definition.inputSchema,
    verboseParsingErrors: true,
    metadata: { anasPluginTool: { pluginId: definition.pluginId, id: definition.id, effect: definition.effect } },
    func: async (args: Record<string, unknown>) => {
      if (options.preview) throw new Error('Plugin tool execution is unavailable in a preview.')
      requirePluginJson(args)
      const control = currentToolExecution()
      if (!control) throw new Error('Plugin tools require managed execution.')
      try {
        const result = await invokePluginTool(definition, args, {
          signal: control.signal,
          onDispatch: () => {
            control.signal.throwIfAborted()
            if (definition.effect !== 'read') armCurrentAgentToolEffect({ kind: 'plugin', recoveryMode: definition.effect,
              target: { plugin_id: definition.pluginId, tool_id: definition.id, args } })
            control.markRunning()
          }
        })
        control.setOutcome({ ok: true, remote_result_confirmed: true })
        return result
      } catch (error) {
        if (control.outcome?.remote_result_confirmed || (error instanceof PluginCallError && error.code === 'result_error')) {
          const message = error instanceof Error ? error.message : String(error)
          control.setOutcome({ ok: false, remote_result_confirmed: true, result_error: message })
          return JSON.stringify({ ok: false, execution_completed: true, result_error: message,
            message: 'The plugin completed its operation, but its result is invalid. Do not repeat a write to retrieve the result.' })
        }
        if (definition.effect !== 'read' && control.dispatched) {
          // An exception is not proof that external work never happened.
          control.markUncertain(error instanceof PluginCallError ? error.message : 'Plugin tool ended without a confirmed result.')
        }
        throw error
      }
    }
  }))
}
