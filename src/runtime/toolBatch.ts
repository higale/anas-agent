/** Facts from the authoritative history, without executable message objects. */
export type ToolBatchEntry<Call> = { kind: 'response'; calls: readonly Call[] }
  | { kind: 'result'; callId: string }
  | { kind: 'other' }

/** Only results following the newest response answer its calls. A later
 * response with no calls still ends the previous batch. Preserve call identity
 * and order so preflight never rewrites intent or chooses a different journal. */
export function pendingToolBatch<Call extends { id?: string }>(messageCount: number, entryAt: (index: number) => ToolBatchEntry<Call>): {
  responseIndex: number; answered: Set<string>; calls: Call[]
} {
  const results: string[] = []
  for (let responseIndex = messageCount - 1; responseIndex >= 0; responseIndex--) {
    const entry = entryAt(responseIndex)
    if (entry.kind === 'result') results.push(entry.callId)
    if (entry.kind !== 'response') continue
    const answered = new Set(results.reverse())
    return { responseIndex, answered, calls: entry.calls.filter(call => !answered.has(call.id!)) }
  }
  return { responseIndex: -1, answered: new Set(results.reverse()), calls: [] }
}
