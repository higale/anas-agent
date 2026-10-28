import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AgentStorage } from '../main/agent/agentStorage'
import { NativeRunHost } from '../main/agent/nativeRunHost'
import { ManagedCallService } from '../main/agent/managedCallService'
import { createManagedToolRuntime } from '../main/agent/managedToolRuntime'
import { createConversationToolExecutor } from '../main/agent/conversationToolExecution'
import { prepareConversationToolBatch, type ConversationToolPreparationOptions } from '../main/agent/conversationToolPreparation'
import { conversationExecution } from '../runtime/conversationExecution'
import type { ToolDefinition } from '../runtime/toolDefinition'
import type { ExecutionToolCall } from '../runtime/executionState'
import type { ConversationToolCall } from '../runtime/conversationMessage'
import { toolEffectArtifactPurposes } from '../runtime/toolEffectIdentity'
import { ToolRunScope } from '../runtime/toolEvents'

/** Isolated current storage and real capability services. Only model responses
 * are scripted; preflight, effect ownership, dispatch and persistence are real. */
export function nativeCapabilityFixture(runId: string = randomUUID()) {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-capability-')), storage = AgentStorage.openNative(root)
  const thread = storage.createThread(), database = storage.conversationForThread(thread.id)
  const run = database.runs.createRun({ threadId: thread.id, runId, operation: 'agent', message: {
    id: runId + ':input', value: { id: runId + ':input', kind: 'user', content: 'Run capability', context: { runId } }
  } })
  const service = new ManagedCallService(database.managed, database.results)
  const host = new NativeRunHost(database, service, { push: () => {} })
  const managed = (definition: ToolDefinition, allowBackground = false) => createManagedToolRuntime(definition, {
    results: database.results, service, threadId: thread.id, runId, allowBackground
  })
  async function executeCalls(definitions: ToolDefinition[], batches: ConversationToolCall[][], allowBackground = false) {
    const preparation: ConversationToolPreparationOptions = { runId, primaryFolder: root, folders: [root],
      accessMode: () => 'full_access', includeRules: false, definitions, fileEditStore: database.resources.fileEditStore }
    const operations = new ToolRunScope(), owner = database.execution
    const execution = conversationExecution({ store: owner.store, enter: owner.enter,
      prepareModel: async state => ({ kind: 'model', invoke: async () => {
        const requested = batches[state.context.modelCalls] ?? []
        const calls: ExecutionToolCall[] = requested.map(call => ({ id: randomUUID(), providerCallId: call.id, name: call.name, args: call.args,
          artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }))
        return { message: { id: 'response-' + state.context.modelCalls, value: { kind: 'assistant', content: requested.length ? '' : 'Done', calls: requested } },
          calls, context: { ...state.context, modelCalls: state.context.modelCalls + 1 } }
      } }), afterModel: async () => ({ kind: 'complete' }),
      prepareTools: state => prepareConversationToolBatch(state, preparation),
      executeTool: createConversationToolExecutor({ store: owner.store,
        definitions: definitions.map(definition => createManagedToolRuntime(definition, {
          results: database.results, service, threadId: thread.id, runId, allowBackground,
          providerCallId: id => owner.store.load(thread.id)!.calls.find(call => call.id === id)!.providerCallId ?? id
        })), preparation, operations, planning: false, managed: owner.managed, persistFileChange: owner.persistFileChange }),
      directions: owner.directions, drain: () => operations.drain(), retry: { maxRetries: 0 }
    })
    const handle = host.start({ threadId: thread.id, runId }, 'input', async () => ({ execution, dispose: async () => {} }))
    const completed = await handle.completed
    await handle.drained
    if (completed.status !== 'completed') throw new Error(`Scripted capability run did not complete: ${completed.status}: ${completed.error ?? ''}`)
    return owner.store.readHistory(thread.id)!
  }
  return { root, host, database, thread, run, service, managed, executeCalls,
    async close() { await host.shutdown(); storage.close(); rmSync(root, { recursive: true, force: true }) } }
}
