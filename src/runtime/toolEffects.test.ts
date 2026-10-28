import { describe, expect, it, vi } from 'vitest'
import { executeJournaledTool, type ToolEffectAttempt, type ToolEffectExecution,
  type ToolEffectJournalState, type ToolEffectRecoveryRequest } from './toolEffects'

type Result = { content: string; error?: boolean }
type Row = ToolEffectJournalState & { result?: Result }

function harness(initial: Partial<Row> = {}) {
  let row: Row = { callKey: 'call-1', toolName: 'write_file', argsJson: '{"path":"draft.txt"}',
    state: 'prepared', recoveryMode: 'confirm', effectAttempt: 0, confirmationCount: 0, automaticRetryCount: 0, ...initial }
  const execution = {
    initial: row,
    load: vi.fn(() => row),
    arm: vi.fn<ToolEffectExecution<Row, Result>['arm']>(effect => row = { ...row, state: 'intent',
      effectAttempt: row.effectAttempt + 1, targetJson: JSON.stringify(effect.target), recoveryMode: effect.recoveryMode ?? row.recoveryMode }),
    retry: vi.fn<ToolEffectExecution<Row, Result>['retry']>(decision => row = { ...row, state: 'prepared',
      confirmationCount: row.confirmationCount + Number(decision.kind === 'approved'),
      automaticRetryCount: row.automaticRetryCount + Number(decision.kind === 'automatic') }),
    save: vi.fn<ToolEffectExecution<Row, Result>['save']>(async (result, confirmation) => row = { ...row, state: 'result', result,
      confirmationCount: row.confirmationCount + Number(confirmation?.kind === 'rejected') }),
    restore: vi.fn(async (saved: Row) => {
      if (!saved.result) throw new Error('Missing saved result')
      return saved.result
    }),
    recoverManaged: vi.fn<ToolEffectExecution<Row, Result>['recoverManaged']>(async () => undefined),
    requestRecovery: vi.fn<(request: ToolEffectRecoveryRequest) => Promise<unknown>>(async () => ({ decisions: [{ type: 'approve' }] })),
    errorResult: (content: string): Result => ({ content, error: true }),
    invoke: vi.fn<ToolEffectExecution<Row, Result>['invoke']>(attempt => {
      attempt.arm({ kind: 'write', target: '/resolved/draft.txt' })
      return { content: 'saved' }
    }),
    isInterruption: vi.fn<(error: unknown) => boolean>(() => false),
    cleanup: vi.fn()
  } satisfies ToolEffectExecution<Row, Result>
  return { execution, state: () => row, run: () => executeJournaledTool(execution) }
}

describe('journaled tool execution without a graph runtime', () => {
  it.each([0, 2])('returns the exact saved result without executing or replaying %s prior decisions', async confirmationCount => {
    const result = { content: 'already completed' }
    const h = harness({ state: 'result', result, confirmationCount })
    expect(await h.run()).toBe(result)
    expect(h.execution.invoke).not.toHaveBeenCalled()
    expect(h.execution.requestRecovery).not.toHaveBeenCalled()
    expect(h.execution.save).not.toHaveBeenCalled()
    expect(h.execution.cleanup).toHaveBeenCalledOnce()
  })

  it('waits for recovery approval before retrying an uncertain effect', async () => {
    const h = harness({ state: 'intent', effectAttempt: 1, targetJson: '"/resolved/draft.txt"' })
    let answer!: (value: unknown) => void
    const approval = new Promise(resolve => { answer = resolve })
    h.execution.requestRecovery.mockReturnValue(approval)
    const pending = h.run()
    await vi.waitFor(() => expect(h.execution.requestRecovery).toHaveBeenCalledOnce())
    expect(h.execution.invoke).not.toHaveBeenCalled()
    expect(h.execution.retry).not.toHaveBeenCalled()
    expect(h.execution.requestRecovery.mock.calls[0][0].actionRequests[0]).toMatchObject({
      args: { path: 'draft.txt', anas_recovery_target: '/resolved/draft.txt' }, anasRecovery: { ordinal: 1, state: 'uncertain' }
    })
    answer({ decisions: [{ type: 'approve' }] })
    expect(await pending).toEqual({ content: 'saved' })
    expect(h.execution.invoke).toHaveBeenCalledOnce()
    expect(h.state()).toMatchObject({ state: 'result', effectAttempt: 2, confirmationCount: 1 })
  })

  it('keeps a rejected uncertain effect explicit instead of claiming rollback', async () => {
    const h = harness({ state: 'intent', effectAttempt: 1 })
    h.execution.requestRecovery.mockResolvedValue({ decisions: [{ type: 'reject', message: '' }] })
    expect(await h.run()).toMatchObject({ error: true, content: expect.stringContaining('does not mean it was undone') })
    expect(h.execution.invoke).not.toHaveBeenCalled()
    expect(h.state()).toMatchObject({ state: 'result', confirmationCount: 1 })
  })

  it('bounds automatic retries and preserves uncertainty after exhaustion', async () => {
    const h = harness({ state: 'intent', recoveryMode: 'idempotent', effectAttempt: 1 })
    h.execution.invoke.mockImplementation(attempt => {
      attempt.arm({ kind: 'write', target: '/resolved/draft.txt' })
      throw new Error('Lost acknowledgement')
    })
    expect(await h.run()).toMatchObject({ error: true, content: expect.stringContaining('may have completed') })
    expect(h.execution.invoke).toHaveBeenCalledTimes(3)
    expect(h.execution.requestRecovery).not.toHaveBeenCalled()
    expect(h.state()).toMatchObject({ state: 'result', automaticRetryCount: 3 })
  })

  it('uses the next persisted ordinal without requesting saved decisions again', async () => {
    const h = harness({ state: 'intent', effectAttempt: 2, confirmationCount: 2 })
    h.execution.requestRecovery
      .mockResolvedValueOnce({ decisions: [{ type: 'approve' }] })
      .mockResolvedValueOnce({ decisions: [{ type: 'reject', message: 'Keep current state' }] })
    h.execution.invoke.mockImplementation(attempt => {
      attempt.arm({ kind: 'write', target: '/resolved/draft.txt' })
      throw new Error('Acknowledgement missing again')
    })
    expect(await h.run()).toMatchObject({ error: true, content: expect.stringContaining('Keep current state') })
    expect(h.execution.requestRecovery.mock.calls.map(([request]) => request.actionRequests[0].anasRecovery.ordinal)).toEqual([3, 4])
    expect(h.execution.invoke).toHaveBeenCalledOnce()
    expect(h.state().confirmationCount).toBe(4)
  })

  it('propagates task suspension without recovering or finishing its effect', async () => {
    const h = harness()
    const suspension = new Error('Suspended task')
    h.execution.isInterruption.mockImplementation(error => error === suspension)
    h.execution.invoke.mockImplementation(attempt => {
      attempt.arm({ kind: 'write', target: '/resolved/draft.txt' })
      throw suspension
    })
    await expect(h.run()).rejects.toBe(suspension)
    expect(h.state().state).toBe('intent')
    expect(h.execution.requestRecovery).not.toHaveBeenCalled()
    expect(h.execution.save).not.toHaveBeenCalled()
  })

  it('keeps a queued handoff uncommitted and reconnects to its eventual managed result', async () => {
    const h = harness()
    let queued!: ToolEffectAttempt
    const handle = { content: 'background call-1' }
    h.execution.invoke.mockImplementation(attempt => {
      queued = attempt
      attempt.deferResult()
      return handle
    })
    expect(await h.run()).toBe(handle)
    expect(h.state().state).toBe('prepared')
    expect(h.execution.save).not.toHaveBeenCalled()
    expect(h.execution.cleanup).not.toHaveBeenCalled()
    queued.arm({ kind: 'write', target: '/resolved/draft.txt' })
    const completed = { content: 'background completed' }
    h.execution.initial = h.state()
    h.execution.recoverManaged.mockResolvedValue(completed)
    expect(await h.run()).toBe(completed)
    expect(h.execution.invoke).toHaveBeenCalledOnce()
    expect(h.execution.requestRecovery).not.toHaveBeenCalled()
  })

  it('reads a committed result when acknowledgement of the save fails', async () => {
    const h = harness()
    const save = h.execution.save.getMockImplementation()!
    h.execution.save.mockImplementation(async (...args) => {
      await save(...args)
      throw new Error('Lost save acknowledgement')
    })
    expect(await h.run()).toEqual({ content: 'saved' })
    expect(h.execution.invoke).toHaveBeenCalledOnce()
    expect(h.execution.restore).toHaveBeenCalledOnce()
    expect(h.execution.requestRecovery).not.toHaveBeenCalled()
  })

  it('propagates a failure before the effect boundary without asking to retry', async () => {
    const h = harness(), error = new Error('Invalid resolved target')
    h.execution.invoke.mockImplementation(() => { throw error })
    await expect(h.run()).rejects.toBe(error)
    expect(h.state().state).toBe('prepared')
    expect(h.execution.requestRecovery).not.toHaveBeenCalled()
  })

  it.each([{ decisions: [] }, { decisions: [{ type: 'edit' }] }, { decisions: [{ type: 'reject', message: 0 }] }])(
    'does not retry or store a fabricated result for invalid recovery input %j', async response => {
      const h = harness({ state: 'intent', effectAttempt: 1 })
      h.execution.requestRecovery.mockResolvedValue(response)
      await expect(h.run()).rejects.toThrow('Invalid recovery')
      expect(h.execution.invoke).not.toHaveBeenCalled()
      expect(h.execution.retry).not.toHaveBeenCalled()
      expect(h.execution.save).not.toHaveBeenCalled()
    }
  )
})
