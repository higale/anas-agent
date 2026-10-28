import { modelParameterInputTokens } from '../../runtime/modelInputBudget'
import type { ManualContextCompression } from '../../runtime/compression'
import { observeModelRetry } from './modelRetryLogging'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { AgentContextStatus } from '@shared/agentTypes'
import { contextCompressionTriggerTokens, projectRuleInputBudget } from '@shared/contextWindow'
import { modelContextKey } from '@shared/modelConfig'
import type { ModelProtocol, ResolvedModelConfig } from '@shared/types'
import { createCompressionModel } from './compressionModel'
import { ModelSelectionError, isModelRequestChangedError, ModelRequestChangedError } from '../../runtime/errors'
import { invokeModelWithRetry } from '../../runtime/modelRetry'
import type {
  AgentSystemPrompt,
  AgentSystemPromptSectionKind
} from './systemPrompt'
import {
  summaryPromptForLanguage,
  type SummaryOutputLanguage
} from '@shared/summaryPrompt'
import { countConversationTokens, conversationContextTokens, conversationUsageSnapshot, projectConversationToolImages } from './conversationContext'
import type { ModelInputBudgetOptions } from '../../runtime/modelInputBudget'
import { projectRulesText, type ProjectRulesSnapshot } from '../../runtime/projectRules'
import { conversationSummaryTranscript, conversationPendingImageStart, effectiveConversationHistory, projectConversationToolHistory, type ConversationSummary } from './conversationHistoryProjection'

export interface ConversationContextSource {
  messages: ConversationMessage[]
  summary?: ConversationSummary
  projectRules?: ProjectRulesSnapshot
}
export interface ConversationContextRuntime {
  status(source: ConversationContextSource): Promise<AgentContextStatus>
  projectedStatus(source: ConversationContextSource): Promise<AgentContextStatus>
  statusFromMessages(messages: ConversationMessage[], model: ResolvedModelConfig, request?: ConversationContextRequest): AgentContextStatus
  compress(source: ConversationContextSource, signal: AbortSignal): Promise<ManualContextCompression>
}
export interface ConversationContextRequest {
  systemMessage: ConversationMessage
  tools: unknown[]
}
function stateMessages(source: ConversationContextSource): ConversationMessage[] { return source.messages }
function summarizationEvent(source: ConversationContextSource): ConversationSummary | undefined { return source.summary }
function effectiveMessages(source: ConversationContextSource): ConversationMessage[] {
  return effectiveConversationHistory(projectConversationToolImages(source.messages), source.summary)
}

/** Recall runs before summarization; retain its raw query with current attachment projections. */
function requestSourceMessages(rawMessages: ConversationMessage[], projectedMessages: ConversationMessage[]): ConversationMessage[] {
  const projectedById = new Map(projectedMessages.flatMap((message) => message.id ? [[message.id, message] as const] : []))
  return rawMessages.map((message) => message.id ? projectedById.get(message.id) ?? message : message)
}

function approximateTokens(
  messages: ConversationMessage[],
  tools?: unknown[],
  protocol?: ModelProtocol
): number {
  return countConversationTokens(
    messages,
    tools ?? [],
    { protocol }
  )
}

function hasRawSummarySource(messages: ConversationMessage[]): boolean {
  return messages.some((message) =>
    message.context?.summary !== true
  )
}

function summaryInputPrompt(
  messages: ConversationMessage[],
  outputLanguage: SummaryOutputLanguage,
  codingMode: boolean,
  compressionPrompt?: string
): string {
  return summaryPromptForLanguage(outputLanguage, codingMode, compressionPrompt)
    .replace('{conversation}', conversationSummaryTranscript(messages))
}

async function messagesForSummary(
  messages: ConversationMessage[],
  inputTokenLimit: number,
  outputLanguage: SummaryOutputLanguage,
  codingMode: boolean,
  tokenCountingOptions: ModelInputBudgetOptions,
  compressionPrompt?: string
): Promise<ConversationMessage[]> {
  const promptTokens = (items: ConversationMessage[]): number => countConversationTokens([
    { kind: 'user', content: summaryInputPrompt(items, outputLanguage, codingMode, compressionPrompt) }
  ], [], tokenCountingOptions)
  if (promptTokens(messages) <= inputTokenLimit) return messages
  throw new ModelSelectionError('The complete history cannot be summarized within this model’s input capacity without dropping source context. Choose a larger-context model; the current history has not been replaced.')
}

export function createConversationContextRuntime(options: {
  codingMode?: boolean
  compressionPrompt?: string
  developerHttpTrace?: boolean
  providerFetch?: typeof fetch
  resolveModel: () => Promise<ResolvedModelConfig>
  outputLanguage: SummaryOutputLanguage
  requestId?: string
  systemPrompt: (model: ResolvedModelConfig) => string | AgentSystemPrompt
  includeProjectRules?: boolean
  tools: (model: ResolvedModelConfig) => unknown[]
  projectHistory?: (messages: ConversationMessage[]) => ConversationMessage[]
  projectMessages?: (messages: ConversationMessage[], model: ResolvedModelConfig) => Promise<ConversationMessage[]>
  projectSystemMessage?: (systemMessage: ConversationMessage, messages: ConversationMessage[]) => Promise<ConversationMessage>
}): ConversationContextRuntime {
  const { outputLanguage, projectMessages } = options
  const projectHistory = (messages: ConversationMessage[]): ConversationMessage[] => projectConversationToolHistory(options.projectHistory?.(messages) ?? messages)

  function calculateStatus(
    messages: ConversationMessage[],
    model: ResolvedModelConfig,
    compressionApplied = messages.some((message) =>
      message.context?.summary === true
    ),
    request?: ConversationContextRequest
  ): AgentContextStatus {
    messages = projectConversationToolImages(messages)
    const tools = request?.tools ?? options.tools(model)
    const systemPrompt = systemPromptValue(options.systemPrompt(model))
    const baseSystemMessage: ConversationMessage = { kind: 'system', content: systemPrompt.text }
    const systemMessage = request?.systemMessage ?? baseSystemMessage
    const systemTokenTotal = approximateTokens([systemMessage]) + modelParameterInputTokens(model.protocol, model.parameters)
    const baseSystemTokenTotal = Math.min(systemTokenTotal, approximateTokens([baseSystemMessage]))
    const systemTokens = allocatedSystemTokens(systemPrompt, baseSystemTokenTotal)
    // Request preparation can add rules, recalled memory, or model instructions.
    // Count their real projection instead of losing it from the local estimate.
    systemTokens.system_instruction += systemTokenTotal - baseSystemTokenTotal
    const inputCapacityTokens = model.maxContextTokens - model.maxOutputTokens
    const requestedCompressionThresholdTokens = contextCompressionTriggerTokens(
      model.maxContextTokens,
      model.maxOutputTokens,
      model.contextCompressionThreshold
    )
    const compressionThresholdTokens = options.includeProjectRules
      ? Math.min(requestedCompressionThresholdTokens, projectRuleInputBudget(inputCapacityTokens))
      : requestedCompressionThresholdTokens
    const key = modelContextKey(model)
    const toolDefinitionTokens = approximateTokens([], tools)
    const messageTokens = approximateTokens(messages, undefined, model.protocol)
    return {
      runId: options.requestId,
      modelConfigId: model.id,
      modelContextKey: key,
      includeProjectRules: options.includeProjectRules === true,
      estimatedInputTokens: systemTokenTotal + toolDefinitionTokens + messageTokens,
      currentContextTokens: conversationContextTokens({ messages, systemMessage, tools, modelContextKey: key, protocol: model.protocol, parameters: model.parameters }),
      serverUsage: conversationUsageSnapshot(messages, key)?.usage,
      maxContextTokens: model.maxContextTokens,
      maxOutputTokens: model.maxOutputTokens,
      inputCapacityTokens,
      compressionEnabled: model.contextCompressionEnabled,
      compressionThreshold: model.contextCompressionThreshold,
      compressionThresholdTokens,
      compressionApplied,
      manualCompressionAvailable: hasRawSummarySource(messages),
      breakdown: {
        profileTokens: systemTokens.profile,
        systemInstructionTokens: systemTokens.system_instruction + systemTokens.project_instruction + systemTokens.coding_instruction + systemTokens.plugin_instruction,
        runtimeContextTokens: systemTokens.runtime_context,
        workspaceTokens: systemTokens.workspace,
        memoryTokens: systemTokens.memory,
        skillTokens: systemTokens.skills,
        toolDefinitionTokens,
        messageTokens,
        attachmentTokens: 0
      }
    }
  }

  function statusFromMessages(messages: ConversationMessage[], model: ResolvedModelConfig, request?: ConversationContextRequest): AgentContextStatus {
    return calculateStatus(messages, model, undefined, request)
  }

  function statusWithModel(values: ConversationContextSource, model: ResolvedModelConfig): AgentContextStatus {
    return calculateStatus(
      projectHistory(effectiveMessages(values)),
      model,
      Boolean(summarizationEvent(values)),
      requestWithRules(values, model)
    )
  }

  async function status(values: ConversationContextSource): Promise<AgentContextStatus> {
    return statusWithModel(values, await options.resolveModel())
  }

  function requestWithRules(values: ConversationContextSource, model: ResolvedModelConfig,
    systemMessage: ConversationMessage = { kind: 'system', content: systemPromptValue(options.systemPrompt(model)).text }): ConversationContextRequest {
    const rules = options.includeProjectRules && values.projectRules ? projectRulesText(values.projectRules) : ''
    return { systemMessage: rules ? { ...systemMessage, content: typeof systemMessage.content === 'string'
      ? `${systemMessage.content}\n\n${rules}` : [...systemMessage.content, { type: 'text', text: `\n\n${rules}` }] } : systemMessage, tools: options.tools(model) }
  }

  async function projectedRequest(values: ConversationContextSource, messages: ConversationMessage[], model: ResolvedModelConfig): Promise<ConversationContextRequest> {
    let systemMessage: ConversationMessage = { kind: 'system', content: systemPromptValue(options.systemPrompt(model)).text }
    if (options.projectSystemMessage) systemMessage = await options.projectSystemMessage(systemMessage, messages)
    return requestWithRules(values, model, systemMessage)
  }

  async function projectedStatusWithModel(values: ConversationContextSource, model: ResolvedModelConfig): Promise<AgentContextStatus> {
    const messages = projectHistory(effectiveMessages(values))
    if (!projectMessages && !options.projectSystemMessage) return statusWithModel(values, model)
    const projectedMessages = projectMessages ? await projectMessages(messages, model) : messages
    const request = await projectedRequest(values, requestSourceMessages(stateMessages(values), projectedMessages), model)
    const projected = calculateStatus(
      projectedMessages,
      model,
      Boolean(summarizationEvent(values)),
      request
    )
    const raw = calculateStatus(
      messages,
      model,
      Boolean(summarizationEvent(values)),
      request
    )
    projected.breakdown.attachmentTokens = Math.max(
      0,
      projected.breakdown.messageTokens - raw.breakdown.messageTokens
    )
    projected.breakdown.messageTokens = raw.breakdown.messageTokens
    return projected
  }

  async function projectedStatus(values: ConversationContextSource): Promise<AgentContextStatus> {
    return projectedStatusWithModel(values, await options.resolveModel())
  }

  async function compressAttempt(
    values: ConversationContextSource,
    signal: AbortSignal
  ): Promise<ManualContextCompression> {
    const model = await options.resolveModel()
    const validateRequestModel = async (): Promise<void> => {
      if (JSON.stringify(model) !== JSON.stringify(await options.resolveModel())) {
        throw new ModelRequestChangedError()
      }
    }
    const summaryInputTokenLimit = Math.max(1, model.maxContextTokens - model.maxOutputTokens - 256)
    const rawMessages = stateMessages(values)
    const previousEvent = summarizationEvent(values)
    const messages = effectiveMessages(values)
    if (messages.length === 0) {
      throw new Error('There is no conversation history to compress.')
    }

    if (!hasRawSummarySource(messages)) {
      throw new Error('There is no new conversation history to compress.')
    }
    const effectiveCutoffIndex = conversationPendingImageStart(messages) ?? messages.length
    if (!hasRawSummarySource(messages.slice(0, effectiveCutoffIndex))) {
      throw new Error('There is no history to compress before the pending tool images. Let the model process them first.')
    }

    // Cutoffs always address persisted conversation messages; request-only filtering
    // must happen after selecting the source range, including for plain chats.
    const history = projectHistory(messages.slice(0, effectiveCutoffIndex))
    const projectedMessages = projectMessages
      ? await projectMessages(history, model)
      : history
    await validateRequestModel()
    const sourceMessages = await messagesForSummary(
      projectedMessages,
      summaryInputTokenLimit,
      outputLanguage,
      options.codingMode === true,
      { protocol: model.protocol, parameters: model.parameters },
      options.compressionPrompt
    )
    if (sourceMessages.length === 0) {
      throw new Error('There is no conversation history eligible for compression.')
    }

    const prompt = summaryInputPrompt(sourceMessages, outputLanguage, options.codingMode === true, options.compressionPrompt)
    const response = await createCompressionModel(model, {
      beforeRequest: validateRequestModel,
      developerHttpTrace: options.developerHttpTrace,
      providerFetch: options.providerFetch,
      requestId: options.requestId,
      requestRole: 'manual-compression',
      signal
    })(prompt, signal)
    const visibleText = response.text.trim()
    if (!visibleText) throw new Error('Context compression returned an empty summary.')

    const modelContent = `Here is a summary of the conversation to date:\n\n${visibleText}`
    const summaryMessage: ConversationMessage = { kind: 'user', content: modelContent, context: { summary: true } }
    const cutoffIndex = previousEvent
      ? previousEvent.cutoffIndex + effectiveCutoffIndex - 1
      : effectiveCutoffIndex
    const afterMessages = projectHistory(projectConversationToolImages([summaryMessage, ...rawMessages.slice(cutoffIndex)]))
    const projectedAfterMessages = projectMessages
      ? await projectMessages(afterMessages, model)
      : afterMessages
    const afterStatus = statusFromMessages(projectedAfterMessages, model,
      await projectedRequest(values, requestSourceMessages(rawMessages, [...projectedMessages, ...projectedAfterMessages]), model))
    const inputLimit = options.includeProjectRules
      ? projectRuleInputBudget(afterStatus.inputCapacityTokens)
      : afterStatus.inputCapacityTokens
    if (afterStatus.estimatedInputTokens > inputLimit) {
      throw new ModelSelectionError('The compressed conversation and required instructions still exceed the selected model’s input capacity. Choose a larger-context model; the current history has not been replaced.')
    }

    return {
      summaryText: visibleText,
      modelContent,
      cutoffIndex,
      activatedAfterMessageIndex: rawMessages.length - 1,
      coveredThroughMessageId: rawMessages[cutoffIndex - 1]?.id,
      firstPreservedMessageId: rawMessages[cutoffIndex]?.id,
      inputTokensBefore: (await projectedStatusWithModel(values, model)).estimatedInputTokens,
      inputTokensAfter: afterStatus.estimatedInputTokens
    }
  }

  function compress(values: ConversationContextSource, signal: AbortSignal): Promise<ManualContextCompression> {
    return invokeModelWithRetry(() => compressAttempt(values, signal), {
      signal,
      onRetry: observeModelRetry(options.requestId),
      initialDelayMs: 0,
      retryWhen: isModelRequestChangedError
    })
  }

  return { status, projectedStatus, statusFromMessages, compress }
}

function systemPromptValue(
  prompt: string | AgentSystemPrompt
): AgentSystemPrompt {
  return typeof prompt === 'string'
    ? {
        text: prompt,
        sections: prompt.trim()
          ? [{ kind: 'system_instruction', content: prompt.trim() }]
          : []
      }
    : prompt
}

function allocatedSystemTokens(
  prompt: AgentSystemPrompt,
  total: number
): Record<AgentSystemPromptSectionKind, number> {
  const kinds: AgentSystemPromptSectionKind[] = [
    'profile',
    'system_instruction',
    'project_instruction',
    'coding_instruction',
    'runtime_context',
    'workspace',
    'memory',
    'skills',
    'plugin_instruction'
  ]
  const weights = Object.fromEntries(kinds.map((kind) => [kind, 0])) as
    Record<AgentSystemPromptSectionKind, number>
  for (const section of prompt.sections) {
    weights[section.kind] += Math.max(
      1,
      approximateTokens([{ kind: 'system', content: section.content }])
    )
  }
  const weightTotal = Object.values(weights).reduce((sum, value) => sum + value, 0)
  if (weightTotal === 0 || total === 0) return { ...weights, system_instruction: total }
  const allocations = Object.fromEntries(kinds.map((kind) => [
    kind,
    Math.floor(total * weights[kind] / weightTotal)
  ])) as Record<AgentSystemPromptSectionKind, number>
  let remainder = total - Object.values(allocations).reduce((sum, value) => sum + value, 0)
  for (const kind of [...kinds].sort((left, right) => weights[right] - weights[left])) {
    if (remainder <= 0) break
    if (weights[kind] <= 0) continue
    allocations[kind] += 1
    remainder -= 1
  }
  return allocations
}
