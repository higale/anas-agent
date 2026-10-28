import { posix } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { assertPatchFileBinding, assertPatchTargets, authorizationInputHash, patchAuthorizationFor, shellAuthorizationFor,
  verifyShellReceipt, recordToolApprovals, type PatchAuthorizationReceipt, type ShellAuthorizationReceipt } from './authorizationReceipts'

const paths = { samePath: (a: string, b: string) => posix.normalize(a) === posix.normalize(b), dirname: posix.dirname,
  isSameOrInsideDirectory: (parent: string, path: string) => path === parent || path.startsWith(parent + '/') }
const args = { command: 'read file', timeout: 0, enabled: false }
function patchReceipt(): PatchAuthorizationReceipt {
  return { id: 'patch', name: 'apply_patch', inputHash: authorizationInputHash({ input: 'patch' }),
    requiresApproval: true, humanApproved: true, targets: [
      { path: '/root/new/file', lexicalPath: '/root/new/file', locator: ['operations', 0, 'path'], kind: 'file', access: 'write' }
    ] }
}
function shellReceipt(): ShellAuthorizationReceipt {
  return { id: 'shell', name: 'pwsh', inputHash: authorizationInputHash(args), requiresApproval: false, humanApproved: false,
    plan: { executable: '/bin/shell', workingDir: '/root', paths: ['/root/file'],
      skillScript: { skillId: 'inspect', root: '/skills/inspect', script: '/skills/inspect/run.ps1', executor: '/bin/shell' } } }
}

describe('native authorization receipts', () => {
  it('records approval only for matching unanswered calls and does not mutate prior receipts', () => {
    const patch = { ...patchReceipt(), humanApproved: false }, shell = shellReceipt()
    const state = { anasPatchAuthorization: { runId: 'run', calls: [patch] }, anasShellAuthorization: { runId: 'run', calls: [shell] } }
    const calls = [{ id: 'patch', name: 'apply_patch', args: { input: 'patch' } }, { id: 'shell', name: 'pwsh', args }]
    const approved = new Set(['patch', 'shell'])
    expect(recordToolApprovals(state, calls, approved, new Set())).toMatchObject({
      anasPatchAuthorization: { calls: [{ humanApproved: true }] }, anasShellAuthorization: { calls: [{ humanApproved: true }] }
    })
    expect(recordToolApprovals(state, [calls[0], { ...calls[1], args: { ...args, command: 'changed' } }], approved, new Set(['patch'])))
      .toMatchObject({ anasPatchAuthorization: { calls: [{ humanApproved: false }] }, anasShellAuthorization: { calls: [{ humanApproved: false }] } })
    expect(recordToolApprovals(state, [], approved, new Set())).toMatchObject({
      anasPatchAuthorization: { calls: [{ humanApproved: false }] }, anasShellAuthorization: { calls: [{ humanApproved: false }] }
    })
    expect(state.anasPatchAuthorization.calls[0].humanApproved).toBe(false)
    expect(state.anasShellAuthorization.calls[0].humanApproved).toBe(false)
  })

  it('binds grants to the recorded run, tool, call and original argument values', () => {
    const shell = shellReceipt(), patch = patchReceipt()
    const state = { anasShellAuthorization: { runId: 'run', calls: [shell] }, anasPatchAuthorization: { runId: 'run', calls: [patch] } }
    const request = { id: 'shell', name: 'pwsh', args: { enabled: false, command: 'read file', timeout: 0 } }
    expect(shellAuthorizationFor(state, request, 'run')).toEqual(shell)
    expect(shellAuthorizationFor(state, request, 'other')).toBeUndefined()
    expect(shellAuthorizationFor(state, { ...request, id: 'other' }, 'run')).toBeUndefined()
    expect(shellAuthorizationFor(state, { ...request, args: { ...args, timeout: 1 } }, 'run')).toBeUndefined()
    expect(shellAuthorizationFor(state, { ...request, name: 'other' }, 'run')).toBeUndefined()
    expect(patchAuthorizationFor(state, { id: 'patch', name: 'apply_patch', args: { input: 'patch' } }, 'run')).toEqual(patch)
    expect(patchAuthorizationFor(state, { id: 'patch', name: 'apply_patch', args: { input: 'changed' } }, 'run')).toBeUndefined()
    expect(patchAuthorizationFor(state, { id: 'patch', name: 'apply_patch', args: { input: 'patch' } }, 'other')).toBeUndefined()
  })

  it('permits the authorized file and its managed staging/parent targets without authorizing unrelated files', () => {
    const expected = patchReceipt().targets
    expect(() => assertPatchTargets([
      { path: '/root/new/file', kind: 'file', access: 'write' },
      { path: '/root/new/staging', kind: 'temporary', access: 'write' },
      { path: '/root/new', kind: 'directory', access: 'write' }
    ], expected, paths)).not.toThrow()
    for (const target of [
      { path: '/root/new/other-file', kind: 'file' as const, access: 'write' as const },
      { path: '/elsewhere/staging', kind: 'temporary' as const, access: 'write' as const }
    ]) expect(() => assertPatchTargets([target], expected, paths)).toThrow('not included')
    expect(() => assertPatchTargets([{ path: '/root/new/file', kind: 'file', access: 'write' }],
      expected.map(target => ({ ...target, access: 'read' })), paths)).toThrow('not included')
  })

  it('does not reuse a patch path for a different operation, access mode or result order', () => {
    const expected = patchReceipt().targets
    const file = { path: '/root/new/file', access: 'write' as const, locator: ['operations', 0, 'path'] }
    expect(() => assertPatchFileBinding([file], expected, paths.samePath)).not.toThrow()
    expect(() => assertPatchFileBinding([{ ...file, locator: ['operations', 1, 'path'] }], expected, paths.samePath)).toThrow('binding')
    expect(() => assertPatchFileBinding([{ ...file, access: 'read' }], expected, paths.samePath)).toThrow('binding')
    expect(() => assertPatchFileBinding([], expected, paths.samePath)).toThrow('binding')
  })

  it('rechecks queued Shell environment and Skill identity at every actual dispatch', async () => {
    const receipt = shellReceipt(), before = structuredClone(receipt)
    let current = structuredClone(receipt.plan)
    const inspect = vi.fn(async () => current)
    const options = { inspect, accessMode: () => 'smart_approval' as const, samePath: paths.samePath }
    await expect(verifyShellReceipt(receipt, args, options)).resolves.toBeUndefined()
    current = { ...current!, skillScript: { ...current!.skillScript!, skillId: 'another-skill' } }
    await expect(verifyShellReceipt(receipt, args, options)).rejects.toThrow('targets changed')
    current = undefined
    await expect(verifyShellReceipt(receipt, args, options)).rejects.toThrow('targets changed')
    expect(inspect).toHaveBeenCalledTimes(3)
    expect(receipt).toEqual(before)
  })

  it.each(['executable', 'workingDir', 'paths'] as const)('rejects changed Shell %s', async field => {
    const receipt = shellReceipt()
    const current = { ...receipt.plan!, [field]: field === 'paths' ? ['/different'] : '/different' }
    await expect(verifyShellReceipt(receipt, args, { accessMode: () => 'smart_approval', samePath: paths.samePath,
      inspect: async () => current })).rejects.toThrow('targets changed')
  })

  it('honors explicit approval and current full access while still rejecting changed original arguments', async () => {
    const inspect = vi.fn(async () => undefined), approved = { ...shellReceipt(), humanApproved: true }
    const options = { inspect, accessMode: () => 'strict_approval' as const, samePath: paths.samePath }
    await expect(verifyShellReceipt(approved, args, options)).resolves.toBeUndefined()
    await expect(verifyShellReceipt(approved, { ...args, command: 'different' }, options)).rejects.toThrow('changed persisted')
    const unrestricted = { ...shellReceipt(), plan: undefined }
    await expect(verifyShellReceipt(unrestricted, args, { ...options, accessMode: () => 'full_access' })).resolves.toBeUndefined()
    await expect(verifyShellReceipt(unrestricted, args, options)).rejects.toThrow('access mode changed')
    expect(inspect).not.toHaveBeenCalled()
  })
})
