/** Executable application capability. Registration and durable dispatch belong
 * to the host. Business definitions return ToolResult; host dispatch may retain
 * its canonical result type without coupling this contract to a framework. */
export interface ToolDefinition<Result = ToolResult> {
  name: string
  description: string
  inputSchema: unknown
  metadata?: Record<string, unknown>
  execute(input: Record<string, unknown>, context: ToolInvocationContext): Promise<Result> | Result
}

/** Content is the model-visible value; artifacts retain non-prompt result data. */
export interface ToolResult {
  content: unknown
  artifact?: unknown
}

export interface ToolInvocationContext {
  callId?: string
  signal?: AbortSignal
  timeoutMs?: number
}

type SchemaInput<Schema> = Schema extends { readonly '~standard': { readonly types?: { readonly output: infer Input } } }
  ? Input extends Record<string, unknown> ? Input : Record<string, unknown>
  : Record<string, unknown>

interface TypedToolDefinition<Schema, Result> {
  name: string
  description: string
  inputSchema: Schema
  metadata?: Record<string, unknown>
  execute(input: SchemaInput<Schema>, context: ToolInvocationContext): Promise<Result> | Result
}

/** Infer parsed input without coupling capabilities to a schema library. */
export function defineTool<Schema>(definition: TypedToolDefinition<Schema, ToolResult>): ToolDefinition {
  return definition as ToolDefinition
}

/** Ordinary capability returns are content, including arbitrary JSON objects.
 * Artifact-producing capabilities use defineTool and return an explicit result. */
export function defineContentTool<Schema>(definition: TypedToolDefinition<Schema, unknown>): ToolDefinition {
  return { ...definition, async execute(input, context) {
    return { content: await definition.execute(input as SchemaInput<Schema>, context) }
  } }
}
