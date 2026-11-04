import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { t } from 'i18next'
import { notice } from '../notice'
import { emptyModelDraft } from './modelDraft'
import { useModelCandidates } from './useModelCandidates'

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
      ({ modelListUrl }: { modelListUrl: string }) => useModelCandidates({ ...initialDraft, modelListUrl }, true, t),
      { initialProps: { modelListUrl: 'https://example.com/v1/models' } }
    )

    await waitFor(() => expect(result.current.modelCandidates).toEqual(['bearer-model']))
    rerender({ modelListUrl: 'https://api.anthropic.com/v1/models' })

    await waitFor(() => expect(result.current.modelCandidates).toEqual([]))
    expect(getCachedModels).toHaveBeenLastCalledWith(expect.objectContaining({
      modelListUrl: 'https://api.anthropic.com/v1/models'
    }))

    await act(async () => resolveAnthropic?.({ models: ['claude-model'] }))
    await waitFor(() => expect(result.current.modelCandidates).toEqual(['claude-model']))
  })

  it.each(['success', 'failure'])('ignores a late %s from a previously selected provider', async outcome => {
    const success = vi.spyOn(notice, 'success').mockReturnValue(1)
    const error = vi.spyOn(notice, 'error').mockReturnValue(1)
    let finishOld!: () => void, finishCurrent!: () => void
    const old = new Promise<{ models: string[] }>((resolve, reject) => {
      finishOld = () => outcome === 'success' ? resolve({ models: ['stale'] }) : reject(new Error('old'))
    })
    const current = new Promise<{ models: string[] }>(resolve => { finishCurrent = () => resolve({ models: ['fresh'] }) })
    vi.stubGlobal('gale', { config: { fetchModels: vi.fn().mockReturnValueOnce(old).mockReturnValueOnce(current),
      getCachedModels: async ({ providerId }: { providerId: string }) => ({ models: [providerId] }) } })
    const { result, rerender } = renderHook(({ providerId }) => useModelCandidates({
      ...emptyModelDraft(), baseUrl: 'https://example.com/v1', providerId
    }, true, t), { initialProps: { providerId: 'a' } })
    await waitFor(() => expect(result.current.modelCandidates).toEqual(['a']))
    act(() => { void result.current.refreshModelCandidates() })
    rerender({ providerId: 'b' })
    await waitFor(() => expect(result.current.modelCandidates).toEqual(['b']))
    act(() => { void result.current.refreshModelCandidates() })
    await act(async () => finishOld())
    expect(result.current.modelCandidates).toEqual(['b'])
    expect(result.current.modelListLoading).toBe(true)
    expect(success).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
    await act(async () => finishCurrent())
    expect(result.current.modelCandidates).toEqual(['fresh'])
    expect(result.current.modelListLoading).toBe(false)
  })
})
