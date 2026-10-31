import type { AgentThread } from '../../shared/agentTypes'
import type { AppConfigSnapshot } from '../../shared/types'
import type { CodeReviewSnapshot } from '../../shared/codeReview'
import type { ConversationResourceAccess } from './conversationResourceReader'
import type { prepareAgentRuntimeResources } from './agentRuntimeResources'
import { conversationToolCatalog } from './conversationToolCatalog'
import { createConversationAttachmentProjector } from './conversationAttachments'
import { createConversationMemoryProjector, type MemoryRecallDetails } from './conversationMemory'
import { createConversationContextRuntime } from './conversationContextRuntime'
import { simpleConversationHistory } from './conversationHistoryProjection'
import { codeReviewToolDeclaration } from '../../runtime/codeReviewReport'

/** Execution and read-only context inspection use identical tool, attachment,
 * memory, summary and system-prompt projections. */
export function prepareConversationContext(thread: AgentThread, database: ConversationResourceAccess, config: AppConfigSnapshot,
  resources: Awaited<ReturnType<typeof prepareAgentRuntimeResources>>, context: {
    requestId?: string; providerFetch?: typeof fetch; review?: CodeReviewSnapshot
    onMemoryRecall?(details: MemoryRecallDetails & { agentName?: string }): void
  }) {
  const { resolveModel, requestSystemPrompt, activeSubagent, runConfiguration, simpleChat, capabilities, outputLanguage } = resources
  const catalog = conversationToolCatalog(resources)
  const tools = (model: Awaited<ReturnType<typeof resolveModel>>) => resources.selectModelTools(model, catalog.declarations)
  const attachments = createConversationAttachmentProjector({ artifacts: database.listAttachmentsForThread(thread.id),
    currentRunId: context.requestId, textMaxChars: config.settings.attachmentTextMaxChars, textOverflow: config.settings.attachmentTextOverflow })
  const memory = createConversationMemoryProjector({ enabled: capabilities.memory && !simpleChat,
    store: database.memoryStore, projectId: thread.projectId,
    onRecall: details => context.onMemoryRecall?.({ ...details, ...(activeSubagent ? { agentName: activeSubagent.name } : {}) }) })
  const includeRules = !simpleChat && runConfiguration.codingMode
  const contextRuntime = createConversationContextRuntime({ retry: false, codingMode: runConfiguration.codingMode,
    compressionPrompt: activeSubagent ? undefined : runConfiguration.compressionPrompt, includeProjectRules: includeRules,
    developerHttpTrace: resources.developerHttpTrace, providerFetch: context.providerFetch, resolveModel, outputLanguage, requestId: context.requestId,
    systemPrompt: requestSystemPrompt, projectSystemMessage: memory,
    tools: model => [...tools(model), ...(context.review ? [codeReviewToolDeclaration(context.review.id)] : [])],
    projectHistory: simpleChat ? simpleConversationHistory : undefined,
    projectMessages: (messages, model) => attachments.project(messages, model.capabilities.vision) })
  return { catalog, tools, attachments, memory, includeRules, contextRuntime }
}
