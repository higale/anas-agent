import { isModelRequestChangedError, isModelSelectionError, isProjectRulesError } from './errors'

export type RunningRunDurability = 'terminal' | 'cancellation' | 'error' | 'recoverable' | 'no_progress'

/** A final commit belongs to the current revision, never an earlier run head. */
export function hasCompletedCommit(currentId: string | null | undefined, completedId: string | null | undefined): boolean {
  return Boolean(completedId) && completedId === currentId
}

export interface RunRecoveryEvidence {
  currentCommitId?: string
  completedCommitId?: string
  taskProgress: boolean
  cancellationRequested: boolean
  hasFatalFailure(): boolean
  hasPendingInput(): boolean
  unhandledTaskFailure: boolean
  hasPendingResume(): boolean
}

/** Evidence may be read lazily from storage. Preserve precedence so a committed
 * completion does not depend on reading obsolete intents or failure details. */
export function classifyRunRecovery(evidence: RunRecoveryEvidence): RunningRunDurability {
  if (hasCompletedCommit(evidence.currentCommitId, evidence.completedCommitId)) return 'terminal'
  if (evidence.cancellationRequested) return 'cancellation'
  if (evidence.hasFatalFailure()) return 'error'
  // A saved new input supersedes task failures from the previous conversation head.
  if (evidence.hasPendingInput()) return 'recoverable'
  if (evidence.unhandledTaskFailure) return 'error'
  if (evidence.hasPendingResume() || evidence.currentCommitId !== undefined || evidence.taskProgress) return 'recoverable'
  return 'no_progress'
}

export type RunFailureDisposition = 'retain' | 'complete' | 'cancel' | 'fail'

/** Retaining a run keeps its durable work available for explicit recovery; this
 * decision never retries execution or turns an uncertain effect into success. */
export function runFailureDisposition(durability: RunningRunDurability, error: unknown,
  freshInputUnstarted: boolean): RunFailureDisposition {
  if (durability === 'recoverable' && !freshInputUnstarted && !isProjectRulesError(error)
    && !isModelSelectionError(error) && !isModelRequestChangedError(error)) return 'retain'
  if (durability === 'terminal') return 'complete'
  if (durability === 'cancellation') return 'cancel'
  return 'fail'
}
