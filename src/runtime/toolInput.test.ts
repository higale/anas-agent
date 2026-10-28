import { describe, expect, it, vi } from 'vitest'
import { createRequire } from 'node:module'
import { z as z3 } from 'zod/v3'
import { z as z4 } from 'zod/v4'
import * as mini from 'zod/v4/mini'
import { serializeToolInput, validateToolInput, validateCapabilityInput } from './toolInput'
import { ToolInputError } from './errors'

const commonjs = createRequire(import.meta.url)
const cjs3: typeof z3 = commonjs('zod/v3').z
const cjs4: typeof z4 = commonjs('zod/v4').z
const cjsMini: typeof mini = commonjs('zod/v4/mini')

describe('tool input validation without an execution framework', () => {
  it('uses the native capability schema and preserves raw intent through asynchronous defaults and transforms', async () => {
    const input = Object.freeze({ label: 'raw', extra: false })
    const transform = vi.fn(async (value: string) => value.toUpperCase())
    const definition = { name: 'inspect', inputSchema: z4.object({
      label: z4.string().transform(transform), count: z4.number().default(0)
    }) }
    await expect(validateCapabilityInput(definition, input)).resolves.toBeUndefined()
    expect(transform).toHaveBeenCalledOnce()
    expect(input).toEqual({ label: 'raw', extra: false })
    await expect(validateCapabilityInput(definition, { label: false })).rejects.toThrow('label')
  })

  it('enforces the custom capability byte limit before schema evaluation', async () => {
    const refine = vi.fn(() => true)
    const definition = { name: 'external', inputSchema: z4.object({}).refine(refine), metadata: { anasCustomToolId: 'fixture' } }
    await expect(validateCapabilityInput(definition, { text: '中'.repeat(350_000) })).rejects.toThrow('UTF-8 bytes')
    expect(refine).not.toHaveBeenCalled()
    await expect(validateCapabilityInput(undefined, { count: 0 })).resolves.toBeUndefined()
    await expect(validateCapabilityInput(undefined, [])).rejects.toThrow('JSON object')
  })

  it.each([undefined, null, [], '', 0, false])('rejects a non-object root %j before schema evaluation', async value => {
    const refine = vi.fn(() => true)
    await expect(validateToolInput(value, z4.any().refine(refine))).rejects.toThrow('JSON object')
    expect(refine).not.toHaveBeenCalled()
  })

  it.each([NaN, Infinity, -Infinity])('reports a nested non-finite number %s before schema evaluation', async value => {
    const refine = vi.fn(() => true)
    await expect(validateToolInput({ 'a/b~c': [{ value }] }, z4.any().refine(refine)))
      .rejects.toThrow('Invalid number at /a~1b~0c/0/value')
    expect(refine).not.toHaveBeenCalled()
  })

  it.each([
    ['Zod 3', z3.object({ count: z3.number().max(3), label: z3.string().default('default') }).transform(value => ({ ...value, count: value.count + 1 }))],
    ['Zod 4', z4.object({ count: z4.number().max(3), label: z4.string().default('default') }).transform(value => ({ ...value, count: value.count + 1 }))],
    ['Zod Mini', mini.object({ count: mini.number().check(mini.maximum(3)), label: mini._default(mini.string(), 'default') })],
    ['CommonJS Zod 3', cjs3.object({ count: cjs3.number().max(3), label: cjs3.string().default('default') })],
    ['CommonJS Zod 4', cjs4.object({ count: cjs4.number().max(3), label: cjs4.string().default('default') })],
    ['CommonJS Zod Mini', cjsMini.object({ count: cjsMini.number().check(cjsMini.maximum(3)), label: cjsMini._default(cjsMini.string(), 'default') })]
  ])('validates %s schemas while preserving raw intent and defaults', async (_name, schema) => {
    const args = Object.freeze({ count: 0, extra: false })
    await expect(validateToolInput(args, schema)).resolves.toBeUndefined()
    expect(args).toEqual({ count: 0, extra: false })
    await expect(validateToolInput({ count: 4 }, schema)).rejects.toBeInstanceOf(ToolInputError)
    await expect(validateToolInput({ count: 'wrong' }, schema)).rejects.toThrow('count')
  })

  it('accepts configured JSON Schema and preserves false, zero, empty strings and lists', async () => {
    const schema = { type: 'object', required: ['enabled', 'count', 'label', 'items'], additionalProperties: false,
      properties: { enabled: { type: 'boolean' }, count: { type: 'integer', maximum: 3 }, label: { type: 'string' }, items: { type: 'array' } } }
    const args = { enabled: false, count: 0, label: '', items: [] }
    await expect(validateToolInput(args, schema)).resolves.toBeUndefined()
    await expect(validateToolInput({ ...args, count: 4 }, schema)).rejects.toThrow('/count')
    await expect(validateToolInput({}, false)).rejects.toBeInstanceOf(ToolInputError)
    await expect(validateToolInput({}, true)).resolves.toBeUndefined()
    await expect(validateToolInput({}, { type: 'object', '~standard': { version: 1, vendor: 'zod' } })).resolves.toBeUndefined()
  })

  it.each([
    ['Zod 3', (check: () => Promise<boolean>) => z3.object({}).refine(check, 'Unavailable argument')],
    ['Zod 4', (check: () => Promise<boolean>) => z4.object({}).refine(check, 'Unavailable argument')],
    ['CommonJS Zod 3', (check: () => Promise<boolean>) => cjs3.object({}).refine(check, 'Unavailable argument')],
    ['CommonJS Zod 4', (check: () => Promise<boolean>) => cjs4.object({}).refine(check, 'Unavailable argument')]
  ] as const)('awaits %s asynchronous validation and preserves internal validator failures', async (_name, schema) => {
    const checked = vi.fn(async () => false)
    await expect(validateToolInput({}, schema(checked))).rejects.toThrow('Unavailable argument')
    expect(checked).toHaveBeenCalledOnce()
    const failure = new Error('Schema service unavailable')
    await expect(validateToolInput({}, schema(async () => { throw failure }))).rejects.toBe(failure)
  })

  it('enforces UTF-8 byte limits before running schemas, including an explicit zero limit', async () => {
    const checked = vi.fn(() => true)
    expect(serializeToolInput({ text: '中' }, 14)).toBe('{"text":"中"}')
    await expect(validateToolInput({ text: '中' }, z4.any().refine(checked), { maxBytes: 13 })).rejects.toThrow('13 UTF-8 bytes')
    expect(checked).not.toHaveBeenCalled()
    await expect(validateToolInput({}, undefined, { maxBytes: 0 })).rejects.toBeInstanceOf(ToolInputError)
    await expect(validateToolInput({}, undefined, { maxBytes: 2 })).resolves.toBeUndefined()
  })

  it('does not relabel a serialization failure as a model argument correction', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => serializeToolInput(cycle, 1024)).toThrow(TypeError)
    expect(() => serializeToolInput(cycle, 1024)).not.toThrow(ToolInputError)
  })
})
