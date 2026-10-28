import { describe, expect, it, vi } from 'vitest'
import { preflightProjectRuleBatch, ruleScopeIds, type ProjectRulesSnapshot } from './projectRules'
import { ProjectRulesError } from './errors'

function snapshot(): ProjectRulesSnapshot {
  return { runId: 'run', trustedFolders: ['root'], roots: [{ folder: 'root', boundary: 'root' }],
    documents: [{ id: 'root-rule', path: 'root/AGENTS.md', content: 'Root rules' }],
    directories: [{ path: 'root', documentId: 'root-rule' }], initialScopes: ['root'], activeScopes: ['root'],
    blockedCalls: [], rejectedCalls: [], checkedWrites: [], blockedReason: '', fatalError: '' }
}
const call = (id: string) => ({ id, name: id, args: { path: 'relative' } })
function input() {
  const state = snapshot()
  return { runId: 'run', snapshot: state, receipt: { runId: 'run', scopes: ruleScopeIds(state), minimumTokens: 10, budget: 100 },
    calls: [call('write'), call('read')], answered: new Set<string>(), countScopeTokens: () => 10 }
}

describe('project rule batch policy without a graph or filesystem', () => {
  it('returns newly discovered rules and canonical arguments while blocking writes from the earlier request', async () => {
    const source = input(), before = structuredClone(source.snapshot), beforeCalls = structuredClone(source.calls)
    const result = await preflightProjectRuleBatch({ ...source, inspect: async (state, request) => {
      if (request.id === 'write') {
        state.documents.push({ id: 'child-rule', path: 'root/child/AGENTS.md', content: 'Child rules' })
        state.directories.push({ path: 'root/child', documentId: 'child-rule' })
        request.args.path = 'root/child/file.txt'
        return { scopes: ['root', 'root/child'], writePaths: [request.args.path] }
      }
      return { scopes: ['root'] }
    } })
    expect(result.snapshot).toMatchObject({ blockedCalls: ['write'], activeScopes: ['root', 'root/child'],
      checkedWrites: [{ id: 'write', paths: ['root/child/file.txt'] }], fatalError: '' })
    expect(result.snapshot.blockedReason).toContain('no original write has been replayed')
    expect(result.calls?.[0].args.path).toBe('root/child/file.txt')
    expect(source.snapshot).toEqual(before)
    expect(source.calls).toEqual(beforeCalls)
  })

  it('allows writes only after their actual document identities appeared in the request receipt', async () => {
    const source = input()
    const result = await preflightProjectRuleBatch({ ...source, inspect: async (_state, request) => ({
      scopes: ['root'], ...(request.id === 'write' ? { writePaths: ['root/file.txt'] } : {})
    }) })
    expect(result.snapshot.blockedCalls).toEqual([])
    expect(result.snapshot.checkedWrites).toEqual([{ id: 'write', paths: ['root/file.txt'] }])
    source.snapshot.documents[0].id = 'changed-document'
    source.snapshot.directories[0].documentId = 'changed-document'
    const changed = await preflightProjectRuleBatch({ ...source, inspect: async () => ({ scopes: ['root'], writePaths: ['root/file.txt'] }) })
    expect(changed.snapshot.blockedCalls).toEqual(['write', 'read'])
  })

  it('blocks the write union when individual operations fit but their combined scopes do not', async () => {
    const result = await preflightProjectRuleBatch({ ...input(), calls: [call('left'), call('right'), call('read')],
      countScopeTokens: (_state, scopes) => scopes.includes('left') && scopes.includes('right') ? 95 : 30,
      inspect: async (_state, request) => ({ scopes: [request.id!], ...(request.id === 'read' ? {} : { writePaths: [] }) })
    })
    expect(result.snapshot.blockedCalls).toEqual(['left', 'right'])
    expect(result.snapshot.blockedReason).toContain('rule union')
    expect(result.snapshot.activeScopes).toEqual(['root'])
    expect(result.snapshot.fatalError).toBe('')
  })

  it('keeps a rejected path separate and never inspects an already answered call', async () => {
    const inspect = vi.fn(async (_state: ProjectRulesSnapshot, request: ReturnType<typeof call>) =>
      request.id === 'write' ? { rejection: 'NOT EXECUTED: Invalid path.' } : { scopes: ['root'] })
    const result = await preflightProjectRuleBatch({ ...input(), calls: [call('finished'), call('write'), call('read')],
      answered: new Set(['finished']), inspect })
    expect(inspect.mock.calls.map(([, request]) => request.id)).toEqual(['write', 'read'])
    expect(result.snapshot.blockedCalls).toEqual(['write'])
    expect(result.snapshot.rejectedCalls).toEqual([{ id: 'write', reason: 'NOT EXECUTED: Invalid path.' }])
  })

  it('returns a durable fatal decision for an indivisible oversized operation without retrying it on recovery', async () => {
    const inspect = vi.fn(async () => ({ scopes: ['root'], writePaths: ['root/file.txt'] }))
    const source = { ...input(), calls: [call('done'), call('write'), call('read')], answered: new Set(['done']), inspect,
      countScopeTokens: () => 91 }
    const result = await preflightProjectRuleBatch(source)
    expect(result.snapshot.blockedCalls).toEqual(['write', 'read'])
    expect(result.snapshot.fatalError).toContain('indivisible write operation')
    expect(result.calls).toBeUndefined()
    await expect(preflightProjectRuleBatch({ ...source, snapshot: result.snapshot })).rejects.toBeInstanceOf(ProjectRulesError)
    expect(inspect).toHaveBeenCalledOnce()
  })

  it.each([undefined, {}, { runId: 'other', scopes: [], minimumTokens: 0, budget: 100 }])('does not inspect without a matching verified request receipt', async receipt => {
    const inspect = vi.fn()
    const result = await preflightProjectRuleBatch({ ...input(), receipt, inspect })
    expect(result.snapshot.fatalError).toContain('receipt')
    expect(inspect).not.toHaveBeenCalled()
  })

  it('propagates cancellation and suspension without publishing a partial snapshot', async () => {
    const source = input(), before = structuredClone(source.snapshot)
    for (const error of [new Error('cancelled'), { pause: 'approval' }]) {
      await expect(preflightProjectRuleBatch({ ...source, inspect: async state => {
        state.documents[0].content = 'not committed'
        throw error
      } })).rejects.toBe(error)
      expect(source.snapshot).toEqual(before)
    }
  })
})
