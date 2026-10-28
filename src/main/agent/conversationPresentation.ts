import type { ConversationMessage } from '../../runtime/conversationMessage'
import { presentMessage } from '../../runtime/messagePresentation'
import { contentText } from '../../runtime/inputContent'
import { conversationContentBlocks } from '../../providers/conversationInput'

/** Keep timeline payloads identical to the existing product presentation. */
export function presentConversationMessage(message: ConversationMessage, fallbackId: string) {
  const blocks = conversationContentBlocks(message), context = message.context
  return presentMessage({ id: message.id, name: message.name,
    role: message.kind === 'user' || message.kind === 'assistant' || message.kind === 'tool' ? message.kind : 'system',
    blocks, text: contentText(blocks), calls: message.calls, resultFor: message.resultFor,
    runId: context?.runId, createdAt: context?.createdAt, displayText: context?.displayText,
    directionAfterToolCallIds: context?.directionAfterCallIds, reviewScope: context?.reviewScope, review: context?.reviewReport
  }, fallbackId)
}
