import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { ModelProtocol, ResolvedModelConfig } from '@shared/types'
import { modelContextKey } from '@shared/modelConfig'
import { conversationAnthropicInput, conversationChatInput, conversationContentBlocks, conversationResponsesInput } from '../../providers/conversationInput'
import { contentText } from '../../runtime/inputContent'
import { consumedToolImageIndices, isToolImageBlock, omittedToolImageText, type HistoryEntry } from '../../runtime/conversationHistory'
import { skillMessageParts } from '../../runtime/messagePresentation'
import { approximateContentTokens, modelParameterInputTokens, modelRequestKey, projectedModelInputHasImages,
  projectedModelInputTokens, type ModelInputBudgetOptions, type ProjectedModelInput } from '../../runtime/modelInputBudget'
import { latestModelUsageSnapshot } from '../../runtime/modelUsage'
import { ModelContextOverflowError, ModelSelectionError } from '../../runtime/errors'
import { modelToolDeclaration } from './modelToolDeclarations'

export function conversationHistoryFacts(messages: readonly ConversationMessage[]): HistoryEntry[] {
  return messages.map(message => ({ id: message.id,
    role: message.kind === 'user' || message.kind === 'assistant' || message.kind === 'tool' ? message.kind : 'other',
    summary: message.context?.summary === true,
    ...(message.kind === 'user' ? { userText: contentText(conversationContentBlocks(message)) } : {}),
    ...(message.kind === 'assistant' ? { calls: message.calls } : {}),
    ...(message.kind === 'tool' ? { resultFor: message.resultFor,
      images: Array.isArray(message.content) && message.content.some(isToolImageBlock) } : {}) }))
}

/** Request-only projection; durable message bodies and image artifacts remain. */
export function projectConversationToolImages(messages: readonly ConversationMessage[]): ConversationMessage[] {
  const consumed = new Set(consumedToolImageIndices(conversationHistoryFacts(messages)))
  return messages.map((message, index) => consumed.has(index) && Array.isArray(message.content)
    ? { ...message, content: message.content.map(block => isToolImageBlock(block) ? { type: 'text', text: omittedToolImageText } : block) }
    : message)
}

export function projectConversationSkills(messages: readonly ConversationMessage[]): ConversationMessage[] {
  return messages.flatMap((message): ConversationMessage[] => {
    if (message.kind !== 'user' || message.context?.reviewScope !== undefined) return [message]
    const parts = skillMessageParts(message.content, message.context?.displayText)
    if (!parts) return [message]
    const { displayText: _displayText, ...context } = message.context ?? {}
    return [{ ...message, content: parts.userContent, context },
      { id: message.id ? `${message.id}:skill` : undefined, kind: 'user', content: parts.skillContent, context: { skill: true } }]
  })
}

export function projectConversationInput(messages: readonly ConversationMessage[], protocol: ModelProtocol): ProjectedModelInput {
  if (protocol === 'openai_chat_completions') return { messages: conversationChatInput(messages) }
  if (protocol === 'openai_responses') return { messages: conversationResponsesInput(messages, { model: '', zeroRetention: false }) }
  return conversationAnthropicInput(messages)
}

export function countConversationTokens(messages: readonly ConversationMessage[], tools: readonly unknown[] = [], options: ModelInputBudgetOptions = {}): number {
  const characters = tools.reduce<number>((total, tool) => total + JSON.stringify(modelToolDeclaration(tool, options.protocol)).length, 0)
  const overhead = Math.ceil(characters / 4) + modelParameterInputTokens(options.protocol, options.parameters)
  if (options.protocol) return overhead + projectedModelInputTokens(projectConversationInput(messages, options.protocol))
  return overhead + messages.reduce((total, message) => total
    + approximateContentTokens(message.kind === 'assistant' ? conversationContentBlocks(message) : message.content)
    + (message.kind === 'tool' ? Math.ceil((message.resultFor ?? '').length / 4) : 0), 0)
}

export function conversationUsageSnapshot(messages: readonly ConversationMessage[], contextKey?: string) {
  return latestModelUsageSnapshot(messages.length, index => {
    const message = messages[index]
    return message.kind === 'assistant' ? { isResponse: true, renderedReport: message.context?.reviewReport !== undefined,
      modelContextKey: message.context?.modelContextKey, usage: message.usage } : { isResponse: false }
  }, contextKey)
}

interface ConversationContextRequest {
  messages: readonly ConversationMessage[]
  systemMessage?: ConversationMessage
  tools: readonly unknown[]
  protocol: ModelProtocol
}

export function conversationRequestKey(options: ConversationContextRequest): string {
  const messages = projectConversationSkills(options.messages)
  const input = projectConversationInput(options.systemMessage ? [options.systemMessage, ...messages] : messages, options.protocol)
  return modelRequestKey(input, options.tools.map(tool => modelToolDeclaration(tool, options.protocol)))
}

/** Calibrate only against the same provider prefix; hidden billed output does
 * not become input, and changed schemas, memory or images invalidate the floor. */
export function conversationContextTokens(options: ConversationContextRequest & {
  modelContextKey?: string
  parameters?: Record<string, unknown>
}): number {
  const messages = projectConversationSkills(projectConversationToolImages(options.messages))
  let snapshot = conversationUsageSnapshot(messages, options.modelContextKey)
  if (snapshot && messages[snapshot.messageIndex].context?.requestKey !== conversationRequestKey({
    ...options, messages: messages.slice(0, snapshot.messageIndex)
  })) snapshot = undefined
  const estimate = countConversationTokens(options.systemMessage ? [options.systemMessage, ...messages] : messages, options.tools, options)
  return snapshot ? Math.max(estimate, snapshot.usage.inputTokens + countConversationTokens(messages.slice(snapshot.messageIndex), [], { protocol: options.protocol })) : estimate
}

export function assertConversationSupported(model: ResolvedModelConfig, messages: readonly ConversationMessage[], requiresTools: boolean): void {
  if (!model.capabilities.toolUse && (requiresTools || messages.some(message => message.kind === 'tool' || message.kind === 'assistant' && message.calls?.length))) {
    throw new ModelSelectionError(`Model "${model.displayName || model.model}" does not support the tool context required by this conversation. The run was stopped. Select a model with tool use enabled and send again.`)
  }
  if (!model.capabilities.vision && projectedModelInputHasImages(projectConversationInput(messages, model.protocol))) {
    throw new ModelSelectionError(`Model "${model.displayName || model.model}" does not support the images required by this conversation. The run was stopped. Select a model with vision enabled and send again.`)
  }
}

export function assertConversationFits(model: ResolvedModelConfig, messages: readonly ConversationMessage[], tools: readonly unknown[]): void {
  const capacity = model.maxContextTokens - model.maxOutputTokens
  const tokens = conversationContextTokens({ messages, tools, modelContextKey: modelContextKey(model), protocol: model.protocol, parameters: model.parameters })
  if (tokens > capacity) throw new ModelContextOverflowError(`Model "${model.displayName || model.model}" has an input capacity of ${capacity} tokens, but the prepared conversation needs approximately ${tokens}. The run was stopped because the required context does not fit. Choose a larger context window or adjust compression and send again.`)
}
