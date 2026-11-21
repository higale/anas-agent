import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { GaleApi, SkillSnapshot } from '@shared/types'
import { useProjectSkills } from './useProjectSkills'

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t }) }))
vi.mock('../notice', () => ({ notice: { error: vi.fn() } }))
const t = (key: string) => key
const globalSkills: SkillSnapshot = { roots: [], skills: [] }

describe('project skills for the composer', () => {
  it('discards skills from the previous project and ignores late responses', async () => {
    let resolveFirst!: (snapshot: SkillSnapshot) => void
    const first = new Promise<SkillSnapshot>((resolve) => { resolveFirst = resolve })
    const second: SkillSnapshot = { projectId: 'second', roots: [], skills: [] }
    const get = vi.fn().mockReturnValueOnce(first).mockResolvedValue(second)
    Object.defineProperty(window, 'gale', { configurable: true, value: { skills: { get } } as unknown as GaleApi })
    const { result, rerender } = renderHook(({ projectId }) => useProjectSkills(projectId, globalSkills), {
      initialProps: { projectId: 'first' }
    })
    rerender({ projectId: 'second' })
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toBe(second))
    await act(async () => { resolveFirst({ projectId: 'first', roots: [], skills: [] }); await first })
    expect(result.current).toBe(second)
    expect(get).toHaveBeenLastCalledWith('second', undefined)
    rerender({ projectId: 'third' })
    expect(result.current).toBeUndefined()
  })

  it('reloads project shortcuts after the global catalog changes', async () => {
    const get = vi.fn().mockResolvedValue({ projectId: 'project', roots: [], skills: [] })
    Object.defineProperty(window, 'gale', { configurable: true, value: { skills: { get } } as unknown as GaleApi })
    const { result, rerender } = renderHook(({ catalog }) => useProjectSkills('project', catalog), {
      initialProps: { catalog: globalSkills }
    })
    await waitFor(() => expect(result.current).toBeDefined())
    const refreshed: SkillSnapshot = { projectId: 'project', roots: [], skills: [] }
    get.mockResolvedValue(refreshed)
    rerender({ catalog: { roots: [], skills: [] } })
    await waitFor(() => expect(result.current).toBe(refreshed))
  })

  it('reloads changed directory references within the same project and ignores the previous scan', async () => {
    const initial: SkillSnapshot = { projectId: 'project', roots: [], skills: [] }
    const current: SkillSnapshot = { projectId: 'project', roots: [], skills: [] }
    let resolvePrevious!: (snapshot: SkillSnapshot) => void
    const previous = new Promise<SkillSnapshot>((resolve) => { resolvePrevious = resolve })
    const get = vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(previous).mockResolvedValue(current)
    Object.defineProperty(window, 'gale', { configurable: true, value: { skills: { get } } as unknown as GaleApi })
    const { result, rerender } = renderHook(({ folders }) => useProjectSkills('project', globalSkills, folders), {
      initialProps: { folders: ['/first'] }
    })
    await waitFor(() => expect(result.current).toBe(initial))
    rerender({ folders: ['/second'] })
    expect(result.current).toBeUndefined()
    rerender({ folders: ['/third'] })
    await waitFor(() => expect(result.current).toBe(current))
    expect(get).toHaveBeenLastCalledWith('project', ['/third'])
    await act(async () => { resolvePrevious(initial); await previous })
    expect(result.current).toBe(current)
  })

  it('reloads shortcuts after custom directories change without changing source folders', async () => {
    const initial: SkillSnapshot = { roots: [], skills: [] }
    const current: SkillSnapshot = { roots: [], skills: [] }
    const get = vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(current)
    Object.defineProperty(window, 'gale', { configurable: true, value: { skills: { get } } as unknown as GaleApi })
    const { result, rerender } = renderHook(({ directories }) => useProjectSkills('project', globalSkills, directories), {
      initialProps: { directories: ['/first'] }
    })
    await waitFor(() => expect(result.current).toBe(initial))
    rerender({ directories: [] })
    expect(result.current).toBeUndefined()
    await waitFor(() => expect(result.current).toBe(current))
    expect(get).toHaveBeenLastCalledWith('project', [])
  })
})
