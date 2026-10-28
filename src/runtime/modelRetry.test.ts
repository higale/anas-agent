import { afterEach, describe, expect, it, vi } from 'vitest'
import { errorCauses, isModelContextOverflow, ModelRequestChangedError, ModelSelectionError, ProjectRulesRequestBudgetError } from './errors'
import { invokeModelWithRetry, classifyModelRetryError } from './modelRetry'

afterEach(() => vi.useRealTimers())

describe('model request policy without a host or framework', () => {
  it('preserves provider rejection diagnostics and capacity recognition without retrying the same input', async () => {
    const failure = Object.assign(new Error('prompt is too long: 2000 > 1000'), { status: 400 })
    const invoke = vi.fn().mockRejectedValue(failure)
    expect(classifyModelRetryError(failure)).toMatchObject({ retry: false, status: 400 })
    const result = await invokeModelWithRetry(invoke, { initialDelayMs: 0 }).catch(error => error)
    expect(result).toBeInstanceOf(ModelSelectionError)
    expect(result.cause).toBe(failure)
    expect(isModelContextOverflow(result)).toBe(true)
    expect(invoke).toHaveBeenCalledOnce()
  })

  it('walks cyclic provider error envelopes and keeps terminal runtime failures terminal', async () => {
    const failure = new ModelSelectionError('Select a model')
    const envelope = { status: 503, cause: failure, error: {} as unknown }
    envelope.error = envelope
    expect(errorCauses(envelope)).toEqual([envelope, failure])
    const invoke = vi.fn().mockRejectedValue(envelope)
    await expect(invokeModelWithRetry(invoke, { initialDelayMs: 0 })).rejects.toBe(envelope)
    expect(invoke).toHaveBeenCalledOnce()
    expect(classifyModelRetryError(new Error('timeout', {
      cause: new ProjectRulesRequestBudgetError(100, 50)
    }))).toEqual({ retry: false })
  })

  it('keeps preparation retries separate from provider retries', async () => {
    const providerFailure = Object.assign(new Error('Unavailable'), { status: 503 })
    const invoke = vi.fn().mockRejectedValueOnce(new ModelRequestChangedError()).mockRejectedValue(providerFailure)
    const onRetry = vi.fn()
    await expect(invokeModelWithRetry(invoke, {
      initialDelayMs: 0,
      retryWhen: error => error instanceof ModelRequestChangedError,
      onRetry
    })).rejects.toBe(providerFailure)
    expect(invoke).toHaveBeenCalledTimes(2)
    expect(onRetry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ reason: 'configuration_changed' }))
  })

  it('honors zero retries and does not emit a retry event', async () => {
    const failure = Object.assign(new Error('Unavailable'), { status: 503 })
    const invoke = vi.fn().mockRejectedValue(failure)
    const onRetry = vi.fn()
    await expect(invokeModelWithRetry(invoke, { maxRetries: 0, onRetry })).rejects.toBe(failure)
    expect(invoke).toHaveBeenCalledOnce()
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('caps backoff and returns the successful response without extra attempts', async () => {
    vi.useFakeTimers()
    const failure = Object.assign(new Error('Unavailable'), { status: 503 })
    const result = { text: 'done' }
    const invoke = vi.fn().mockRejectedValueOnce(failure).mockRejectedValueOnce(failure)
      .mockRejectedValueOnce(failure).mockResolvedValue(result)
    const onRetry = vi.fn()
    const operation = invokeModelWithRetry(invoke, { maxRetries: 3, initialDelayMs: 100, maxDelayMs: 150, onRetry })
    await vi.runAllTimersAsync()
    expect(await operation).toBe(result)
    expect(invoke).toHaveBeenCalledTimes(4)
    expect(onRetry.mock.calls.map(([event]) => event.delayMs)).toEqual([100, 150, 150])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('cancels during a retry notification without installing a timer or sending again', async () => {
    vi.useFakeTimers()
    const controller = new AbortController()
    const reason = new Error('User cancelled')
    const invoke = vi.fn().mockRejectedValue(Object.assign(new Error('Unavailable'), { status: 503 }))
    await expect(invokeModelWithRetry(invoke, {
      signal: controller.signal,
      onRetry: () => controller.abort(reason)
    })).rejects.toBe(reason)
    expect(invoke).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('keeps rejected request details and the original cause available to the caller', async () => {
    const failure = Object.assign(new Error('Invalid model'), { status: 400 })
    await expect(invokeModelWithRetry(() => Promise.reject(failure))).rejects.toMatchObject({
      code: 'MODEL_SELECTION_INVALID', cause: failure, message: expect.stringContaining('HTTP 400')
    })
  })
})
