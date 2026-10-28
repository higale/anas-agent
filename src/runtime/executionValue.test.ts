import { describe, expect, it } from 'vitest'
import { decodeExecutionValue, encodeExecutionValue } from './executionValue'

const roundtrip = (value: unknown) => decodeExecutionValue(encodeExecutionValue(value))

describe('native execution value encoding', () => {
  it('keeps ordinary marker-shaped JSON distinct from typed values at every nesting level', () => {
    const literal = { lc: 2, type: 'constructor', id: ['Uint8Array'], args: [[255]] }
    const value = { literal, bytes: new Uint8Array([255]), array: ['bytes', '/w=='],
      envelope: { version: 1, value: ['bytes', '/w=='] }, nested: new Map([[literal, new Set([literal])]]) }
    const restored = roundtrip(value)
    expect(restored).toEqual(value)
    expect((restored as typeof value).literal).not.toBeInstanceOf(Uint8Array)
    expect((restored as typeof value).bytes).toBeInstanceOf(Uint8Array)
  })

  it('preserves explicit empty and exceptional values, sparse arrays and null-prototype records', () => {
    const sparse = new Array(3)
    sparse[1] = undefined
    sparse[2] = null
    const dictionary = Object.assign(Object.create(null), { enabled: false, count: 0, text: '', values: [] })
    const value = { empty: undefined, sparse, dictionary, values: [false, 0, -0, '', [], null, NaN, Infinity, -Infinity, 12345678901234567890n] }
    const restored = roundtrip(value) as typeof value
    expect(restored).toEqual(value)
    expect(Object.hasOwn(restored, 'empty')).toBe(true)
    expect(Object.hasOwn(restored.sparse, 0)).toBe(false)
    expect(Object.hasOwn(restored.sparse, 1)).toBe(true)
    expect(Object.getPrototypeOf(restored.dictionary)).toBeNull()
    expect(Object.is(restored.values[2], -0)).toBe(true)
  })

  it('retains binary slices, date, regexp position and complete error facts without creating a new stack', () => {
    const bytes = new Uint8Array([9, 2, 4, 6, 9]).subarray(1, 4)
    const expression = /fixture/giu
    expression.lastIndex = 7
    const error = Object.assign(new Error('failure', { cause: new Error('cause') }), { code: 0 })
    error.name = 'ToolResultError'
    error.stack = 'original stack'
    const value = { bytes, date: new Date('2026-10-27T00:00:00.000Z'), invalidDate: new Date(NaN), expression, error }
    const restored = roundtrip(value) as typeof value
    expect(restored).toEqual(value)
    expect(restored.expression.lastIndex).toBe(7)
    expect(restored.error.stack).toBe('original stack')
    expect(restored.error.cause).toEqual(error.cause)
    expect(restored.error.code).toBe(0)
    const withoutStack = new Error('no stack')
    delete withoutStack.stack
    expect((roundtrip(withoutStack) as Error).stack).toBeUndefined()
  })

  it('uses deterministic object ordering and owns the encoded bytes', () => {
    const value = { b: new Uint8Array([1]), a: { z: false, c: 0 } }
    const bytes = encodeExecutionValue(value)
    expect(bytes).toEqual(encodeExecutionValue({ a: { c: 0, z: false }, b: new Uint8Array([1]) }))
    value.b[0] = 9
    value.a.c = 8
    expect(decodeExecutionValue(bytes)).toEqual({ a: { c: 0, z: false }, b: new Uint8Array([1]) })
  })

  it('restores property names as data, including an own __proto__ key', () => {
    const value = JSON.parse('{"__proto__":{"value":1},"constructor":"ordinary"}')
    const restored = roundtrip(value) as object
    expect(restored).toEqual(value)
    expect(Object.getPrototypeOf(restored)).toBe(Object.prototype)
    expect(Object.hasOwn(restored, '__proto__')).toBe(true)
  })

  it('reports unsupported values and cycles rather than silently losing them', () => {
    const cycle: Record<string, unknown> = {}
    cycle.self = cycle
    expect(() => encodeExecutionValue(cycle)).toThrow('circular reference')
    expect(() => encodeExecutionValue({ callable: () => {} })).toThrow('unsupported function')
    expect(() => encodeExecutionValue(new Uint16Array([1]))).toThrow('unsupported object prototype')
    expect(() => encodeExecutionValue({ get field() { throw new Error('must not execute') } })).toThrow('accessor property')
    expect(() => encodeExecutionValue({ [Symbol('field')]: 1 })).toThrow('symbol property')
  })

  it.each([
    ['bytes', '%%%'], ['bytes', '/x=='], ['date', 'not a date'], ['regexp', '[', '', 0],
    ['array', [['hole', 'extra']]], ['object', [['same', 1], ['same', 2]]],
    ['map', [[1, 'a'], [1, 'b']]], ['set', [1, 1]], ['undefined', 1], ['future', 'value']
  ])('reports malformed encoded value %j', (...value) => {
    expect(() => decodeExecutionValue(new TextEncoder().encode(JSON.stringify({ version: 1, value })))).toThrow('Invalid execution value')
  })

  it('rejects unknown versions, truncated JSON and malformed UTF-8', () => {
    expect(() => decodeExecutionValue(new TextEncoder().encode('{"version":2,"value":null}'))).toThrow('unsupported version 2')
    expect(() => decodeExecutionValue(new TextEncoder().encode('{"version":1,'))).toThrow('malformed UTF-8 or JSON')
    expect(() => decodeExecutionValue(new Uint8Array([0xff]))).toThrow('malformed UTF-8 or JSON')
  })
})
