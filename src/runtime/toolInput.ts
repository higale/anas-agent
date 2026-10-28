import { validate, type Schema } from '@cfworker/json-schema'
import type { ZodType } from 'zod/v3'
import { type $ZodType, prettifyError, safeParseAsync } from 'zod/v4/core'
import { ToolInputError } from './errors'
import type { ToolDefinition } from './toolDefinition'
import { isCustomToolMetadata, maxCustomToolInputBytes } from '../shared/customTools'

export type ToolInputDefinition = Pick<ToolDefinition, 'name' | 'inputSchema' | 'metadata'>

export function toolInputDiagnostic(toolName: string, detail: string): string {
  detail = detail.trim()
  return [`Tool '${toolName}' received invalid input${detail ? ':' : '.'}`, detail, 'Correct the arguments and try again.'].filter(Boolean).join('\n')
}

/** Preflight reads the original capability definition, never a protocol schema
 * projected for the model or a tool object registered with an executor. */
export function validateCapabilityInput(definition: ToolInputDefinition | undefined, args: unknown): Promise<void> {
  return validateToolInput(args, definition?.inputSchema, {
    maxBytes: isCustomToolMetadata(definition?.metadata) ? maxCustomToolInputBytes : undefined
  })
}

function isZodSchema(schema: unknown): schema is ZodType | $ZodType {
  if (!schema || typeof schema !== 'object') return false
  // The public vendor marker survives ESM/CommonJS copies. Constructor identity
  // does not, and would misclassify a perfectly valid schema as JSON Schema.
  const standard = (schema as { '~standard'?: { version?: unknown; vendor?: unknown; validate?: unknown } })['~standard']
  return standard?.version === 1 && standard.vendor === 'zod' && typeof standard.validate === 'function'
}

export function serializeToolInput(args: unknown, maxBytes: number): string {
  const json = JSON.stringify(args)
  if (typeof json !== 'string') throw new Error('Tool arguments could not be serialized as JSON.')
  const size = new TextEncoder().encode(json).byteLength
  if (size > maxBytes) throw new ToolInputError(`Tool arguments exceed ${maxBytes} UTF-8 bytes. Reduce the submitted data.`)
  return json
}

/** Validate before hashing, authorizing or dispatching. Schema defaults and
 * transformations belong to execution and must not rewrite recorded intent. */
export async function validateToolInput(args: unknown, schema?: unknown, options: { maxBytes?: number } = {}): Promise<void> {
  await parseToolInput(args, schema, options)
}

/** Final execution parsing returns defaults/transforms without rewriting intent. */
export async function parseToolInput(args: unknown, schema?: unknown, options: { maxBytes?: number } = {}): Promise<Record<string, unknown>> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    throw new ToolInputError('Tool arguments must be a JSON object.')
  }
  const pending = [{ value: args as unknown, path: '' }]
  const visited = new WeakSet<object>()
  while (pending.length) {
    const { value, path } = pending.pop()!
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new ToolInputError(`Invalid number at ${path}: expected a finite number, received ${String(value)}.`)
    }
    if (!value || typeof value !== 'object' || visited.has(value)) continue
    visited.add(value)
    for (const [key, child] of Object.entries(value)) {
      pending.push({ value: child, path: `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}` })
    }
  }
  if (options.maxBytes !== undefined) serializeToolInput(args, options.maxBytes)
  if (schema === undefined) return args as Record<string, unknown>
  if (isZodSchema(schema)) {
    // Use the asynchronous API directly; Standard Schema validation may first
    // attempt synchronous parsing and run an async refinement twice.
    const result = 'safeParseAsync' in schema
      ? await schema.safeParseAsync(args)
      : await safeParseAsync(schema, args)
    if (!result.success) throw new ToolInputError(prettifyError(result.error))
    return result.data as Record<string, unknown>
  }
  const result = validate(args, schema as Schema)
  if (!result.valid) throw new ToolInputError(result.errors
    .map(error => `${error.instanceLocation || '/'}: ${error.error} (${error.keywordLocation})`).join('\n'))
  return args as Record<string, unknown>
}

/** Authorization and dispatch consume object arguments only after preflight.
 * A non-object here is a broken saved/prepared state, not a new model error. */
export function requireObjectToolCall<T extends { args: unknown }>(call: T): T & { args: Record<string, unknown> } {
  if (!call.args || typeof call.args !== 'object' || Array.isArray(call.args)) {
    throw new Error('Prepared tool arguments must be a JSON object.')
  }
  return call as T & { args: Record<string, unknown> }
}
