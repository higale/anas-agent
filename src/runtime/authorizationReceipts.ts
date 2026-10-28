import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AgentAccessMode } from '../shared/agentTypes'
import { canonicalToolEffectJson } from './toolEffects'

const targetSchema = z.object({
  path: z.string(), lexicalPath: z.string(), locator: z.array(z.union([z.string(), z.number()])),
  kind: z.enum(['file', 'temporary', 'directory']), access: z.enum(['read', 'write'])
})
const patchReceiptSchema = z.object({
  runId: z.string(), calls: z.array(z.object({ id: z.string(), name: z.string(), inputHash: z.string(),
    targets: z.array(targetSchema), requiresApproval: z.boolean(), humanApproved: z.boolean(), error: z.string().optional() }))
})
export const patchAuthorizationStateSchema = z.object({ anasPatchAuthorization: patchReceiptSchema.optional() })
export type PatchAuthorizationReceipt = z.infer<typeof patchReceiptSchema>['calls'][number]
const shellReceiptSchema = z.object({ runId: z.string(), calls: z.array(z.object({
  id: z.string(), name: z.string(), inputHash: z.string(), requiresApproval: z.boolean(), humanApproved: z.boolean(),
  plan: z.object({ workingDir: z.string(), executable: z.string(), paths: z.array(z.string()),
    skillScript: z.object({ skillId: z.string(), root: z.string(), script: z.string(), executor: z.string() }).optional()
  }).optional()
})) })
export const shellAuthorizationStateSchema = z.object({ anasShellAuthorization: shellReceiptSchema.optional() })
export type ShellAuthorizationReceipt = z.infer<typeof shellReceiptSchema>['calls'][number]

export function authorizationInputHash(args: unknown): string {
  return createHash('sha256').update(canonicalToolEffectJson(args)).digest('hex')
}

export function patchAuthorizationFor(state: unknown, call: { id?: string; name: string; args: unknown }, runId?: string): PatchAuthorizationReceipt | undefined {
  const parsed = patchAuthorizationStateSchema.safeParse(state)
  const receipt = parsed.success ? parsed.data.anasPatchAuthorization : undefined
  if (!receipt || (runId && receipt.runId !== runId)) return undefined
  return receipt.calls.find((item) => (!call.id || item.id === call.id) && item.name === call.name && item.inputHash === authorizationInputHash(call.args))
}

export function shellAuthorizationFor(state: unknown, call: { id?: string; name: string; args: unknown }, runId?: string): ShellAuthorizationReceipt | undefined {
  const parsed = shellAuthorizationStateSchema.safeParse(state)
  const receipt = parsed.success ? parsed.data.anasShellAuthorization : undefined
  if (!receipt || receipt.runId !== (runId ?? '')) return undefined
  return receipt.calls.find((item) => item.id === call.id && item.name === call.name && item.inputHash === authorizationInputHash(call.args))
}

export interface AuthorizationPaths {
  samePath(left: string, right: string): boolean
  dirname(path: string): string
  isSameOrInsideDirectory(parent: string, path: string): boolean
}

export function assertPatchTargets(actual: readonly { path: string; kind: 'file' | 'temporary' | 'directory'; access: 'read' | 'write' }[],
  expected: PatchAuthorizationReceipt['targets'], paths: AuthorizationPaths): void {
  const { samePath, dirname, isSameOrInsideDirectory } = paths
  for (const target of actual) {
    const authorized = expected.filter((item) => item.access === 'write' || target.access === 'read')
    const files = authorized.filter((item) => item.kind === 'file')
    if (authorized.some((item) => item.kind === target.kind && samePath(item.path, target.path))) continue
    // These are validated, managed transaction artifacts, not model-selected
    // write targets. Creating a requested file also authorizes its own staging
    // file and missing parents; recovery may encounter them after a hard exit.
    if (target.kind === 'temporary' && files.some((item) => samePath(dirname(item.path), dirname(target.path)))) continue
    if (target.kind === 'directory' && files.some((item) => isSameOrInsideDirectory(target.path, dirname(item.path)))) continue
    throw new Error(`Patch target was not included in the authorized operation: ${target.path}`)
  }
}

/** Bind every file to its original operation and access mode, not just its path. */
export function assertPatchFileBinding(actual: readonly { path: string; access: 'read' | 'write'; locator: readonly (string | number)[] }[],
  expected: PatchAuthorizationReceipt['targets'], samePath: AuthorizationPaths['samePath']): void {
  const files = expected.filter(target => target.kind === 'file')
  if (actual.length !== files.length || actual.some((target, index) =>
    !samePath(target.path, files[index].path) || target.access !== files[index].access
    || JSON.stringify(target.locator) !== JSON.stringify(files[index].locator))) {
    throw new Error('Patch file targets changed their operation binding after authorization.')
  }
}

/** Called at actual dispatch, including calls released from a background queue.
 * The caller supplies current environment/Skill inspection, never a cached grant. */
export async function verifyShellReceipt(receipt: ShellAuthorizationReceipt | undefined, args: unknown, options: {
  accessMode(): AgentAccessMode
  inspect(): Promise<ShellAuthorizationReceipt['plan']>
  samePath: AuthorizationPaths['samePath']
}): Promise<void> {
  const { samePath } = options
  if (!receipt || receipt.inputHash !== authorizationInputHash(args)) {
    throw new Error('Missing or changed persisted Shell authorization. Submit the command again.')
  }
  if (receipt.humanApproved) return
  if (!receipt.plan) {
    if (options.accessMode() === 'full_access') return
    if (options.accessMode() === 'smart_approval' && !receipt.requiresApproval && args && typeof args === 'object'
      && 'needs_approval' in args && args.needs_approval === false) return
    throw new Error('Shell command requires approval after the access mode changed. Submit the command again.')
  }
  const current = await options.inspect()
  const expected = receipt.plan
  const currentSkill = current?.skillScript, expectedSkill = expected.skillScript
  const sameSkill = !currentSkill && !expectedSkill || currentSkill && expectedSkill
    && currentSkill.skillId === expectedSkill.skillId && samePath(currentSkill.root, expectedSkill.root)
    && samePath(currentSkill.script, expectedSkill.script) && samePath(currentSkill.executor, expectedSkill.executor)
  if (!current || !samePath(current.executable, expected.executable) || !samePath(current.workingDir, expected.workingDir)
    || !sameSkill
    || current.paths.length !== expected.paths.length || current.paths.some((path, index) => !samePath(path, expected.paths[index]))) {
    throw new Error('Auto-approved Shell targets changed or could not be verified before execution. Submit the original command again for authorization.')
  }
}

export const isFileEditTool = (name: string): boolean => name === 'apply_patch' || name === 'write_file' || name === 'restore_file_edit'

/** Return the existing receipt updates for one fully resolved approval batch.
 * Callers commit these together with rejected results and canonical arguments. */
export function recordToolApprovals(state: unknown, calls: readonly { id?: string; name: string; args: unknown }[],
  approved: ReadonlySet<string>, answered: ReadonlySet<string>) {
  const parsed = patchAuthorizationStateSchema.safeParse(state)
  const receipt = parsed.success ? parsed.data.anasPatchAuthorization : undefined
  const approval = receipt ? { anasPatchAuthorization: { ...receipt,
    calls: receipt.calls.map((item) => ({ ...item, humanApproved: approved.has(item.id) && !answered.has(item.id)
      && !!calls.some((call) => call.id === item.id && patchAuthorizationFor(state, call)?.inputHash === item.inputHash) }))
  } } : {}
  const shellParsed = shellAuthorizationStateSchema.safeParse(state)
  const shellReceipt = shellParsed.success ? shellParsed.data.anasShellAuthorization : undefined
  const shellApproval = shellReceipt ? { anasShellAuthorization: { ...shellReceipt,
    calls: shellReceipt.calls.map((item) => ({ ...item, humanApproved: approved.has(item.id) && !answered.has(item.id)
      && !!calls.some((call) => call.id === item.id
        && shellAuthorizationFor(state, call, shellReceipt.runId)?.inputHash === item.inputHash) }))
  } } : {}

  return { ...approval, ...shellApproval }
}
