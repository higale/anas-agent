import type { ToolDefinition, ToolInvocationContext } from './toolDefinition'
import { parseToolInput } from './toolInput'
import { isCustomToolMetadata, maxCustomToolInputBytes } from '../shared/customTools'

/** One final parse and one business invocation. Cleanup belongs to the handler;
 * cancellation must not race it or discard a confirmed result. */
export async function invokeCapability<Result>(definition: ToolDefinition<Result>, input: unknown,
  context: ToolInvocationContext, started?: () => void): Promise<Result> {
  context.signal?.throwIfAborted()
  const parsed = await parseToolInput(input, definition.inputSchema, {
    maxBytes: isCustomToolMetadata(definition.metadata) ? maxCustomToolInputBytes : undefined
  })
  context.signal?.throwIfAborted()
  started?.()
  return definition.execute(parsed, context)
}
