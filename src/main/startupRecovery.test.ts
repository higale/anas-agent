import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (...args: any[]) => any>(),
  transition: vi.fn(), closeAgent: vi.fn(), closeMcp: vi.fn(), closePlugins: vi.fn(), recoverRestore: vi.fn(),
  createWindow: vi.fn(), preserve: vi.fn(), reset: vi.fn(), resetProjects: vi.fn(), resetExecution: vi.fn(), inspectResetTargets: vi.fn(),
  relaunch: vi.fn(), quit: vi.fn(), configureLogger: vi.fn(),
  inspectRepair: vi.fn(), repair: vi.fn()
}))
vi.mock('electron', () => ({ app: { relaunch: mocks.relaunch, quit: mocks.quit }, shell: { openPath: vi.fn() } }))
vi.mock('./ipcSecurity', () => ({ handleMainIpc: (channel: string, handler: (...args: any[]) => any) => mocks.handlers.set(channel, handler) }))
vi.mock('./config/dataDir', () => ({
  getDataDir: () => '/test/data', getLogDir: () => '/test/data/log', getBundledConfigDir: () => '/bundled/config',
  getAgentCatalogFile: () => '/test/data/db/catalog.sqlite', getProjectsDir: () => '/test/data/db/projects'
}))
vi.mock('./applicationDataLifecycle', () => ({ beginApplicationDataTransition: mocks.transition }))
vi.mock('./agent/agentIpcHandlers', () => ({ closeAgentRuntime: mocks.closeAgent }))
vi.mock('./mcpRuntimeService', () => ({ closeCachedMcpRuntime: mocks.closeMcp }))
vi.mock('./plugins/pluginHost', () => ({ closePluginHost: mocks.closePlugins }))
vi.mock('./appShell', () => ({ createMainWindow: mocks.createWindow }))
vi.mock('./recoveryData', async (importOriginal) => ({
  ...await importOriginal<typeof import('./recoveryData')>(),
  preserveRecoveryData: mocks.preserve, resetRecoveryConfig: mocks.reset
}))
vi.mock('./backupService', () => ({ defaultRecoveryDirectory: () => '/test/documents/Anas/recovery', recoverInterruptedDataRestore: mocks.recoverRestore, resetProjectData: mocks.resetProjects, resetExecutionData: mocks.resetExecution, inspectResetTargets: mocks.inspectResetTargets }))
vi.mock('./runtimeLogger', () => ({ runtimeLog: vi.fn(), configureRuntimeLogger: mocks.configureLogger }))
vi.mock('./recoveryRepair', async (importOriginal) => ({
  ...await importOriginal<typeof import('./recoveryRepair')>(), inspectRecoveryRepair: mocks.inspectRepair, repairRecoveryData: mocks.repair
}))

async function setup() {
  const recovery = await import('./startupRecovery')
  recovery.registerRecoveryIpcHandlers()
  return recovery
}
function invoke(channel: string, ...args: unknown[]) {
  return mocks.handlers.get(`recovery:${channel}`)!(undefined, ...args)
}
beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  mocks.handlers.clear()
  mocks.inspectRepair.mockResolvedValue({ candidates: [], issues: [], files: [] })
  mocks.inspectResetTargets.mockResolvedValue([])
  mocks.preserve.mockResolvedValue('/test/documents/Anas/recovery/copy')
})

describe('startup recovery lifecycle', () => {
  it('presents the combined project and database inspection result', async () => {
    const recovery = await setup()
    mocks.inspectRepair.mockResolvedValue({ candidates: [], issues: [], files: [{ name: 'projects.json', path: '/test/data/db/projects/state.json', repairableFields: ['db/catalog.sqlite: user_version (1 → 2)'] }] })
    await recovery.showStartupRecovery(new Error('database failed'))
    const snapshot = await invoke('inspect')
    expect(snapshot).toMatchObject({ preservationParent: '/test/documents/Anas/recovery', catalogPath: '/test/data/db/catalog.sqlite', conversationsPath: '/test/data/db/projects' })
    expect(snapshot.files[0]).toMatchObject({ name: 'projects.json', repairableFields: ['db/catalog.sqlite: user_version (1 → 2)'] })
  })
  it('requires stopped writers for field repair and delegates preservation to the repair service', async () => {
    const recovery = await setup()
    await expect(invoke('repair')).rejects.toThrow('Enter startup recovery')
    await recovery.showStartupRecovery(new Error('invalid capabilities'))
    mocks.repair.mockImplementation(async (_root: string, _file: string, preserve: () => Promise<string>) => ({
      preservationPath: await preserve(), repaired: ['subagents.json: subagents[0].capabilities'], unresolved: []
    }))
    await expect(invoke('repair', '../settings.json')).rejects.toThrow('exactly one')
    const result = await invoke('repair', 'subagents.json')
    expect(mocks.repair).toHaveBeenCalledWith('/test/data', 'subagents.json', expect.any(Function))
    expect(result.repaired).toHaveLength(1)
    expect(mocks.preserve).toHaveBeenCalledExactlyOnceWith('/test/data', '/test/documents/Anas/recovery')
    expect(mocks.resetProjects).not.toHaveBeenCalled()
  })
  it('requires stopped writers and raw preservation for project reset', async () => {
    const recovery = await setup()
    await expect(invoke('resetProjects', [])).rejects.toThrow('Enter startup recovery')
    await recovery.showStartupRecovery(new Error('broken projects'))
    mocks.resetProjects.mockImplementation(async (preserve: () => Promise<string>) => preserve())
    await expect(invoke('resetProjects', [])).resolves.toEqual({ preservationPath: '/test/documents/Anas/recovery/copy' })
    expect(mocks.preserve).toHaveBeenCalledExactlyOnceWith('/test/data', '/test/documents/Anas/recovery')
    expect(mocks.reset).not.toHaveBeenCalled()
  })

  it('routes database-only reset with its confirmed list without resetting projects', async () => {
    const recovery = await setup()
    await expect(invoke('resetExecution', [])).rejects.toThrow('Enter startup recovery')
    await recovery.showStartupRecovery(new Error('catalog failed'))
    await expect(invoke('resetExecution')).rejects.toThrow('Confirm the reset file list')
    const targets = [{ path: '/test/data/db/catalog.sqlite', kind: 'file' }]
    mocks.resetExecution.mockImplementation(async (preserve: () => Promise<string>) => preserve())
    await expect(invoke('resetExecution', targets)).resolves.toEqual({ preservationPath: '/test/documents/Anas/recovery/copy' })
    expect(mocks.resetExecution).toHaveBeenCalledWith(expect.any(Function), targets)
    expect(mocks.resetProjects).not.toHaveBeenCalled()
  })

  it('opens a recovery window after stopping writers, without starting normal services', async () => {
    const recovery = await setup()
    await recovery.showStartupRecovery(new Error('broken SQLite'))
    expect(mocks.createWindow).toHaveBeenCalledWith({ recovery: true })
    expect(mocks.transition).toHaveBeenCalledOnce()
    expect(mocks.closeAgent).toHaveBeenCalledOnce()
    expect(mocks.closeMcp).toHaveBeenCalledOnce()
    expect(mocks.closePlugins).toHaveBeenCalledOnce()
    expect(mocks.configureLogger).toHaveBeenCalledWith('info', 0)
    expect(await invoke('inspect')).toMatchObject({ startupError: 'broken SQLite', canModify: true })
  })

  it('keeps recovery available when its log directory cannot be initialized', async () => {
    const recovery = await setup()
    mocks.configureLogger.mockImplementation(() => { throw new Error('log directory unavailable') })
    await recovery.showStartupRecovery(new Error('broken SQLite'))
    expect(mocks.createWindow).toHaveBeenCalledWith({ recovery: true })
    expect(await invoke('inspect')).toMatchObject({ startupError: expect.stringContaining('log directory unavailable'), canModify: true })
  })

  it('leaves diagnostics available but blocks mutation when any writer cannot stop', async () => {
    const recovery = await setup()
    mocks.closeAgent.mockRejectedValue(new Error('run still active'))
    await recovery.showStartupRecovery(new Error('failed'))
    expect(mocks.createWindow).toHaveBeenCalled()
    expect(await invoke('inspect')).toMatchObject({ canModify: false, stopError: expect.stringContaining('run still active') })
    await expect(invoke('reset', 'settings.json')).rejects.toThrow('run still active')
    await expect(invoke('repair', 'settings.json')).rejects.toThrow('run still active')
    expect(mocks.preserve).not.toHaveBeenCalled()
    expect(mocks.reset).not.toHaveBeenCalled()
  })

  it('does not allow reset until recovery is active or allow non-config targets', async () => {
    const recovery = await setup()
    await expect(invoke('reset', 'settings.json')).rejects.toThrow('Enter startup recovery')
    await recovery.showStartupRecovery(new Error('failed'))
    await expect(invoke('reset', '../projects.json')).rejects.toThrow('exactly one')
    expect(mocks.preserve).not.toHaveBeenCalled()
  })

  it('preserves before resetting and never resets if preservation fails', async () => {
    const recovery = await setup()
    await recovery.showStartupRecovery(new Error('failed'))
    mocks.preserve.mockRejectedValueOnce(new Error('disk full'))
    await expect(invoke('reset', 'models.json')).rejects.toThrow('disk full')
    expect(mocks.reset).not.toHaveBeenCalled()
    await invoke('reset', 'models.json')
    expect(mocks.reset).toHaveBeenCalledWith('/test/data', '/bundled/config', 'models.json')
    expect(await invoke('inspect')).toMatchObject({ lastPreservationPath: '/test/documents/Anas/recovery/copy' })
  })

  it('rejects concurrent reset and restart until preservation finishes', async () => {
    const recovery = await setup()
    await recovery.showStartupRecovery(new Error('failed'))
    let complete!: (path: string) => void
    mocks.preserve.mockImplementation(() => new Promise<string>((resolve) => { complete = resolve }))
    const first = invoke('reset', 'settings.json')
    expect(recovery.isRecoveryOperationRunning()).toBe(true)
    await expect(invoke('reset', 'models.json')).rejects.toThrow('in progress')
    expect(() => invoke('restart')).toThrow('finish')
    complete('/test/preserved')
    await first
    expect(recovery.isRecoveryOperationRunning()).toBe(false)
    expect(mocks.reset).toHaveBeenCalledOnce()
  })

  it('uses a full navigation when entering recovery from the normal loading gate', async () => {
    await setup()
    const loadURL = vi.fn(async (_url: string) => {})
    const event = { sender: { getURL: () => 'file:///app/index.html', loadURL } }
    await mocks.handlers.get('recovery:enter')!(event, 'config failed')
    const url = new URL(loadURL.mock.calls[0]![0] as string)
    expect(url.hash).toBe('#recovery')
    expect(url.searchParams.get('recovery')).toBeTruthy()
    expect(await invoke('inspect')).toMatchObject({ startupError: 'config failed', canModify: true })
  })

  it('blocks further writes if a failed project reset cannot be rolled back', async () => {
    const recovery = await setup()
    await recovery.showStartupRecovery(new Error('failed'))
    mocks.resetProjects.mockRejectedValue(new Error('reset failed'))
    mocks.recoverRestore.mockRejectedValue(new Error('rollback failed'))
    await expect(invoke('resetProjects', [])).rejects.toThrow('reset failed')
    expect(await invoke('inspect')).toMatchObject({ canModify: false, stopError: 'rollback failed' })
    await expect(invoke('reset', 'settings.json')).rejects.toThrow('rollback failed')
  })

  it('blocks further repair writes when the project repair rollback cannot finish', async () => {
    const recovery = await setup()
    await recovery.showStartupRecovery(new Error('wrong versions'))
    mocks.repair.mockRejectedValue(new Error('repair failed'))
    mocks.recoverRestore.mockRejectedValue(new Error('rollback failed'))
    await expect(invoke('repair', 'projects.json')).rejects.toThrow('repair failed')
    expect(await invoke('inspect')).toMatchObject({ canModify: false, stopError: 'rollback failed' })
    await expect(invoke('repair', 'projects.json')).rejects.toThrow('rollback failed')
  })
})
