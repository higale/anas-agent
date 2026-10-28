import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AgentAccessMode } from '@shared/agentTypes'
import type { ShellCommandPlan } from '../shellCommandAuthorization'
import { preparePatchAuthorization, patchAuthorizationDiagnostic, withPatchAuthorization, authorizeCurrentPatchTargets,
  prepareShellAuthorization, withShellAuthorization, verifyCurrentShellAuthorization } from './toolAuthorizationRuntime'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  await mkdir(join(process.cwd(), 'tmp'), { recursive: true })
  const root = await realpath(await mkdtemp(join(process.cwd(), 'tmp', 'native-authorization-')))
  roots.push(root)
  await mkdir(join(root, 'project')); await mkdir(join(root, 'outside'))
  return root
}
const target = (path: string) => ({ path, kind: 'file' as const, index: 0, semantics: 'entry' as const, access: 'write' as const })

describe('framework-free authorization at actual execution', () => {
  it('binds patch arguments and current access while preserving the approved call', async () => {
    const root = await fixture(), path = join(root, 'outside/new.txt')
    let mode: AgentAccessMode = 'full_access'
    const options = { runId: 'run', primaryFolder: join(root, 'project'), folders: [join(root, 'project')], accessMode: () => mode }
    const call = { id: 'app-call', name: 'write_file', args: { path, content: 'text' } }
    const before = structuredClone(call.args), receipt = await preparePatchAuthorization(call, options)
    expect(receipt.requiresApproval).toBe(false)
    expect(call.args).toEqual(before)
    expect(await patchAuthorizationDiagnostic(receipt, call, options)).toBeUndefined()
    mode = 'strict_approval'
    expect(await patchAuthorizationDiagnostic(receipt, call, options)).toContain('new approval')
    const approved = { ...receipt, humanApproved: true }
    expect(await patchAuthorizationDiagnostic(approved, call, options)).toBeUndefined()
    expect(await patchAuthorizationDiagnostic(approved, { ...call, id: 'different-call' }, options)).toContain('Missing')
    expect(await patchAuthorizationDiagnostic(approved, { ...call, args: { ...call.args, content: 'changed' } }, options)).toContain('Missing')
    await expect(withPatchAuthorization(approved, () => authorizeCurrentPatchTargets([target(path)]))).resolves.toBeUndefined()
    await expect(authorizeCurrentPatchTargets([target(path)])).rejects.toThrow('persisted path authorization')
  })

  it('isolates overlapping patch invocations and propagates errors after entry', async () => {
    const root = await fixture(), options = { runId: 'run', primaryFolder: root, folders: [root], accessMode: () => 'full_access' as const }
    const [left, right] = await Promise.all(['left.txt', 'right.txt'].map(name => preparePatchAuthorization({ id: name, name: 'write_file', args: { path: join(root, name), content: '' } }, options)))
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = withPatchAuthorization(left, async () => {
      await gate
      await authorizeCurrentPatchTargets([target(left.targets[0].path)])
      await expect(authorizeCurrentPatchTargets([target(right.targets[0].path)])).rejects.toThrow('not included')
    })
    await withPatchAuthorization(right, async () => { release(); await first; await authorizeCurrentPatchTargets([target(right.targets[0].path)]) })
    const failure = new Error('failed after writing')
    await expect(withPatchAuthorization(left, async () => { throw failure })).rejects.toBe(failure)
  })

  it('rechecks delayed Shell dispatch, keeps Skill scope, and rejects grants for another call', async () => {
    let mode: AgentAccessMode = 'full_access'
    let plan: ShellCommandPlan | undefined = { workingDir: process.cwd(), executable: 'pwsh', paths: [],
      skillScript: { skillId: 'skill', root: process.cwd(), script: join(process.cwd(), 'script.ps1'), executor: 'pwsh' } }
    const analyzer = { inspect: vi.fn(async () => plan), requiresApproval: vi.fn(async () => false) }
    const options = { analyzer, accessMode: () => mode }, call = { id: 'shell', name: 'pwsh', args: { command: 'script.ps1' } }, skill = { name: 'inspect' }
    const unrestricted = await prepareShellAuthorization(call, skill, options)
    expect(analyzer.inspect).not.toHaveBeenCalled()
    await withShellAuthorization(unrestricted, call, skill, options, async () => {
      mode = 'smart_approval'
      await expect(verifyCurrentShellAuthorization()).rejects.toThrow('access mode changed')
    })
    const automatic = await prepareShellAuthorization(call, skill, options)
    expect(analyzer.inspect).toHaveBeenCalledWith(call.args, skill)
    expect(automatic.requiresApproval).toBe(false)
    await withShellAuthorization(automatic, call, skill, options, async () => {
      await verifyCurrentShellAuthorization()
      plan = undefined
      await expect(verifyCurrentShellAuthorization()).rejects.toThrow()
    })
    await withShellAuthorization({ ...automatic, humanApproved: true }, { ...call, id: 'other' }, skill, options,
      async () => { await expect(verifyCurrentShellAuthorization()).rejects.toThrow('Missing or changed') })
    await withShellAuthorization({ ...automatic, humanApproved: true }, call, skill, options, verifyCurrentShellAuthorization)
    await expect(verifyCurrentShellAuthorization()).rejects.toThrow('persisted authorization')
  })
})

it('checks readonly and Skill plans before a true or omitted model flag and revokes model exemptions on mode changes', async () => {
  let mode: AgentAccessMode = 'smart_approval'
  let plan: ShellCommandPlan | undefined = { workingDir: process.cwd(), executable: '/bin/zsh', paths: [] }
  const analyzer = { inspect: vi.fn(async () => plan), requiresApproval: vi.fn() }, options = { analyzer, accessMode: () => mode }
  for (const flag of [{}, { needs_approval: true }, { needs_approval: false }]) {
    const call = { id: 'shell', name: 'zsh', args: { command: 'cat file', ...flag } }
    const receipt = await prepareShellAuthorization(call, undefined, options)
    expect(receipt.requiresApproval).toBe(false)
    await withShellAuthorization(receipt, call, undefined, options, verifyCurrentShellAuthorization)
  }
  plan = undefined
  for (const flag of [{}, { needs_approval: true }, { needs_approval: false }]) {
    const call = { id: 'shell', name: 'zsh', args: { command: 'some-write', ...flag } }
    const receipt = await prepareShellAuthorization(call, undefined, options)
    expect(receipt.requiresApproval).toBe(flag.needs_approval !== false)
    if (flag.needs_approval === false) {
      await withShellAuthorization(receipt, call, undefined, options, verifyCurrentShellAuthorization)
      mode = 'strict_approval'
      await expect(withShellAuthorization(receipt, call, undefined, options, verifyCurrentShellAuthorization)).rejects.toThrow('requires approval')
      mode = 'smart_approval'
    }
  }
})
