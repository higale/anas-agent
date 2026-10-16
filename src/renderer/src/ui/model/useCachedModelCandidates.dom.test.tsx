import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyModelDraft } from './modelDraft'
import { useCachedModelCandidates } from './useCachedModelCandidates'

afterEach(() => {
  vi.clearAllMocks()
  vi.unstubAllGlobals()
})

describe('cached model candidates', () => {
  it('clears and reloads candidates when model list URL changes', async () => {
    let resolveAnthropic: ((value: { models: string[] }) => void) | undefined
    const getCachedModels = vi.fn()
      .mockResolvedValueOnce({ models: ['bearer-model'] })
      .mockImplementationOnce(() => new Promise<{ models: string[] }>((resolve) => {
        resolveAnthropic = resolve
      }))
    vi.stubGlobal('gale', { config: { getCachedModels } })
    const initialDraft = {
      ...emptyModelDraft(),
      baseUrl: 'https://example.com/v1'
    }
    const { result, rerender } = renderHook(
      ({ modelListUrl }: { modelListUrl: string }) => useCachedModelCandidates({
        draft: { ...initialDraft, modelListUrl },
        enabled: true
      }),
      { initialProps: { modelListUrl: 'https://example.com/v1/models' } }
    )

    await waitFor(() => expect(result.current[0]).toEqual(['bearer-model']))
    rerender({ modelListUrl: 'https://api.anthropic.com/v1/models' })

    await waitFor(() => expect(result.current[0]).toEqual([]))
    expect(getCachedModels).toHaveBeenLastCalledWith(expect.objectContaining({
      modelListUrl: 'https://api.anthropic.com/v1/models'
    }))

    await act(async () => resolveAnthropic?.({ models: ['claude-model'] }))
    await waitFor(() => expect(result.current[0]).toEqual(['claude-model']))
  })
})
