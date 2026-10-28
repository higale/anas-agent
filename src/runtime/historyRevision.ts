export interface HistoryRevisionMessage {
  id?: string
  role: 'user' | 'assistant' | 'tool' | 'other'
  runId?: string
}

/** Select the existing product's edit boundary, without modifying history. */
export function historyRevisionBoundary(messages: readonly HistoryRevisionMessage[], messageId: string, kind: 'truncate' | 'regenerate') {
  const index = messages.findIndex(message => message.id === messageId)
  if (index < 0) throw new Error(`Message ${messageId} was not found.`)
  const target = messages[index]
  if (kind === 'regenerate' && target.role !== 'user') throw new Error('Only user messages can be resent.')
  if (!target.runId) throw new Error(`Message ${messageId} is missing its run association.`)
  const retainedCount = kind === 'regenerate' ? index : messages.findIndex(message => message.runId === target.runId)
  if (retainedCount < 0) throw new Error(`Run ${target.runId} has no input message.`)
  return { targetIndex: index, retainedCount, fromRunId: target.runId }
}

/** Replace only the original prompt slot; media and later text remain intact. */
export function regenerationContent(content: string | readonly Record<string, unknown>[], hasSkill: boolean, skillPromptText?: string): string | Record<string, unknown>[] {
  if (!hasSkill) {
    if (skillPromptText !== undefined) throw new Error('Skill instructions were provided for a non-skill message.')
    return typeof content === 'string' ? content : [...content]
  }
  if (!skillPromptText) throw new Error('Skill instructions must be refreshed before regenerating this message.')
  if (typeof content === 'string') return skillPromptText
  let replaced = false
  const result = content.map(block => {
    if (replaced || !block || typeof block !== 'object' || (block.type !== 'text' && block.type !== 'text-plain') || typeof block.text !== 'string') return block
    replaced = true
    return { ...block, text: skillPromptText }
  })
  if (!replaced) result.unshift({ type: 'text', text: skillPromptText })
  return result
}
