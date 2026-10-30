import type { ConversationMessage } from './conversationMessage'
import type { ExecutionState } from './executionState'
import { planningToolSpec } from './planning'

export const withheldToolResultText = 'This tool call already has a recorded result. After the previous model request failed, the user chose to retry without returning this round of tool results to the model. The original result is withheld; any actions and effects of the tool remain unchanged.'

/** Current-format records written before the optional failure marker retain
 * the response pointer until a tool/model-result phase ends. A failed head
 * without that pointer is already at the next model request, never tool replay. */
export function canRetryModelRequest(state: Pick<ExecutionState, 'phase' | 'context' | 'response'>): boolean {
  return state.phase === 'failed' && (state.context.modelRequestFailed ?? state.response === undefined)
}

/** Withholding is offered only for a complete tool batch directly before the failure, with no later user input. */
export function lastToolResultBatch(messages: readonly ConversationMessage[]): string[] {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.kind === 'user') return []
    if (message.kind !== 'assistant') continue
    if (message.partial || !message.calls?.length) return []
    const calls = new Set(message.calls.map(call => call.id))
    if (calls.has(undefined) || calls.size !== message.calls.length) return []
    const results = messages.slice(index + 1).filter(item => item.kind === 'tool' && calls.has(item.resultFor))
    if (results.length !== calls.size || new Set(results.map(item => item.resultFor)).size !== calls.size || results.some(item => !item.id)) return []
    return results.map(item => item.id!)
  }
  return []
}

/** A historical retry resumes only complete input; unresolved calls are never replayed. */
export function isCompleteModelInput(messages: readonly ConversationMessage[]): boolean {
  const pending = new Set<string>()
  for (const message of messages) {
    if (message.partial) return false
    if (message.kind === 'assistant') {
      if (pending.size) return false
      for (const call of message.calls ?? []) {
        if (!call.id || pending.has(call.id)) return false
        pending.add(call.id)
      }
    } else if (message.kind === 'tool') {
      if (!message.resultFor || !pending.delete(message.resultFor)) return false
    } else if (message.kind === 'user' && pending.size) return false
  }
  const last = messages.at(-1)
  return pending.size === 0 && (last?.kind === 'user' || last?.kind === 'tool')
}

/** Rebuild this run's plan from confirmed calls, even when their return text was withheld. */
export function modelRetryTodos(messages: readonly ConversationMessage[]): ExecutionState['context']['todos'] {
  let todos: ExecutionState['context']['todos'] = []
  let calls: NonNullable<ConversationMessage['calls']> = []
  for (const message of messages) {
    if (message.kind === 'assistant') calls = message.partial ? [] : message.calls ?? []
    if (message.kind !== 'tool' || message.resultStatus !== 'success' || !message.resultFor) continue
    const call = calls.find(call => call.id === message.resultFor)
    if (call?.name === planningToolSpec.name) todos = planningToolSpec.inputSchema.parse(call.args).todos
  }
  return todos
}

/** The user explicitly replaces the saved return value; the tool's execution status stays unchanged. */
export function withholdToolResult(message: ConversationMessage): ConversationMessage {
  if (message.kind !== 'tool') throw new Error('Only tool results can be withheld.')
  return { ...message, content: withheldToolResultText, artifact: undefined, resultMetadata: undefined,
    context: { ...message.context, resultWithheld: true } }
}
