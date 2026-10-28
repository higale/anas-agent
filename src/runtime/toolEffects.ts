import type { ToolApprovalRequest } from './toolApproval'

export type ToolEffectRecoveryMode = 'confirm' | 'idempotent'

export interface ToolEffectArm {
  kind: string
  target: unknown
  recoveryMode?: ToolEffectRecoveryMode
  idempotencyFingerprint?: string
}

/** The journal owns these values; execution never keeps a second durable state. */
export interface ToolEffectJournalState {
  callKey: string
  toolName: string
  argsJson: string
  targetJson?: string
  state: 'prepared' | 'intent' | 'result'
  recoveryMode: ToolEffectRecoveryMode
  effectAttempt: number
  confirmationCount: number
  automaticRetryCount: number
}

type RecoveryDecision = { type: 'approve' } | { type: 'reject'; message?: string }
type Retry = { kind: 'automatic'; expectedAutomaticRetryCount: number }
  | { kind: 'approved'; expectedConfirmationCount: number }
type RejectedConfirmation = { kind: 'rejected'; expectedConfirmationCount: number }
export type ToolEffectRecoveryRequest = ToolApprovalRequest & {
  actionRequests: Array<ToolApprovalRequest['actionRequests'][number] & {
    anasRecovery: { ordinal: number; state: 'uncertain' }
  }>
}

export interface ToolEffectAttempt {
  arm(effect: ToolEffectArm): void
  deferResult(): void
}

/** Host operations bind one existing journal identity, storage codec and task.
 * The result is opaque so execution does not construct graph or UI messages. */
export interface ToolEffectExecution<State extends ToolEffectJournalState, Result> {
  initial: State
  initialArmRecoveryMode?: ToolEffectRecoveryMode
  load(): State | undefined
  arm(effect: ToolEffectArm): State
  retry(decision: Retry): State
  save(result: Result, confirmation?: RejectedConfirmation): Promise<State>
  restore(row: State): Promise<Result>
  recoverManaged(row: State): Promise<Result | undefined>
  requestRecovery(request: ToolEffectRecoveryRequest): unknown | Promise<unknown>
  errorResult(content: string, row: State): Result
  invoke(attempt: ToolEffectAttempt): Result | Promise<Result>
  isInterruption(error: unknown): boolean
  cleanup(): void
}

const maximumAutomaticRetries = 3

function jsonValue(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Tool effect values must contain only finite numbers.')
    return value
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('Tool effect values must not contain cycles.')
    seen.add(value)
    const normalized = value.map(item => item === undefined ? null : jsonValue(item, seen))
    seen.delete(value)
    return normalized
  }
  if (typeof value !== 'object') return null
  if (seen.has(value)) throw new Error('Tool effect values must not contain cycles.')
  seen.add(value)
  const normalized = Object.create(null) as Record<string, unknown>
  for (const key of Object.keys(value).sort()) {
    const item = (value as Record<string, unknown>)[key]
    if (item !== undefined) normalized[key] = jsonValue(item, seen)
  }
  seen.delete(value)
  return normalized
}

export function canonicalToolEffectJson(value: unknown): string {
  return JSON.stringify(jsonValue(value, new Set()))
}

function recoveryTarget(row: ToolEffectJournalState): unknown {
  return JSON.parse(row.targetJson ?? row.argsJson)
}

export function toolEffectRecoveryRequest(row: ToolEffectJournalState, ordinal: number, failure?: unknown): ToolEffectRecoveryRequest {
  const target = recoveryTarget(row)
  const reason = failure instanceof Error && failure.message ? `\nLast observed error: ${failure.message}` : ''
  return {
    actionRequests: [{
      name: row.toolName,
      args: { ...JSON.parse(row.argsJson) as Record<string, unknown>, anas_recovery_target: target },
      description: [
        'The application stopped after crossing the external operation boundary.',
        'The operation may already have happened, and retrying may repeat it.',
        `Resolved target: ${JSON.stringify(target, null, 2)}${reason}`,
        'Choose Retry to run the operation again, or Do not retry to keep the current external state.'
      ].join('\n'),
      anasRecovery: { ordinal, state: 'uncertain' }
    }],
    reviewConfigs: [{ actionName: row.toolName, allowedDecisions: ['approve', 'reject'] }]
  }
}

export function toolEffectRecoveryDecision(value: unknown): RecoveryDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid recovery response: expected a HITL response object.')
  }
  const decisions = (value as { decisions?: unknown }).decisions
  if (!Array.isArray(decisions) || decisions.length !== 1) {
    throw new Error('Invalid recovery response: expected exactly one decision.')
  }
  const decision = decisions[0]
  if (!decision || typeof decision !== 'object' || Array.isArray(decision)) throw new Error('Invalid recovery response decision.')
  const type = (decision as { type?: unknown }).type
  if (type === 'approve') return { type }
  if (type === 'reject') {
    const message = (decision as { message?: unknown }).message
    if (message !== undefined && typeof message !== 'string') throw new Error('Invalid recovery rejection message.')
    return { type, ...(message === undefined ? {} : { message }) }
  }
  throw new Error(`Invalid recovery decision type: ${String(type)}.`)
}

export function toolEffectRejectionText(row: ToolEffectJournalState, message?: string): string {
  const base = [
    `The user chose not to retry ${row.toolName}.`,
    'The earlier operation may already have happened; choosing not to retry does not mean it was undone.',
    `Resolved recovery target: ${JSON.stringify(recoveryTarget(row))}`
  ].join(' ')
  return message ? `${base}\n\nUser feedback: ${message}` : base
}

/** Resume or execute one effect, preserving confirmed results and retry ordinals. */
export async function executeJournaledTool<State extends ToolEffectJournalState, Result>(
  execution: ToolEffectExecution<State, Result>
): Promise<Result> {
  let row = execution.initial
  let ordinal = row.confirmationCount
  const requestRecovery = async (failure?: unknown) => toolEffectRecoveryDecision(
    await execution.requestRecovery(toolEffectRecoveryRequest(row, ++ordinal, failure))
  )
  const restore = async () => {
    const result = await execution.restore(row)
    execution.cleanup()
    return result
  }
  const recover = async (failure?: unknown): Promise<State> => {
    if (row.recoveryMode === 'idempotent' && row.automaticRetryCount < maximumAutomaticRetries) {
      return execution.retry({ kind: 'automatic', expectedAutomaticRetryCount: row.automaticRetryCount })
    }
    if (row.recoveryMode === 'idempotent') {
      return execution.save(execution.errorResult(
        `Automatic recovery stopped after ${maximumAutomaticRetries} attempts. The external operation may have completed, but no result was received.`, row
      ))
    }
    const decision = await requestRecovery(failure)
    if (decision.type === 'approve') {
      return execution.retry({ kind: 'approved', expectedConfirmationCount: row.confirmationCount })
    }
    return execution.save(execution.errorResult(toolEffectRejectionText(row, decision.message), row), {
      kind: 'rejected', expectedConfirmationCount: row.confirmationCount
    })
  }

  // Persisted confirmations have already changed the journal. Native execution
  // asks only about the next uncertainty, never about previously settled work.
  if (row.state === 'result') return restore()
  if (row.state === 'intent') {
    const recovered = await execution.recoverManaged(row)
    if (recovered !== undefined) return recovered
    row = await recover()
    if (row.state === 'result') return restore()
  }
  while (row.state === 'prepared') {
    let armed = false
    let deferred = false
    const attempt: ToolEffectAttempt = {
      arm(effect) {
        if (armed) return
        const kind = effect.kind.trim()
        if (!kind) throw new Error('Tool effect kind must not be empty.')
        const recoveryMode = effect.recoveryMode ?? (row.effectAttempt === 0 ? execution.initialArmRecoveryMode : undefined)
        row = execution.arm({ ...effect, kind, ...(recoveryMode ? { recoveryMode } : {}) })
        armed = true
      },
      deferResult() { deferred = true }
    }
    try {
      const result = await execution.invoke(attempt)
      if (deferred) return result
      row = await execution.save(result)
      execution.cleanup()
      return result
    } catch (error) {
      if (execution.isInterruption(error)) throw error
      const durable = execution.load()
      if (!durable) throw new Error(`Tool effect journal entry ${row.callKey} disappeared.`)
      row = durable
      if (row.state === 'result') return restore()
      if (!armed || row.state !== 'intent') throw error
      const recovered = await execution.recoverManaged(row)
      if (recovered !== undefined) return recovered
      row = await recover(error)
      if (row.state === 'result') return restore()
    }
  }
  return restore()
}
