import type { ResolvedModelConfig } from '@shared/types'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { ModelSelectionError } from '../../runtime/errors'
import { OpenAiChatCompletions } from '../../providers/openAiChatCompletions'
import { OpenAiResponses } from '../../providers/openAiResponses'
import { AnthropicMessages } from '../../providers/anthropicMessages'
import { openAiModelParameters, anthropicModelParameters } from '../../providers/modelParameters'
import { openAiChatParameters, openAiResponsesParameters } from '../../providers/openAiParameters'
import { anthropicRequestParameters } from '../../providers/anthropicParameters'
import { conversationAnthropicInput, conversationChatInput, conversationResponsesInput } from '../../providers/conversationInput'
import { anthropicConversationResponse, openAiChatConversationResponses, openAiResponsesConversationResponse,
  type ConversationResponse } from '../../providers/conversationOutput'
import { streamAnthropicConversation, streamChatConversation, streamResponsesConversation, type ObserveConversationProgress } from '../../providers/conversationStream'
import { prepareModelConnection, type ModelConnectionOptions } from './modelConnection'
import { modelToolDeclaration } from './modelToolDeclarations'

export interface ConversationModelOptions extends ModelConnectionOptions {
  streaming?: boolean
  timeoutMs?: number
}
export interface ConversationModelRequest {
  messages: readonly ConversationMessage[]
  /** The prepared, budgeted list includes host, response and provider tools. */
  tools: readonly unknown[]
  toolChoice?: string | Record<string, unknown>
  cacheControl?: unknown
  signal: AbortSignal
  observe?: ObserveConversationProgress
}
export interface ConversationModel {
  invoke(request: ConversationModelRequest): Promise<ConversationResponse & { observationErrors: unknown[] }>
}

/** One prepared model request. The application loop owns selection, retries,
 * budgets and durable results; this service never dispatches tools or saves state. */
export function createConversationModel(config: ResolvedModelConfig, options: ConversationModelOptions = {}): ConversationModel {
  try {
    const { protocol, model, apiKey, parameters, providerFetch } = prepareModelConnection(config, options)
    const streaming = options.streaming ?? config.stream
    const maxOutputTokens = config.maxOutputTokens > 0 ? config.maxOutputTokens : undefined
    const client = { apiKey, fetch: providerFetch, ...(options.timeoutMs ? { timeout: options.timeoutMs } : {}) }
    let invoke: (request: ConversationModelRequest, observe: ObserveConversationProgress) => Promise<ConversationResponse>
    if (protocol === 'anthropic_messages') {
      const settings = { model, maxOutputTokens, streaming, parameters: anthropicModelParameters(parameters) }
      anthropicRequestParameters(settings)
      const provider = new AnthropicMessages({ ...client,
        baseURL: config.baseUrl || process.env.ANTHROPIC_API_URL || process.env.ANTHROPIC_BASE_URL })
      invoke = async (request, observe) => {
        const body = { ...anthropicRequestParameters(settings, { tools: request.tools.map(tool => modelToolDeclaration(tool, protocol)),
          toolChoice: request.toolChoice, cacheControl: request.cacheControl }),
          ...conversationAnthropicInput(request.messages) }
        return streaming ? streamAnthropicConversation(await provider.openStream(body, { signal: request.signal }), observe)
          : anthropicConversationResponse(await provider.complete(body, { signal: request.signal }))
      }
    } else {
      const { tools: _tools, ...kwargs } = openAiModelParameters(parameters)
      const settings = { model, maxOutputTokens, streaming, parameters: kwargs, protocol: protocol === 'openai_responses' ? 'responses' as const : 'chat' as const }
      const connection = { ...client, baseURL: config.baseUrl || process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL }
      if (protocol === 'openai_responses') {
        const provider = new OpenAiResponses(connection)
        invoke = async (request, observe) => {
          const body = { ...openAiResponsesParameters(settings, { tools: request.tools.map(tool => modelToolDeclaration(tool, protocol)), tool_choice: request.toolChoice }),
            input: conversationResponsesInput(request.messages, { model, zeroRetention: false }) }
          return streaming ? streamResponsesConversation(provider.stream(body, { signal: request.signal }), observe)
            : openAiResponsesConversationResponse(await provider.complete(body, { signal: request.signal }))
        }
      } else {
        const provider = new OpenAiChatCompletions(connection)
        invoke = async (request, observe) => {
          const body = { ...openAiChatParameters(settings, { tools: request.tools.map(tool => modelToolDeclaration(tool, protocol)), tool_choice: request.toolChoice }),
            messages: conversationChatInput(request.messages, model) }
          if (streaming) return streamChatConversation(provider.stream(body, { signal: request.signal }), observe)
          const response = await provider.complete(body, { signal: request.signal })
          const primary = response.choices.findIndex(choice => choice.index === 0)
          if (primary < 0) throw new Error('Chat Completions response did not contain the primary choice.')
          return openAiChatConversationResponses(response)[primary]
        }
      }
    }
    return { async invoke(request) {
      request.signal.throwIfAborted()
      const observationErrors: unknown[] = []
      const response = await invoke(request, event => {
        try { request.observe?.(event) } catch (error) { if (!observationErrors.length) observationErrors.push(error) }
      })
      return { ...response, observationErrors }
    } }
  } catch (cause) {
    if (cause instanceof ModelSelectionError) throw cause
    throw new ModelSelectionError(`The selected model cannot be initialized: ${cause instanceof Error ? cause.message : String(cause)}. Correct its settings and send again.`, { cause })
  }
}
