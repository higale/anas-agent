import { describe, expect, it } from 'vitest'
import { ToolInputError } from './errors'
import { readToolEffectCall, toolEffectCallIdentity } from './toolEffectIdentity'

describe('durable tool call identity', () => {
  it('uses the actual batch member before ambiguous IDs or equal arguments', () => {
    const calls = [{ id: 'repeated', name: 'write_file', args: { path: 'a' } },
      { id: 'repeated', name: 'write_file', args: { path: 'a' } }]
    expect(toolEffectCallIdentity(calls, calls[1])).toMatchObject({ callIndex: 1, callKey: 'id:repeated' })
    expect(() => toolEffectCallIdentity(calls, structuredClone(calls[1]))).toThrow('Cannot resolve a stable call index')
  })

  it('keeps provider identity ahead of changed arguments while binding the hash to the actual request', () => {
    const calls = [{ id: 'first', name: 'write_file', args: { path: 'a' } },
      { id: 'second', name: 'write_file', args: { path: 'b' } }]
    const changed = { ...calls[0], args: { path: 'b' } }
    expect(toolEffectCallIdentity(calls, changed)).toMatchObject({ callIndex: 0, callKey: 'id:first', argsJson: '{"path":"b"}' })
    expect(toolEffectCallIdentity(calls, changed).inputHash).not.toBe(toolEffectCallIdentity(calls, calls[0]).inputHash)
  })

  it('recovers a copied call by canonical arguments, preserving empty IDs and zero values', () => {
    const call = { id: '', name: 'write_file', args: { z: '', a: false, list: [undefined, 0] } }
    const copied = { ...call, args: { list: [null, 0], z: '', a: false } }
    const before = structuredClone(call)
    const identity = toolEffectCallIdentity([{ name: 'read_file', args: {} }, call], copied)
    expect(identity).toMatchObject({ callIndex: 1, callKey: 'index:1', argsJson: '{"a":false,"list":[null,0],"z":""}' })
    expect(identity.inputHash).toBe('e258ab76fba379ccf3547a0b472e1dc7a159024ea75f1b85c21baffad94a4039')
    expect(identity.inputHash).toBe(toolEffectCallIdentity([call], call).inputHash)
    expect(call).toEqual(before)
  })

  it('uses canonical values to resolve duplicate IDs only when exactly one call matches', () => {
    const calls = [{ id: 'same', name: 'write_file', args: { path: 'a' } },
      { id: 'same', name: 'write_file', args: { path: 'b' } }]
    expect(toolEffectCallIdentity(calls, structuredClone(calls[1]))).toMatchObject({ callIndex: 1, callKey: 'id:same' })
    expect(() => toolEffectCallIdentity(calls, { name: 'write_file', args: { path: 'missing' } })).toThrow('Cannot resolve a stable call index')
    expect(() => toolEffectCallIdentity([], calls[0])).toThrow('Cannot resolve a stable call index')
  })

  it('rejects invalid input before it can identify a journal entry', () => {
    for (const value of [null, [], false, { args: {} }, { name: '', args: {} }]) {
      expect(() => readToolEffectCall(value)).toThrow()
    }
    for (const args of [null, [], 'text', 0]) {
      expect(() => readToolEffectCall({ name: 'write_file', args })).toThrow(ToolInputError)
    }
    const call = { name: 'write_file', args: {} }
    expect(readToolEffectCall(call)).toBe(call)
    const cyclic: Record<string, unknown> = {}
    cyclic.self = cyclic
    const bad = { name: 'write_file', args: cyclic }
    expect(() => toolEffectCallIdentity([bad], bad)).toThrow('must not contain cycles')
  })
})
