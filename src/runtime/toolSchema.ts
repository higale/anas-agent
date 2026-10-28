import { toJSONSchema, type $ZodType } from 'zod/v4/core'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ZodType } from 'zod/v3'

type Fields = Record<string, unknown>
const converted = new WeakMap<object, Fields>()

/** Shared input description for model requests and their settings preview. */
export function modelToolJsonSchema(inputSchema: unknown): Fields {
  const converted = toolJsonSchema(inputSchema)
  // Raw external schemas keep their declared dialect. Generated descriptions
  // omit it without mutating the cached schema or local validation definition.
  if (converted === inputSchema) return converted
  const schema = { ...converted }
  delete schema.$schema
  return schema
}

/** Describe accepted input, leaving validation/defaults/transforms to execution. */
export function toolJsonSchema(schema: unknown): Fields {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema)) throw new Error('Tool schema must be a JSON Schema or schema object.')
  const standard = (schema as { '~standard'?: { vendor?: string; jsonSchema?: { input: (options: { target: string }) => unknown } } })['~standard']
  if (!standard) return schema as Fields
  const cached = converted.get(schema)
  if (cached) return cached
  let result: unknown
  if (standard.vendor === 'zod' && '_zod' in schema) {
    result = toJSONSchema(schema as $ZodType, { io: 'input', override({ zodSchema, jsonSchema }) {
      // Zod's ordinary objects strip unknown keys. Advertise their known input
      // fields without rewriting passthrough objects or mutating source schemas.
      if (zodSchema._zod.def.type === 'object' && zodSchema._zod.def.catchall === undefined) jsonSchema.additionalProperties = false
    } })
  } else if (standard.vendor === 'zod') result = zodToJsonSchema(schema as ZodType)
  else if (standard.jsonSchema) result = standard.jsonSchema.input({ target: 'draft-07' })
  else throw new Error('Schema does not provide a JSON input description.')
  if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error('Schema produced an invalid JSON input description.')
  converted.set(schema, result as Fields)
  return result as Fields
}
