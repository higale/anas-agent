import { isSameOrInsideDirectory, samePath } from '../pathContainment'
import type { FilePatchRestoreTarget } from '../filePatchRestore'
import { resolveFilePatchTargets, resolveWriteFileTargets } from '../filePatch'
import { filePatchRestoreTargets } from '../filePatchRestore'
import type { FileEditStore } from '../fileEditStore'
import {
  canonicalizeAbsolutePath,
  resolveCanonicalWorkspacePath,
  type CanonicalWorkspacePath
} from '../workspacePath'
import {
  toolPathArguments,
  toolPathDescriptors,
  type ToolArgumentLocatorSegment
} from './toolPathArguments'
import type { AgentAccessMode } from '@shared/agentTypes'
import { terminalActionSchema } from '@shared/terminal'
import { modelApprovalDecision, withoutApprovalParameter } from '../../runtime/smartApproval'
import { safeApprovalFolders, type ApprovalDirectories } from './approvalDirectories'

const fullAccessBypassToolNames = new Set(['update_config', 'write_call'])

function setArgumentValue(
  args: Record<string, unknown>,
  locator: ToolArgumentLocatorSegment[],
  value: string
): void {
  let parent: unknown = args
  for (const segment of locator.slice(0, -1)) {
    if (!parent || typeof parent !== 'object') throw new Error('tool path locator is invalid')
    parent = (parent as Record<string | number, unknown>)[segment]
  }
  const final = locator.at(-1)
  if (final === undefined || !parent || typeof parent !== 'object') {
    throw new Error('tool path locator is invalid')
  }
  const record = parent as Record<string | number, unknown>
  record[final] = value
}

export interface ToolPathAuthorization {
  requiresApproval: boolean
  targets: Array<CanonicalWorkspacePath & {
    locator: ToolArgumentLocatorSegment[]
    access: 'read' | 'write'
    kind?: 'file' | 'temporary' | 'directory'
  }>
}

async function authorizeCanonicalTargets(
  targets: ToolPathAuthorization['targets'], trusted: readonly string[], accessMode: AgentAccessMode,
  args: Record<string, unknown>, codeOnly = false
): Promise<ToolPathAuthorization> {
  if (accessMode === 'full_access' || targets.length === 0) return { requiresApproval: false, targets }
  const trustedFolders = await Promise.all(trusted.map(async (folder) =>
    (await canonicalizeAbsolutePath(folder, 'follow')).canonicalPath
  ))
  const outside = targets.some((target) =>
    !trustedFolders.some((folder) => isSameOrInsideDirectory(folder, target.canonicalPath))
    && target.access === 'write'
  )
  return { requiresApproval: outside && (accessMode === 'strict_approval' || codeOnly || modelApprovalDecision(args)), targets }
}

// Internal preflight integration point; this does not approve, register or run a
// restore tool. The host must present the decision through its existing boundary.
export async function prepareFilePatchRestoreAuthorization(options: {
  targets: readonly FilePatchRestoreTarget[]
  primaryFolder: string
  trustedFolders: string[]
  accessMode: AgentAccessMode
  args?: Record<string, unknown>
}): Promise<ToolPathAuthorization> {
  const targets = await Promise.all(options.targets.map(async (target, index) => {
    const resolved = await resolveCanonicalWorkspacePath(target.path, options.primaryFolder, 'entry')
    if (!samePath(resolved.canonicalPath, target.path) || resolved.finalIsSymbolicLink) throw new Error('Patch restore authorization target changed.')
    return { ...resolved, locator: ['targets', index, 'path'], access: target.access, kind: target.kind }
  }))
  return authorizeCanonicalTargets(targets, options.trustedFolders, options.accessMode, options.args ?? {})
}

export async function prepareToolPathAuthorization(options: {
  toolName: string
  args: Record<string, unknown>
  primaryFolder: string
  trustedFolders: string[]
  accessMode: AgentAccessMode
  commandShellToolName?: string
  requestId?: string
  fileEditStore?: Pick<FileEditStore, 'loadOperationRecord'>
  directories?: ApprovalDirectories
}): Promise<ToolPathAuthorization> {
  const approvalArgs = options.args
  const codeOnly = options.toolName === 'apply_patch' && typeof approvalArgs.input === 'string'
  options = { ...options, trustedFolders: safeApprovalFolders(options.trustedFolders, options.accessMode, options.directories),
    args: withoutApprovalParameter({ name: options.toolName }, options.args) as Record<string, unknown> }
  if (options.toolName === 'restore_file_edit') {
    const args = options.args
    if (!options.fileEditStore) throw new Error('Conversation file edit storage is unavailable.')
    const record = await options.fileEditStore.loadOperationRecord(
      typeof args.operation_id === 'string' ? args.operation_id.trim() : '',
      typeof args.request_id === 'string' && args.request_id.trim() ? args.request_id.trim() : options.requestId)
    return prepareFilePatchRestoreAuthorization({ ...options, args: approvalArgs, targets: filePatchRestoreTargets(record).map((target) => ({
      ...target, access: args.dry_run === true ? 'read' : 'write'
    })) })
  }
  if (options.toolName === 'apply_patch' || options.toolName === 'write_file') {
    const resolve = options.toolName === 'write_file' ? resolveWriteFileTargets : resolveFilePatchTargets
    const { targets } = await resolve(options.args, options.primaryFolder)
    // The locator identifies the parsed operation, not a public JSON property.
    // Keep patch text unchanged so persisted calls retain lexical paths and cannot
    // hide a link retargeted after rule discovery.
    return authorizeCanonicalTargets(targets.map((target) => ({ ...target,
      locator: ['operations', target.operationIndex, target.field]
    })), options.trustedFolders, options.accessMode, approvalArgs, codeOnly)
  }
  if (fullAccessBypassToolNames.has(options.toolName)) {
    return {
      requiresApproval: options.accessMode !== 'full_access' && (options.toolName !== 'write_call'
        || terminalActionSchema.parse(options.args.action).type !== 'resize')
        && (options.accessMode === 'strict_approval' || modelApprovalDecision(approvalArgs)),
      targets: []
    }
  }
  const pathArguments = toolPathArguments(options.toolName, options.args)
  if (!pathArguments) throw new Error('Invalid file path arguments. Supply every required path with the documented structure.')
  const targets = await Promise.all(pathArguments.map(async (argument) => ({
    locator: argument.locator,
    access: argument.access,
    ...await resolveCanonicalWorkspacePath(
      argument.value,
      options.primaryFolder,
      argument.semantics
    )
  })))
  for (const target of targets) {
    setArgumentValue(approvalArgs, target.locator, target.canonicalPath)
  }
  if (options.accessMode === 'full_access') return { requiresApproval: false, targets }
  if (options.toolName === options.commandShellToolName) return { requiresApproval: true, targets }
  return authorizeCanonicalTargets(targets, options.trustedFolders, options.accessMode, approvalArgs)
}

export async function requiresToolApproval(options: {
  toolName: string
  args: Record<string, unknown>
  primaryFolder: string
  trustedFolders: string[]
  accessMode: AgentAccessMode
  commandShellToolName?: string
  directories?: ApprovalDirectories
}): Promise<boolean> {
  return (await prepareToolPathAuthorization(options)).requiresApproval
}

export function approvalToolNames(commandShellToolName?: string): string[] {
  return [...new Set([
    ...fullAccessBypassToolNames,
    ...Object.keys(toolPathDescriptors),
    ...(commandShellToolName ? [commandShellToolName] : [])
  ])]
}
