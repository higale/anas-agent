import { EventEmitter } from 'node:events'
import { cp, mkdtemp, realpath, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ root: '', bundled: '', fork: vi.fn(), send: vi.fn(), log: vi.fn() }))
vi.mock('../runtimeLogger', () => ({ runtimeLog: state.log }))
vi.mock('../config/dataDir', () => ({
  getDataDir: () => state.root,
  getBundledDataDir: () => state.bundled,
  getSystemPluginsDir: () => join(state.root, 'plugins/_system'),
  getPluginExamplesDir: () => join(state.root, 'examples/plugins')
}))
vi.mock('../ipcSecurity', () => ({ isMainRendererWindow: () => true }))
vi.mock('electron', () => ({ app: { getAppPath: () => '/app' }, BrowserWindow: { getAllWindows: () => [{ webContents: { send: state.send } }] }, utilityProcess: { fork: state.fork } }))
class Child extends EventEmitter {
  postMessage = vi.fn((message: { stop?: boolean }) => { if (message.stop) queueMicrotask(() => this.emit('exit', 0)) })
  kill = vi.fn(() => { this.emit('exit', 1); return true })
}
let child: Child
let runtime: typeof import('./pluginRuntime')
const { prepareExamples } = createRequire(import.meta.url)('../../../scripts/prepare-examples.cjs') as {
  prepareExamples(source: string, target: string): Promise<void>
}
beforeEach(async () => {
  vi.resetModules()
  state.send.mockReset()
  state.root = await realpath(await mkdtemp(join(tmpdir(), 'anas-plugin-runtime-')))
  state.bundled = join(state.root, 'bundled')
  await cp(resolve('data/plugins/_system'), join(state.bundled, 'plugins/_system'), { recursive: true })
  await prepareExamples(resolve('data/examples'), join(state.root, 'examples'))
  child = new Child()
  state.fork.mockReset().mockReturnValue(child)
  runtime = await import('./pluginRuntime')
  await runtime.initializePluginsStore()
  await runtime.pluginRuntime().store.install(join(state.root, 'examples/plugins/text-tools.zip'))
})
afterEach(async () => { await runtime.stopPluginBackends(); await rm(state.root, { recursive: true, force: true }) })

it.each([false, true])('keeps backend stop notifications except during application exit (quitting=%s)', async quitting => {
  const prepared = await runtime.pluginRuntime().backends.prepare('example-text-tools')
  child.emit('message', { ready: true })
  await prepared.ready
  expect(state.send).toHaveBeenCalledWith('plugins:changed')
  state.send.mockClear()
  if (quitting) runtime.stopPluginChangeNotifications()
  await runtime.stopPluginBackends()
  runtime.changed()
  expect(child.postMessage).toHaveBeenCalledWith({ stop: true })
  expect(runtime.pluginRuntime().backends.status('example-text-tools')).toMatchObject({ backendStatus: 'stopped' })
  if (quitting) expect(state.send).not.toHaveBeenCalled()
  else expect(state.send).toHaveBeenCalledWith('plugins:changed')
})

it('loads mirrored built-ins, keeps examples inactive and refreshes only app-owned packages', async () => {
  const { store } = runtime.pluginRuntime()
  expect((await store.list()).map(plugin => plugin.id).sort()).toEqual(['example-text-tools', 'usage-meter'])
  expect(await store.packageDirectory('usage-meter')).toBe(join(state.root, 'plugins/_system/usage-meter'))
  await store.data('usage-meter', 'choice', true, 'keep')
  await store.setEnabled('usage-meter', false)
  const settings = await store.settings('example-text-tools')
  await store.settings('example-text-tools', { revision: settings.revision, values: { ...settings.values, prefix: 'keep' } })
  const installed = await store.packageFile('example-text-tools', 'backend.cjs')
  const original = await readFile(installed, 'utf8')
  await writeFile(join(state.root, 'plugins/_system/usage-meter/stale.txt'), 'old file')
  await mkdir(join(state.root, 'examples/plugins/text-tools'))
  await writeFile(join(state.root, 'examples/plugins/text-tools/stale.txt'), 'old file')
  await writeFile(join(state.bundled, 'plugins/_system/usage-meter/backend.cjs'), 'module.exports = {}\n')
  await Promise.all([runtime.initializePluginsStore(), runtime.initializePluginsStore()])
  expect(await readFile(await store.packageFile('usage-meter', 'backend.cjs'), 'utf8')).toBe('module.exports = {}\n')
  expect(await readFile(installed, 'utf8')).toBe(original)
  expect((await store.settings('example-text-tools')).values.prefix).toBe('keep')
  expect(await store.read('usage-meter')).toMatchObject({ enabled: false, builtin: true, error: undefined })
  await store.setEnabled('usage-meter', true)
  expect(await store.data('usage-meter', 'choice')).toBe('keep')
  await expect(readFile(join(state.root, 'plugins/_system/usage-meter/stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(state.root, 'examples/plugins/text-tools/stale.txt'), 'utf8')).toBe('old file')
  expect(state.fork).not.toHaveBeenCalled()
})

it('retains the current system package on invalid bundled metadata and retries after correction', async () => {
  const { store } = runtime.pluginRuntime()
  const backend = await store.packageFile('usage-meter', 'backend.cjs')
  const original = await readFile(backend, 'utf8')
  const manifest = join(state.bundled, 'plugins/_system/usage-meter/PLUGIN.json')
  const contents = await readFile(manifest, 'utf8')
  await writeFile(manifest, '{broken')
  await expect(runtime.initializePluginsStore()).rejects.toThrow()
  expect(await readFile(backend, 'utf8')).toBe(original)
  await writeFile(manifest, contents)
  await runtime.initializePluginsStore()
  expect(await store.read('usage-meter')).toMatchObject({ enabled: true, error: undefined })
})

it('recreates mirrors absent from an older backup without resetting plugin state', async () => {
  const { store } = runtime.pluginRuntime()
  await store.setEnabled('usage-meter', false)
  await rm(join(state.root, 'plugins/_system'), { recursive: true })
  await runtime.initializePluginsStore()
  expect(await store.read('usage-meter')).toMatchObject({ enabled: false, error: undefined })
  expect((await store.list()).map(plugin => plugin.id).sort()).toEqual(['example-text-tools', 'usage-meter'])
  expect(state.fork).not.toHaveBeenCalled()
})

it('assembles selected static prompts without a backend, gates dependencies and scope, and reads replacements', async () => {
  const { store } = runtime.pluginRuntime()
  await store.install(resolve('data/examples/plugins/writing-helper/PLUGIN.json'))
  const selected = ['writing-helper:prompt:writing-tone']
  expect(await runtime.buildPluginPrompts([], [], 'main')).toBe('')
  expect(await runtime.buildPluginPrompts(selected, [], 'main')).toContain('preserve the author')
  expect(state.fork).not.toHaveBeenCalled()
  const path = await store.packageFile('example-text-tools', 'PLUGIN.json')
  const manifest = JSON.parse(await readFile(path, 'utf8'))
  const root = await store.packageDirectory('example-text-tools')
  await mkdir(join(root, 'prompts'))
  await writeFile(join(root, 'prompts/help.md'), 'Use the echo tool for the supplied text.')
  manifest.prompts = [{ id: 'help', path: 'prompts/help.md', description: 'Help', scope: 'subagent', tools: ['echo'] }]
  await writeFile(path, JSON.stringify(manifest))
  const own = ['example-text-tools:prompt:help'], tools = ['example-text-tools:tool:echo']
  expect(await runtime.buildPluginPrompts(own, [], 'subagent')).toBe('')
  expect(await runtime.buildPluginPrompts(own, tools, 'main')).toBe('')
  const text = await runtime.buildPluginPrompts([...own, ...own], tools, 'subagent')
  expect(text.match(/Use the echo tool/g)).toHaveLength(1)
  expect(text).toContain('example-text-tools:tool:echo: plugin__example-text-tools__echo')
  expect(state.fork).not.toHaveBeenCalled()
  await store.setEnabled('example-text-tools', false)
  expect(await runtime.buildPluginPrompts(own, tools, 'subagent')).toBe('')
  await store.setEnabled('example-text-tools', true)
  await writeFile(join(root, 'prompts/help.md'), 'Updated instructions.')
  expect(await runtime.buildPluginPrompts(own, tools, 'subagent')).toContain('Updated instructions.')
})

it('cancels during activation without dispatching later or killing another caller’s backend', async () => {
  const [snapshot] = await runtime.resolvePluginTools(['example-text-tools:tool:echo'])
  const controller = new AbortController()
  const dispatch = vi.fn()
  const pending = runtime.invokePluginTool(snapshot, {}, { signal: controller.signal, onDispatch: dispatch })
  const failure = expect(pending).rejects.toThrow('cancelled early')
  await vi.waitFor(() => expect(state.fork).toHaveBeenCalled())
  controller.abort(new Error('cancelled early'))
  await failure
  expect(dispatch).not.toHaveBeenCalled()
  expect(child.kill).not.toHaveBeenCalled()
  child.emit('message', { ready: true })
  const next = runtime.invokePluginTool(snapshot, {}, { onDispatch: dispatch })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  const sent = child.postMessage.mock.calls[0][0] as { id: number }
  child.emit('message', { id: sent.id, result: 'done' })
  expect(await next).toBe('done')
})

it('allows backup to stop a running tool instead of waiting for its execution timeout', async () => {
  const [snapshot] = await runtime.resolvePluginTools(['example-text-tools:tool:echo'])
  const prepared = await runtime.pluginRuntime().backends.prepare(snapshot.pluginId)
  child.emit('message', { ready: true })
  await prepared.ready
  const dispatch = vi.fn()
  const pending = runtime.invokePluginTool(snapshot, {}, { onDispatch: dispatch })
  const failure = expect(pending).rejects.toMatchObject({ code: 'unknown_effect', dispatched: true })
  await vi.waitFor(() => expect(dispatch).toHaveBeenCalledOnce())
  const restarted = new Child()
  state.fork.mockImplementation(() => {
    queueMicrotask(() => restarted.emit('message', { ready: true }))
    return restarted
  })
  await runtime.withPluginBackendsStoppedForBackup(async () => {
    expect(runtime.pluginRuntime().backends.status(snapshot.pluginId).backendStatus).toBe('stopped')
  })
  await failure
  expect(child.postMessage).toHaveBeenCalledWith({ stop: true })
  expect(runtime.pluginRuntime().backends.status(snapshot.pluginId).backendStatus).toBe('running')
  expect(restarted.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ tool: true }))
})

it.each([false, true])('restores backends and automatic eligibility after backup, allowing activation host calls (copy fails=%s)', async fails => {
  const { backends } = runtime.pluginRuntime()
  await backends.stop('usage-meter')
  const prepared = await backends.prepare('example-text-tools')
  child.emit('message', { ready: true })
  await prepared.ready
  const { runApplicationDataOperation } = await import('../applicationDataLifecycle')
  const hostCall = vi.fn(() => runApplicationDataOperation(async () => 'opened'))
  runtime.setPluginBackendViewAction(hostCall)
  const restarted = new Child()
  restarted.postMessage.mockImplementation((message: { stop?: boolean; hostResponse?: number }) => {
    if (message.stop) queueMicrotask(() => restarted.emit('exit', 0))
    if (message.hostResponse) queueMicrotask(() => restarted.emit('message', { ready: true }))
  })
  state.fork.mockImplementation(() => {
    queueMicrotask(() => restarted.emit('message', { hostRequest: 1, method: 'openView', params: {} }))
    return restarted
  })
  const copyError = new Error('disk full')
  const backup = runtime.withPluginBackendsStoppedForBackup(async () => {
    expect(backends.status('example-text-tools').backendStatus).toBe('stopped')
    expect(backends.canStartAutomatically('unused-plugin')).toBe(false)
    if (fails) throw copyError
    return 'saved.zip'
  })
  if (fails) await expect(backup).rejects.toBe(copyError)
  else await expect(backup).resolves.toBe('saved.zip')
  expect(hostCall).toHaveBeenCalledOnce()
  expect(backends.status('example-text-tools').backendStatus).toBe('running')
  expect(backends.canStartAutomatically('example-text-tools')).toBe(true)
  expect(backends.canStartAutomatically('unused-plugin')).toBe(true)
  expect(backends.canStartAutomatically('usage-meter')).toBe(false)
  expect(backends.status('usage-meter').backendStatus).toBe('stopped')
})

it.each(['shutdown', 'manual stop'])('does not undo %s while completing backup', async action => {
  const { backends } = runtime.pluginRuntime()
  const prepared = await backends.prepare('example-text-tools')
  child.emit('message', { ready: true })
  await prepared.ready
  await runtime.withPluginBackendsStoppedForBackup(async () => {
    if (action === 'shutdown') await runtime.stopPluginBackends()
    else await backends.stop('example-text-tools')
  })
  expect(state.fork).toHaveBeenCalledOnce()
  expect(backends.status('example-text-tools').backendStatus).toBe('stopped')
  expect(backends.canStartAutomatically('example-text-tools')).toBe(false)
})

it.each([false, true])('reports restart failures and retains the failed backend state (copy fails=%s)', async fails => {
  const { backends } = runtime.pluginRuntime()
  const prepared = await backends.prepare('example-text-tools')
  child.emit('message', { ready: true })
  await prepared.ready
  const restarted = new Child()
  state.fork.mockImplementation(() => {
    queueMicrotask(() => restarted.emit('message', { ready: false, error: 'activation failed' }))
    return restarted
  })
  const copyError = new Error('disk full')
  const backup = runtime.withPluginBackendsStoppedForBackup(async () => { if (fails) throw copyError; return 'saved.zip' })
  const restartErrors = [expect.objectContaining({ message: 'Could not restart plugin example-text-tools: activation failed' })]
  await expect(backup).rejects.toMatchObject({ errors: fails
    ? [copyError, expect.objectContaining({ errors: restartErrors })] : restartErrors })
  expect(backends.status('example-text-tools')).toEqual({ backendStatus: 'failed', backendError: 'activation failed' })
  expect(backends.canStartAutomatically('example-text-tools')).toBe(false)
  expect(state.log).toHaveBeenCalledWith('error', 'backup', expect.any(String), expect.objectContaining({
    error: expect.any(AggregateError), failures: restartErrors
  }))
})

it('restores healthy backends if another backend cannot stop cleanly and prevents copying', async () => {
  const { backends } = runtime.pluginRuntime()
  const prepared = await backends.prepare('example-text-tools')
  child.emit('message', { ready: true })
  await prepared.ready
  const broken = new Child()
  state.fork.mockReturnValue(broken)
  const other = await backends.prepare('usage-meter')
  broken.emit('message', { ready: true })
  await other.ready
  broken.postMessage.mockImplementation(message => {
    if (message.stop) queueMicrotask(() => {
      broken.emit('message', { stopError: 'flush failed' })
      broken.emit('exit', 0)
    })
  })
  const restarted = new Child()
  state.fork.mockImplementation(() => {
    queueMicrotask(() => restarted.emit('message', { ready: true }))
    return restarted
  })
  const copy = vi.fn(async () => 'saved.zip')
  await expect(runtime.withPluginBackendsStoppedForBackup(copy)).rejects.toThrow('Could not cleanly stop')
  expect(copy).not.toHaveBeenCalled()
  expect(backends.status('example-text-tools').backendStatus).toBe('running')
  expect(backends.status('usage-meter')).toEqual({ backendStatus: 'failed', backendError: 'Plugin backend cleanup failed: flush failed' })
  expect(backends.canStartAutomatically('usage-meter')).toBe(false)
})

it('serializes consecutive backups through backend restart', async () => {
  const { backends } = runtime.pluginRuntime()
  const prepared = await backends.prepare('example-text-tools')
  child.emit('message', { ready: true })
  await prepared.ready
  const restarted = new Child()
  state.fork.mockReturnValue(restarted)
  const first = runtime.withPluginBackendsStoppedForBackup(async () => 'first.zip')
  const secondCopy = vi.fn(async () => 'second.zip')
  const second = runtime.withPluginBackendsStoppedForBackup(secondCopy)
  await vi.waitFor(() => expect(state.fork).toHaveBeenCalledTimes(2))
  expect(secondCopy).not.toHaveBeenCalled()
  state.fork.mockImplementation(() => {
    const next = new Child()
    queueMicrotask(() => next.emit('message', { ready: true }))
    return next
  })
  restarted.emit('message', { ready: true })
  await expect(first).resolves.toBe('first.zip')
  await expect(second).resolves.toBe('second.zip')
  expect(backends.status('example-text-tools').backendStatus).toBe('running')
  expect(backends.canStartAutomatically('example-text-tools')).toBe(true)
})

it('does not fork a recovering backend after shutdown interrupts its package checks', async () => {
  const { backends, store } = runtime.pluginRuntime()
  const prepared = await backends.prepare('example-text-tools')
  child.emit('message', { ready: true })
  await prepared.ready
  const packageFile = store.packageFile.bind(store)
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const check = vi.spyOn(store, 'packageFile').mockImplementation(async (...args) => {
    await held
    return packageFile(...args)
  })
  const backup = runtime.withPluginBackendsStoppedForBackup(async () => 'saved.zip')
  const failure = expect(backup).rejects.toThrow('could not be restarted')
  await vi.waitFor(() => expect(check).toHaveBeenCalled())
  await runtime.stopPluginBackends()
  release()
  await failure
  expect(state.fork).toHaveBeenCalledOnce()
  expect(backends.status('example-text-tools').backendStatus).toBe('stopped')
  expect(backends.canStartAutomatically('example-text-tools')).toBe(false)
})
