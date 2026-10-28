import Database from 'better-sqlite3'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { z } from 'zod'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeRunHost } from './nativeRunHost'
import { ManagedCallService } from './managedCallService'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { conversationExecution } from '../../runtime/conversationExecution'
import { ToolRunScope } from '../../runtime/toolEvents'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import type { ExecutionEffectKey, ExecutionToolCall } from '../../runtime/executionState'
import type { NativeExecutionStore } from './nativeExecutionStore'
import { createConversationToolExecutor } from './conversationToolExecution'
import { prepareConversationToolBatch, type ConversationToolPreparationOptions } from './conversationToolPreparation'
import { armCurrentAgentToolEffect } from './toolEffectScope'
import type { ToolDefinition } from '../../runtime/toolDefinition'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { fileToolDefinitions } from '../llm/fileTools'
import { toolResultMessage } from '../../runtime/toolResultMessage'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import { filePatchRecordMetadataSchema } from '../filePatchRecord'

export const nativeEffectCrashExitCode = 83
export type NativeEffectCrashFault = 'none' | 'before_prepare' | 'after_prepare' | 'after_arm' | 'after_effect' | 'after_result' | 'after_accept' | 'after_decision'
  | 'patch_before_metadata' | 'patch_before_postimage' | 'patch_after_partial' | 'patch_after_applied' | 'patch_before_history' | 'patch_after_history' | 'patch_after_finalized'
export interface NativeEffectCrashOptions {
  root: string
  threadId: string
  runId: string
  fault: NativeEffectCrashFault
  scenario?: 'host-file' | 'parallel' | 'parallel-result' | 'write-file' | 'patch' | 'restore'
  child?: { id: string; threadId: string; runId: string }
  restore?: { requestId: string; operationId: string }
  cancel?: boolean
  decision?: { id: string; generation: string; type: 'approve' | 'reject' }
}

function crashFileStore(options: NativeEffectCrashOptions): FileEditStore {
  return new Proxy(new FileEditStore(join(options.root, 'file-edits')), {
    get(target, property, receiver) {
      const value: unknown = Reflect.get(target, property, target)
      if (property === 'writeManagedText') return async (requestId: string, operationId: string, name: string, text: string, replace: boolean) => {
        const write = value as (requestId: string, operationId: string, name: string, text: string, replace: boolean) => Promise<void>
        if (name !== 'record.json') return write.call(receiver, requestId, operationId, name, text, replace)
        const record = filePatchRecordMetadataSchema.parse(JSON.parse(text))
        const partial = record.transaction.entries.some(entry => entry.state === 'applied')
        const applied = record.transaction.entries.every(entry => entry.state === 'applied')
        const stop = (fault: NativeEffectCrashFault) => { if (options.fault === fault) process.exit(nativeEffectCrashExitCode) }
        if (record.revision === 0) stop('patch_before_metadata')
        if (partial) stop('patch_before_postimage')
        await write.call(receiver, requestId, operationId, name, text, replace)
        if (partial && !applied) stop('patch_after_partial')
        if (record.transaction.state === 'applied') stop('patch_after_applied')
        if (record.transaction.recovery?.state === 'complete') stop('patch_after_finalized')
      }
      return typeof value === 'function' ? value.bind(receiver) : value
    }
  })
}

/** Run the product's native owner, preflight, effect service and persistence in
 * an expendable process. Faults terminate without shutdown or SQLite close. */
export async function runNativeEffectCrashHarness(options: NativeEffectCrashOptions) {
  if (options.scenario === 'restore' && !options.restore) throw new Error('A restore fixture requires its saved source identity.')
  const global = new Database(':memory:'), fileEdits = crashFileStore(options)
  const database = NativeConversationDatabase.open(join(options.root, 'conversation.sqlite'), {
    attachmentRoot: join(options.root, 'attachments'), memoryStore: new SqliteMemoryStore(global), fileEditStore: fileEdits
  })
  const parent = { threadId: options.threadId, runId: options.runId }
  const identity = options.child ? { threadId: options.child.threadId, runId: options.child.runId } : parent
  const host = new NativeRunHost(database, new ManagedCallService(database.managed, database.results), { push() {} })
  const mixed = options.scenario === 'parallel-result'
  const parallel = mixed || options.scenario === 'parallel'
  let releaseLeftResult!: () => void
  const leftResultSaved = new Promise<void>(resolve => { releaseLeftResult = resolve })
  const stop = (boundary: NativeEffectCrashFault, key?: ExecutionEffectKey) => {
    const selected = mixed ? 'mcp_right' : 'mcp_left'
    if (options.fault === boundary && (!parallel || !key || database.execution.store.load(key.threadId)?.calls.find(call => call.id === key.callId)?.name === selected)) {
      process.exit(nativeEffectCrashExitCode)
    }
  }
  const trace = (event: string, key: ExecutionEffectKey) => appendFileSync(join(options.root, 'trace.log'), JSON.stringify({ event, ...key }) + '\n')
  const store = new Proxy(database.execution.store, {
    get(target, property) {
      if (property === 'prepareEffect') return (...args: Parameters<NativeExecutionStore['prepareEffect']>) => {
        trace('prepare:before', args[0]); stop('before_prepare', args[0])
        const result = target.prepareEffect(...args); trace('prepare:after', args[0]); stop('after_prepare', args[0]); return result
      }
      if (property === 'armEffect') return (...args: Parameters<NativeExecutionStore['armEffect']>) => {
        const result = target.armEffect(...args); trace('arm:after', args[0]); stop('after_arm', args[0]); return result
      }
      if (property === 'saveEffectResult') return (...args: Parameters<NativeExecutionStore['saveEffectResult']>) => {
        const result = target.saveEffectResult(...args); trace('result:after', args[0]); stop('after_result', args[0])
        if (target.load(args[0].threadId)?.calls.find(call => call.id === args[0].callId)?.name === 'mcp_left') releaseLeftResult()
        return result
      }
      if (property === 'settleCall') return (...args: Parameters<NativeExecutionStore['settleCall']>) => {
        const key = { ...args[0], callId: args[1] }
        const result = target.settleCall(...args); trace('accept:after', key); stop('after_accept', key); return result
      }
      const value: unknown = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    }
  })
  try {
    const fileScenario = options.scenario === 'host-file' || options.scenario === 'write-file' || options.scenario === 'patch' || options.scenario === 'restore'
    const workspace = fileScenario ? join(options.root, 'workspace') : options.root
    const targetFile = join(options.root, 'outside.txt')
    if (!database.readModel.getRun(parent.runId)) {
      if (fileScenario && !options.restore) {
        mkdirSync(workspace)
        if (options.scenario === 'host-file') writeFileSync(targetFile, 'Isolated file outside the authorized workspace')
        else writeFileSync(join(workspace, 'target.txt'), 'write before\n')
      }
      database.runs.createThreadAndRun({ ...parent, thread: {}, submissionId: randomUUID(), message: {
        id: 'input', value: { id: 'input', kind: 'user', content: 'Run the isolated effect', context: { runId: parent.runId } }
      } })
      if (options.child) {
        await database.runs.enter('input', parent)
        database.runs.createSubagentCall({ id: options.child.id, ownerThreadId: parent.threadId, parentThreadId: parent.threadId,
          parentRunId: parent.runId, childThreadId: identity.threadId, childRunId: identity.runId, childThread: {}, description: 'Run the child effect',
          config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false,
            description: 'Isolated child', systemPrompt: 'Run the isolated task.' } })
      }
    }
    database.recover()
    const fileTool = fileScenario ? fileToolDefinitions({ primaryFolder: workspace, requestId: identity.runId,
      fileEditStore: fileEdits, maxReadBytes: 10000, toolNames: [options.scenario === 'host-file' ? 'delete_file' : options.scenario === 'write-file' ? 'write_file' : options.restore ? 'restore_file_edit' : 'apply_patch'] })[0] : undefined
    const fileArgs = options.restore ? { summary: 'Restore the isolated file edit', operation_id: options.restore.operationId, request_id: options.restore.requestId }
      : options.scenario === 'host-file' ? { path: targetFile, summary: 'Delete the isolated fixture file' }
      : options.scenario === 'write-file' ? { path: 'target.txt', content: 'write after\n', overwrite: true, summary: 'Replace complete content' }
      : { summary: 'Write the crash recovery fixture', patch: [
        '*** Begin Patch', '*** Update File: target.txt', '@@', '-write before', '+write after',
        '*** Add File: second.txt', '+second', '*** End Patch'
      ].join('\n') }
    const effectDefinition = (label: string): ToolDefinition<ConversationMessage> => ({
      name: parallel ? `mcp_${label}` : 'mcp_crash_effect', description: 'Isolated crash fixture', inputSchema: z.object({}),
      execute: async (_input, context) => {
        if (!context.callId) throw new Error('The effect must have a saved application call identity.')
        if (mixed && options.fault !== 'none' && label === 'right') await leftResultSaved
        armCurrentAgentToolEffect({ kind: 'crash_fixture', target: { label } })
        appendFileSync(join(options.root, 'effects.log'), `${label}\n`); stop('after_effect', { ...identity, callId: context.callId })
        return { id: `${label}-result`, kind: 'tool', name: parallel ? `mcp_${label}` : 'mcp_crash_effect', resultFor: context.callId,
          content: 'Effect completed', resultStatus: 'success', artifact: { bytes: new Uint8Array([1, 2]) } }
      }
    })
    const definitions: ToolDefinition<ConversationMessage>[] = fileTool ? [{ ...fileTool, async execute(input, context) {
      if (!context.callId) throw new Error('The file effect must have a saved application call identity.')
      const result = await fileTool.execute(input, context)
      appendFileSync(join(options.root, 'effects.log'), 'host-file\n'); stop('after_effect')
      return toolResultMessage(result, { name: fileTool.name, callId: context.callId })
    } }] : (parallel ? ['left', 'right'] : [options.child ? 'child' : 'single']).map(effectDefinition)
    const preparation: ConversationToolPreparationOptions = { runId: identity.runId, primaryFolder: workspace, folders: [workspace],
      accessMode: () => options.scenario === 'host-file' ? 'strict_approval' : 'full_access', includeRules: false, fileEditStore: fileEdits, definitions }
    const operations = new ToolRunScope()
    const executeTool = createConversationToolExecutor({ store, definitions, preparation, operations, planning: false,
      persistFileChange: (record, observed) => {
        const partial = record.transaction.entries.some(entry => entry.state === 'applied')
        if (partial) stop('patch_before_history')
        database.execution.persistFileChange(record, observed)
        if (partial) stop('patch_after_history')
      } })
    const execution = conversationExecution({ store, enter: async (command, request) => {
      await database.execution.enter(command, request)
      if (command === 'resume') stop('after_decision')
    },
      prepareModel: async state => ({ kind: 'model', invoke: async () => {
        const calls: ExecutionToolCall[] = state.context.modelCalls ? [] : definitions.map(definition => {
          const id = randomUUID()
          return { id, providerCallId: id, name: definition.name,
          args: fileTool ? fileArgs : {},
          artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }
        })
        return { message: { id: `response-${state.context.modelCalls}`, value: { kind: 'assistant', content: calls.length ? '' : 'Done',
          calls: calls.map(call => ({ id: call.id, name: call.name, args: call.args })) } }, calls,
          context: { ...state.context, modelCalls: state.context.modelCalls + 1 } }
      } }), afterModel: async () => ({ kind: 'complete' }), prepareTools: state => prepareConversationToolBatch(state, preparation),
      executeTool: async (...args) => {
        const result = await executeTool(...args)
        // Hold the durable left result before batch acceptance until the right
        // intent terminates the process. Recovery uses the normal executor.
        if (mixed && options.fault !== 'none' && args[0].name === 'mcp_left') await new Promise<void>(() => {})
        return result
      }, directions: database.execution.directions,
      drain: () => operations.drain(), retry: { maxRetries: 0 }
    })
    const create = async () => ({ execution, dispose: async () => {} })
    if (options.cancel) { host.cancel(identity); await host.waitForIdle(); await host.cleanupResources() }
    const handle = options.cancel ? undefined : options.decision ? host.resumeRun({ ...identity, responses: [{ interruptId: options.decision.id,
      expectedGeneration: options.decision.generation, decisions: [{ type: options.decision.type }] }] }, create)
      : host.recoverRun(identity.threadId, create)
    if (handle) { await handle.completed; await handle.drained }
    const state = store.load(identity.threadId)!
    const approvals = database.runs.readInterrupts(identity).map(pending => {
      if (!pending.approvalGeneration) throw new Error('A pending product approval must expose its response generation.')
      return { id: pending.id, generation: pending.approvalGeneration, request: pending.value }
    })
    return { phase: state.phase, approvals, history: store.readHistory(identity.threadId)!.messages.map(message => message.value),
      pendingFileCleanup: database.resourceCleanup.listFileEditCleanupRunIds(),
      parent: options.child ? { phase: store.load(parent.threadId)!.phase, history: store.readHistory(parent.threadId)!.messages.map(message => message.value),
        call: database.runs.subagents.require(options.child.id, parent.threadId) } : undefined }
  } finally { await host.shutdown(); database.close(); global.close() }
}
