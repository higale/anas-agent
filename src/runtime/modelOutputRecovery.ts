import type { ConversationMessage } from './conversationMessage'
import type { ModelRecoveryState } from '../shared/modelRecovery'
import { IncompleteModelResponseError, InvalidModelToolCallError, ModelOutputLimitError } from './errors'

export const maxModelRecoveryAttempts = 2

/** Only provider-owned completion metadata identifies output truncation. */
export function modelOutputWasTruncated(message: ConversationMessage): boolean {
  const source = message.source, metadata = source?.metadata
  if (!metadata) return false
  return source?.provider === 'anthropic' && metadata.stop_reason === 'max_tokens'
    || source?.provider === 'openai' && (metadata.finish_reason === 'length'
      || metadata.status === 'incomplete' && (metadata.incomplete_details as { reason?: unknown } | null)?.reason === 'max_output_tokens')
}

export function outputRecoveryReason(error: unknown): ModelRecoveryState['reason'] | undefined {
  if (error instanceof InvalidModelToolCallError) return 'invalid_tool_call'
  if (error instanceof ModelOutputLimitError) return 'output_limit'
  if (error instanceof IncompleteModelResponseError) return 'incomplete'
  return undefined
}

/** Ephemeral application feedback, never a replacement user instruction or executable call. */
export function modelRecoveryFeedback(recovery: ModelRecoveryState | undefined): ConversationMessage[] {
  if (!recovery?.feedback) return []
  const text = recovery.feedback === 'text_continuation'
    ? 'Your previous answer reached the output token limit. Its text is retained above. Continue exactly where it ended, without repeating the retained text. Complete the original task concisely.'
    : recovery.feedback === 'output_limit'
      ? 'Your previous response reached the output token limit and could not be used. No tool calls from that response were executed. Regenerate the required response using shorter output and smaller tool batches.'
      : 'Your previous response contained an invalid tool call (unparseable arguments or missing call identity). No tool calls from that response were executed. Generate complete valid tool calls matching the supplied definitions.'
  return [{ kind: 'user', content: `[Application recovery notice]\n${text}\nPreviously completed tool actions and their recorded results remain valid. Continue the original task; do not repeat those actions.` }]
}
