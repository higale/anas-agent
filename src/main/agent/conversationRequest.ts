import type { ResolvedModelConfig } from '@shared/types'
import type { CodeReviewSnapshot } from '@shared/codeReview'
import { modelContextKey } from '@shared/modelConfig'
import { projectRuleInputBudget } from '@shared/contextWindow'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { contentText } from '../../runtime/inputContent'
import { codeReviewToolDeclaration } from '../../runtime/codeReviewReport'
import { ModelRequestChangedError, ModelSelectionError, ProjectRulesError, ProjectRulesRequestBudgetError } from '../../runtime/errors'
import { projectRulesText, ruleScopeIds, type ProjectRulesSnapshot } from '../../runtime/projectRules'
import { conversationContentBlocks } from '../../providers/conversationInput'
import { createConversationModel, type ConversationModelOptions } from './conversationModel'
import type { ObserveConversationProgress } from '../../providers/conversationStream'
import { assertConversationFits, assertConversationSupported, conversationRequestKey, countConversationTokens, projectConversationSkills } from './conversationContext'
import { codeReviewPrompt } from './codeReview'
import { withResponseTools } from './modelToolDeclarations'

export interface PreparedConversationContext {
  /** Context services already applied memory, attachments, rules and summaries. */
  messages: readonly ConversationMessage[]
  systemMessage: ConversationMessage
  tools: readonly unknown[]
  requiresTools: boolean
  review?: CodeReviewSnapshot
  projectRules?: ProjectRulesSnapshot
}

/** Finalize the actual provider request after asynchronous context preparation.
 * No retry or durable state lives here; each loop retry prepares a fresh call. */
export async function prepareConversationModelCall(model: ResolvedModelConfig, context: PreparedConversationContext,
  options: ConversationModelOptions & {
    runId: string
    signal: AbortSignal
    resolveModel(): Promise<ResolvedModelConfig>
    now?: () => string
  }) {
  options.signal.throwIfAborted()
  let messages = [...context.messages]
  const tools = withResponseTools(context.tools, context.review ? [codeReviewToolDeclaration(context.review.id)] : [])
  if (context.review) {
    const prompt = codeReviewPrompt(context.review)
    const scope: ConversationMessage = { kind: 'user', content: prompt }
    if (countConversationTokens([context.systemMessage, scope], tools, { protocol: model.protocol, parameters: model.parameters })
      > (model.maxContextTokens - model.maxOutputTokens) * 0.6) {
      throw new ModelSelectionError('The captured review is too large for this model. The run was stopped. Select a smaller review scope or a larger-context model.')
    }
    if (!messages.some(message => message.kind === 'user' && contentText(conversationContentBlocks(message)) === prompt)) messages.push(scope)
  }
  messages = projectConversationSkills(messages)
  let systemMessage = context.systemMessage
  const systemText = contentText(conversationContentBlocks(systemMessage))
  const cacheControl = model.protocol === 'anthropic_messages' && (messages.length || systemText)
    ? model.parameters.cache_control !== undefined ? model.parameters.cache_control : { type: 'ephemeral', ttl: '5m' }
    : undefined
  if (model.protocol === 'anthropic_messages' && systemText.trim()) {
    const content = typeof systemMessage.content === 'string' ? [{ type: 'text', text: systemMessage.content }] : [...systemMessage.content]
    if (content.length) content[content.length - 1] = { ...(content[content.length - 1] as Record<string, unknown>), cache_control: { type: 'ephemeral' } }
    systemMessage = { ...systemMessage, content }
  }
  const input = [systemMessage, ...messages]
  let rulesReceipt: { runId: string; scopes: string[]; minimumTokens: number; budget: number } | undefined
  if (context.projectRules) {
    const snapshot = context.projectRules, text = projectRulesText(snapshot)
    if (snapshot.runId !== options.runId || snapshot.fatalError) throw new ProjectRulesError(snapshot.fatalError || 'The rule snapshot belongs to another run.')
    if (text && !systemText.includes(text)) throw new ProjectRulesError('Complete project rules were removed from the final model request.')
    let end = messages.length - 1
    while (end >= 0 && messages[end].kind !== 'user') end--
    let start = end
    while (start > 0 && messages[start].context?.skill === true && messages[start - 1].kind === 'user') start--
    const task = end < 0 ? [] : messages.slice(start, end + 1)
    const counting = { protocol: model.protocol, parameters: model.parameters }
    const budget = projectRuleInputBudget(model.maxContextTokens - model.maxOutputTokens)
    const minimum = countConversationTokens([systemMessage, ...task], tools, counting)
    if (minimum > budget) throw new ProjectRulesError(`Rules for ${snapshot.activeScopes.join(', ')} plus system instructions, tools and required task context need about ${minimum} input tokens; safe capacity is ${budget}.`)
    const total = countConversationTokens(input, tools, counting)
    if (total > budget) throw new ProjectRulesRequestBudgetError(total, budget)
    const withoutRules = text ? systemText.replace(`\n\n${text}`, '') : systemText
    rulesReceipt = { runId: options.runId, scopes: ruleScopeIds(snapshot), budget,
      minimumTokens: countConversationTokens([{ kind: 'system', content: withoutRules }, ...task], tools, counting) }
  }
  assertConversationSupported(model, input, context.requiresTools || Boolean(context.review))
  assertConversationFits(model, input, tools)
  const selection = JSON.stringify(model)
  if (selection !== JSON.stringify(await options.resolveModel())) throw new ModelRequestChangedError()
  options.signal.throwIfAborted()
  const requestKey = conversationRequestKey({ messages, systemMessage, tools, protocol: model.protocol })
  const connection = createConversationModel(model, { ...options, requestId: options.requestId ?? options.runId })
  return { requestKey, systemMessage, messages, tools, async invoke(observe?: ObserveConversationProgress) {
    // The returned call can wait behind other preparation. Check selection at
    // dispatch as well; never discard a response because settings changed later.
    if (selection !== JSON.stringify(await options.resolveModel())) throw new ModelRequestChangedError()
    options.signal.throwIfAborted()
    const result = await connection.invoke({ messages: input, tools, signal: options.signal, observe,
      ...(context.review ? { toolChoice: 'required' } : {}), cacheControl })
    if (context.review && !result.message.calls?.length) {
      throw new Error('The model ended the review without the required structured report. No completed review is available.')
    }
    return { ...result, message: { ...result.message, context: { ...result.message.context,
      ...(rulesReceipt ? { projectRulesReceipt: rulesReceipt } : {}),
      modelContextKey: modelContextKey(model), requestKey, runId: options.runId, createdAt: (options.now ?? (() => new Date().toISOString()))() } } }
  } }
}
