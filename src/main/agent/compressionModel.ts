import type { ResolvedModelConfig } from '@shared/types'
import { OpenAiChatCompletions } from '../../providers/openAiChatCompletions'
import { OpenAiResponses } from '../../providers/openAiResponses'
import { AnthropicMessages } from '../../providers/anthropicMessages'
import { openAiModelParameters, anthropicModelParameters } from '../../providers/modelParameters'
import { openAiChatParameters, openAiResponsesParameters } from '../../providers/openAiParameters'
import { anthropicRequestParameters } from '../../providers/anthropicParameters'
import { readOpenAiResponse } from '../../providers/openAiResponsesOutput'
import { readChatCompletion } from '../../providers/openAiChatOutput'
import { readAnthropicResponse } from '../../providers/anthropicOutput'
import { invokeModelWithRetry } from '../../runtime/modelRetry'
import { ModelSelectionError, isModelRequestChangedError } from '../../runtime/errors'
import { prepareModelConnection, type ModelConnectionOptions } from './modelConnection'
import { observeModelRetry } from './modelRetryLogging'
import { trackCompressionSummary, type GenerateSummary, type SummaryResponse, type CompressionTrackingCallbacks } from '../../runtime/compression'

export interface CompressionModelOptions extends ModelConnectionOptions {
  beforeRequest?: () => Promise<void>
  compressionTracking?: CompressionTrackingCallbacks
  signal?: AbortSignal
  observe?: (prompt: string, generate: () => Promise<SummaryResponse>) => Promise<SummaryResponse>
}

export const contextCompressionTimeoutMs = 120_000

/** A single non-streaming summary request; no graph model, tools or callbacks. */
export function createCompressionModel(config: ResolvedModelConfig, options: CompressionModelOptions = {}): GenerateSummary {
  try {
    const { protocol, model, apiKey, parameters, providerFetch } = prepareModelConnection(config, {
      ...options, requestRole: options.requestRole ?? 'compression'
    })
    const client = { apiKey, fetch: providerFetch, timeout: contextCompressionTimeoutMs }
    const maxOutputTokens = config.maxOutputTokens > 0 ? config.maxOutputTokens : undefined
    let request: GenerateSummary
    if (protocol === 'anthropic_messages') {
      const provider = new AnthropicMessages({ ...client,
        baseURL: config.baseUrl || process.env.ANTHROPIC_API_URL || process.env.ANTHROPIC_BASE_URL })
      const body = anthropicRequestParameters({ model, maxOutputTokens, streaming: false, parameters: anthropicModelParameters(parameters) })
      request = async (prompt, signal) => {
        const response = await provider.complete({ ...body, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] }, { signal })
        const { id, text, usage } = readAnthropicResponse(response)
        return { id, text, usage }
      }
    } else {
      const { tools: _tools, ...kwargs } = openAiModelParameters(parameters)
      const settings = { model, maxOutputTokens, streaming: false, parameters: kwargs, protocol: protocol === 'openai_responses' ? 'responses' as const : 'chat' as const }
      const connection = { ...client, baseURL: config.baseUrl || process.env.OPENAI_API_BASE || process.env.OPENAI_BASE_URL }
      if (protocol === 'openai_responses') {
        const provider = new OpenAiResponses(connection), body = openAiResponsesParameters(settings)
        request = async (prompt, signal) => {
          const response = await provider.complete({ ...body, input: [{ role: 'user', content: prompt }] }, { signal })
          const { id, text, usage } = readOpenAiResponse(response)
          return { id, text, usage }
        }
      } else {
        const provider = new OpenAiChatCompletions(connection), body = openAiChatParameters(settings)
        request = async (prompt, signal) => {
          const response = await provider.complete({ ...body, messages: [{ role: 'user', content: prompt }] }, { signal })
          const { id, candidates, usage } = readChatCompletion(response)
          return { id, text: candidates[0]?.text ?? '', usage }
        }
      }
    }
    return (prompt, signal, preparation) => {
      const requestSignal = signal && options.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options.signal
      let attempts = 0
      const generate = () => invokeModelWithRetry(async () => {
        requestSignal?.throwIfAborted()
        if (attempts++ > 0) await options.beforeRequest?.()
        return request(prompt, requestSignal)
      }, { signal: requestSignal, onRetry: observeModelRetry(options.requestId), retryWhen: error => !isModelRequestChangedError(error) })
      return trackCompressionSummary(prompt, options.compressionTracking,
        () => options.observe ? options.observe(prompt, generate) : generate(), { preparation, beforePrepare: async () => { requestSignal?.throwIfAborted(); await options.beforeRequest?.() } })
    }
  } catch (cause) {
    if (cause instanceof ModelSelectionError) throw cause
    throw new ModelSelectionError(`The selected model cannot be initialized: ${cause instanceof Error ? cause.message : String(cause)}. Correct its settings and send again.`, { cause })
  }
}
