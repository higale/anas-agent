import type { AgentThread } from '@shared/agentTypes'
import type { AppConfigSnapshot, Project } from '@shared/types'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { contentText } from '../../runtime/inputContent'
import { conversationContentBlocks } from '../../providers/conversationInput'
import type { ConversationResourceAccess } from './conversationResourceReader'
import { prepareAgentRuntimeResources, createAgentAccessModeResolver, type AgentResourceContext } from './agentRuntimeResources'
import { conversationToolCatalog } from './conversationToolCatalog'
import { createConversationMemoryProjector } from './conversationMemory'
import { prepareConversationRules, conversationRuleSystemMessage } from './conversationRules'
import { projectConversationSupervision } from './conversationSupervision'
import { prepareConversationModelCall } from './conversationRequest'
import { createProviderRequestCaptureFetch, type CapturedProviderRequest } from './providerRequestCapture'
import { prepareConversationContext } from './conversationContextPreparation'
import type { ConversationContextSource } from './conversationContextRuntime'
import type { CodeReviewSnapshot } from '../../shared/codeReview'

const simulatedInput = 'hello world'

export async function projectConversationContextStatus(thread: AgentThread, database: ConversationResourceAccess,
  config: AppConfigSnapshot, source: ConversationContextSource, context: AgentResourceContext & { review?: CodeReviewSnapshot }) {
  const resources = await prepareAgentRuntimeResources(thread, database, config, context, {
    persistent: false, contextPreview: true, prepareWorkspace: false, review: context.review,
    requestSubagentApproval: () => { throw new Error('A context preview cannot request subagent approval.') }
  })
  return prepareConversationContext(thread, database, config, resources, context).contextRuntime.projectedStatus(source)
}

/** Read-only request preparation uses the same product resources and native
 * request finalization as execution. It never creates a run or invokes a tool. */
async function preparePreview(thread: AgentThread, database: ConversationResourceAccess, config: AppConfigSnapshot,
  managedCalls?: AgentResourceContext['managedCalls'], project?: Project) {
  const resources = await prepareAgentRuntimeResources(thread, database, config, { managedCalls }, {
    project, persistent: false, prepareWorkspace: false,
    requestSubagentApproval: () => { throw new Error('A preview cannot request subagent approval.') }
  })
  const { workspace } = resources
  const catalog = conversationToolCatalog(resources)
  const model = await resources.resolveModel(), tools = resources.selectModelTools(model, catalog.declarations)
  const messages: ConversationMessage[] = [{ kind: 'user', content: simulatedInput }]
  let systemMessage: ConversationMessage = { kind: 'system', content: resources.requestSystemPrompt(model).text }
  if (managedCalls) {
    systemMessage = (await projectConversationSupervision(systemMessage, tools, {
      managed: { unresolved: () => managedCalls.unresolvedForThread(thread.id) }
    })).systemMessage
  }
  systemMessage = await createConversationMemoryProjector({ enabled: resources.capabilities.memory && !resources.simpleChat,
    store: database.memoryStore, projectId: thread.projectId })(systemMessage, messages)
  let projectRules
  if (!resources.simpleChat && resources.runConfiguration.codingMode) {
    const rules = await prepareConversationRules({ modelCalls: 0, todos: [] }, {
      runId: 'preview', primaryFolder: workspace.primaryFolder, folders: workspace.trustedFolders,
      accessMode: createAgentAccessModeResolver(database, thread.id), allowApprovals: false
    })
    if (rules.kind !== 'ready') throw new Error('Preview rule preparation did not complete.')
    systemMessage = conversationRuleSystemMessage(systemMessage, rules.context, 'preview')
    projectRules = rules.context.projectRules
  }
  let captured: CapturedProviderRequest | undefined
  const request = await prepareConversationModelCall(model, { messages, systemMessage, tools, projectRules, requiresTools: false }, {
    runId: 'preview', signal: new AbortController().signal, resolveModel: resources.resolveModel,
    providerFetch: createProviderRequestCaptureFetch(value => { captured = value })
  })
  return { model, request, captured: () => captured }
}

export async function captureAgentSystemPrompt(thread: AgentThread, database: ConversationResourceAccess,
  config: AppConfigSnapshot, project?: Project): Promise<string> {
  const prepared = await preparePreview(thread, database, config, undefined, project)
  return contentText(conversationContentBlocks(prepared.request.systemMessage))
}

export async function captureAgentModelRequest(thread: AgentThread, database: ConversationResourceAccess, config: AppConfigSnapshot,
  managedCalls: NonNullable<AgentResourceContext['managedCalls']>, project?: Project): Promise<string> {
  const prepared = await preparePreview(thread, database, config, managedCalls, project)
  try { await prepared.request.invoke() } catch (error) { if (!prepared.captured()) throw error }
  const request = prepared.captured()
  if (!request) throw new Error('The provider request was not captured.')
  return JSON.stringify({ simulated: true, simulated_input: simulatedInput,
    provider: { id: prepared.model.providerId, name: prepared.model.providerName, protocol: prepared.model.protocol },
    model: { config_id: prepared.model.id, name: prepared.model.model }, request }, null, 2)
}
