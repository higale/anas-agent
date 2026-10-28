import type { AgentServerTokenUsage, AgentTokenModalityDetails } from '../shared/agentTypes'

export interface ModelUsage {
  input_tokens: number
  output_tokens: number
  total_tokens: number
  input_token_details?: Record<string, number | undefined>
  output_token_details?: Record<string, number | undefined>
}

export interface ModelUsageEvidence {
  isResponse: boolean
  renderedReport?: boolean
  modelContextKey?: unknown
  usage?: ModelUsage
}

/** A rendered review is not a provider response. The newest actual response
 * owns the snapshot; missing usage or a changed model never borrows older usage. */
export function latestModelUsageSnapshot(messageCount: number, evidenceAt: (index: number) => ModelUsageEvidence, modelContextKey?: string):
  { messageIndex: number; usage: AgentServerTokenUsage } | undefined {
  for (let index = messageCount - 1; index >= 0; index--) {
    const message = evidenceAt(index)
    if (!message.isResponse || message.renderedReport) continue
    if (modelContextKey !== undefined && message.modelContextKey !== modelContextKey) return undefined
    const usage = modelUsageSnapshot(message.usage)
    return usage ? { messageIndex: index, usage } : undefined
  }
  return undefined
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined
}

function modalityDetails(
  details: Record<string, number | undefined> | undefined
): AgentTokenModalityDetails {
  return {
    ...(tokenCount(details?.text) !== undefined
      ? { textTokens: tokenCount(details?.text) }
      : {}),
    ...(tokenCount(details?.image) !== undefined
      ? { imageTokens: tokenCount(details?.image) }
      : {}),
    ...(tokenCount(details?.audio) !== undefined
      ? { audioTokens: tokenCount(details?.audio) }
      : {}),
    ...(tokenCount(details?.video) !== undefined
      ? { videoTokens: tokenCount(details?.video) }
      : {}),
    ...(tokenCount(details?.document) !== undefined
      ? { documentTokens: tokenCount(details?.document) }
      : {})
  }
}

function hasDetails(details: AgentTokenModalityDetails): boolean {
  return Object.keys(details).length > 0
}

export function modelUsageSnapshot(usage: ModelUsage | undefined): AgentServerTokenUsage | undefined {
  const inputTokens = tokenCount(usage?.input_tokens)
  const outputTokens = tokenCount(usage?.output_tokens)
  const totalTokens = tokenCount(usage?.total_tokens)
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || totalTokens === undefined
    || totalTokens <= 0
  ) return undefined

  const inputTokenDetails = {
    ...modalityDetails(usage?.input_token_details),
    ...(tokenCount(usage?.input_token_details?.cache_read) !== undefined
      ? { cacheReadTokens: tokenCount(usage?.input_token_details?.cache_read) }
      : {}),
    ...(tokenCount(usage?.input_token_details?.cache_creation) !== undefined
      ? { cacheCreationTokens: tokenCount(usage?.input_token_details?.cache_creation) }
      : {})
  }
  const outputTokenDetails = {
    ...modalityDetails(usage?.output_token_details),
    ...(tokenCount(usage?.output_token_details?.reasoning) !== undefined
      ? { reasoningTokens: tokenCount(usage?.output_token_details?.reasoning) }
      : {})
  }

  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(hasDetails(inputTokenDetails) ? { inputTokenDetails } : {}),
    ...(hasDetails(outputTokenDetails) ? { outputTokenDetails } : {})
  }
}
