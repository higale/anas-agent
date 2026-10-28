import { describe, expect, it } from 'vitest'
import { ModelRequestChangedError, ModelSelectionError, ProjectRulesError } from './errors'
import { classifyRunRecovery, hasCompletedCommit, runFailureDisposition, type RunRecoveryEvidence } from './runRecovery'

const empty: RunRecoveryEvidence = {
  taskProgress: false, cancellationRequested: false, hasFatalFailure: () => false,
  hasPendingInput: () => false, unhandledTaskFailure: false, hasPendingResume: () => false
}

describe('durable run recovery decisions', () => {
  it('keeps a completed current revision authoritative without reading stale failure or intent data', () => {
    const evidence: RunRecoveryEvidence = { ...empty, currentCommitId: 'current', completedCommitId: 'current',
      cancellationRequested: true,
      hasFatalFailure: (): boolean => { throw new Error('obsolete failure unreadable') },
      hasPendingInput: (): boolean => { throw new Error('obsolete input unreadable') },
      hasPendingResume: (): boolean => { throw new Error('obsolete approval unreadable') }
    }
    expect(classifyRunRecovery(evidence)).toBe('terminal')
    expect(runFailureDisposition('terminal', new ProjectRulesError('late display failure'), false)).toBe('complete')
  })

  it('does not confuse a previous completion or absent IDs with this run completing', () => {
    expect(hasCompletedCommit('current', 'previous')).toBe(false)
    expect(hasCompletedCommit(undefined, undefined)).toBe(false)
    expect(hasCompletedCommit(null, null)).toBe(false)
    expect(classifyRunRecovery({ ...empty, currentCommitId: 'current', completedCommitId: 'previous' })).toBe('recoverable')
  })

  it('honors durable cancellation before inspecting failures or queued input', () => {
    expect(classifyRunRecovery({ ...empty, cancellationRequested: true,
      hasFatalFailure: (): boolean => { throw new Error('unreadable stale failure') },
      hasPendingInput: (): boolean => { throw new Error('unreadable stale input') }
    })).toBe('cancellation')
    expect(runFailureDisposition('cancellation', new Error('cleanup failed'), false)).toBe('cancel')
  })

  it('preserves a fresh input over an old task error, but never over a fatal run failure', () => {
    const evidence = { ...empty, hasPendingInput: () => true, unhandledTaskFailure: true }
    expect(classifyRunRecovery(evidence)).toBe('recoverable')
    expect(classifyRunRecovery({ ...evidence, hasFatalFailure: () => true })).toBe('error')
  })

  it('does not hide an unresolved task failure behind a resume or committed progress', () => {
    expect(classifyRunRecovery({ ...empty, currentCommitId: 'current', taskProgress: true,
      hasPendingResume: () => true, unhandledTaskFailure: true })).toBe('error')
  })

  it.each([
    { taskProgress: true }, { hasPendingResume: () => true }, { hasPendingInput: () => true }, { currentCommitId: 'current' }
  ])('keeps saved work recoverable without claiming completion: %j', progress => {
    expect(classifyRunRecovery({ ...empty, ...progress })).toBe('recoverable')
    expect(runFailureDisposition('recoverable', new Error('commit acknowledgement lost'), false)).toBe('retain')
  })

  it('reports no progress when no durable input, resume, task or commit exists', () => {
    expect(classifyRunRecovery(empty)).toBe('no_progress')
    expect(runFailureDisposition('no_progress', new Error('initialization failed'), true)).toBe('fail')
  })

  it('propagates errors reading required evidence instead of assuming there is no saved work', () => {
    const failure = new Error('invalid saved input')
    expect(() => classifyRunRecovery({ ...empty, hasPendingInput: (): boolean => { throw failure } })).toThrow(failure)
  })

  it.each([
    new ProjectRulesError('rules exceed capacity'), new ModelSelectionError('missing model'), new ModelRequestChangedError()
  ])('ends a recoverable run when configuration must be corrected: %s', cause => {
    const wrapped = new Error('execution failed', { cause })
    expect(runFailureDisposition('recoverable', wrapped, false)).toBe('fail')
  })

  it('distinguishes a fresh pre-execution failure from failure after durable work', () => {
    const failure = new Error('cannot assemble execution')
    expect(runFailureDisposition('recoverable', failure, true)).toBe('fail')
    expect(runFailureDisposition('recoverable', failure, false)).toBe('retain')
    expect(runFailureDisposition('error', failure, false)).toBe('fail')
  })
})
