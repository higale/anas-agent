import { modelParameterInputTokens, type ModelInputBudgetOptions } from './modelInputBudget'
import { ModelSelectionError } from './errors'
import type { ModelUsage } from './modelUsage'

export interface SummaryResponse {
  text: string
  id?: string
  usage?: ModelUsage
}

export type GenerateSummary = (prompt: string, signal?: AbortSignal, preparation?: CompressionPreparation) => Promise<SummaryResponse>

export interface SummaryTranscriptMessage {
  speaker: string
  name?: string
  content: unknown
  calls?: readonly unknown[]
  functionCall?: unknown
}

const omittedSummaryBlocks = new Set(['reasoning', 'tool_call', 'tool_call_chunk',
  'invalid_tool_call', 'server_tool_call', 'server_tool_call_chunk', 'server_tool_call_result', 'non_standard'])
const summaryMediaLabels: Record<string, string> = {
  image: 'image', image_url: 'image', audio: 'audio', input_audio: 'audio', video: 'video', file: 'file'
}

function summaryBlock(block: unknown): unknown {
  if (typeof block === 'string') return block
  if (block === null || block === undefined) throw new Error('Invalid empty content block in summary history.')
  if (typeof block !== 'object') return ''
  const value = block as Record<string, unknown>
  if (value.type === 'text') return value.text ?? ''
  if (value.type === 'text-plain') return value.text ?? '[text-plain file]'
  if (!value.type) return ''
  const type = String(value.type)
  if (omittedSummaryBlocks.has(type)) return ''
  return `[${Object.hasOwn(summaryMediaLabels, type) ? summaryMediaLabels[type] : type}]`
}

/** Preserve the existing summary prompt's roles, calls and media placeholders.
 * Binary content and provider bookkeeping are not serialized into the prompt.
 * Rendering behavior is based on the imported LangChain Core baseline; see THIRD_PARTY_NOTICES.md. */
export function summaryTranscript(messages: readonly SummaryTranscriptMessage[]): string {
  return messages.map(message => {
    const content = typeof message.content === 'string' ? message.content
      : Array.isArray(message.content) ? message.content.map(summaryBlock).filter(Boolean).join('') : ''
    const calls = message.calls?.length ? JSON.stringify(message.calls)
      : 'functionCall' in message ? String(JSON.stringify(message.functionCall)) : ''
    return `${message.speaker}: ${message.name ? `${message.name}, ` : ''}${content}${calls}`
  }).join('\n')
}

export interface CompressionCompletion {
  modelContent: string
  cutoffIndex: number
  activatedAfterMessageIndex: number
  coveredThroughMessageId?: string
  firstPreservedMessageId?: string
  inputTokensBefore: number
  inputTokensAfter: number
}

export interface ManualContextCompression extends CompressionCompletion {
  summaryText: string
}

export interface CompressionTrackingCallbacks {
  onCompressionStart?(): string
  onCompressionCompleted?(
    summaryId: string,
    summaryText: string,
    completion?: CompressionCompletion
  ): void
  onCompressionFailed?(summaryId: string): void
}

/** A generated manual summary remains provisional until the store commits its
 * exact content and boundary. Generation alone cannot complete the run. */
export async function stageManualCompression(
  generate: () => Promise<ManualContextCompression>,
  callbacks: CompressionTrackingCallbacks
): Promise<ManualContextCompression & { id: string }> {
  const id = callbacks.onCompressionStart?.()
  if (!id) throw new Error('Manual context compression requires durable summary tracking.')
  try {
    const compression = await generate()
    const { summaryText, ...completion } = compression
    callbacks.onCompressionCompleted?.(id, summaryText, completion)
    return { ...compression, id }
  } catch (error) {
    callbacks.onCompressionFailed?.(id)
    throw error
  }
}

export interface GeneratedCompressionSummary {
  callbacks?: CompressionTrackingCallbacks
  id?: string
  state: 'pending' | 'staged' | 'failed'
  text: string
}

export interface CompressionPreparation {
  activeUserRequest?: string
  inputCapacityTokens?: number
  tokenCountingOptions?: ModelInputBudgetOptions
  generated: GeneratedCompressionSummary[]
}

function discardSummary(summary: GeneratedCompressionSummary): void {
  if (summary.state === 'failed') return
  summary.state = 'failed'
  if (summary.id) summary.callbacks?.onCompressionFailed?.(summary.id)
}

/** Stage the newest prepared summary against its history boundary. The store
 * still owns durable commit acknowledgement; staging alone is not completion. */
export function stageCompressionSummary(
  generated: GeneratedCompressionSummary[],
  describe?: (summaryId: string) => CompressionCompletion
): void {
  const pending = generated.filter(summary => summary.state === 'pending')
  const selected = pending.at(-1)
  if (!selected) return
  if (!describe) {
    for (const summary of pending) discardSummary(summary)
    return
  }
  for (const summary of pending.slice(0, -1)) discardSummary(summary)
  selected.state = 'staged'
  if (selected.id) {
    const completion = describe(selected.id)
    selected.callbacks?.onCompressionCompleted?.(selected.id, selected.text, completion)
  }
}

const activeUserRequestStart = '<active_user_request>'
const activeUserRequestEnd = '</active_user_request>'
const activeUserRequestPattern = new RegExp(
  `\\n*${activeUserRequestStart}[\\s\\S]*?${activeUserRequestEnd}\\n*`,
  'g'
)

function finalizedSummaryText(text: string, preparation?: CompressionPreparation): string {
  const summary = text.replace(activeUserRequestPattern, '\n').trim()
  if (!summary) throw new ModelSelectionError('Context compression returned an empty summary. The run was stopped without replacing its history. Try again or select another model.')
  const activeUserRequest = preparation?.activeUserRequest?.trim()
  if (!activeUserRequest) return summary
  return [
    summary,
    activeUserRequestStart,
    activeUserRequest,
    activeUserRequestEnd
  ].filter(Boolean).join('\n\n')
}

/** Keep generated summaries provisional until the caller stages the matching
 * history boundary. Failure discards every provisional result in this attempt. */
export async function prepareCompression<Result>(
  context: Omit<CompressionPreparation, 'generated'>,
  action: (preparation: CompressionPreparation) => Promise<Result>
): Promise<Result> {
  const preparation: CompressionPreparation = { ...context, generated: [] }
  try {
    return await action(preparation)
  } catch (error) {
    for (const generated of preparation.generated) discardSummary(generated)
    throw error
  }
}

export async function trackCompressionSummary<Result extends { text: string }>(
  prompt: string,
  callbacks: CompressionTrackingCallbacks | undefined,
  generate: () => Promise<Result>,
  options: { beforePrepare?: () => Promise<void>; preparation?: CompressionPreparation } = {}
): Promise<Result> {
  const summaryId = callbacks?.onCompressionStart?.()
  try {
    // Preparation may have awaited attachment or backend work. Refresh before
    // judging the summary against a budget captured by the outer model call.
    await options.beforePrepare?.()
    const scope = options.preparation
    const capacity = scope?.inputCapacityTokens
    if (capacity !== undefined && (Math.ceil(prompt.length / 4) + modelParameterInputTokens(scope?.tokenCountingOptions?.protocol, scope?.tokenCountingOptions?.parameters)) > capacity) {
      throw new ModelSelectionError('The complete summary input exceeds the model capacity. The run was stopped without replacing its history. Choose a larger-context model and send again.')
    }
    const response = await generate()
    const summaryText = finalizedSummaryText(response.text, scope)
    if (scope) {
      scope.generated.push({
        callbacks,
        id: summaryId,
        state: 'pending',
        text: summaryText
      })
    } else if (summaryId) {
      callbacks?.onCompressionCompleted?.(summaryId, summaryText)
    }
    return { ...response, text: summaryText }
  } catch (error) {
    if (summaryId) callbacks?.onCompressionFailed?.(summaryId)
    throw error
  }
}
