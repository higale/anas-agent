import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZipFile } from 'yazl'
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
    expect((await store.install(join(source, 'PLUGIN.json'))).enabled).toBe(true)
    for (const [index, value] of [false, 0, '', [], null].entries()) await store.data(manifest.id, `key${index}`, true, value)
    expect(await store.data(manifest.id, 'missing')).toBeNull()
    await store.uninstall(manifest.id)
    expect(await store.list()).toEqual([])
    await store.install(join(source, 'PLUGIN.json'))
    for (const [index, value] of [false, 0, '', [], null].entries()) expect(await store.data(manifest.id, `key${index}`)).toEqual(value)
  })

  it('defaults a missing enabled field without migrating and rejects disabled calls', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    await writeFile(join(root, 'data/plugins/test-plugin/installation.json'), '{"version":0}')
    expect((await store.read(manifest.id)).enabled).toBe(true)
    await store.setEnabled(manifest.id, false)
    await expect(store.data(manifest.id, 'test')).rejects.toThrow('disabled')
    await store.setEnabled(manifest.id, true)
    expect(await store.data(manifest.id, 'test')).toBeNull()
  })

  it('does not overwrite a duplicate or install an incomplete/incompatible package', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    await expect(store.install(join(source, 'PLUGIN.json'))).rejects.toThrow('already installed')
    for (const update of [{ id: 'another-plugin', ui: 'missing.html' }, { api_version: 99 }, { ui: '../outside.html' }, { id: 'con' }]) {
      await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ ...manifest, ...update }))
      await expect(store.install(join(source, 'PLUGIN.json'))).rejects.toThrow()
    }
    expect(await store.list()).toHaveLength(1)
    expect((await store.read(manifest.id)).error).toBeUndefined()
  })

  it('isolates a damaged plugin and preserves invalid data instead of resetting it', async () => {
    await store.install(join(source, 'PLUGIN.json'))
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
    await store.install(join(source, 'PLUGIN.json'))
    await Promise.all(Array.from({ length: 20 }, (_, index) => store.exclusive(() => store.data(manifest.id, `key${index}`, true, index))))
    for (let index = 0; index < 20; index++) expect(await store.data(manifest.id, `key${index}`)).toBe(index)
  })

  it('rejects path escape and linked installation directories without modifying their targets', async () => {
    await expect(store.install(join(source, '..'))).rejects.toThrow()
    await store.install(join(source, 'PLUGIN.json'))
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
    await expect(store.install(join(source, 'PLUGIN.json'))).rejects.toThrow('leaves its directory')
    await rm(join(source, 'outside'))
    await store.install(join(source, 'PLUGIN.json'))
    await store.data(manifest.id, 'text', true, 'previous')
    await expect(store.data(manifest.id, 'text', true, 'x'.repeat(1024 * 1024))).rejects.toThrow('limit')
    expect(await store.data(manifest.id, 'text')).toBe('previous')
  })
})

interface ZipEntry { name: string; text?: string; mode?: number }
async function pluginZip(entries: ZipEntry[], file = 'plugin.zip'): Promise<string> {
  const path = join(root, file)
  await new Promise<void>((resolve, reject) => {
    const zip = new ZipFile()
    const output = createWriteStream(path)
    output.on('close', resolve)
    output.on('error', reject)
    zip.on('error', reject)
    zip.outputStream.on('error', reject)
    zip.outputStream.pipe(output)
    for (const entry of entries) {
      if (entry.name.endsWith('/')) zip.addEmptyDirectory(entry.name)
      else zip.addBuffer(Buffer.from(entry.text ?? ''), entry.name, { mode: entry.mode, compress: false })
    }
    zip.end()
  })
  return path
}

function packageEntries(prefix = ''): ZipEntry[] {
  return [
    { name: `${prefix}PLUGIN.json`, text: JSON.stringify(manifest) },
    { name: `${prefix}index.html`, text: '<p>ZIP plugin</p>' }
  ]
}

async function expectNoStagedInstallation(): Promise<void> {
  expect(await store.list()).toEqual([])
  expect(await readdir(join(root, 'data/tmp'))).toEqual([])
}

describe('plugin package selection', () => {
  it('requires PLUGIN.json or a ZIP, and copies the whole directory when selecting the manifest', async () => {
    await expect(store.install(source)).rejects.toThrow('ZIP file or PLUGIN.json')
    const other = join(source, 'other.json')
    await writeFile(other, JSON.stringify(manifest))
    await expect(store.install(other)).rejects.toThrow('ZIP file or PLUGIN.json')
    await store.install(join(source, 'PLUGIN.json'))
    expect(await readFile(await store.packageFile(manifest.id, 'index.html'), 'utf8')).toBe('<p>Hello</p>')
    await writeFile(join(source, 'index.html'), 'Source edited later')
    expect(await readFile(await store.packageFile(manifest.id, 'index.html'), 'utf8')).toBe('<p>Hello</p>')
  })

  it.each(['', 'my-plugin/'])('installs a ZIP with manifest prefix "%s" without dropping runtime-named resources', async prefix => {
    const archive = await pluginZip([
      ...packageEntries(prefix),
      { name: `${prefix}dev/helper.cjs`, text: 'module.exports = {}' },
      { name: `${prefix}tmp/resource.txt`, text: 'keep' },
      { name: `${prefix}empty/` },
      { name: `${prefix}bin/helper`, text: '#!/bin/sh\nexit 0\n', mode: 0o100755 }
    ], 'plugin.ZIP')
    const original = await readFile(archive)
    expect((await store.install(archive)).enabled).toBe(true)
    expect(await readFile(await store.packageFile(manifest.id, 'index.html'), 'utf8')).toBe('<p>ZIP plugin</p>')
    expect(await readFile(await store.packageFile(manifest.id, 'dev/helper.cjs'), 'utf8')).toBe('module.exports = {}')
    expect(await readFile(await store.packageFile(manifest.id, 'tmp/resource.txt'), 'utf8')).toBe('keep')
    expect((await stat(join(await store.packageDirectory(manifest.id), 'empty'))).isDirectory()).toBe(true)
    if (process.platform !== 'win32') expect((await stat(await store.packageFile(manifest.id, 'bin/helper'))).mode & 0o777).toBe(0o755)
    expect(await readFile(archive)).toEqual(original)
    expect(await readdir(join(root, 'data/tmp'))).toEqual([])
  })

  it.each([
    [...packageEntries(), ...packageEntries('second/')],
    [...packageEntries('first/'), ...packageEntries('second/')],
    packageEntries('outer/inner/'),
    [...packageEntries('wrapped/'), { name: 'unrelated.txt', text: 'outside the plugin root' }],
    [{ name: 'README.md', text: 'No manifest' }]
  ].map(entries => ({ entries })))('rejects ambiguous or unsupported ZIP layouts and removes temporary files (%#)', async ({ entries }) => {
    await expect(store.install(await pluginZip(entries))).rejects.toThrow(/multiple plugin roots|must contain PLUGIN.json/)
    await expectNoStagedInstallation()
  })

  it('validates manifests and entries before installing, and never overwrites an existing plugin or its data', async () => {
    for (const update of [{ ui: 'missing.html' }, { api_version: 99 }, { ui: '../outside.html' }]) {
      const archive = await pluginZip([
        { name: 'PLUGIN.json', text: JSON.stringify({ ...manifest, ...update }) },
        { name: 'index.html', text: 'Invalid package' }
      ])
      await expect(store.install(archive)).rejects.toThrow()
      await expectNoStagedInstallation()
    }
    await store.install(join(source, 'PLUGIN.json'))
    await store.data(manifest.id, 'draft', true, 'keep my data')
    const archive = await pluginZip(packageEntries())
    await expect(store.install(archive)).rejects.toThrow('already installed')
    expect(await readFile(await store.packageFile(manifest.id, 'index.html'), 'utf8')).toBe('<p>Hello</p>')
    expect(await store.data(manifest.id, 'draft')).toBe('keep my data')
    expect(await readdir(join(root, 'data/tmp'))).toEqual([])
    await store.uninstall(manifest.id)
    await store.install(archive)
    expect(await store.data(manifest.id, 'draft')).toBe('keep my data')
  })

  it.each([
    { name: 'PLUGIN.json', text: '{}' },
    { name: 'INDEX.HTML', text: 'case collision' },
    { name: 'con.txt', text: 'reserved name' },
    { name: 'asset:stream', text: 'invalid path' },
    { name: 'link', text: '../outside', mode: 0o120777 }
  ])('rejects conflicting or unsafe ZIP entries: $name', async entry => {
    await expect(store.install(await pluginZip([...packageEntries(), entry]))).rejects.toThrow()
    await expectNoStagedInstallation()
  })

  it('rejects traversal and corrupted payloads without modifying files outside staging', async () => {
    const outside = join(root, 'outside.txt')
    await writeFile(outside, 'untouched')
    const archive = await pluginZip([...packageEntries(), { name: 'aa/outside.txt', text: 'escape' }])
    let bytes = await readFile(archive)
    const from = Buffer.from('aa/outside.txt')
    const to = Buffer.from('../outside.txt')
    for (let offset = bytes.indexOf(from); offset >= 0; offset = bytes.indexOf(from, offset + from.length)) to.copy(bytes, offset)
    await writeFile(archive, bytes)
    await expect(store.install(archive)).rejects.toThrow(/path/i)
    expect(await readFile(outside, 'utf8')).toBe('untouched')
    await expectNoStagedInstallation()

    await pluginZip(packageEntries())
    bytes = await readFile(archive)
    const offset = bytes.indexOf(Buffer.from('<p>ZIP plugin</p>'))
    expect(offset).toBeGreaterThan(0)
    bytes[offset] ^= 1
    await writeFile(archive, bytes)
    await expect(store.install(archive)).rejects.toThrow('checksum')
    await expectNoStagedInstallation()
  })

  it('rejects an oversized declared file before extracting its data', async () => {
    const archive = await pluginZip(packageEntries())
    const bytes = await readFile(archive)
    const header = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    expect(header).toBeGreaterThan(0)
    bytes.writeUInt32LE(129 * 1024 * 1024, header + 24)
    await writeFile(archive, bytes)
    await expect(store.install(archive)).rejects.toThrow(/size|bytes/i)
    await expectNoStagedInstallation()
  })

  it.skipIf(process.platform === 'win32')('installs internal ZIP links as ordinary copied files', async () => {
    const archive = await pluginZip([...packageEntries(), { name: 'linked.html', text: 'index.html', mode: 0o120777 }])
    await store.install(archive)
    expect(await readFile(await store.packageFile(manifest.id, 'linked.html'), 'utf8')).toBe('<p>ZIP plugin</p>')
  })
})
