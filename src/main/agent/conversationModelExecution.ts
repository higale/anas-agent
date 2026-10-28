import { randomUUID } from 'node:crypto'
import type { ResolvedModelConfig } from '@shared/types'
import type { CodeReviewSnapshot } from '@shared/codeReview'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { ConversationExecutionServices } from '../../runtime/conversationExecution'
import type { ExecutionState, ExecutionToolCall } from '../../runtime/executionState'
import { checkModelCallBudget } from '../../runtime/modelCallBudget'
import { stageManualCompression } from '../../runtime/compression'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { conversationContentBlocks } from '../../providers/conversationInput'
import type { ConversationAttachmentProjector } from './conversationAttachments'
import type { createConversationMemoryProjector } from './conversationMemory'
import { invokeConversationWithCompression, type ConversationCompressionOptions } from './conversationCompression'
import type { ConversationContextRuntime, ConversationContextSource } from './conversationContextRuntime'
import { effectiveConversationHistory, simpleConversationHistory } from './conversationHistoryProjection'
import { projectConversationToolImages } from './conversationContext'
import { prepareConversationRules, conversationRuleSystemMessage, type ConversationRulesOptions } from './conversationRules'
import { ToolArgumentProgress } from './toolArgumentProgress'
import { presentConversationMessage } from './conversationPresentation'
import { projectConversationSupervision, reconcileConversationSupervision, type ConversationSupervisionOptions } from './conversationSupervision'

export interface ConversationModelExecutionOptions extends Omit<ConversationCompressionOptions, 'runId' | 'signal' | 'observe' | 'resolveModel' | 'includeProjectRules'> {
  store: Pick<ConversationExecutionServices['store'], 'readMessageRecord'>
  resolveModel(): Promise<ResolvedModelConfig>
  systemPrompt(model: ResolvedModelConfig): string
  tools(model: ResolvedModelConfig): readonly unknown[]
  requiresTools(): boolean | Promise<boolean>
  /** Root-run limit; the product supplies zero for subagents. */
  maxModelCalls: number
  simpleChat?: boolean
  review?: CodeReviewSnapshot
  attachments?: ConversationAttachmentProjector
  memory?: ReturnType<typeof createConversationMemoryProjector>
  rules?: ConversationRulesOptions
  supervision?: ConversationSupervisionOptions
  /** Present only for a saved manual-compression run intent. */
  manualCompression?: Pick<ConversationContextRuntime, 'compress'>
  subagentId?: string
}

/** Read full authoritative history, including the exact active summary body. */
export function conversationContextSource(state: Pick<ExecutionState, 'threadId' | 'messages' | 'context'>,
  store: Pick<ConversationExecutionServices['store'], 'readMessageRecord'>): ConversationContextSource {
  const summary = state.context.summary
  return { messages: state.messages.map(message => ({ ...message.value, id: message.id })),
    ...(summary ? { summary: { cutoffIndex: summary.cutoffIndex, message: store.readMessageRecord(state.threadId, summary.messageRecordId).value } } : {}),
    ...(state.context.projectRules ? { projectRules: state.context.projectRules } : {}) }
}

/** Assemble the business request once for each native attempt. Durable history,
 * context preparation and counters belong to the loop/store, never this service. */
export function createConversationModelPreparation(options: ConversationModelExecutionOptions): ConversationExecutionServices['prepareModel'] {
  return async (state, request, observer) => {
    if (state.threadId !== request.threadId || state.runId !== request.runId || state.phase !== 'prepare_model') {
      throw new Error('Model preparation does not own this conversation turn.')
    }
    const source = conversationContextSource(state, options.store)
    if (options.manualCompression) {
      return { kind: 'manual_summary', summary: await stageManualCompression(
        () => options.manualCompression!.compress(source, request.signal), options.compressionTracking) }
    }
    if (options.supervision) {
      const context = await reconcileConversationSupervision(state.context, source.messages, options.supervision)
      if (context) return { kind: 'context', context }
    }
    checkModelCallBudget(options.maxModelCalls, state.context.modelCalls)
    if (options.rules && options.rules.runId !== request.runId) throw new Error('Rule preparation belongs to another run.')
    if (options.rules && (state.context.rulePreparation?.runId !== request.runId || !state.context.rulePreparation.initialized)) {
      const prepared = await prepareConversationRules(state.context, { ...options.rules, signal: request.signal })
      return { kind: 'context', context: prepared.context }
    }
    const model = await options.resolveModel()
    request.signal.throwIfAborted()
    const included = new Set(effectiveConversationHistory(projectConversationToolImages(source.messages), source.summary)
      .flatMap(message => message.id ? [message.id] : []))
    let messages = options.attachments ? await options.attachments.project(source.messages, model.capabilities.vision, included) : source.messages
    let systemMessage: ConversationMessage = { kind: 'system', content: options.systemPrompt(model) }
    const tools = options.simpleChat ? [] : options.tools(model)
    const supervised = options.supervision ? await projectConversationSupervision(systemMessage, tools, options.supervision) : undefined
    if (supervised) systemMessage = supervised.systemMessage
    if (options.memory) systemMessage = await options.memory(systemMessage, messages)
    if (options.rules) systemMessage = conversationRuleSystemMessage(systemMessage, state.context, request.runId)
    if (options.simpleChat) messages = simpleConversationHistory(effectiveConversationHistory(messages, source.summary))
    const context = { messages, systemMessage, tools,
      requiresTools: await options.requiresTools() || supervised?.requiresTools === true, review: options.review,
      ...(!options.simpleChat && source.summary ? { summary: source.summary } : {}),
      ...(options.rules ? { projectRules: state.context.projectRules } : {}) }
    return { kind: 'model', invoke: async () => {
      const modelId = observer.startModel(options.subagentId)
      let streamedText = '', streamedReasoning = '', publishedProgress = false
      const progress = new ToolArgumentProgress(values => {
        if (!values.length && !publishedProgress) return
        publishedProgress = true
        observer.model({ kind: 'tool_input', modelId, subagentId: options.subagentId, progress: values })
      })
      try {
        const result = await invokeConversationWithCompression(model, context, {
          developerHttpTrace: options.developerHttpTrace, providerFetch: options.providerFetch,
          requestId: request.runId, requestRole: options.requestRole, streaming: options.streaming, timeoutMs: options.timeoutMs,
          runId: request.runId, signal: request.signal, resolveModel: options.resolveModel,
          outputLanguage: options.outputLanguage, codingMode: options.codingMode, compressionPrompt: options.compressionPrompt,
          includeProjectRules: Boolean(options.rules), enabled: options.simpleChat ? false : options.enabled,
          compressionTracking: options.compressionTracking, saveToolResult: options.saveToolResult,
          onRequest: options.onRequest,
          observe: event => {
            if (event.kind === 'tool_input') progress.accept(event.progress)
            else {
              if (event.channel === 'text') streamedText += event.text
              else streamedReasoning += event.text
              observer.model({ ...event, modelId, subagentId: options.subagentId })
            }
          }
        })
        if (result.message.invalidCalls?.length || conversationContentBlocks(result.message).some(block => block.type === 'invalid_tool_call')) {
          throw new Error('Model returned an invalid tool call.')
        }
        progress.flush()
        // Provider IDs may repeat across responses. Keep protocol metadata and
        // replay IDs intact while assigning application-owned durable identities.
        const id = randomUUID(), message = { ...result.message, id }
        const calls = (message.calls ?? []).map((call): ExecutionToolCall => ({ id: randomUUID(),
          providerCallId: call.id, name: call.name, args: call.args,
          artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, randomUUID()])) as ExecutionToolCall['artifacts'] }))
        observer.model({ kind: 'completed', modelId, subagentId: options.subagentId,
          message: presentConversationMessage({ ...message, calls: message.calls?.map((call, index) => ({ ...call, id: calls[index].id })) }, id),
          calls: calls.map(call => ({ id: call.id, name: call.name, args: call.args })),
          streamedText, streamedReasoning, usage: message.usage, responseMetadata: message.source?.metadata })
        return { message: { id, value: message }, calls, summary: result.summary,
          context: { ...state.context, modelCalls: state.context.modelCalls + 1, threadModelCalls: (state.context.threadModelCalls ?? 0) + 1 } }
      } catch (error) {
        observer.model({ kind: 'incomplete', modelId, subagentId: options.subagentId })
        throw error
      } finally {
        progress.dispose()
        if (publishedProgress) observer.model({ kind: 'tool_input', modelId, subagentId: options.subagentId, progress: [] })
      }
    } }
  }
}
