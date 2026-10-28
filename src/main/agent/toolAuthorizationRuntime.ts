import { AsyncLocalStorage } from 'node:async_hooks'
import { dirname } from 'node:path'
import type { AgentAccessMode } from '@shared/agentTypes'
import { authorizationInputHash, assertPatchTargets, assertPatchFileBinding, verifyShellReceipt,
  type PatchAuthorizationReceipt, type ShellAuthorizationReceipt } from '../../runtime/authorizationReceipts'
import type { FileEditStore } from '../fileEditStore'
import type { FilePatchRestoreTarget } from '../filePatchRestore'
import type { FilePatchTarget } from '../filePatch'
import { isSameOrInsideDirectory, samePath } from '../pathContainment'
import type { createShellCommandAuthorization } from '../shellCommandAuthorization'
import type { SkillScriptInvocation } from '../skillsStore'
import { prepareToolPathAuthorization } from './toolAuthorization'

type Call = { id: string; name: string; args: Record<string, unknown> }
export interface PatchAuthorizationOptions {
  runId: string
  primaryFolder: string
  folders: string[]
  accessMode(): AgentAccessMode
  fileEditStore?: Pick<FileEditStore, 'loadOperationRecord'>
}
export interface ShellAuthorizationOptions {
  analyzer: ReturnType<typeof createShellCommandAuthorization>
  accessMode(): AgentAccessMode
}

const approvedTargets = new AsyncLocalStorage<PatchAuthorizationReceipt['targets']>()
const shellVerifier = new AsyncLocalStorage<() => Promise<void>>()
const pathOperations = { dirname, samePath, isSameOrInsideDirectory }

export async function preparePatchAuthorization(call: Call, options: PatchAuthorizationOptions): Promise<PatchAuthorizationReceipt> {
  const identity = { id: call.id, name: call.name, inputHash: authorizationInputHash(call.args), humanApproved: false }
  try {
    const prepared = await prepareToolPathAuthorization({ toolName: call.name, args: structuredClone(call.args),
      primaryFolder: options.primaryFolder, trustedFolders: options.folders,
      accessMode: options.accessMode() === 'strict_approval' ? 'strict_approval' : 'read_only_allowed',
      requestId: options.runId, fileEditStore: options.fileEditStore })
    return { ...identity, requiresApproval: prepared.requiresApproval,
      targets: prepared.targets.map(target => ({ path: target.canonicalPath, lexicalPath: target.lexicalPath,
        locator: target.locator, kind: target.kind ?? 'file', access: target.access })) }
  } catch (error) {
    return { ...identity, targets: [], requiresApproval: false,
      error: `NOT EXECUTED: ${error instanceof Error ? error.message : String(error)}\nInspect the operation and decide again.` }
  }
}

/** Return only preparation/authorization diagnostics. A handler failure must
 * propagate independently and must never be recast as a pre-dispatch failure. */
export async function patchAuthorizationDiagnostic(receipt: PatchAuthorizationReceipt | undefined, call: Call,
  options: PatchAuthorizationOptions): Promise<string | undefined> {
  if (receipt && (receipt.id !== call.id || receipt.name !== call.name || receipt.inputHash !== authorizationInputHash(call.args))) receipt = undefined
  if (receipt?.error) return receipt.error
  try {
    if (!receipt) throw new Error('Missing persisted patch authorization.')
    const current = await prepareToolPathAuthorization({ toolName: call.name, args: structuredClone(call.args),
      primaryFolder: options.primaryFolder, trustedFolders: options.folders, accessMode: options.accessMode(),
      requestId: options.runId, fileEditStore: options.fileEditStore })
    const currentFiles = current.targets.filter(target => !target.kind || target.kind === 'file')
    assertPatchFileBinding(currentFiles.map(target => ({ path: target.canonicalPath, access: target.access, locator: target.locator })), receipt.targets, samePath)
    if (current.requiresApproval && !receipt.humanApproved) throw new Error('Patch targets require a new approval after the access mode changed.')
    assertPatchTargets(current.targets.map(target => ({ path: target.canonicalPath, kind: target.kind ?? 'file', access: target.access })), receipt.targets, pathOperations)
  } catch (error) {
    return `NOT EXECUTED: ${error instanceof Error ? error.message : String(error)}\nInspect current targets and decide again.`
  }
  return undefined
}

export function withPatchAuthorization<T>(receipt: PatchAuthorizationReceipt, operation: () => T): T {
  return approvedTargets.run(receipt.targets, operation)
}

export async function authorizeCurrentPatchTargets(targets: readonly FilePatchRestoreTarget[]): Promise<void> {
  const expected = approvedTargets.getStore()
  if (!expected) throw new Error('Patch execution requires its persisted path authorization.')
  assertPatchTargets(targets, expected, pathOperations)
}

export function verifyCurrentPatchInputTargets(targets: readonly FilePatchTarget[]): void {
  const expected = approvedTargets.getStore()
  if (!expected) throw new Error('Patch execution requires its persisted path authorization.')
  assertPatchFileBinding(targets.map(target => ({ path: target.canonicalPath, access: target.access,
    locator: ['operations', target.operationIndex, target.field] })), expected, samePath)
}

export async function prepareShellAuthorization(call: Call, skill: SkillScriptInvocation | undefined,
  options: ShellAuthorizationOptions): Promise<ShellAuthorizationReceipt> {
  const fullAccess = options.accessMode() === 'full_access'
  const plan = fullAccess ? undefined : await options.analyzer.inspect(call.args, skill)
  return { id: call.id, name: call.name, inputHash: authorizationInputHash(call.args), requiresApproval: !fullAccess && !plan,
    humanApproved: false, ...(plan ? { plan } : {}) }
}

/** Carries the saved receipt to the actual runner, including delayed managed
 * dispatch. The environment and Skill scope are rechecked at that boundary. */
export function withShellAuthorization<T>(receipt: ShellAuthorizationReceipt | undefined, call: Call,
  skill: SkillScriptInvocation | undefined, options: ShellAuthorizationOptions, operation: () => T): T {
  const bound = receipt?.id === call.id && receipt.name === call.name ? receipt : undefined
  return shellVerifier.run(() => verifyShellReceipt(bound, call.args, { accessMode: options.accessMode, samePath,
    inspect: () => options.analyzer.inspect(call.args, skill) }), operation)
}

export async function verifyCurrentShellAuthorization(): Promise<void> {
  const verify = shellVerifier.getStore()
  if (!verify) throw new Error('Shell execution requires its persisted authorization.')
  await verify()
}
