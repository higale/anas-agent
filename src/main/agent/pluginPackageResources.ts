import type { StructuredToolInterface } from '@langchain/core/tools'
import { isCommandShellMetadata } from '@shared/commandShell'
import { isCustomToolMetadata } from '@shared/customTools'
import { toolPathArguments } from './toolPathArguments'
import { resolveWorkspacePath } from '../workspacePath'
import { pluginRuntime } from '../plugins/pluginRuntime'

/** A Shell/custom executable may load package files indirectly. Keep the package
 * directory stable only while its managed executor is alive, never for a whole run. */
export function withPluginToolResources<T>(tool: StructuredToolInterface, args: Record<string, unknown>,
  primaryFolder: string, operation: () => Promise<T>): Promise<T> {
  const metadata = (tool as { metadata?: unknown }).metadata
  const processTool = isCommandShellMetadata(metadata) || isCustomToolMetadata(metadata)
  const paths = processTool || tool.name === 'restore_file_edit' ? null
    : (toolPathArguments(tool.name, args) ?? []).map(arg => resolveWorkspacePath(arg.value, primaryFolder))
  if (paths?.length === 0) return operation()
  return pluginRuntime().store.withPackageResources(paths, operation)
}
