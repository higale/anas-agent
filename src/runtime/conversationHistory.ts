/** Read-only facts used to plan model history. These are not persisted messages. */
export interface HistoryEntry {
  id?: string
  role: 'user' | 'assistant' | 'tool' | 'other'
  summary?: boolean
  userText?: string
  calls?: readonly { id?: string; name: string }[]
  resultFor?: string
  images?: boolean
}

interface CausalUnit { start: number; end: number }
export interface CompressionRetentionSelection {
  cutoffIndex: number
  retainedTokens: number
  activeUserRequest?: string
}

function isSummaryMessage(message: HistoryEntry): boolean { return message.summary === true }
function isRealUserMessage(message: HistoryEntry): boolean { return message.role === 'user' && !message.summary }

function latestResponseIndex(messages: readonly HistoryEntry[]): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === 'assistant' && !messages[index].summary) return index
  }
  return -1
}

export function isToolImageBlock(block: unknown): boolean {
  return Boolean(block && typeof block === 'object' && 'type' in block
    && ['image', 'image_url', 'input_image'].includes(String(block.type)))
}

/** Keep the whole pending tool transaction, not only the image result. */
export function pendingToolImageStart(messages: readonly HistoryEntry[]): number | undefined {
  const responseIndex = latestResponseIndex(messages)
  return messages.some((message, index) => index > responseIndex && message.role === 'tool' && message.images)
    ? Math.max(0, responseIndex) : undefined
}

export function consumedToolImageIndices(messages: readonly HistoryEntry[]): number[] {
  const responseIndex = latestResponseIndex(messages)
  return messages.flatMap((message, index) => index < responseIndex && message.role === 'tool' && message.images ? [index] : [])
}

export const unrecordedToolResultText = 'No result is recorded for this tool call. Its outcome is unknown. Check the actual state before attempting the operation again.'
export const omittedToolImageText = '[Tool image provided in an earlier step; omitted from this request.]'

/** Restore the user's display text without losing attachments or review scope. */
export function simpleChatUserContent(input: {
  content: string | readonly unknown[]; displayText?: unknown; summary: boolean; review: boolean
}): string | unknown[] | undefined {
  if (input.summary || input.review || typeof input.displayText !== 'string' || !input.displayText) return undefined
  const displayText = input.displayText
  if (typeof input.content === 'string') return displayText
  let replaced = false
  const content = input.content.map(block => {
    if (!replaced && block && typeof block === 'object' && 'type' in block && block.type === 'text' && 'text' in block) {
      replaced = true
      return { ...block, text: displayText }
    }
    return block
  })
  if (!replaced) content.unshift({ type: 'text', text: displayText })
  return content
}

function isClientToolCallBlock(block: unknown): boolean {
  if (!block || typeof block !== 'object' || !('type' in block)) return false
  if (block.type === 'non_standard' && 'value' in block) return isClientToolCallBlock(block.value)
  return ['tool_call', 'tool_call_chunk', 'invalid_tool_call', 'tool_use', 'function_call', 'custom_tool_call'].includes(String(block.type))
}

/** Remove client calls from every replay representation. A reasoning ID may
 * survive only when its original following provider item survives as well. */
export function simpleChatAssistantContent(input: {
  content: string | readonly unknown[]; providerOutput?: unknown; reasoning?: unknown; refusal?: unknown; hasClientCalls: boolean
}): { content: string | unknown[]; providerOutput: unknown; reasoning: unknown } | undefined {
  const content = typeof input.content === 'string' ? [] : input.content
  const output = Array.isArray(input.providerOutput) ? input.providerOutput : []
  const removesCalls = input.hasClientCalls || content.some(isClientToolCallBlock) || output.some(isClientToolCallBlock)
  const detachedIds = new Map<string, boolean>()
  function item(block: unknown): Record<string, unknown> | undefined {
    if (!block || typeof block !== 'object' || !('type' in block)) return undefined
    return block.type === 'non_standard' && 'value' in block ? item(block.value) : block as Record<string, unknown>
  }
  if (removesCalls) {
    // Complete provider output is authoritative: visible content can omit
    // server tools and would otherwise detach still-valid reasoning IDs.
    for (const blocks of [output, content]) {
      let following: unknown
      for (let index = blocks.length - 1; index >= 0; index--) {
        const block = item(blocks[index])
        if (block?.type === 'reasoning') {
          if (typeof block.id === 'string' && !detachedIds.has(block.id)) {
            detachedIds.set(block.id, following === undefined || isClientToolCallBlock(following))
          }
        } else following = blocks[index]
      }
    }
    const reasoning = item(input.reasoning)
    if (typeof reasoning?.id === 'string' && !detachedIds.has(reasoning.id)) detachedIds.set(reasoning.id, true)
  }
  function project(block: unknown): unknown {
    if (!block || typeof block !== 'object' || !('type' in block)) return block
    if (block.type === 'non_standard' && 'value' in block) return { ...block, value: project(block.value) }
    if (block.type !== 'reasoning' || !('id' in block) || typeof block.id !== 'string' || !detachedIds.get(block.id)) return block
    const { id: _id, ...reasoning } = block
    return reasoning
  }
  const projectedContent = typeof input.content === 'string' ? input.content : content.filter(block => !isClientToolCallBlock(block)).map(project)
  const projectedOutput = Array.isArray(input.providerOutput) ? output.filter(block => !isClientToolCallBlock(block)).map(project) : input.providerOutput
  const reasoning = input.reasoning ? project(input.reasoning) : input.reasoning
  if (!projectedContent.length && !reasoning && !input.refusal && !(Array.isArray(projectedOutput) && projectedOutput.length)) return undefined
  return { content: projectedContent, providerOutput: projectedOutput, reasoning }
}

export type ToolHistoryItem = { index: number } | { missingResult: { callId: string; name: string } }

/** Arrange protocol call/result groups without changing durable history. */
export function toolHistoryPlan(messages: readonly HistoryEntry[]): ToolHistoryItem[] {
  const projected: ToolHistoryItem[] = []
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]
    if (message.role === 'tool') continue
    projected.push({ index })
    if (message.role !== 'assistant' || !message.calls?.length) continue
    const calls = message.calls.filter(call => call.id)
    const ids = new Set(calls.map(call => call.id))
    const answered = new Set<string>()
    for (let resultIndex = index + 1; resultIndex < messages.length; resultIndex++) {
      const result = messages[resultIndex]
      if (result.role === 'assistant') break
      if (result.role !== 'tool' || !ids.has(result.resultFor)) continue
      projected.push({ index: resultIndex })
      answered.add(result.resultFor!)
    }
    for (const call of calls) {
      if (!answered.has(call.id!)) projected.push({ missingResult: { callId: call.id!, name: call.name } })
    }
  }
  return projected
}

export function causalUnits(messages: readonly HistoryEntry[], start: number): CausalUnit[] {
  const units: CausalUnit[] = []
  let index = start
  while (index < messages.length) {
    const unitStart = index
    const message = messages[index]
    index += 1
    if (message.role === 'assistant' && message.calls?.length) {
      const toolCallIds = new Set(message.calls.flatMap((call) => call.id ? [call.id] : []))
      while (
        index < messages.length
        && messages[index].role === 'tool'
        && (
          toolCallIds.size === 0
          || toolCallIds.has(messages[index].resultFor!)
        )
      ) {
        index += 1
      }
    } else if (message.role === 'tool') {
      while (index < messages.length && messages[index].role === 'tool') index += 1
    }
    units.push({
      start: unitStart,
      end: index
    })
  }
  return units
}

function newestCausalSuffix(
  messages: readonly HistoryEntry[],
  start: number,
  tokenLimit: number,
  countRange: (start: number, end: number) => number
): { cutoffIndex: number; retainedTokens: number } {
  const units = causalUnits(messages, start)
  let cutoffIndex = messages.length
  let retainedTokens = 0
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index]
    const tokens = countRange(unit.start, unit.end)
    if (retainedTokens + tokens > tokenLimit) {
      if (retainedTokens === 0) {
        cutoffIndex = unit.start
        retainedTokens = tokens
      }
      break
    }
    cutoffIndex = unit.start
    retainedTokens += tokens
  }
  return { cutoffIndex, retainedTokens }
}

export async function compactedToolContent(content: string | unknown[], maxChars: number, save: (content: string) => Promise<string>): Promise<string> {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  if (text.length <= maxChars) return text
  const path = await save(text)
  const marker = `\n\n[Tool result compacted for model context. Full result (${text.length} characters): ${JSON.stringify(path)}. Read this file for omitted details; do not rerun the operation.]\n\n`
  const retainedChars = Math.max(0, maxChars - marker.length)
  let headChars = Math.ceil(retainedChars * 0.75)
  let tailChars = retainedChars - headChars
  if (headChars > 0 && /[\uD800-\uDBFF]/.test(text[headChars - 1])) headChars--
  if (tailChars > 0 && /[\uDC00-\uDFFF]/.test(text[text.length - tailChars])) tailChars--
  return text.slice(0, headChars) + marker + (tailChars > 0 ? text.slice(-tailChars) : '')
}

/** Shorten request-only results in the newest causal unit. Full content must
 * finish saving before a replacement can be used, including on partial failure. */
export async function compactLatestToolResults(
  messages: readonly (HistoryEntry & { content: string | unknown[] })[],
  inputCapacityTokens: number,
  countWithoutResults: (indices: readonly number[]) => number,
  save: (content: string) => Promise<string>
): Promise<Array<{ index: number; content: string }>> {
  const latestUnit = causalUnits(messages, 0).at(-1)
  if (!latestUnit) return []
  const indices: number[] = []
  for (let index = latestUnit.start; index < latestUnit.end; index++) {
    if (messages[index].role === 'tool' && !messages[index].images) indices.push(index)
  }
  if (!indices.length) return []
  const overhead = countWithoutResults(indices)
  const resultTokens = Math.max(64, Math.floor(inputCapacityTokens * 0.7) - overhead)
  const maxChars = Math.max(256, Math.floor(resultTokens * 4 / indices.length))
  let failure: { reason: unknown } | undefined
  const results = await Promise.all(indices.map(async index => {
    try {
      const original = messages[index].content
      const content = await compactedToolContent(original, maxChars, save)
      return content === (typeof original === 'string' ? original : JSON.stringify(original))
        ? undefined : { index, content }
    } catch (reason) {
      failure ??= { reason }
      return undefined
    }
  }))
  if (failure) throw failure.reason
  return results.flatMap(result => result ? [result] : [])
}

function latestRealUserIndex(messages: readonly HistoryEntry[]): number | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (isRealUserMessage(messages[index])) return index
  }
  return undefined
}

function preservedContainsMessage(
  preserved: readonly HistoryEntry[],
  target: HistoryEntry
): boolean {
  if (preserved.includes(target)) return true
  return Boolean(target.id && preserved.some((message) => message.id === target.id))
}

export function compressionRetention(
  effectiveMessages: readonly HistoryEntry[],
  rawMessages: readonly HistoryEntry[],
  thresholdTokens: number,
  countRange: (start: number, end: number) => number
): CompressionRetentionSelection {
  const currentTurnLimit = Math.max(1, Math.floor(thresholdTokens / 4))
  const olderTurnsLimit = Math.max(1, Math.floor(thresholdTokens / 8))
  const currentUserIndex = latestRealUserIndex(effectiveMessages)
  const currentTurnStart = currentUserIndex
    ?? (effectiveMessages[0] && isSummaryMessage(effectiveMessages[0]) ? 1 : 0)
  const currentTurnTokens = countRange(currentTurnStart, effectiveMessages.length)
  let cutoffIndex = currentTurnStart
  let retainedTokens = currentTurnTokens

  if (currentTurnTokens > currentTurnLimit) {
    const selected = newestCausalSuffix(
      effectiveMessages,
      currentTurnStart,
      currentTurnLimit,
      countRange
    )
    cutoffIndex = selected.cutoffIndex
    retainedTokens = selected.retainedTokens
  } else if (currentUserIndex !== undefined) {
    let olderBudget = Math.min(
      olderTurnsLimit,
      Math.max(0, currentTurnLimit - currentTurnTokens)
    )
    const userIndices = effectiveMessages.flatMap((message, index) =>
      isRealUserMessage(message) && index < currentUserIndex ? [index] : []
    )
    let nextTurnStart = currentUserIndex
    for (let index = userIndices.length - 1; index >= 0; index -= 1) {
      const turnStart = userIndices[index]
      const turnTokens = countRange(turnStart, nextTurnStart)
      if (turnTokens > olderBudget) break
      cutoffIndex = turnStart
      retainedTokens += turnTokens
      olderBudget -= turnTokens
      nextTurnStart = turnStart
    }
  }

  const pendingImagesStart = pendingToolImageStart(effectiveMessages)
  if (pendingImagesStart !== undefined && cutoffIndex > pendingImagesStart) {
    cutoffIndex = pendingImagesStart
    retainedTokens = countRange(cutoffIndex, effectiveMessages.length)
  }
  const summarizedPrefix = effectiveMessages.slice(0, cutoffIndex)
  if (
    summarizedPrefix.length > 0
    && summarizedPrefix.every(isSummaryMessage)
  ) {
    cutoffIndex = 0
    retainedTokens = countRange(0, effectiveMessages.length)
  }

  const latestRawUserIndex = latestRealUserIndex(rawMessages)
  const latestRawUser = latestRawUserIndex === undefined
    ? undefined
    : rawMessages[latestRawUserIndex]
  const preserved = effectiveMessages.slice(cutoffIndex)
  const activeUserRequest = latestRawUser
    && !preservedContainsMessage(preserved, latestRawUser)
    ? latestRawUser.userText?.trim() || undefined
    : undefined

  return {
    cutoffIndex,
    retainedTokens: Math.max(1, retainedTokens),
    activeUserRequest
  }
}
