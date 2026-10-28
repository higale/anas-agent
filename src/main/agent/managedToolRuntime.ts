import { verifyCurrentToolAuthorization } from './toolAuthorizationRuntime'
import { pluginToolMetadata } from '@shared/pluginTools'
import { isCustomToolMetadata } from '@shared/customTools'
import { isCommandShellMetadata } from '@shared/commandShell'
import { builtinToolCatalog } from '@shared/toolRegistry'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { ToolDefinition } from '../../runtime/toolDefinition'
import { toolResultMessage, toolResultText, isManagedToolResultReference } from '../../runtime/toolResultMessage'
import type { AgentManagedCallKind } from './managedCallStore'
import type { ManagedCallService } from './managedCallService'
import { classifyAgentToolEffect } from './toolEffectClassification'
import { toolLocalCommitStarted, withToolExecution } from './toolExecutionContext'

const managementTools = new Set(['read_call', 'read_call_output', 'wait_call', 'cancel_call', 'write_call'])
const builtinTools = new Set<string>(builtinToolCatalog.map(({ id }) => id))
const fileMutations = new Set(['apply_patch', 'write_file', 'restore_file_edit', 'create_directory', 'move_file', 'delete_file'])

export interface ManagedResultStorage {
  /** Current format is supplied by the owning database, never inferred. */
  format: 'conversation'
  save(message: ConversationMessage, owner: { threadId: string; runId: string; managedCallId: string }): Promise<string>
  read(reference: string, threadId: string): Promise<ConversationMessage>
}
export interface ManagedToolRuntimeOptions {
  results: ManagedResultStorage
  service?: Pick<ManagedCallService, 'start'>
  threadId: string
  runId?: string
  allowBackground: boolean
  signal?: AbortSignal
  /** Resolve the saved provider ID before a call can leave the active batch. */
  providerCallId?(applicationCallId: string): string
  withResources?<T>(args: Record<string, unknown>, operation: () => Promise<T>): Promise<T>
}

export function supportsManagedTool(tool: { name: string; metadata?: unknown }): boolean {
  if (tool.name === 'request_user_input' || tool.name === 'sleep') return false
  return !managementTools.has(tool.name) && (builtinTools.has(tool.name) || Boolean(pluginToolMetadata(tool.metadata))
    || isCustomToolMetadata(tool.metadata) || isCommandShellMetadata(tool.metadata) || tool.name.startsWith('mcp_'))
}

export function managedToolDescription(tool: Pick<ToolDefinition, 'name' | 'description' | 'metadata'>, allowBackground: boolean): string {
  return tool.description + (allowBackground && supportsManagedTool(tool)
    ? ' Calls queue automatically when execution capacity is busy. After 10 seconds waiting or executing, this tool may return a background call_id instead of its final result; do not resubmit a queued call. Wait for dependent work with wait_call; inspect details with read_call_output. No output or progress does not by itself indicate a stalled call.' : '')
}

/** Existing managed-call scheduling, cancellation and result ownership, with
 * application message content. Stored canonical results pass through unchanged. */
export function createManagedToolRuntime(definition: ToolDefinition, options: ManagedToolRuntimeOptions): ToolDefinition<ConversationMessage> {
  const providerId = (id: string) => options.providerCallId ? options.providerCallId(id) : id
  if (!supportsManagedTool(definition)) return { ...definition, async execute(args, context) {
    return toolResultMessage(await definition.execute(args, context), { name: definition.name, callId: providerId(context.callId ?? ''), metadata: definition.metadata })
  } }
  const plugin = Boolean(pluginToolMetadata(definition.metadata))
  const kind: AgentManagedCallKind = isCommandShellMetadata(definition.metadata) ? 'shell'
    : plugin || isCustomToolMetadata(definition.metadata) ? 'custom' : definition.name === 'http_request' ? 'http' : definition.name.startsWith('mcp_') ? 'mcp' : 'builtin'
  return { ...definition,
    description: managedToolDescription(definition, options.allowBackground),
    execute: async (args, context) => {
      const { service, runId } = options
      if (!service || !runId) throw new Error('Tool execution requires an active agent run.')
      const callId = providerId(context.callId ?? ''), effectful = Boolean(classifyAgentToolEffect(definition.name, args, definition))
      const result = await service.start({ kind, threadId: options.threadId, runId,
        summary: typeof args.summary === 'string' ? args.summary : definition.name,
        parentSignal: options.signal && context.signal ? AbortSignal.any([options.signal, context.signal]) : options.signal ?? context.signal,
        allowBackground: options.allowBackground, retainInlineResult: effectful,
        uncertainWhenCancelledAfterDispatch: effectful && (plugin || kind !== 'shell' && kind !== 'custom'),
        serialGroup: fileMutations.has(definition.name) ? 'filesystem-writes' : definition.name === 'update_config' ? 'configuration'
          : definition.name === 'save_to_memory' || definition.name === 'forget_memory' ? 'memory-writes' : undefined,
        execute: control => withToolExecution(control, kind === 'builtin' && effectful, async () => {
          control.signal.throwIfAborted()
          if (!effectful) control.markRunning()
          control.setOutcome({ tool_name: definition.name })
          try {
            const invoke = async () => {
              control.signal.throwIfAborted()
              await verifyCurrentToolAuthorization()
              return definition.execute(args, { signal: control.signal, ...(typeof context.timeoutMs === 'number' ? { timeoutMs: context.timeoutMs } : {}) })
            }
            const output = await (options.withResources ? options.withResources(args, invoke) : invoke())
            const message = toolResultMessage(output, { name: definition.name, callId, metadata: definition.metadata })
            if (kind === 'custom' && control.outcome?.ok === false) message.resultStatus = 'error'
            // Publish the reference metadata only after its body is durable.
            // Await here so a rejected save participates in effect recovery.
            const reference = await options.results.save(message, { threadId: options.threadId, runId, managedCallId: control.callId })
            control.setOutcome({ ok: typeof control.outcome?.ok === 'boolean' ? control.outcome.ok : message.resultStatus !== 'error',
              result_format: options.results.format, ...(kind !== 'shell' ? { result_output_chars: toolResultText(message).length } : {}),
              ...(toolLocalCommitStarted() ? { local_commit_completed: true } : {}) })
            return reference
          } catch (error) {
            if (effectful && control.dispatched && !control.outcome?.remote_failure_confirmed && !(plugin && control.outcome?.remote_result_confirmed)
              && (plugin || kind === 'mcp' || toolLocalCommitStarted())) control.markUncertain('The tool did not return a confirmed outcome after dispatch.')
            throw error
          }
        })
      })
      const value = JSON.parse(result) as { ok?: boolean }
      if (isManagedToolResultReference(value)) return options.results.read(result, options.threadId)
      return { kind: 'tool', name: definition.name, resultFor: callId, content: result, resultStatus: value.ok === false ? 'error' : 'success' }
    }
  }
}
