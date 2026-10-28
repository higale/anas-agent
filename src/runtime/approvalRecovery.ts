import type { AgentInterrupt } from '../shared/agentTypes'

const interruptMetadataKey = 'anasSubagentApproval'
const responseGenerationKey = '__anas_interrupt_generation'

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined
}

export function subagentApprovalInterruptMetadata(generation: string): {
  anasSubagentApproval: { generation: string }
} {
  return { [interruptMetadataKey]: { generation } }
}

export function subagentApprovalGenerationFromInterrupt(value: unknown): string | undefined {
  const metadata = record(record(value)?.[interruptMetadataKey])
  return typeof metadata?.generation === 'string' && metadata.generation
    ? metadata.generation
    : undefined
}

export function tagSubagentApprovalResponse(
  response: unknown,
  generation: string | undefined
): unknown {
  if (!generation) return response
  const current = record(response)
  if (!current) throw new Error('A subagent approval response must be an object.')
  return { ...current, [responseGenerationKey]: generation }
}

export function subagentApprovalGenerationFromResponse(value: unknown): string | undefined {
  const generation = record(value)?.[responseGenerationKey]
  return typeof generation === 'string' && generation ? generation : undefined
}

export interface RequestedApprovalResponse {
  interruptId: string
  response: Record<string, unknown>
  expectedGeneration: string
}

/** Responses are validated as a complete batch before the caller saves them. */
export function matchApprovalResponses(pending: readonly AgentInterrupt[],
  requested: readonly RequestedApprovalResponse[]): Array<{ interruptId: string; response: unknown }> {
  const pendingById = new Map(pending.map(interrupt => [interrupt.id, interrupt]))
  const responseIds = requested.map(entry => entry.interruptId)
  if (responseIds.length !== pendingById.size || new Set(responseIds).size !== responseIds.length
    || responseIds.some(id => !pendingById.has(id))) {
    throw new Error('Resume responses must match the current durable root interrupts exactly.')
  }
  return requested.map(entry => {
    const interrupt = pendingById.get(entry.interruptId)!
    if (entry.expectedGeneration !== interrupt.approvalGeneration) {
      throw new Error(`Resume response for interrupt ${entry.interruptId} does not match its current approval generation.`)
    }
    return { interruptId: entry.interruptId, response: tagSubagentApprovalResponse(entry.response,
      subagentApprovalGenerationFromInterrupt(interrupt.value)) }
  })
}
