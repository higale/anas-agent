import { summaryPromptForLanguage, type SummaryOutputLanguage } from '@shared/summaryPrompt'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import { summaryTranscript, type SummaryTranscriptMessage } from '../../runtime/compression'
import { compressionRetention, pendingToolImageStart,
  toolHistoryPlan, unrecordedToolResultText, type HistoryEntry } from '../../runtime/conversationHistory'
import { conversationHistoryFacts } from './conversationContext'

export interface ConversationSummary {
  cutoffIndex: number
  message: ConversationMessage
}

export function effectiveConversationHistory(messages: ConversationMessage[], summary?: ConversationSummary): ConversationMessage[] {
  if (!summary) return messages
  if (!Number.isSafeInteger(summary.cutoffIndex) || summary.cutoffIndex < 0 || summary.cutoffIndex > messages.length) {
    throw new Error('The summary boundary is outside this conversation history.')
  }
  return [summary.message, ...messages.slice(summary.cutoffIndex)]
}

export function projectConversationToolHistory(messages: ConversationMessage[]): ConversationMessage[] {
  const plan = toolHistoryPlan(conversationHistoryFacts(messages))
  if (plan.length === messages.length && plan.every((item, index) => 'index' in item && item.index === index)) return messages
  return plan.map(item => 'index' in item ? messages[item.index] : {
    kind: 'tool', resultFor: item.missingResult.callId, name: item.missingResult.name, resultStatus: 'error',
    content: unrecordedToolResultText, context: { unrecordedResult: true }
  })
}

export function summaryInputPrompt(
  messages: ConversationMessage[],
  outputLanguage: SummaryOutputLanguage,
  codingMode: boolean,
  compressionPrompt?: string
): string {
  return summaryPromptForLanguage(outputLanguage, codingMode, compressionPrompt)
    .replace('{conversation}', () => conversationSummaryTranscript(messages))
}

export function conversationSummaryTranscript(messages: ConversationMessage[]): string {
  return summaryTranscript(messages.map((message): SummaryTranscriptMessage => {
    const speaker = message.kind === 'user' ? 'Human' : message.kind === 'assistant' ? 'AI'
      : message.kind === 'system' ? 'System' : message.kind === 'tool' ? 'Tool' : message.kind === 'custom' ? message.role : undefined
    if (speaker === undefined) throw new Error(`Got unsupported message type: ${message.kind}`)
    const extras = message.source?.extras ?? {}
    return { speaker, name: message.name, content: message.content,
      ...(message.kind === 'assistant' ? {
        calls: message.calls?.map(call => ({ ...call.extensions, id: call.id, name: call.name, args: call.args,
          ...(call.kind === 'custom' ? { isCustomTool: true } : call.kind === 'computer' ? { isComputerTool: true } : {}),
          ...(Object.hasOwn(call, 'itemId') ? { call_id: call.itemId } : {}) })),
        ...('function_call' in extras ? { functionCall: extras.function_call } : {})
      } : {}) }
  }))
}

export function conversationPendingImageStart(messages: ConversationMessage[]): number | undefined {
  return pendingToolImageStart(conversationHistoryFacts(messages))
}

export function selectConversationRetention(effective: ConversationMessage[], raw: ConversationMessage[], threshold: number,
  countMessages: (messages: ConversationMessage[]) => number) {
  const facts = new Map<ConversationMessage, HistoryEntry>()
  const fact = (message: ConversationMessage) => {
    let value = facts.get(message)
    if (!value) { value = conversationHistoryFacts([message])[0]; facts.set(message, value) }
    return value
  }
  return compressionRetention(effective.map(fact), raw.map(fact), threshold, (start, end) => countMessages(effective.slice(start, end)))
}
