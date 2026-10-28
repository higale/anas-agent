export class ModelCallLimitError extends Error {
  readonly code = 'MODEL_CALL_LIMIT_REACHED'

  constructor(readonly completedCalls: number) {
    super(`Model call limits exceeded: run level call limit reached with ${completedCalls} model calls`)
    this.name = 'ModelCallLimitError'
  }
}

/** Zero disables the configured limit. Counts come from the owning run's
 * durable state, never from UI activity or an in-memory request counter. */
export function checkModelCallBudget(limit: number, completedCalls: number): void {
  if (limit > 0 && completedCalls >= limit) throw new ModelCallLimitError(completedCalls)
}
