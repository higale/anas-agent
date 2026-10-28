import { modelParameterInputTokens } from '../../runtime/modelInputBudget'
import type { ResolvedModelConfig } from '@shared/types'
import { modelReservedParameterKeys, requireModelProtocol } from '@shared/modelConfig'
import { resolveModelApiKey } from '../config/apiKeys'
import { runtimeLog } from '../runtimeLogger'
import { createProviderHttpTraceFetch } from './providerHttpTrace'

export interface ModelConnectionOptions {
  developerHttpTrace?: boolean
  providerFetch?: typeof fetch
  requestId?: string
  requestRole?: string
}
const fallbackApiKey = 'anas-no-auth'

function observedProviderFetch(config: ResolvedModelConfig, overrides: ModelConnectionOptions): typeof fetch {
  let requestNumber = 0
  return async (input, init) => {
    requestNumber += 1
    const startedAt = Date.now()
    runtimeLog('debug', 'agent-model', 'Provider request started.', {
      runId: overrides.requestId,
      role: overrides.requestRole ?? 'model',
      protocol: config.protocol,
      model: config.model,
      requestNumber
    })
    try {
      const response = await globalThis.fetch(input, init)
      runtimeLog('debug', 'agent-model', 'Provider request completed.', {
        runId: overrides.requestId,
        role: overrides.requestRole ?? 'model',
        protocol: config.protocol,
        model: config.model,
        requestNumber,
        status: response.status,
        durationMs: Date.now() - startedAt
      })
      return response
    } catch (error) {
      runtimeLog('warn', 'agent-model', 'Provider request failed.', {
        runId: overrides.requestId,
        role: overrides.requestRole ?? 'model',
        protocol: config.protocol,
        model: config.model,
        requestNumber,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error
          ? {
              name: error.name,
              code: 'code' in error && typeof error.code === 'string' ? error.code : undefined
            }
          : { name: typeof error }
      })
      throw error
    }
  }
}

function requireModelName(config: ResolvedModelConfig): string {
  const model = config.model.trim()
  if (!model) throw new Error(`Provider "${config.providerName}" has an incomplete model configuration.`)
  return model
}

function modelApiKey(config: ResolvedModelConfig): string {
  return resolveModelApiKey(config) ?? fallbackApiKey
}

export function prepareModelConnection(config: ResolvedModelConfig, overrides: ModelConnectionOptions) {
  const parameters = config.parameters
  const protocol = requireModelProtocol(config.protocol, 'model.protocol')
  if ('tools' in parameters && protocol !== 'openai_responses') {
    throw new Error('The model parameter "tools" is only supported by the OpenAI Responses protocol.')
  }
  const reserved = modelReservedParameterKeys(parameters)
  if (reserved.length > 0) {
    throw new Error(`Config value model.parameters contains reserved keys: ${reserved.join(', ')}.`)
  }
  modelParameterInputTokens(protocol, parameters)
  const model = requireModelName(config)
  const apiKey = modelApiKey(config)
  const observedFetch = observedProviderFetch(config, overrides)
  const providerFetch = overrides.providerFetch ?? (
    overrides.developerHttpTrace
      ? createProviderHttpTraceFetch(observedFetch, {
          model,
          protocol,
          providerName: config.providerName,
          requestId: overrides.requestId,
          requestRole: overrides.requestRole
        })
      : observedFetch
  )
  return { parameters, protocol, model, apiKey, providerFetch }
}
