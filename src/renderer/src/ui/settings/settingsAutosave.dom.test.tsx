import { act, renderHook, waitFor } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TFunction } from 'i18next'
import type { AppConfigSnapshot, EnvFileSnapshot, McpServerConfigSave, SkillRootSummary, SkillSnapshot, SubagentConfigSave } from '@shared/types'
import { useEnvSettingsState } from './useEnvSettingsState'
import { useSkillsSettingsState } from './useSkillsSettingsState'
import { useMcpSettingsState } from '../mcp/useMcpSettingsState'
import { useSubagentSettingsState } from '../subagent/useSubagentSettingsState'
import { notice } from '../notice'
import { createSubagentDraft } from '../subagent/subagentDraft'
import type { ConfirmDialogRequest } from '../dialogs/AppDialogs'

vi.mock('../notice', () => ({ notice: { error: vi.fn(), info: vi.fn(), success: vi.fn(), dismiss: vi.fn() } }))
const t = ((key: string) => key) as TFunction
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks() })

describe('autosave page boundaries', () => {
  it('loads the surviving subagent draft after deletion reuses the selected index', async () => {
    const base = createSubagentDraft(undefined, t)
    const initial = { providers: [], mcpServers: [], subagents: [
      { ...base, index: 0, name: 'first', description: 'First description', builtIn: false },
      { ...base, index: 1, name: 'second', description: 'Second description', builtIn: false }
    ] } as unknown as AppConfigSnapshot
    const removed = { ...initial, subagents: [{ ...initial.subagents[1], index: 0 }] }
    let confirmation: ConfirmDialogRequest | undefined
    const saveSubagent = vi.fn(async (payload: SubagentConfigSave) => ({ ...removed, subagents: [{ ...removed.subagents[0], ...payload, index: 0 }] }))
    vi.stubGlobal('gale', { config: { deleteSubagent: vi.fn().mockResolvedValue(removed), saveSubagent } })
    const { result } = renderHook(() => {
      const [config, setConfig] = useState(initial)
      return useSubagentSettingsState({ config, setConfig, openConfirmDialog: (request) => { confirmation = request }, t })
    })
    await waitFor(() => expect(result.current.draft.name).toBe('first'))
    act(() => result.current.deleteSubagent())
    await act(async () => { await confirmation!.onConfirm() })
    expect(result.current.draft).toMatchObject({ name: 'second', description: 'Second description', index: 0 })
    await act(async () => result.current.updateDraft({ description: 'Updated second' }))
    expect(saveSubagent).toHaveBeenLastCalledWith(expect.objectContaining({ name: 'second', description: 'Updated second', index: 0 }))
  })

  it('uses the latest catalog for three MCP Add clicks while the first creation is pending', async () => {
    const first = deferred<void>()
    const empty = { mcpServers: [], providers: [], subagents: [] } as unknown as AppConfigSnapshot
    let saved = empty
    const saveMcpServer = vi.fn(async (payload: McpServerConfigSave) => {
      if (saveMcpServer.mock.calls.length === 1) await first.promise
      if (saved.mcpServers.some((server) => server.id === payload.id)) throw new Error('Duplicate ID')
      saved = { ...saved, mcpServers: [...saved.mcpServers, {
        url: '', command: '', workingDir: '', ...payload, index: saved.mcpServers.length, apiKey: payload.apiKey ?? undefined
      }] }
      return saved
    })
    vi.stubGlobal('gale', { config: { saveMcpServer }, mcp: { status: vi.fn().mockResolvedValue(undefined), onStatus: () => () => {} } })
    const { result } = renderHook(() => {
      const [config, setConfig] = useState(empty)
      return useMcpSettingsState({ config, setConfig, openConfirmDialog: vi.fn(), t })
    })
    act(() => { void result.current.addMcpServer() })
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledOnce())
    act(() => { void result.current.addMcpServer(); void result.current.addMcpServer() })
    await act(async () => first.resolve())
    await waitFor(() => expect(saved.mcpServers).toHaveLength(3))
    expect(new Set(saved.mcpServers.map((server) => server.id)).size).toBe(3)
    expect(notice.error).not.toHaveBeenCalled()
  })

  it('uses the latest catalog for three subagent Add clicks while the first creation is pending', async () => {
    const first = deferred<void>()
    const empty = { mcpServers: [], providers: [], subagents: [] } as unknown as AppConfigSnapshot
    let saved = empty
    const saveSubagent = vi.fn(async (payload: SubagentConfigSave) => {
      if (saveSubagent.mock.calls.length === 1) await first.promise
      if (saved.subagents.some((agent) => agent.name === payload.name)) throw new Error('Duplicate name')
      saved = { ...saved, subagents: [...saved.subagents, { ...payload, index: saved.subagents.length, builtIn: false }] }
      return saved
    })
    vi.stubGlobal('gale', { config: { saveSubagent } })
    const { result } = renderHook(() => {
      const [config, setConfig] = useState(empty)
      return useSubagentSettingsState({ config, setConfig, openConfirmDialog: vi.fn(), t })
    })
    act(() => { void result.current.addSubagent() })
    await waitFor(() => expect(saveSubagent).toHaveBeenCalledOnce())
    act(() => { void result.current.addSubagent(); void result.current.addSubagent() })
    await act(async () => first.resolve())
    await waitFor(() => expect(saved.subagents).toHaveLength(3))
    expect(new Set(saved.subagents.map((agent) => agent.name)).size).toBe(3)
    expect(notice.error).not.toHaveBeenCalled()
  })

  it('does not retry failed edits for skills from a removed directory', async () => {
    const root = { id: 'root', name: 'Root', removable: true } as SkillRootSummary
    const initial = { scriptAutoApprove: false, roots: [root], skills: [] } satisfies SkillSnapshot
    const removed = { scriptAutoApprove: false, roots: [], skills: [] } satisfies SkillSnapshot
    let confirmation: ConfirmDialogRequest | undefined
    const updateAvailability = vi.fn().mockRejectedValue(new Error('write failed'))
    const updateScriptApproval = vi.fn().mockResolvedValue({ ...removed, scriptAutoApprove: true })
    vi.stubGlobal('gale', { skills: {
      get: vi.fn().mockResolvedValue(initial), updateAvailability, updateScriptApproval,
      removeDirectory: vi.fn().mockResolvedValue(removed)
    } })
    const { result } = renderHook(() => useSkillsSettingsState({
      openConfirmDialog: (request) => { confirmation = request }, settingsOpen: false, settingsTab: 'skills', t
    }))
    await waitFor(() => expect(result.current.skills).toBeDefined())
    await act(async () => result.current.updateAvailability('removed-skill', { modelAvailable: false }))
    const retry = vi.mocked(notice.error).mock.calls.at(-1)?.[1]?.action as unknown as { onClick: () => void }
    act(() => result.current.removeDirectory(root))
    await act(async () => { await confirmation!.onConfirm() })
    await act(async () => retry.onClick())
    await act(async () => result.current.updateScriptApproval(undefined, true))
    expect(updateAvailability).toHaveBeenCalledOnce()
    expect(result.current.skills?.scriptAutoApprove).toBe(true)
  })

  it('finishes all queued MCP edits before deleting the server', async () => {
    const first = deferred<void>()
    const order: string[] = []
    const server = { index: 0, id: 'server', name: 'Server', enabled: false, type: 'stdio' as const, url: '', command: 'node', args: [], env: {}, workingDir: '', timeoutMs: 30000 }
    const survivor = { ...server, index: 1, id: 'survivor', name: 'Survivor' }
    const initial = { mcpServers: [server, survivor], providers: [], subagents: [] } as unknown as AppConfigSnapshot
    let saved = initial
    let confirmation: ConfirmDialogRequest | undefined
    const saveMcpServer = vi.fn(async (payload: McpServerConfigSave) => {
      if (saveMcpServer.mock.calls.length === 1) await first.promise
      order.push(payload.name)
      saved = { ...saved, mcpServers: [{ ...server, ...payload, index: 0, apiKey: payload.apiKey ?? undefined }] }
      return saved
    })
    const deleteMcpServer = vi.fn(async () => { order.push('delete'); return { ...saved, mcpServers: [{ ...survivor, index: 0 }] } })
    vi.stubGlobal('gale', { config: { saveMcpServer, deleteMcpServer }, mcp: { status: vi.fn().mockResolvedValue(undefined), onStatus: () => () => {} } })
    const { result } = renderHook(() => {
      const [config, setConfig] = useState(initial)
      return useMcpSettingsState({ config, setConfig, openConfirmDialog: (request) => { confirmation = request }, t })
    })
    await waitFor(() => expect(result.current.mcpDraft.index).toBe(0))
    act(() => result.current.updateMcpDraft({ name: 'First' }))
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledOnce())
    act(() => result.current.updateMcpDraft({ name: 'Second' }))
    act(() => { void result.current.deleteEditingMcpServer() })
    let deletion!: Promise<unknown>
    act(() => { deletion = Promise.resolve(confirmation!.onConfirm()) })
    expect(deleteMcpServer).not.toHaveBeenCalled()
    await act(async () => { first.resolve(); await deletion })
    expect(order).toEqual(['First', 'Second', 'delete'])
    expect(result.current.mcpDraft).toMatchObject({ index: 0, id: 'survivor', name: 'Survivor' })
    await act(async () => result.current.updateMcpDraft({ name: 'Updated survivor' }))
    expect(saveMcpServer).toHaveBeenLastCalledWith(expect.objectContaining({ index: 0, id: 'survivor', name: 'Updated survivor' }))
  })

  it('does not replace an edited env draft with a late read or a reload after failure', async () => {
    const load = deferred<EnvFileSnapshot>()
    const write = deferred<EnvFileSnapshot>()
    const saved = { path: 'test.env', content: 'NEW=1' } as EnvFileSnapshot
    const saveEnvFile = vi.fn().mockReturnValueOnce(write.promise).mockResolvedValue(saved)
    vi.stubGlobal('gale', { app: { readEnvFile: vi.fn().mockReturnValueOnce(load.promise).mockResolvedValue({ ...saved, content: 'OLD=1' }), saveEnvFile } })
    const { result, rerender } = renderHook(({ open }) => useEnvSettingsState({ settingsOpen: open, settingsTab: 'environment', t }), { initialProps: { open: true } })
    act(() => result.current.updateEnvDraft('NEW=1'))
    await waitFor(() => expect(saveEnvFile).toHaveBeenCalledOnce())
    await act(async () => load.resolve({ ...saved, content: 'OLD=1' }))
    expect(result.current.envDraft).toBe('NEW=1')
    await act(async () => write.reject(new Error('disk unavailable')))
    rerender({ open: false })
    rerender({ open: true })
    await act(async () => {})
    expect(result.current.envDraft).toBe('NEW=1')
    const action = vi.mocked(notice.error).mock.calls.at(-1)?.[1]?.action as unknown as { onClick: () => void }
    await act(async () => action.onClick())
    expect(saveEnvFile).toHaveBeenLastCalledWith('NEW=1')
    expect(result.current.envDraft).toBe('NEW=1')
  })

  it('shows skill toggles immediately and ignores a stale refresh after a save', async () => {
    const snapshot = { scriptAutoApprove: false, roots: [], skills: [
      { id: 'skill', modelAvailable: true, userAvailable: true, scriptAutoApprove: false,
        rootId: 'root', name: 'skill', description: '', dirPath: '', linked: false,
        relativePath: 'skill', source: 'user', rootName: 'root', shortcutAlias: '' }
    ] } satisfies SkillSnapshot
    const first = deferred<SkillSnapshot>()
    const reload = deferred<SkillSnapshot>()
    let persisted = structuredClone(snapshot)
    const updateAvailability = vi.fn(async (_project, id, patch) => {
      if (updateAvailability.mock.calls.length === 1) await first.promise
      persisted = { ...persisted, skills: persisted.skills.map((skill) => skill.id === id ? { ...skill, ...patch } : skill) }
      return persisted
    })
    vi.stubGlobal('gale', { skills: { get: vi.fn().mockResolvedValueOnce(snapshot).mockReturnValue(reload.promise), updateAvailability } })
    const { result } = renderHook(() => useSkillsSettingsState({ openConfirmDialog: vi.fn(), settingsOpen: false, settingsTab: 'skills', t }))
    await waitFor(() => expect(result.current.skills).toBeDefined())
    act(() => { void result.current.updateAvailability('skill', { modelAvailable: false }) })
    act(() => { void result.current.updateAvailability('skill', { userAvailable: false }); void result.current.refreshSkills() })
    expect(result.current.skills?.skills[0]).toMatchObject({ modelAvailable: false, userAvailable: false })
    await waitFor(() => expect(updateAvailability).toHaveBeenCalledTimes(1))
    await act(async () => first.resolve(snapshot))
    await waitFor(() => expect(updateAvailability).toHaveBeenCalledTimes(2))
    await act(async () => reload.resolve(snapshot))
    expect(result.current.skills?.skills[0]).toMatchObject({ modelAvailable: false, userAvailable: false })
    expect(persisted.skills[0]).toMatchObject({ modelAvailable: false, userAvailable: false })
  })

  it('keeps edits during MCP creation attached to the one created server', async () => {
    const first = deferred<void>()
    const empty = { mcpServers: [], providers: [], subagents: [] } as unknown as AppConfigSnapshot
    let saved = empty
    const saveMcpServer = vi.fn(async (payload: McpServerConfigSave) => {
      if (saveMcpServer.mock.calls.length === 1) await first.promise
      const index = payload.index ?? saved.mcpServers.length
      const server = { url: '', command: '', workingDir: '', ...payload, index, apiKey: payload.apiKey ?? undefined }
      saved = { ...saved, mcpServers: [...saved.mcpServers.filter((item) => item.index !== index), server] }
      return saved
    })
    vi.stubGlobal('gale', { config: { saveMcpServer }, mcp: { status: vi.fn().mockResolvedValue(undefined), onStatus: () => () => {} } })
    const { result } = renderHook(() => {
      const [config, setConfig] = useState(empty)
      return useMcpSettingsState({ config, setConfig, openConfirmDialog: vi.fn(), t })
    })
    act(() => { void result.current.addMcpServer() })
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledOnce())
    act(() => result.current.updateMcpDraft({ name: 'Edited while creating' }))
    await act(async () => first.resolve())
    await waitFor(() => expect(saveMcpServer).toHaveBeenCalledTimes(2))
    expect(saveMcpServer.mock.calls[1][0].index).toBe(0)
    expect(saved.mcpServers).toHaveLength(1)
    expect(result.current.mcpDraft).toMatchObject({ index: 0, name: 'Edited while creating' })
  })

  it('keeps edits during subagent creation attached to the one created subagent', async () => {
    const first = deferred<void>()
    const empty = { mcpServers: [], providers: [], subagents: [] } as unknown as AppConfigSnapshot
    let saved = empty
    const saveSubagent = vi.fn(async (payload: SubagentConfigSave) => {
      if (saveSubagent.mock.calls.length === 1) await first.promise
      const index = payload.index ?? saved.subagents.length
      saved = { ...saved, subagents: [...saved.subagents.filter((item) => item.index !== index), { ...payload, index, builtIn: false }] }
      return saved
    })
    vi.stubGlobal('gale', { config: { saveSubagent } })
    const { result } = renderHook(() => {
      const [config, setConfig] = useState(empty)
      return useSubagentSettingsState({ config, setConfig, openConfirmDialog: vi.fn(), t })
    })
    act(() => { void result.current.addSubagent() })
    await waitFor(() => expect(saveSubagent).toHaveBeenCalledOnce())
    act(() => result.current.updateDraft({ description: 'Edited while creating' }))
    await act(async () => first.resolve())
    await waitFor(() => expect(saveSubagent).toHaveBeenCalledTimes(2))
    expect(saveSubagent.mock.calls[1][0].index).toBe(0)
    expect(saved.subagents).toHaveLength(1)
    expect(result.current.draft).toMatchObject({ index: 0, description: 'Edited while creating' })
  })
})
