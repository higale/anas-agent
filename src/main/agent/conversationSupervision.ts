import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { ExecutionContext } from '../../runtime/executionState'
import { managedCallSupervision, subagentSupervision, reconcileTaskObservations, observedManagedCalls, observedSubagents,
  type SupervisionMessage } from '../../runtime/backgroundSupervision'
import type { AgentManagedCallRecord } from './managedCallStore'
import type { AgentSubagentCallRecord } from './subagentTaskStore'

export interface ConversationSupervisionOptions {
  managed?: {
    unresolved(): readonly Pick<AgentManagedCallRecord, 'id' | 'kind' | 'status' | 'summary'>[]
      | Promise<readonly Pick<AgentManagedCallRecord, 'id' | 'kind' | 'status' | 'summary'>[]>
    resolve?(callId: string): void | Promise<void>
  }
  subagents?: {
    unresolved(): readonly Pick<AgentSubagentCallRecord, 'id' | 'agentName' | 'status' | 'description'>[]
      | Promise<readonly Pick<AgentSubagentCallRecord, 'id' | 'agentName' | 'status' | 'description'>[]>
    resolve(subagentId: string): void | Promise<void>
  }
}

function supervisionMessages(messages: readonly ConversationMessage[]): SupervisionMessage[] {
  return messages.flatMap((message): SupervisionMessage[] => message.kind === 'assistant' && !message.partial
    ? [{ kind: 'calls', calls: message.calls ?? [] }] : message.kind === 'tool' && message.resultFor !== undefined
      ? [{ kind: 'result', callId: message.resultFor, name: message.name, content: message.content }] : [])
}

/** Use full committed history, not summarized request context or live events.
 * Keep evidence until the managed/subagent owner confirms acknowledgement. */
export async function reconcileConversationSupervision(context: ExecutionContext, history: readonly ConversationMessage[],
  options: ConversationSupervisionOptions): Promise<ExecutionContext | undefined> {
  const messages = supervisionMessages(history)
  const settled = await Promise.allSettled([
    options.managed ? reconcileTaskObservations({ messages, previous: context.observedManagedCalls ?? {},
      ...options.managed, observe: observedManagedCalls }) : undefined,
    options.subagents ? reconcileTaskObservations({ messages, previous: context.observedSubagents ?? {},
      ...options.subagents, observe: observedSubagents }) : undefined
  ])
  const failure = settled.find((result): result is PromiseRejectedResult => result.status === 'rejected')
  if (failure) throw failure.reason
  const managed = (settled[0] as PromiseFulfilledResult<Record<string, true> | undefined>).value
  const subagents = (settled[1] as PromiseFulfilledResult<Record<string, true> | undefined>).value
  if (managed === undefined && subagents === undefined) return undefined
  return { ...context,
    ...(managed === undefined ? {} : { observedManagedCalls: Object.keys(managed).length ? managed : undefined }),
    ...(subagents === undefined ? {} : { observedSubagents: Object.keys(subagents).length ? subagents : undefined }) }
}

export async function projectConversationSupervision(system: ConversationMessage, tools: readonly unknown[], options: ConversationSupervisionOptions) {
  const [calls, subagents] = await Promise.all([options.managed?.unresolved() ?? [], options.subagents?.unresolved() ?? []])
  const names = tools.flatMap(tool => {
    if (!tool || typeof tool !== 'object') return []
    const value = tool as { name?: unknown; function?: { name?: unknown } }
    const name = value.name ?? value.function?.name
    return typeof name === 'string' ? [name] : []
  })
  // Preserve the original subagent-then-managed instruction order.
  const instruction = [subagentSupervision(subagents, names), managedCallSupervision(calls, names)].filter(Boolean).join('\n\n')
  const systemMessage = instruction ? { ...system, content: typeof system.content === 'string' ? `${system.content}\n\n${instruction}`
    : [...system.content, { type: 'text', text: `\n\n${instruction}` }] } : system
  return { systemMessage, requiresTools: calls.length > 0 || subagents.length > 0 }
}
