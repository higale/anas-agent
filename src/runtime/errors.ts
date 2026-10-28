/** Walk nested provider and runtime failures without revisiting cycles. */
export function errorCauses(error: unknown): object[] {
  const causes: object[] = []
  const seen = new Set<unknown>()
  const pending = [error]
  while (pending.length > 0) {
    const current = pending.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    causes.push(current)
    seen.add(current)
    const record = current as { cause?: unknown; error?: unknown }
    pending.push(record.cause, record.error)
  }
  return causes
}

/** An argument problem the model can correct, distinct from execution/storage failure. */
export class ToolInputError extends Error {
  readonly code = 'TOOL_INPUT_INVALID'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ToolInputError'
  }
}

export class ModelSelectionError extends Error {
  readonly code = 'MODEL_SELECTION_INVALID'

  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModelSelectionError'
  }
}

export function isModelSelectionError(error: unknown): boolean {
  return errorCauses(error).some((cause) => cause instanceof ModelSelectionError)
}

export class ModelContextOverflowError extends ModelSelectionError {
  constructor(message = 'The prepared conversation exceeds the model context window.', options?: ErrorOptions) {
    super(message, options)
    this.name = 'ModelContextOverflowError'
  }
}

/** Recognize provider capacity failures through wrappers without SDK/framework classes. */
export function isModelContextOverflow(error: unknown): boolean {
  return errorCauses(error).some(cause => {
    if (cause instanceof ModelContextOverflowError) return true
    const { code, message, status } = cause as { code?: unknown; message?: unknown; status?: unknown }
    if (code === 'context_length_exceeded') return true
    if (typeof message !== 'string') return false
    return /context_length_exceeded|input tokens exceed the configured limit|exceeds the context window|maximum context length/i.test(message)
      || (status === 400 && /prompt is too long/i.test(message))
  })
}

/** Re-enter request preparation if settings changed during asynchronous work. */
export class ModelRequestChangedError extends Error {
  readonly code = 'MODEL_REQUEST_CHANGED'

  constructor() {
    super('The selected model or its parameters kept changing while preparing the request. The run was stopped before sending; select a valid model and send again.')
    this.name = 'ModelRequestChangedError'
  }
}

export function isModelRequestChangedError(error: unknown): boolean {
  return errorCauses(error).some((cause) => cause instanceof ModelRequestChangedError)
}

export class ProjectRulesError extends Error {
  constructor(detail: string) {
    super(`Project rules cannot be applied: ${detail} This run cannot continue automatically. Adjust the rules, model context capacity or operation scope, then start a new turn.`)
    this.name = 'ProjectRulesError'
  }
}

/** A preparation pause, not a failed read or an executable tool call. */
export class ProjectRulesReadRequired extends Error {
  constructor(readonly path: string) {
    super(`Reading project rules requires approval: ${path}`)
    this.name = 'ProjectRulesReadRequired'
  }
}

export class ProjectRulesRequestBudgetError extends ProjectRulesError {
  constructor(tokens: number, readonly inputCapacityTokens: number) {
    super(`Final model request needs about ${tokens} input tokens; safe capacity is ${inputCapacityTokens}, including reply reserve and estimation margin.`)
  }
}

export function isProjectRulesError(error: unknown): boolean {
  return errorCauses(error).some((cause) => cause instanceof ProjectRulesError || ('name' in cause && cause.name === 'ProjectRulesError'))
}

export class IncompleteModelResponseError extends Error {
  readonly code = 'MODEL_RESPONSE_INCOMPLETE'

  constructor() {
    super('The model stream ended before a complete response was received. No tool calls from this response can be executed.')
    this.name = 'IncompleteModelResponseError'
  }
}
