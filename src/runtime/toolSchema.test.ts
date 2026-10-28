import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'
import { z as z3 } from 'zod/v3'
import { z as z4 } from 'zod'
import * as mini from 'zod/mini'
import { toolJsonSchema } from './toolSchema'
import { validateToolInput } from './toolInput'

describe('runtime JSON input schema', () => {
  it.each(['v3', 'v4'] as const)('describes defaults, optional fields and input transformations without executing them (%s)', async version => {
    const transform = vi.fn((value: string) => Number(value))
    const schema = version === 'v3'
      ? z3.object({ value: z3.string().transform(transform), enabled: z3.boolean().default(false), limit: z3.number().default(0), note: z3.string().optional() })
      : z4.object({ value: z4.string().transform(transform), enabled: z4.boolean().default(false), limit: z4.number().default(0), note: z4.string().optional() })
    const result = toolJsonSchema(schema)
    expect(result).toMatchObject({ type: 'object', properties: { value: { type: 'string' }, enabled: { default: false }, limit: { default: 0 }, note: { type: 'string' } }, required: ['value'] })
    expect(transform).not.toHaveBeenCalled()
    await validateToolInput({ value: '2' }, schema)
    expect(transform).toHaveBeenCalledOnce()
    expect(schema.parse({ value: '2' })).toEqual({ value: 2, enabled: false, limit: 0 })
  })

  it('preserves recursive schema links and raw JSON unions', () => {
    const schema: z3.ZodType = z3.lazy(() => z3.object({ name: z3.string(), children: z3.array(schema).optional() }))
    const result = toolJsonSchema(schema)
    expect(JSON.stringify(result)).toContain('"$ref":"#"')
    const raw = { oneOf: [{ type: 'string' }, { type: 'number' }], additionalProperties: false }
    expect(toolJsonSchema(raw)).toBe(raw)
    expect(raw.oneOf).toHaveLength(2)
  })

  it('does not tighten passthrough schemas or mutate nested source objects', () => {
    const inner = z4.object({ label: z4.string() }).passthrough(), schema = z4.object({ inner })
    expect(toolJsonSchema(schema)).toMatchObject({ additionalProperties: false, properties: { inner: { additionalProperties: {} } } })
    expect(schema.parse({ inner: { label: 'x', extra: false } })).toEqual({ inner: { label: 'x', extra: false } })
    expect(inner.parse({ label: 'x', extra: 0 })).toHaveProperty('extra', 0)
  })

  it('accepts Mini and CommonJS schemas without constructor identity checks', () => {
    const common = createRequire(import.meta.url)('zod') as typeof z4
    for (const schema of [mini.object({ text: mini.string() }), common.object({ text: common.string() })]) {
      expect(toolJsonSchema(schema)).toMatchObject({ type: 'object', properties: { text: { type: 'string' } }, required: ['text'] })
    }
  })

  it('uses an explicit Standard Schema input exporter and reports missing or invalid exporters', () => {
    const input = vi.fn(() => ({ type: 'object', properties: { text: { type: 'string' } } }))
    const schema = { '~standard': { vendor: 'fixture', jsonSchema: { input } } }
    expect(toolJsonSchema(schema)).toEqual(input.mock.results[0].value)
    expect(toolJsonSchema(schema)).toEqual(input.mock.results[0].value)
    expect(input).toHaveBeenCalledExactlyOnceWith({ target: 'draft-07' })
    expect(() => toolJsonSchema({ '~standard': { vendor: 'fixture' } })).toThrow('does not provide')
    expect(() => toolJsonSchema({ '~standard': { vendor: 'fixture', jsonSchema: { input: () => null } } })).toThrow('invalid')
  })
})
