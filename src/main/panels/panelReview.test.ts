import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/dataDir', () => ({ getDataDir: () => '/isolated-panel-review-data' }))
afterEach(() => { vi.resetModules(); vi.clearAllMocks() })

describe('review from an independent file panel', () => {
  it.each([false, true])('uses the originating context and captures changes in main (draft=%s)', async draft => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = (channel: string, callback: (...args: unknown[]) => unknown) => handlers.set(channel, callback)
    const content = { kind: 'files', projectId: 'origin-project', ...(draft
      ? { draft: { modelConfigId: 'draft-model', modelParameterPresetId: null, accessMode: 'full_access' } }
      : { threadId: 'origin-thread' }) }
    const thread = { id: 'origin-thread', projectId: 'origin-project', modelConfigId: 'thread-model' }
    const database = { getThread: vi.fn(() => thread) }
    const storage = { conversationForThread: () => database, previewDatabase: () => database }
    const submit = vi.fn(async () => ({ thread, run: { id: 'review-run' } }))
    const runtime = { getRunSubmission: vi.fn(), submitRunWithAttachments: submit,
      databaseForThread: () => database, storageForOperation: () => storage,
      useStorage: (action: (store: unknown) => unknown) => action(storage) }
    const capture = vi.fn(async () => ({ id: 'captured-scope' }))
    const view = { viewId: 'files-view', content }
    const updateContent = vi.fn(), notify = vi.fn()
    vi.doMock('electron', () => ({ BrowserWindow: { getAllWindows: () => [{ webContents: { send: notify } }] } }))
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle, isMainRendererWindow: () => true }))
    vi.doMock('./panelRegistry', () => ({ panelLabel: () => 'Code review', panelViews: {
      fromPage: () => view, pageState: () => ({ view, language: 'en' }), pageContent: () => content, updateContent
    } }))
    vi.doMock('../agent/agentStorage', () => ({ AgentStorage: { open: () => storage } }))
    vi.doMock('../agent/agentRuntimeCoordinator', () => ({ AgentRuntimeCoordinator: vi.fn(function () { return runtime }) }))
    vi.doMock('../projectStore', () => ({ getProject: async () => ({ id: 'origin-project', kind: 'workspace', modelConfigId: 'project-model', accessMode: 'read_only_allowed' }) }))
    vi.doMock('../agent/codeReview', () => ({ captureCodeReview: capture, codeReviewPrompt: () => 'Captured review prompt' }))
    vi.doMock('../config/appConfig', () => ({ getAppConfigSnapshot: async () => ({ defaultModelId: 'global-model' }),
      findResolvedModelConfig: (_config: unknown, id: string) => ({ id, capabilities: { toolUse: true } }) }))
    vi.doMock('../runtimeLogger', () => ({ runtimeLog: vi.fn() }))
    const { registerAgentIpcHandlers } = await import('../agent/agentIpcHandlers')
    registerAgentIpcHandlers()
    const review = handlers.get('agent:panels:review')!
    const request = { kind: 'git', projectId: 'origin-project', sourceFolder: '/origin', scope: 'workspace', version: 'a'.repeat(64) }
    await expect(review({ sender: {} }, { ...request, projectId: 'currently-selected-project' })).rejects.toThrow('panel context')
    expect(capture).not.toHaveBeenCalled()
    await review({ sender: {} }, request)
    expect(capture).toHaveBeenCalledExactlyOnceWith(database, request, 'origin-project')
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      text: 'Captured review prompt', codeReview: { id: 'captured-scope' },
      ...(draft ? { newThread: expect.objectContaining({ projectId: 'origin-project', modelConfigId: 'draft-model', modelParameterPresetId: null, accessMode: 'full_access' }) }
        : { threadId: 'origin-thread' })
    }))
    if (draft) expect(updateContent).toHaveBeenCalledWith('files-view', { ...content, threadId: 'origin-thread' })
    else expect(updateContent).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('panels:reviewStarted', 'origin-thread')
  })
})
