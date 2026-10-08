import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../config/dataDir', () => ({ getDataDir: () => '/isolated-panel-review-data' }))
afterEach(() => { vi.resetModules(); vi.clearAllMocks() })

describe('review from an independent file panel', () => {
  it.each([false, true].flatMap(draft => [false, true].map(switched => ({ draft, switched }))))('uses the captured context (draft=$draft, switched=$switched)', async ({ draft, switched }) => {
    const handlers = new Map<string, (...args: unknown[]) => unknown>()
    const handle = (channel: string, callback: (...args: unknown[]) => unknown) => handlers.set(channel, callback)
    const content = { kind: 'files', projectId: 'origin-project', navigationId: 'navigation-one', ...(draft
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
    if (switched) submit.mockImplementation(async () => {
      view.content = { ...content, threadId: 'another-thread', navigationId: 'navigation-two' }
      return { thread, run: { id: 'review-run' } }
    })
    const updateContent = vi.fn(), notify = vi.fn()
    vi.doMock('electron', () => ({ BrowserWindow: { getAllWindows: () => [{ webContents: { send: notify } }] } }))
    vi.doMock('../ipcSecurity', () => ({ handleMainIpc: handle, isMainRendererWindow: () => true }))
    vi.doMock('./panelRegistry', () => ({ panelLabel: () => 'Code review', panelViews: {
      fromPage: () => ({ ...view }), pageState: () => ({ view, language: 'en' }), pageContent: () => view.content, updateContent
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
    await expect(review({ sender: {} }, { ...request, projectId: 'currently-selected-project' }, content.navigationId)).rejects.toThrow('panel context')
    await expect(review({ sender: {} }, request, 'obsolete-navigation')).rejects.toThrow('Panel context changed')
    expect(capture).not.toHaveBeenCalled()
    await review({ sender: {} }, request, content.navigationId)
    expect(capture).toHaveBeenCalledExactlyOnceWith(database, request, 'origin-project')
    expect(submit).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      text: 'Captured review prompt', codeReview: { id: 'captured-scope' },
      ...(draft ? { newThread: expect.objectContaining({ projectId: 'origin-project', modelConfigId: 'draft-model', modelParameterPresetId: null, accessMode: 'full_access' }) }
        : { threadId: 'origin-thread' })
    }))
    if (draft && !switched) expect(updateContent).toHaveBeenCalledWith('files-view', { ...content, threadId: 'origin-thread', navigationId: expect.any(String), draft: undefined })
    else expect(updateContent).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('panels:reviewStarted', 'origin-thread', { projectId: content.projectId, threadId: draft ? undefined : 'origin-thread' })
  })
})
