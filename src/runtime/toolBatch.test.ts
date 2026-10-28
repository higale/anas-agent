import { describe, expect, it, vi } from 'vitest'
import { pendingToolBatch, type ToolBatchEntry } from './toolBatch'

type Call = { id?: string; name: string; args: unknown }
function batch(history: ToolBatchEntry<Call>[]) {
  return pendingToolBatch(history.length, index => history[index])
}

describe('pending native tool batch', () => {
  it('does not borrow earlier results for a reused provider call ID', () => {
    const call = { id: 'reused', name: 'write_file', args: { path: 'new' } }
    const history: ToolBatchEntry<Call>[] = [{ kind: 'result', callId: 'reused' },
      { kind: 'response', calls: [call] }, { kind: 'other' }]
    const read = vi.fn((index: number) => {
      if (index < 1) throw new Error('Older history is irrelevant to this batch')
      return history[index]
    })
    const result = pendingToolBatch(history.length, read)
    expect(result).toEqual({ responseIndex: 1, answered: new Set(), calls: [call] })
    expect(result.calls[0]).toBe(call)
    expect(read).toHaveBeenCalledTimes(2)
  })

  it('keeps result order across queued user input and preserves pending call objects', () => {
    const calls = ['a', 'b', 'c'].map(id => ({ id, name: 'read_file', args: { id } }))
    const history: ToolBatchEntry<Call>[] = [{ kind: 'response', calls }, { kind: 'result', callId: 'b' },
      { kind: 'other' }, { kind: 'result', callId: 'a' }, { kind: 'result', callId: 'b' }]
    const before = structuredClone(history)
    const result = batch(history)
    expect([...result.answered]).toEqual(['b', 'a'])
    expect(result.calls).toEqual([calls[2]])
    expect(result.calls[0]).toBe(calls[2])
    expect(history).toEqual(before)
  })

  it('ends an earlier batch even when the newest response has no calls', () => {
    const calls = [{ id: 'old', name: 'write_file', args: {} }]
    expect(batch([{ kind: 'response', calls }, { kind: 'response', calls: [] }]))
      .toEqual({ responseIndex: 1, answered: new Set(), calls: [] })
    expect(batch([{ kind: 'result', callId: 'orphan' }]))
      .toEqual({ responseIndex: -1, answered: new Set(['orphan']), calls: [] })
    expect(batch([])).toEqual({ responseIndex: -1, answered: new Set(), calls: [] })
  })

  it('retains existing duplicate, missing and empty ID semantics without inventing identities', () => {
    const calls: Call[] = [{ id: 'same', name: 'one', args: {} }, { id: 'same', name: 'two', args: {} },
      { name: 'missing', args: {} }, { id: '', name: 'empty', args: {} }]
    expect(batch([{ kind: 'response', calls }, { kind: 'result', callId: 'same' }]).calls).toEqual(calls.slice(2))
    const pending = batch([{ kind: 'response', calls }, { kind: 'result', callId: '' }]).calls
    expect(pending).toEqual(calls.slice(0, 3))
  })
})
