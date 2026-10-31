import type { ResolvedModelConfig } from '@shared/types'
import { contextCompressionTriggerTokens, projectRuleInputBudget } from '@shared/contextWindow'
import { modelContextKey } from '@shared/modelConfig'
import { summaryPromptForLanguage, type SummaryOutputLanguage } from '@shared/summaryPrompt'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { compactLatestToolResults } from '../../runtime/conversationHistory'
import { prepareCompression, stageCompressionSummary, type CompressionTrackingCallbacks, type ManualContextCompression } from '../../runtime/compression'
import { isModelContextOverflow, ModelRequestChangedError, ModelSelectionError } from '../../runtime/errors'
import type { ObserveConversationProgress } from '../../providers/conversationStream'
import { createCompressionModel } from './compressionModel'
import { conversationContextTokens, conversationHistoryFacts, countConversationTokens, projectConversationToolImages } from './conversationContext'
import { conversationSummaryTranscript, effectiveConversationHistory, projectConversationToolHistory, selectConversationRetention,
  type ConversationSummary } from './conversationHistoryProjection'
import { prepareConversationModelCall, type PreparedConversationContext } from './conversationRequest'
import type { ConversationModelOptions } from './conversationModel'
import { codeReviewToolDeclaration } from '../../runtime/codeReviewReport'
import { withResponseTools } from './modelToolDeclarations'
import { projectRulesRequestBudget } from './projectRules'
import { modelRecoveryFeedback } from '../../runtime/modelOutputRecovery'

type Summary = ManualContextCompression & { id: string }
class PreservedContextOverflowError extends ModelSelectionError {
  constructor() {
    super('The latest complete conversation unit still exceeds the model context window after compacting its tool results. The unit was not removed.')
    this.name = 'PreservedContextOverflowError'
  }
}

export interface ConversationCompressionOptions extends ConversationModelOptions {
  runId: string
  signal: AbortSignal
  resolveModel(): Promise<ResolvedModelConfig>
  outputLanguage: SummaryOutputLanguage
  codingMode?: boolean
  compressionPrompt?: string
  includeProjectRules?: boolean
  enabled?: boolean
  compressionTracking: CompressionTrackingCallbacks
  saveToolResult(content: string): Promise<string>
  observe?: ObserveConversationProgress
  onRequest?(model: ResolvedModelConfig, context: Pick<PreparedConversationContext, 'messages' | 'systemMessage' | 'tools'>): void
}

/** One native model attempt with optional summary preparation. The returned
 * summary and complete response must be accepted in the same store transaction.
 * Original history and tool results are never replaced by request projections. */
export async function invokeConversationWithCompression(model: ResolvedModelConfig,
  context: PreparedConversationContext & { summary?: ConversationSummary }, options: ConversationCompressionOptions) {
  const raw = projectConversationToolImages([...context.messages])
  const effective = effectiveConversationHistory(raw, context.summary)
  const messages = projectConversationToolHistory(effective)
  const tools = withResponseTools(context.tools, context.review ? [codeReviewToolDeclaration(context.review.id)] : [])
  const inputCapacityTokens = model.maxContextTokens - model.maxOutputTokens
  const trigger = contextCompressionTriggerTokens(model.maxContextTokens, model.maxOutputTokens, model.contextCompressionThreshold)
  const threshold = options.includeProjectRules ? Math.min(trigger, projectRuleInputBudget(inputCapacityTokens)) : trigger
  const invoke = async (messages: ConversationMessage[]) => {
    const request = await prepareConversationModelCall(model, { ...context, messages, tools }, options)
    options.onRequest?.(model, { messages: request.messages, systemMessage: request.systemMessage, tools: request.tools })
    return request.invoke(options.observe)
  }
  if (!(options.enabled ?? model.contextCompressionEnabled) || !effective.length) return { ...await invoke(messages), summary: undefined as Summary | undefined }
  const selection = selectConversationRetention(effective, raw, threshold,
    messages => countConversationTokens(messages, [], { protocol: model.protocol }))
  const feedback = modelRecoveryFeedback(context.modelRecovery)
  const currentTokens = conversationContextTokens({ messages: [...messages, ...feedback], tools, systemMessage: context.systemMessage,
    modelContextKey: modelContextKey(model), protocol: model.protocol, parameters: model.parameters })
  if (currentTokens < threshold) {
    try { return { ...await invoke(messages), summary: undefined as Summary | undefined } } catch (error) {
      if (!isModelContextOverflow(error) || selection.cutoffIndex <= 0) throw error
    }
  } else if (selection.cutoffIndex <= 0) return { ...await invoke(messages), summary: undefined as Summary | undefined }

  return prepareCompression({ activeUserRequest: selection.activeUserRequest,
    inputCapacityTokens: Math.max(1, inputCapacityTokens - 256), tokenCountingOptions: { protocol: model.protocol, parameters: model.parameters } }, async preparation => {
    const generate = createCompressionModel(model, {
      retry: false,
      developerHttpTrace: options.developerHttpTrace, providerFetch: options.providerFetch,
      compressionTracking: options.compressionTracking, signal: options.signal, requestId: options.runId,
      requestRole: `${options.requestRole ?? 'main'}-compression`,
      beforeRequest: async () => { if (JSON.stringify(model) !== JSON.stringify(await options.resolveModel())) throw new ModelRequestChangedError() }
    })
    const prompt = summaryPromptForLanguage(options.outputLanguage, options.codingMode === true, options.compressionPrompt)
      .replace('{conversation}', conversationSummaryTranscript(effective.slice(0, selection.cutoffIndex)))
    const generated = await generate(prompt, options.signal, preparation)
    options.signal.throwIfAborted()
    if (!generated.text.trim()) throw new ModelSelectionError('Context compression returned an empty summary. The current history has not been replaced.')
    const tracked = preparation.generated.filter(summary => summary.state === 'pending').at(-1)
    if (!tracked?.id) throw new Error('Automatic context compression requires durable summary tracking.')
    const summaryMessage: ConversationMessage = { kind: 'user', content: `Here is a summary of the conversation to date:\n\n${generated.text}`,
      context: { summary: true, summaryId: tracked.id } }
    const firstPreserved = effective[selection.cutoffIndex]
    const cutoffIndex = firstPreserved ? raw.findIndex(message => message === firstPreserved || Boolean(message.id && message.id === firstPreserved.id)) : raw.length
    if (cutoffIndex < 0) throw new Error('The prepared summary boundary does not match the conversation history.')
    let finalMessages = projectConversationToolHistory([summaryMessage, ...effective.slice(selection.cutoffIndex)])
    let result: Awaited<ReturnType<typeof invoke>>
    try { result = await invoke(finalMessages) } catch (error) {
      const ruleBudget = projectRulesRequestBudget(error)
      if (ruleBudget === undefined && !isModelContextOverflow(error)) throw error
      const facts = conversationHistoryFacts(finalMessages).map((fact, index) => ({ ...fact, content: finalMessages[index].content }))
      const replacements = await compactLatestToolResults(facts, ruleBudget ?? inputCapacityTokens, indices =>
        countConversationTokens([context.systemMessage, ...finalMessages.map((message, index) => indices.includes(index) ? { ...message, content: '' } : message), ...feedback],
          tools, { protocol: model.protocol, parameters: model.parameters }), options.saveToolResult)
      if (!replacements.length) throw ruleBudget === undefined ? new PreservedContextOverflowError() : error
      finalMessages = [...finalMessages]
      for (const { index, content } of replacements) finalMessages[index] = { ...finalMessages[index], content }
      try { result = await invoke(finalMessages) } catch (retryError) {
        if (isModelContextOverflow(retryError)) throw new PreservedContextOverflowError()
        throw retryError
      }
    }
    const summary: Summary = { id: tracked.id, summaryText: generated.text, modelContent: String(summaryMessage.content), cutoffIndex,
      activatedAfterMessageIndex: Math.max(0, cutoffIndex - 1), coveredThroughMessageId: raw[cutoffIndex - 1]?.id,
      firstPreservedMessageId: raw[cutoffIndex]?.id,
      inputTokensBefore: countConversationTokens([context.systemMessage, ...effective], tools, { protocol: model.protocol, parameters: model.parameters }),
      inputTokensAfter: countConversationTokens([context.systemMessage, ...finalMessages], tools, { protocol: model.protocol, parameters: model.parameters }) }
    stageCompressionSummary(preparation.generated, () => {
      const { id: _id, summaryText: _text, ...completion } = summary
      return completion
    })
    return { ...result, summary }
  })
}
