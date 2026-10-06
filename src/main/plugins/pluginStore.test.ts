import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PluginStore } from './pluginStore'

let root: string
let source: string
let store: PluginStore
const manifest = { version: 0, id: 'test-plugin', name: 'Test', plugin_version: '1.0.0', api_version: 1, ui: 'index.html' }
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'anas-plugins-test-'))
  source = join(root, 'source')
  await mkdir(source)
  await mkdir(join(root, 'data'))
  await writeFile(join(source, 'PLUGIN.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'index.html'), '<p>Hello</p>')
  store = new PluginStore(join(root, 'data'))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('plugin installation and data', () => {
  it('needs no existing config, copies a plugin and retains falsy data across reinstall', async () => {
    expect(await store.list()).toEqual([])
    expect((await store.install(source)).enabled).toBe(true)
    for (const [index, value] of [false, 0, '', [], null].entries()) await store.data(manifest.id, `key${index}`, true, value)
    expect(await store.data(manifest.id, 'missing')).toBeNull()
    await store.uninstall(manifest.id)
    expect(await store.list()).toEqual([])
    await store.install(source)
    for (const [index, value] of [false, 0, '', [], null].entries()) expect(await store.data(manifest.id, `key${index}`)).toEqual(value)
  })

  it('defaults a missing enabled field without migrating and rejects disabled calls', async () => {
    await store.install(source)
    await writeFile(join(root, 'data/plugins/test-plugin/installation.json'), '{"version":0}')
    expect((await store.read(manifest.id)).enabled).toBe(true)
    await store.setEnabled(manifest.id, false)
    await expect(store.data(manifest.id, 'test')).rejects.toThrow('disabled')
    await store.setEnabled(manifest.id, true)
    expect(await store.data(manifest.id, 'test')).toBeNull()
  })

  it('does not overwrite a duplicate or install an incomplete/incompatible package', async () => {
    await store.install(source)
    await expect(store.install(source)).rejects.toThrow('already installed')
    for (const update of [{ id: 'another-plugin', ui: 'missing.html' }, { api_version: 99 }, { ui: '../outside.html' }, { id: 'con' }]) {
      await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ ...manifest, ...update }))
      await expect(store.install(source)).rejects.toThrow()
    }
    expect(await store.list()).toHaveLength(1)
    expect((await store.read(manifest.id)).error).toBeUndefined()
  })

  it('isolates a damaged plugin and preserves invalid data instead of resetting it', async () => {
    await store.install(source)
    await store.data(manifest.id, 'key', true, 'saved')
    const dataFile = join(root, 'data/plugin_data/test-plugin/state.json')
    await writeFile(dataFile, '{broken')
    await expect(store.data(manifest.id, 'key', true, 'new')).rejects.toThrow()
    expect(await readFile(dataFile, 'utf8')).toBe('{broken')
    await writeFile(join(root, 'data/plugins/test-plugin/package/PLUGIN.json'), '{}')
    expect((await store.list())[0].error).toContain('manifest version')
    await store.uninstall(manifest.id)
    expect(await readFile(dataFile, 'utf8')).toBe('{broken')
  })

  it('serializes concurrent data writes without losing independent keys', async () => {
    await store.install(source)
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.exclusive(() => store.data(manifest.id, `key${index}`, true, index))))
    for (let index = 0; index < 20; index++) expect(await store.data(manifest.id, `key${index}`)).toBe(index)
  })

  it('rejects path escape and linked installation directories without modifying their targets', async () => {
    await expect(store.install(join(source, '..'))).rejects.toThrow()
    await store.install(source)
    await expect(store.packageFile(manifest.id, '../installation.json')).rejects.toThrow()
    await store.uninstall(manifest.id)
    await symlink(source, join(root, 'data/plugins/test-plugin'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.uninstall(manifest.id)).rejects.toThrow('managed directory')
    expect(await readFile(join(source, 'index.html'), 'utf8')).toBe('<p>Hello</p>')
  })

  it('rejects package links outside the source and bounds persisted JSON size', async () => {
    const outside = join(root, 'outside')
    await mkdir(outside)
    await symlink(outside, join(source, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.install(source)).rejects.toThrow('leaves its directory')
    await rm(join(source, 'outside'))
    await store.install(source)
    await store.data(manifest.id, 'text', true, 'previous')
    await expect(store.data(manifest.id, 'text', true, 'x'.repeat(1024 * 1024))).rejects.toThrow('limit')
    expect(await store.data(manifest.id, 'text')).toBe('previous')
  })
})
