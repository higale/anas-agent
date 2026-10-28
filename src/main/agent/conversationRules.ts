import { requireObjectToolCall } from '../../runtime/toolInput'
import type { AgentAccessMode } from '@shared/agentTypes'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { ExecutionContext, ExecutionPendingCall } from '../../runtime/executionState'
import { ProjectRulesError } from '../../runtime/errors'
import { preflightProjectRuleBatch, projectRulesText } from '../../runtime/projectRules'
import type { FileEditStore } from '../fileEditStore'
import { createProjectRulesSnapshot, discoverProjectRules, mutationDirectories, projectRuleTargetDirectory, type ProjectRulesReader } from './projectRules'
import { prepareToolPathAuthorization } from './toolAuthorization'
import { toolPathArguments } from './toolPathArguments'
import { countConversationTokens } from './conversationContext'
import { authorizationInputHash } from '../../runtime/authorizationReceipts'
import type { ApprovalDirectories } from './approvalDirectories'

export interface ConversationRulesOptions {
  runId: string
  folders: string[]
  primaryFolder: string
  accessMode(): AgentAccessMode
  signal?: AbortSignal
  fileEditStore?: Pick<FileEditStore, 'loadOperationRecord'>
  directories?: ApprovalDirectories
}
function reader(options: ConversationRulesOptions): ProjectRulesReader {
  // Rule discovery validates canonical file targets; verified reads are allowed
  // in every access mode, including outside the project folders.
  return { signal: options.signal, authorizeRead: () => {} }
}

/** Freeze rule documents and absences once per run; resumed runs retain the snapshot. */
export async function prepareConversationRules(source: ExecutionContext, options: ConversationRulesOptions): Promise<
  { kind: 'ready'; context: ExecutionContext }> {
  const context = structuredClone(source)
  if (context.projectRules?.runId !== options.runId) {
    // A read can have been approved before any discovery snapshot was saved.
    // Keep only this run's unfinished discovery decisions; another run starts
    // with no grants. Discovery still captures the actual current documents.
    const reads = context.rulePreparation?.runId === options.runId && !context.rulePreparation.initialized ? context.rulePreparation.reads : []
    context.projectRules = await createProjectRulesSnapshot(options.runId, options.folders, options.signal)
    context.rulePreparation = { runId: options.runId, initialized: false, reads }
  }
  const snapshot = context.projectRules, preparation = context.rulePreparation
  if (!preparation || preparation.runId !== options.runId) throw new ProjectRulesError('Missing native rule preparation state.')
  if (snapshot.fatalError) throw new ProjectRulesError(snapshot.fatalError)
  if (preparation.initialized) return { kind: 'ready', context }
  for (const root of [...snapshot.roots]) {
    const scopes = await discoverProjectRules(snapshot, root.folder, reader(options))
    if (!snapshot.initialScopes.length) snapshot.initialScopes = scopes
  }
  snapshot.initialScopes = [...new Set(snapshot.initialScopes)]
  snapshot.activeScopes = [...snapshot.initialScopes]
  preparation.initialized = true
  return { kind: 'ready', context }
}

export function conversationRuleSystemMessage(system: ConversationMessage, context: ExecutionContext, runId: string): ConversationMessage {
  const snapshot = context.projectRules
  if (snapshot?.runId !== runId || context.rulePreparation?.runId !== runId || !context.rulePreparation.initialized) {
    throw new ProjectRulesError('The current run has no complete rule snapshot.')
  }
  if (snapshot.fatalError) throw new ProjectRulesError(snapshot.fatalError)
  const text = projectRulesText(snapshot)
  return text ? { ...system, content: typeof system.content === 'string' ? `${system.content}\n\n${text}`
    : [...system.content, { type: 'text', text: `\n\n${text}` }] } : system
}

/** Inspect the whole batch before any dispatch. The shared rule algorithm binds
 * writes to the scopes seen by the model and withholds newly discovered scopes. */
export async function preflightConversationRules(source: ExecutionContext, rawCalls: readonly ExecutionPendingCall[], receipt: unknown,
  options: ConversationRulesOptions): Promise<{ kind: 'ready'; context: ExecutionContext; calls: ExecutionPendingCall[] }> {
  const calls = rawCalls.map(requireObjectToolCall)
  const context = structuredClone(source)
  if (context.rulePreparation?.runId !== options.runId || !context.rulePreparation.initialized) throw new ProjectRulesError('Missing completed rule discovery.')
  const previous = context.rulePreparation.completedCalls ?? []
  for (const call of calls) {
    const prepared = previous.find(item => item.id === call.id)
    if (prepared && (prepared.name !== call.name || prepared.inputHash !== authorizationInputHash(call.args))) {
      throw new ProjectRulesError('The prepared rule inputs changed before tool authorization.')
    }
  }
  if (calls.every(call => previous.some(item => item.id === call.id))) return { kind: 'ready', context, calls: [...calls] }
  const result = await preflightProjectRuleBatch({ runId: options.runId, snapshot: context.projectRules, calls, receipt,
    answered: new Set(calls.filter(call => call.result).map(call => call.id)),
    countScopeTokens: (snapshot, scopes) => { const text = projectRulesText(snapshot, scopes); return text ? countConversationTokens([{ kind: 'system', content: text }], []) : 0 },
    inspect: async (snapshot, call) => {
      context.projectRules = snapshot
      if (call.name !== 'apply_patch') {
        const arguments_ = toolPathArguments(call.name, call.args)
        if (!arguments_ || arguments_.some(argument => typeof argument.value !== 'string' || !argument.value.trim())) {
          return { rejection: 'NOT EXECUTED: Invalid file path arguments. Correct the arguments and decide again.' }
        }
        if (!arguments_.length && call.name !== 'restore_file_edit') return undefined
      }
      let prepared: Awaited<ReturnType<typeof prepareToolPathAuthorization>>
      try {
        prepared = await prepareToolPathAuthorization({ toolName: call.name, args: call.args, primaryFolder: options.primaryFolder,
          trustedFolders: options.folders, accessMode: options.accessMode(), directories: options.directories, requestId: options.runId, fileEditStore: options.fileEditStore })
      } catch (error) {
        options.signal?.throwIfAborted()
        return { rejection: `NOT EXECUTED: Cannot resolve the file targets: ${String(error)}. Correct the paths and decide again.` }
      }
      const scopes = new Set<string>(), fileTargets = prepared.targets.filter(target => !target.kind || target.kind === 'file')
      for (const target of fileTargets) {
        let directories = [await projectRuleTargetDirectory(target.canonicalPath)]
        if (target.access === 'write' && (call.name === 'delete_file' || call.name === 'move_file')) {
          directories = await mutationDirectories(target.canonicalPath,
            call.name === 'move_file' && target.locator[0] === 'source' ? String(call.args.destination) : undefined, reader(options))
        } else if (call.name === 'create_directory') directories.push(target.canonicalPath)
        for (const directory of directories) for (const scope of await discoverProjectRules(snapshot, directory, reader(options))) scopes.add(scope)
      }
      return { scopes: [...scopes], ...(prepared.targets.some(target => target.access === 'write') ? { writePaths: fileTargets.map(target => target.canonicalPath) } : {}) }
    }
  })
  context.projectRules = result.snapshot
  context.rulePreparation.completedCalls = (result.calls ?? calls).map(call => ({ id: call.id, name: call.name, inputHash: authorizationInputHash(call.args) }))
  return { kind: 'ready', context, calls: result.calls ?? [...calls] }
}

export async function conversationRuleToolRejection(context: ExecutionContext, rawCall: ExecutionPendingCall,
  options: ConversationRulesOptions): Promise<string | undefined> {
  const call = requireObjectToolCall(rawCall)
  const snapshot = context.projectRules
  if (snapshot?.runId !== options.runId) throw new ProjectRulesError('Missing rule snapshot before tool dispatch.')
  if (snapshot.blockedCalls.includes(call.id)) {
    return (!snapshot.fatalError && snapshot.rejectedCalls.find(rejected => rejected.id === call.id)?.reason) || snapshot.blockedReason
  }
  if (snapshot.fatalError) throw new ProjectRulesError(snapshot.fatalError)
  const checked = snapshot.checkedWrites.find(checked => checked.id === call.id)
  if (!checked) return undefined
  const prepared = await prepareToolPathAuthorization({ toolName: call.name, args: structuredClone(call.args),
    primaryFolder: options.primaryFolder, trustedFolders: options.folders, accessMode: options.accessMode(), directories: options.directories,
    requestId: options.runId, fileEditStore: options.fileEditStore })
  if (JSON.stringify(prepared.targets.filter(target => !target.kind || target.kind === 'file').map(target => target.canonicalPath)) !== JSON.stringify(checked.paths)) {
    return 'NOT EXECUTED: The resolved file targets changed after rule preflight. Inspect the current paths and decide again.'
  }
  return undefined
}

export function conversationRuleResult(context: ExecutionContext, result: ConversationMessage): ConversationMessage {
  const reason = context.projectRules?.blockedReason
  if (!reason?.includes('rule union')) return result
  const notice = `\n\nRule context notice: ${reason}`
  return { ...result, content: typeof result.content === 'string' ? `${result.content}${notice}` : [...result.content, { type: 'text', text: notice.trimStart() }] }
}
