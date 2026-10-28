import type { AgentMessage, AgentRunActivity, AgentToolCall } from '../shared/agentTypes'
import { presentToolResult, traceText } from './messagePresentation'

/** Rebuild timeline evidence from committed messages, never streamed progress.
 * These projections do not schedule work or replace the owning stored state. */
export interface DurableRootModelActivity {
  messageId: string
  text: string
  reasoning: string
  toolCalls: AgentToolCall[]
}

export interface DurableRootToolActivity {
  call: AgentToolCall
  output: unknown
  subagentName?: string
  subagentId?: string
}

export interface DurableRootActivityEvidence {
  models: DurableRootModelActivity[]
  tools: DurableRootToolActivity[]
}

export interface CanonicalChildActivityEvidence {
  subagentIds: ReadonlySet<string>
  modelIds: ReadonlySet<string>
  tools: ReadonlyMap<string, { completed: boolean }>
}

interface ToolMessageIndex {
  results: Map<string, {
    call: AgentToolCall
    message: AgentMessage
    ownerMessageId: string
    runId?: string
  }>
}

function indexToolMessages(
  messages: AgentMessage[],
  fallbackRunId?: string
): ToolMessageIndex {
  const unresolved = new Map<string, {
    call: AgentToolCall
    ownerMessageId: string
    runId?: string
  }>()
  const results: ToolMessageIndex['results'] = new Map()
  for (const message of messages) {
    if (message.role === 'assistant') {
      for (const call of message.toolCalls ?? []) {
        // Reused IDs start a new ownership interval. A result from an older
        // interval must never be discoverable after this call appears.
        results.delete(call.id)
        unresolved.set(call.id, {
          call,
          ownerMessageId: message.id,
          runId: message.runId ?? fallbackRunId
        })
      }
      continue
    }
    if (message.role !== 'tool' || !message.toolCallId) continue
    const owner = unresolved.get(message.toolCallId)
    if (!owner) continue
    unresolved.delete(message.toolCallId)
    results.set(message.toolCallId, {
      call: owner.call,
      message,
      ownerMessageId: owner.ownerMessageId,
      runId: owner.runId
    })
  }
  return { results }
}

function rootSubagentName(call: AgentToolCall): string | undefined {
  if (call.name !== 'start_subagent' || !call.args || typeof call.args !== 'object') return undefined
  const agent = (call.args as { agent?: unknown }).agent
  return typeof agent === 'string' && agent ? agent : undefined
}

function startedSubagentId(output: unknown): string | undefined {
  let value = output
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return undefined
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  const id = (value as Record<string, unknown>).subagent_id
  return typeof id === 'string' && id ? id : undefined
}

export function rootActivityEvidence(messages: AgentMessage[], runId: string): DurableRootActivityEvidence {
  const models: DurableRootModelActivity[] = messages.flatMap((message) =>
    message.role === 'assistant' && message.runId === runId
      ? [{
          messageId: message.id,
          text: traceText(message.content, 'text'),
          reasoning: traceText(message.content, 'reasoning'),
          toolCalls: message.toolCalls ?? []
        }]
      : []
  )
  const tools = [...indexToolMessages(messages).results.values()].flatMap((resolved) =>
    resolved.runId === runId
      ? (() => {
          const output = presentToolResult(resolved.message.content)
          return [{
            call: resolved.call,
            output,
            subagentName: rootSubagentName(resolved.call),
            subagentId: startedSubagentId(output)
          }]
        })()
      : []
  )
  return { models, tools }
}

export function normalizeRootActivityProjection(
  activity: AgentRunActivity,
  evidence: DurableRootActivityEvidence,
  retainUncommitted: boolean,
  canonicalChildren: CanonicalChildActivityEvidence,
  activeSubagentIds?: ReadonlySet<string>
): AgentRunActivity {
  const durableModels = new Map(evidence.models.map((model) => [model.messageId, model]))
  const durableTools = new Map(evidence.tools.map((tool) => [tool.call.id, tool]))
  const durableCalls = new Map(evidence.models.flatMap((model) => model.toolCalls)
    .map((call) => [call.id, call]))
  // Child projections follow committed tool results or their own persisted
  // relationship and message evidence, independently of the parent batch.
  const allowedSubagents = new Set(evidence.tools.flatMap((tool) =>
    tool.subagentId ? [tool.subagentId] : []
  ))
  let discoveredSubagent = true
  while (discoveredSubagent) {
    discoveredSubagent = false
    for (const subagent of activity.subagents) {
      if (
        subagent.parentSubagentId
        && allowedSubagents.has(subagent.parentSubagentId)
        && !allowedSubagents.has(subagent.id)
      ) {
        allowedSubagents.add(subagent.id)
        discoveredSubagent = true
      }
    }
  }
  const claimedModels = new Set<string>()
  const models = activity.models.flatMap((model) => {
    if (model.subagentId) {
      if (canonicalChildren.subagentIds.has(model.subagentId)) {
        return canonicalChildren.modelIds.has(model.id) || retainUncommitted || activeSubagentIds?.has(model.subagentId) ? [model] : []
      }
      return allowedSubagents.has(model.subagentId) ? [model] : []
    }
    const durable = model.messageId ? durableModels.get(model.messageId) : undefined
    if (durable && !claimedModels.has(durable.messageId)) {
      claimedModels.add(durable.messageId)
      return [{
        ...model,
        messageId: durable.messageId,
        status: 'completed' as const,
        text: durable.text,
        reasoning: durable.reasoning,
        toolCallIds: durable.toolCalls.map((call) => call.id)
      }]
    }
    if (!retainUncommitted) return []
    return [{
      ...model,
      messageId: undefined,
      status: 'running' as const,
      toolCallIds: [],
      completedAt: undefined
    }]
  })
  const tools = activity.tools.flatMap((tool) => {
    if (tool.subagentId) {
      if (canonicalChildren.subagentIds.has(tool.subagentId)) {
        const durable = canonicalChildren.tools.get(JSON.stringify([tool.subagentId, tool.call.id]))
        if (durable?.completed || retainUncommitted || activeSubagentIds?.has(tool.subagentId)) return [tool]
        return durable ? [{ ...tool, status: 'running' as const, output: undefined, completedAt: undefined }] : []
      }
      return allowedSubagents.has(tool.subagentId) ? [tool] : []
    }
    const durable = durableTools.get(tool.call.id)
    const durableCall = durableCalls.get(tool.call.id)
    const call = durableCall ?? tool.call
    if (durable) {
      return [{
        ...tool,
        call: durable.call,
        status: 'completed' as const,
        approval: undefined,
        output: durable.output
      }]
    }
    if (!durableCall && !retainUncommitted) return []
    return [{
      ...tool,
      call,
      status: 'running' as const,
      approval: activity.status === 'interrupted' ? tool.approval : undefined,
      output: undefined,
      completedAt: undefined
    }]
  })
  const subagents = activity.subagents.flatMap((subagent) => {
    if (canonicalChildren.subagentIds.has(subagent.id)) {
      return [subagent]
    }
    if (subagent.parentSubagentId) {
      return allowedSubagents.has(subagent.id) ? [subagent] : []
    }
    const durable = evidence.tools.find((tool) => tool.subagentId === subagent.id)
    if (!durable && !retainUncommitted) return []
    return [subagent]
  })

  return { ...activity, models, tools, subagents }
}
