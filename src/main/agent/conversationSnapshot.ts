import type { AgentMessage, AgentRunActivity, AgentAttachmentArtifact, AgentThreadSnapshot, AgentRun } from '../../shared/agentTypes'
import { initialAgentMessageWindow } from '../../shared/agentMessageWindow'
import { traceReasoningSummary } from '../../runtime/messagePresentation'

function conversationMessages(messages: AgentMessage[]): AgentMessage[] {
  return messages.filter((message) =>
    message.role === 'user'
    || (message.role === 'assistant' && !message.toolCalls?.length)
  )
}

function firstPreservedActivitySequence(
  activity: AgentRunActivity,
  summary: NonNullable<AgentRunActivity['summaries']>[number],
  messages: AgentMessage[]
): number | undefined {
  if (!summary.firstPreservedMessageId) return undefined
  const messageIndex = messages.findIndex((message) => message.id === summary.firstPreservedMessageId)
  if (messageIndex < 0 || messages[messageIndex].role === 'user') return undefined
  let boundaryRunId: string | undefined
  for (let index = messageIndex; index >= 0; index -= 1) {
    if (messages[index].runId) {
      boundaryRunId = messages[index].runId
      break
    }
  }
  if (boundaryRunId !== activity.runId) return undefined

  const message = messages[messageIndex]
  if (message.role === 'tool' && message.toolCallId) {
    return activity.tools.find((tool) =>
      !tool.subagentId && tool.call.id === message.toolCallId
    )?.sequence
  }
  if (message.role !== 'assistant') return undefined
  return activity.models.find((model) =>
    !model.subagentId && model.messageId === message.id
  )?.sequence
}

function attachReasoningSummaries(
  activities: AgentRunActivity[],
  messages: AgentMessage[]
): AgentRunActivity[] {
  const summaries = new Map(messages.flatMap((message) => {
    const summary = traceReasoningSummary(message.content)
    return summary ? [[message.id, summary] as const] : []
  }))
  if (summaries.size === 0) return activities
  return activities.map((activity) => ({
    ...activity,
    models: activity.models.map((model) => {
      const summary = model.messageId ? summaries.get(model.messageId) : undefined
      return summary ? { ...model, reasoningSummary: summary } : model
    })
  }))
}


export interface ConversationSnapshotSource {
  activities(runIds: string[]): AgentRunActivity[]
  attachments(messageIds: string[]): AgentAttachmentArtifact[]
  normalizeActivity(activity: AgentRunActivity): AgentRunActivity
  decorateActivity(activity: AgentRunActivity): AgentRunActivity
}

/** Shared product presentation, independent of graph/native storage and UI
 * subscriptions. Persistent inputs and live activity decoration stay separate. */
export function conversationSnapshot(input: {
  thread: AgentThreadSnapshot['thread']; latestRun: AgentRun | null; messages: AgentMessage[];
  todos: AgentThreadSnapshot['todos']; interrupts: AgentThreadSnapshot['interrupts'];
  contextStatus?: AgentThreadSnapshot['contextStatus']; requestedStartIndex?: number; settling: boolean;
  window?: { messages: AgentMessage[]; startIndex: number; totalCount: number }
}, source: ConversationSnapshotSource): AgentThreadSnapshot {
  const { thread, latestRun, interrupts, contextStatus, requestedStartIndex, window } = input
  const sourceMessages = input.messages
  const normalizeLatest = latestRun?.status === 'running' || latestRun?.status === 'interrupted'
  const allMessages = conversationMessages(sourceMessages)
  const total = window?.totalCount ?? allMessages.length
  const startIndex = window?.startIndex ?? Math.max(
    0,
    Math.min(total, requestedStartIndex ?? Math.max(0, total - initialAgentMessageWindow))
  )
  const messages = window ? allMessages : allMessages.slice(startIndex)
  const windowRunIds = new Set(messages.flatMap((message) => message.runId ? [message.runId] : []))
  if (latestRun) windowRunIds.add(latestRun.id)
  const activitiesForWindow = source.activities([...windowRunIds])
  const allActivities = attachReasoningSummaries(
    activitiesForWindow
      .map((activity) =>
        normalizeLatest && activity.runId === latestRun?.id
          ? source.normalizeActivity(activity)
          : activity
      ),
    sourceMessages
  ).map((activity) => source.decorateActivity(activity))
  const attachmentsByMessage = new Map<string, AgentAttachmentArtifact[]>()
  for (const attachment of source.attachments(messages.map((message) => message.id))) {
    attachmentsByMessage.set(attachment.messageId, [
      ...(attachmentsByMessage.get(attachment.messageId) ?? []), attachment
    ])
  }
  const allMessageRunIds = new Set(allMessages.flatMap((message) =>
    message.runId ? [message.runId] : []
  ))
  const windowMessageIds = new Set(messages.map((message) => message.id))
  const trailingUnanchoredIds = new Set(
    allActivities
      .filter((activity) => !allMessageRunIds.has(activity.runId))
      .slice(-initialAgentMessageWindow)
      .map((activity) => activity.runId)
  )
  const activities = allActivities.flatMap((activity) => {
    const summariesWithBoundaries = (activity.summaries ?? [])
      .map((summary) => ({
        ...summary,
        firstPreservedActivitySequence: firstPreservedActivitySequence(
          activity,
          summary,
          sourceMessages
        )
      }))
    const summaries = summariesWithBoundaries
      .filter((summary) =>
        (
          summary.firstPreservedActivitySequence !== undefined
          && windowRunIds.has(activity.runId)
        )
        || Boolean(
          summary.coveredThroughMessageId
          && windowMessageIds.has(summary.coveredThroughMessageId)
        )
        || Boolean(
          summary.firstPreservedMessageId
          && windowMessageIds.has(summary.firstPreservedMessageId)
        )
        || (
          summary.status === 'running'
          && windowRunIds.has(activity.runId)
        )
      )
    const include = windowRunIds.has(activity.runId)
      || summaries.length > 0
      || trailingUnanchoredIds.has(activity.runId)
    if (!include) return []
    return [{
      ...activity,
      summaries: summaries.length > 0 ? summaries : undefined
    }]
  })
  return {
    thread,
    pendingRun: latestRun?.status === 'running' || latestRun?.status === 'interrupted'
      ? latestRun
      : undefined,
    settlingRun: latestRun?.status === 'completed' && input.settling ? latestRun : undefined,
    messages: messages.map((mapped) => {
      const attachments = attachmentsByMessage.get(mapped.id)
      return attachments?.length ? { ...mapped, attachments } : mapped
    }),
    todos: input.todos,
    interrupts,
    activities,
    contextStatus,
    messageWindow: {
      startIndex,
      shown: total - startIndex,
      total,
      remaining: startIndex
    }
  }
}
