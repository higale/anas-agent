import { cp, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import fs from 'stubborn-fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PluginStore } from './pluginStore'

const faults = vi.hoisted(() => ({ failCleanup: false, initialWrite: undefined as undefined | (() => Promise<void>) }))
vi.mock('node:fs/promises', async original => {
  const native = await original<typeof import('node:fs/promises')>()
  return { ...native, writeFile: async (...args: Parameters<typeof native.writeFile>) => {
    await native.writeFile(...args)
    if (/[\\/]tmp[\\/]plugin-remove-[^\\/]+[\\/]\.transaction\.json\..+\.tmp$/.test(String(args[0]))) {
      await faults.initialWrite?.()
    }
  }, rm: async (...args: Parameters<typeof native.rm>) => {
    if (faults.failCleanup && /[\\/]\.replace-[^\\/]+[\\/]previous$/.test(String(args[0]))) throw new Error('Cleanup busy')
    return native.rm(...args)
  } }
})

let root: string, source: string, data: string, plugins: string, store: PluginStore
const id = 'transaction-test'
const manifest = { version: 0, id, name: 'Transaction', plugin_version: '1.0.0', api_version: 2, ui: 'index.html' }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'anas-plugin-transaction-')))
  source = join(root, 'source'); data = join(root, 'data'); plugins = join(data, 'plugins')
  await mkdir(source); await mkdir(data)
  await writeFile(join(source, 'PLUGIN.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'index.html'), 'old package')
  store = new PluginStore(data)
  await store.install(source)
  await store.data(id, 'draft', true, 'saved data')
  await store.setEnabled(id, false)
})
afterEach(async () => {
  faults.failCleanup = false
  faults.initialWrite = undefined
  vi.restoreAllMocks()
  await rm(root, { recursive: true, force: true })
})

type Operation = 'replace' | 'remove'

it('keeps an interrupted first uninstall journal outside the recovery directory', async () => {
  const restartedRoot = join(root, 'interrupted-copy')
  faults.initialWrite = async () => {
    // Capture the filesystem at the crash boundary, before atomic journal publication.
    await cp(data, restartedRoot, { recursive: true })
    throw new Error('Interrupted initial journal write')
  }
  await expect(store.uninstall(id, true)).rejects.toThrow('Interrupted initial journal write')
  faults.initialWrite = undefined
  expect((await readdir(join(restartedRoot, 'plugins'))).filter(name => name.startsWith('.remove-'))).toEqual([])
  const restarted = new PluginStore(restartedRoot)
  await restarted.recoverTransactions()
  expect(await restarted.read(id)).toMatchObject({ enabled: false, error: undefined })
  expect(await readFile(join(restartedRoot, 'plugins', id, 'package/index.html'), 'utf8')).toBe('old package')
  expect(JSON.parse(await readFile(join(restartedRoot, 'db/plugins', id, 'state.json'), 'utf8')).values.draft).toBe('saved data')
  await rm(join(restartedRoot, 'tmp'), { recursive: true, force: true })
  await restarted.recoverTransactions()
})
// These fixtures represent persisted v0 transactions at abrupt-exit boundaries,
// including the window between an OS rename and its completion journal write.
async function interrupted(operation: Operation, moved: number, phase = 'pending', pending = false, recorded = moved) {
  const stage = join(plugins, `.${operation}-interrupted`)
  await mkdir(stage)
  const live = join(plugins, id), liveData = join(data, 'db/plugins', id)
  if (operation === 'replace') {
    await cp(live, join(stage, 'incoming'), { recursive: true })
    await writeFile(join(stage, 'incoming/package/index.html'), 'new package')
  }
  const steps = [[live, join(stage, 'previous')], [liveData, join(stage, 'data')],
    ...(operation === 'replace' ? [[join(stage, 'incoming'), live]] : [])]
  for (const [from, to] of steps.slice(0, moved)) await rename(from, to)
  const record = { version: 0, plugin_id: id, operation, had_package: true, move_data: true,
    phase, completed_moves: recorded, move_pending: pending }
  await writeFile(join(stage, 'transaction.json'), JSON.stringify(record))
  return { stage, live, liveData, steps, record }
}

async function expectRestored() {
  const restarted = new PluginStore(data)
  await restarted.recoverTransactions()
  expect(await readFile(join(plugins, id, 'package/index.html'), 'utf8')).toBe('old package')
  expect(await restarted.read(id)).toMatchObject({ enabled: false, error: undefined })
  expect(JSON.parse(await readFile(join(data, 'db/plugins', id, 'state.json'), 'utf8')).values.draft).toBe('saved data')
  expect((await readdir(plugins)).filter(name => /^\.(replace|remove)-/.test(name))).toEqual([])
  await restarted.recoverTransactions()
}

describe.each(['replace', 'remove'] as const)('%s transaction recovery', operation => {
  const length = operation === 'replace' ? 3 : 2
  it.each(Array.from({ length: length + 1 }, (_, n) => n))('rolls back after %i completed moves', async moved => {
    await interrupted(operation, moved)
    await rm(join(data, 'tmp'), { recursive: true, force: true })
    await expectRestored()
  })

  it.each(Array.from({ length }, (_, n) => n))('recovers a recorded forward intent at step %i before and after rename', async step => {
    for (const applied of [false, true]) {
      await interrupted(operation, step + Number(applied), 'pending', true, step)
      await expectRestored()
    }
  })

  it.each(Array.from({ length }, (_, n) => n + 1))('continues interrupted rollback with %i moves remaining', async remaining => {
    for (const applied of [false, true]) {
      await interrupted(operation, remaining - Number(applied), 'rolling_back', true, remaining)
      await expectRestored()
    }
  })

  it('cleans committed leftovers without restoring old code or data', async () => {
    const { stage, live, liveData } = await interrupted(operation, length, 'committed')
    await rm(join(stage, 'previous/package/index.html')) // interrupted recursive cleanup
    await new PluginStore(data).recoverTransactions()
    await expect(lstat(stage)).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(lstat(liveData)).rejects.toMatchObject({ code: 'ENOENT' })
    if (operation === 'replace') expect(await readFile(join(live, 'package/index.html'), 'utf8')).toBe('new package')
    else await expect(lstat(live)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('cleans an interrupted successful rollback without requiring discarded incoming files', async () => {
    const { stage } = await interrupted(operation, 0, 'rolled_back')
    await rm(join(stage, 'incoming'), { recursive: true, force: true })
    await expectRestored()
  })
})

it('rolls back a new install interrupted before its commit marker', async () => {
  await rm(join(plugins, id), { recursive: true })
  const stage = join(plugins, '.replace-new-install')
  await mkdir(join(stage, 'incoming'), { recursive: true })
  await cp(source, join(stage, 'incoming/package'), { recursive: true })
  await writeFile(join(stage, 'incoming/installation.json'), '{"version":0,"enabled":true}')
  await writeFile(join(stage, 'transaction.json'), JSON.stringify({ version: 0, plugin_id: id, operation: 'replace',
    had_package: false, move_data: false, phase: 'pending', completed_moves: 0, move_pending: true }))
  await rename(join(stage, 'incoming'), join(plugins, id))
  await new PluginStore(data).recoverTransactions()
  expect(await store.list()).toEqual([])
  expect(JSON.parse(await readFile(join(data, 'db/plugins', id, 'state.json'), 'utf8')).values.draft).toBe('saved data')
})

it('handles an empty directory left after the completion journal was removed', async () => {
  const stage = join(plugins, '.remove-empty')
  await mkdir(stage)
  await expectRestored()
})

it('recovers a transaction copied to another data root without using its original absolute paths', async () => {
  const { stage } = await interrupted('replace', 3)
  const relocated = join(root, 'restored-backup')
  await cp(data, relocated, { recursive: true })
  await new PluginStore(relocated).recoverTransactions()
  expect(await readFile(join(relocated, 'plugins', id, 'package/index.html'), 'utf8')).toBe('old package')
  expect(JSON.parse(await readFile(join(relocated, 'db/plugins', id, 'state.json'), 'utf8')).values.draft).toBe('saved data')
  expect(await readFile(join(stage, 'previous/package/index.html'), 'utf8')).toBe('old package')
})

it.each(['missing', 'invalid', 'unsupported', 'unsafe-id', 'wrong-progress'])('preserves %s journals and reports the recovery location', async kind => {
  const { stage, record } = await interrupted('replace', 1)
  if (kind === 'missing') await rm(join(stage, 'transaction.json'))
  else await writeFile(join(stage, 'transaction.json'), kind === 'invalid' ? '{broken' : JSON.stringify({ ...record,
    ...(kind === 'unsupported' ? { version: 99 } : kind === 'unsafe-id' ? { plugin_id: '../outside' } : { completed_moves: 0 }) }))
  const restarted = new PluginStore(data)
  await expect(restarted.recoverTransactions()).rejects.toThrow(stage)
  expect(await readFile(join(stage, 'previous/package/index.html'), 'utf8')).toBe('old package')
  expect(await readFile(join(stage, 'incoming/package/index.html'), 'utf8')).toBe('new package')
})

it('preserves conflicting destination files and resumes after the conflict is resolved', async () => {
  const { stage, live } = await interrupted('remove', 1)
  await mkdir(live)
  await writeFile(join(live, 'unrelated'), 'do not overwrite')
  const restarted = new PluginStore(data)
  await expect(restarted.recoverTransactions()).rejects.toThrow('preserved files remain')
  expect(await readFile(join(live, 'unrelated'), 'utf8')).toBe('do not overwrite')
  expect(await readFile(join(stage, 'previous/package/index.html'), 'utf8')).toBe('old package')
  await rm(live, { recursive: true })
  await expectRestored()
})

it('rejects linked recovery directories without following or cleaning the target', async () => {
  const outside = join(root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'keep'), 'retained')
  await symlink(outside, join(plugins, '.remove-linked'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(new PluginStore(data).recoverTransactions()).rejects.toThrow('linked or invalid')
  expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('retained')
})

it('retains the commit journal on cleanup failure and only retries cleanup after restart', async () => {
  await writeFile(join(source, 'index.html'), 'new package')
  const preview = await store.prepareInstall(source)
  faults.failCleanup = true
  await expect(store.finishInstall(preview.token, { replace: true, deleteData: true })).rejects.toThrow('operation completed')
  const [name] = (await readdir(plugins)).filter(name => name.startsWith('.replace-'))
  const record = JSON.parse(await readFile(join(plugins, name, 'transaction.json'), 'utf8'))
  expect(record.phase).toBe('committed')
  expect(await readFile(join(plugins, id, 'package/index.html'), 'utf8')).toBe('new package')
  await expect(new PluginStore(data).recoverTransactions()).rejects.toThrow('Cleanup busy')
  faults.failCleanup = false
  await new PluginStore(data).recoverTransactions()
  expect(await readFile(join(plugins, id, 'package/index.html'), 'utf8')).toBe('new package')
  await expect(lstat(join(data, 'db/plugins', id))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('recovers using persisted intent if a rename succeeds but reporting completion fails', async () => {
  const nativeRename = fs.retry.rename({ timeout: 2_000, interval: 25 })
  let failed = false
  vi.spyOn(fs.retry, 'rename').mockImplementation(() => async (from, to) => {
    await nativeRename(from, to)
    if (!failed && from === join(plugins, id)) { failed = true; throw new Error('Lost rename acknowledgment') }
  })
  await expect(store.uninstall(id, true)).rejects.toThrow('Lost rename acknowledgment')
  await expectRestored()
})
