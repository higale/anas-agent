import { EventEmitter } from 'node:events'
import { cp, mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
const state = vi.hoisted(() => ({ root: '', bundled: '', fork: vi.fn() }))
vi.mock('../config/dataDir', () => ({
  getDataDir: () => state.root,
  getBundledDataDir: () => state.bundled,
  getSystemPluginsDir: () => join(state.root, 'plugins_system'),
  getPluginExamplesDir: () => join(state.root, 'plugins_examples')
}))
vi.mock('../ipcSecurity', () => ({ isMainRendererWindow: () => false }))
vi.mock('electron', () => ({ app: { getAppPath: () => '/app' }, BrowserWindow: { getAllWindows: () => [] }, utilityProcess: { fork: state.fork } }))
class Child extends EventEmitter {
  postMessage = vi.fn((message: { stop?: boolean }) => { if (message.stop) queueMicrotask(() => this.emit('exit', 0)) })
  kill = vi.fn(() => { this.emit('exit', 1); return true })
}
let child: Child
let runtime: typeof import('./pluginRuntime')
beforeEach(async () => {
  vi.resetModules()
  state.root = await mkdtemp(join(tmpdir(), 'anas-plugin-runtime-'))
  state.bundled = join(state.root, 'bundled')
  await cp(resolve('data/plugins_system'), join(state.bundled, 'plugins_system'), { recursive: true })
  await cp(resolve('data/plugins_examples'), join(state.bundled, 'plugins_examples'), { recursive: true })
  child = new Child()
  state.fork.mockReset().mockReturnValue(child)
  runtime = await import('./pluginRuntime')
  await runtime.initializePluginsStore()
  await runtime.pluginRuntime().store.install(join(state.root, 'plugins_examples/text-tools/PLUGIN.json'))
})
afterEach(async () => { await runtime.stopPluginBackends(); await rm(state.root, { recursive: true, force: true }) })

it('loads mirrored built-ins, keeps examples inactive and refreshes only app-owned packages', async () => {
  const { store } = runtime.pluginRuntime()
  expect((await store.list()).map(plugin => plugin.id).sort()).toEqual(['example-text-tools', 'usage-meter'])
  expect(await store.packageDirectory('usage-meter')).toBe(join(state.root, 'plugins_system/usage-meter'))
  await store.data('usage-meter', 'choice', true, 'keep')
  await store.setEnabled('usage-meter', false)
  const settings = await store.settings('example-text-tools')
  await store.settings('example-text-tools', { revision: settings.revision, values: { ...settings.values, prefix: 'keep' } })
  const installed = await store.packageFile('example-text-tools', 'backend.cjs')
  const original = await readFile(installed, 'utf8')
  await writeFile(join(state.root, 'plugins_system/usage-meter/stale.txt'), 'old file')
  await writeFile(join(state.root, 'plugins_examples/text-tools/stale.txt'), 'old file')
  await writeFile(join(state.bundled, 'plugins_system/usage-meter/backend.cjs'), 'module.exports = {}\n')
  await writeFile(join(state.bundled, 'plugins_examples/text-tools/backend.cjs'), 'module.exports = {}\n')
  await Promise.all([runtime.initializePluginsStore(), runtime.initializePluginsStore()])
  expect(await readFile(await store.packageFile('usage-meter', 'backend.cjs'), 'utf8')).toBe('module.exports = {}\n')
  expect(await readFile(installed, 'utf8')).toBe(original)
  expect((await store.settings('example-text-tools')).values.prefix).toBe('keep')
  expect(await store.read('usage-meter')).toMatchObject({ enabled: false, builtin: true, error: undefined })
  await store.setEnabled('usage-meter', true)
  expect(await store.data('usage-meter', 'choice')).toBe('keep')
  await expect(readFile(join(state.root, 'plugins_system/usage-meter/stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(join(state.root, 'plugins_examples/text-tools/stale.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(state.fork).not.toHaveBeenCalled()
})

it('retains the current system package on invalid bundled metadata and retries after correction', async () => {
  const { store } = runtime.pluginRuntime()
  const backend = await store.packageFile('usage-meter', 'backend.cjs')
  const original = await readFile(backend, 'utf8')
  const manifest = join(state.bundled, 'plugins_system/usage-meter/PLUGIN.json')
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
  await rm(join(state.root, 'plugins_system'), { recursive: true })
  await rm(join(state.root, 'plugins_examples'), { recursive: true })
  await runtime.initializePluginsStore()
  expect(await store.read('usage-meter')).toMatchObject({ enabled: false, error: undefined })
  expect(JSON.parse(await readFile(join(state.root, 'plugins_examples/notepad/PLUGIN.json'), 'utf8')).id).toBe('example-notepad')
  expect((await store.list()).map(plugin => plugin.id).sort()).toEqual(['example-text-tools', 'usage-meter'])
  expect(state.fork).not.toHaveBeenCalled()
})

it('assembles selected static prompts without a backend, gates dependencies and scope, and reads replacements', async () => {
  const { store } = runtime.pluginRuntime()
  await store.install(resolve('data/plugins_examples/writing-helper/PLUGIN.json'))
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
  // Import the same lifecycle instance as runtime after resetModules.
  const { withApplicationDataSnapshot: snapshotData } = await import('../applicationDataSnapshot')
  await snapshotData(() => runtime.stopPluginBackends())
  await failure
  expect(child.postMessage).toHaveBeenCalledWith({ stop: true })
})
