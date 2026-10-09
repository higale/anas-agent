import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'stubborn-fs'
import { createWriteStream } from 'node:fs'
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ZipFile } from 'yazl'
import { PluginStore } from './pluginStore'
import { pluginDisplayText } from '@shared/plugins'

let root: string
let source: string
let store: PluginStore
const manifest = { version: 0, id: 'test-plugin', name: 'Test', plugin_version: '1.0.0', api_version: 2, ui: 'index.html' }
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'anas-plugins-test-')))
  source = join(root, 'source')
  await mkdir(source)
  await mkdir(join(root, 'data'))
  await writeFile(join(source, 'PLUGIN.json'), JSON.stringify(manifest))
  await writeFile(join(source, 'index.html'), '<p>Hello</p>')
  store = new PluginStore(join(root, 'data'))
})
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }) })

describe('plugin installation and data', () => {
  it('reads bounded icon assets while disabled without granting access to plugin execution', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path d="M1 1h20v20H1z"/></svg>'
    await writeFile(join(source, 'icon.svg'), svg)
    await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ ...manifest, icon: 'icon.svg' }))
    await store.install(join(source, 'PLUGIN.json'))
    await store.setEnabled(manifest.id, false)
    expect((await store.read(manifest.id)).manifest?.icon).toBe('icon.svg')
    const resource = await store.iconResource(manifest.id, 'icon.svg')
    expect(resource.mime).toBe('image/svg+xml')
    expect(resource.bytes.toString()).toBe(svg)
    await expect(store.requireEnabled(manifest.id)).rejects.toThrow('disabled')
    for (const path of ['index.html', '../icon.svg', 'missing.png']) await expect(store.iconResource(manifest.id, path)).rejects.toThrow()
    await writeFile(join(root, 'data/plugins/test-plugin/package/icon.svg'), 'x'.repeat(256 * 1024 + 1))
    await expect(store.iconResource(manifest.id, 'icon.svg')).rejects.toThrow('256 KiB')
    expect((await store.read(manifest.id)).error).toBeUndefined()
  })

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
    const dataFile = join(root, 'data/plugins_data/test-plugin/state.json')
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

describe('optional data removal on uninstall', () => {
  it('deletes only the selected plugin data and permits a fresh installation', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    await store.data(manifest.id, 'home_open_location', true, 'window')
    const data = join(root, 'data/plugins_data/test-plugin')
    await writeFile(join(data, 'profiles.json'), '{broken credentials file')
    const other = join(root, 'data/plugins_data/other-plugin')
    await mkdir(other)
    await writeFile(join(other, 'state.json'), 'keep')
    await store.uninstall(manifest.id, true)
    await expect(stat(data)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(other, 'state.json'), 'utf8')).toBe('keep')
    await store.install(join(source, 'PLUGIN.json'))
    expect(await store.data(manifest.id, 'home_open_location')).toBeNull()
  })

  it('supports no saved data and rejects a non-boolean option before uninstalling', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    await expect(store.uninstall(manifest.id, 'true' as unknown as boolean)).rejects.toThrow('deletion option')
    expect((await store.read(manifest.id)).enabled).toBe(true)
    await store.uninstall(manifest.id, true)
    expect(await store.list()).toEqual([])
  })

  it('refuses linked data directories without uninstalling or touching their targets', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    const group = join(root, 'data/plugins_data')
    await mkdir(group)
    const outside = join(root, 'outside-data')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'untouched')
    await symlink(outside, join(group, manifest.id), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(store.uninstall(manifest.id, true)).rejects.toThrow('managed directory')
    expect((await store.read(manifest.id)).enabled).toBe(true)
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('untouched')
  })

  it('restores the installation when staging its data fails', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    await store.data(manifest.id, 'draft', true, 'keep')
    const rename = fs.retry.rename({ timeout: 2_000, interval: 25 })
    const data = join(root, 'data/plugins_data/test-plugin')
    vi.spyOn(fs.retry, 'rename').mockImplementation(() => async (from, to) => {
      if (from === data) throw new Error('Data directory is busy')
      return rename(from, to)
    })
    await expect(store.uninstall(manifest.id, true)).rejects.toThrow('busy')
    expect((await store.read(manifest.id)).enabled).toBe(true)
    expect(await store.data(manifest.id, 'draft')).toBe('keep')
    expect(await readdir(join(root, 'data/tmp'))).toEqual([])
  })

  it('preserves staged files when rolling back removal also fails', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    await store.data(manifest.id, 'draft', true, 'keep')
    const rename = fs.retry.rename({ timeout: 2_000, interval: 25 })
    const installation = join(root, 'data/plugins/test-plugin')
    vi.spyOn(fs.retry, 'rename').mockImplementation(() => async (from, to) => {
      if (from !== installation) throw new Error('Directory busy')
      return rename(from, to)
    })
    await expect(store.uninstall(manifest.id, true)).rejects.toThrow('preserved files remain')
    const [stage] = await readdir(join(root, 'data/tmp'))
    expect(await readFile(join(root, 'data/tmp', stage, 'removed/package/index.html'), 'utf8')).toBe('<p>Hello</p>')
    expect(JSON.parse(await readFile(join(root, 'data/plugins_data/test-plugin/state.json'), 'utf8')).values.draft).toBe('keep')
  })
})

describe('plugin home location', () => {
  it('uses the legacy default, stores a preference in plugin data and retains it across reinstall', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    expect((await store.home(manifest.id)).location).toBe('sidebar')
    await store.data(manifest.id, 'draft', true, 'keep')
    await store.data(manifest.id, 'home_open_location', true, 'window')
    expect((await store.home(manifest.id)).location).toBe('window')
    const saved = JSON.parse(await readFile(join(root, 'data/plugins_data/test-plugin/state.json'), 'utf8'))
    expect(saved.values).toEqual({ draft: 'keep', home_open_location: 'window' })
    await store.uninstall(manifest.id)
    await store.install(join(source, 'PLUGIN.json'))
    expect((await store.home(manifest.id)).location).toBe('window')
    await store.data(manifest.id, 'home_open_location', true, null)
    expect((await store.home(manifest.id)).location).toBe('sidebar')
  })

  it('uses declared defaults and rejects unsupported choices without overwriting configuration', async () => {
    await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ ...manifest, home: { locations: ['window'], default_location: 'window' } }))
    await store.install(join(source, 'PLUGIN.json'))
    expect(await store.home(manifest.id)).toEqual({ location: 'window', locations: ['window'] })
    await store.data(manifest.id, 'home_open_location', true, 'window')
    for (const value of ['sidebar', 'invalid', false, 0, []]) {
      await expect(store.data(manifest.id, 'home_open_location', true, value)).rejects.toThrow('home location')
    }
    expect(await store.data(manifest.id, 'home_open_location')).toBe('window')
    await store.setEnabled(manifest.id, false)
    await expect(store.home(manifest.id)).rejects.toThrow('disabled')
  })

  it('preserves corrupted stored preferences and rejects invalid home declarations', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    await store.data(manifest.id, 'draft', true, 'keep')
    const file = join(root, 'data/plugins_data/test-plugin/state.json')
    const broken = '{"version":0,"values":{"home_open_location":"invalid","draft":"keep"}}'
    await writeFile(file, broken)
    await expect(store.home(manifest.id)).rejects.toThrow('home location')
    expect(await readFile(file, 'utf8')).toBe(broken)
    await store.data(manifest.id, 'home_open_location', true, 'sidebar')
    expect(await store.data(manifest.id, 'draft')).toBe('keep')
    await store.uninstall(manifest.id)
    for (const home of [{ locations: [] }, { locations: ['bad'] }, { locations: ['window'], default_location: 'sidebar' }, { default_location: false }]) {
      await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ ...manifest, home }))
      await expect(store.install(join(source, 'PLUGIN.json'))).rejects.toThrow('home')
    }
  })
})

describe('plugin language packs', () => {
  async function localized() {
    await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ ...manifest, lang: 'lang' }))
    await mkdir(join(source, 'lang'))
    await writeFile(join(source, 'lang/en.json'), JSON.stringify({ version: 0, _meta: { name: 'English' }, plugin: { name: 'Notebook', description: 'English description' }, actions: { save: 'Save' } }))
    await writeFile(join(source, 'lang/zh-CN.json'), JSON.stringify({ version: 0, _meta: { name: '简体中文' }, plugin: { name: '记事本' } }))
    await store.install(join(source, 'PLUGIN.json'))
    return join(root, 'data/plugins/test-plugin/package/lang')
  }

  it('reads user-added languages without a backend and resolves localized metadata per field', async () => {
    const lang = await localized()
    await writeFile(join(lang, 'fr.json'), JSON.stringify({ version: 0, _meta: { name: 'Français', author: 'Translator' }, plugin: { name: 'Carnet' }, actions: { save: 'Enregistrer' } }))
    const item = await store.read(manifest.id)
    expect(item.languages).toContainEqual(expect.objectContaining({ code: 'fr', name: 'Français', author: 'Translator' }))
    expect(pluginDisplayText(item, 'FR-ca')).toBe('Carnet')
    expect(pluginDisplayText(item, 'zh-TW')).toBe('记事本')
    expect(pluginDisplayText(item, 'fr', 'description')).toBe('English description')
    expect(pluginDisplayText(item, 'ja')).toBe('Notebook')
    expect((await store.languageResources(manifest.id)).resources.fr.actions).toEqual({ save: 'Enregistrer' })
    await store.setEnabled(manifest.id, false)
    await expect(store.languageResources(manifest.id)).rejects.toThrow('disabled')
  })

  it('isolates invalid packs, reports them, and keeps valid resources and original files', async () => {
    const lang = await localized()
    await writeFile(join(lang, 'fr.json'), '{broken')
    await writeFile(join(lang, 'ja.json'), '{"version":1}')
    const item = await store.read(manifest.id)
    expect(item.error).toBeUndefined()
    expect(item.languageErrors).toHaveLength(2)
    expect(pluginDisplayText(item, 'fr')).toBe('Notebook')
    expect(Object.keys((await store.languageResources(manifest.id)).resources)).toEqual(['en', 'zh-CN'])
    expect(await readFile(join(lang, 'fr.json'), 'utf8')).toBe('{broken')
  })

  it('uses language files from the new package on reinstall without merging previous edits', async () => {
    const lang = await localized()
    const french = '{"version":0,"_meta":{"name":"Français"},"plugin":{"name":"Mon carnet"}}'
    const edited = '{"version":0,"plugin":{"name":"My notebook"}}'
    await writeFile(join(lang, 'fr.json'), french)
    await writeFile(join(lang, 'en.json'), edited)
    await writeFile(join(lang, 'de.json'), '{unfinished')
    await store.setEnabled(manifest.id, false)
    await store.uninstall(manifest.id)
    await writeFile(join(source, 'lang/en.json'), '{"version":0,"plugin":{"name":"New English"}}')
    await writeFile(join(source, 'lang/zh-CN.json'), '{"version":0,"plugin":{"name":"新版记事本"}}')
    await store.install(join(source, 'PLUGIN.json'))
    await expect(stat(join(lang, 'fr.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(stat(join(lang, 'de.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(pluginDisplayText(await store.read(manifest.id), 'en')).toBe('New English')
    expect(pluginDisplayText(await store.read(manifest.id), 'zh-CN')).toBe('新版记事本')
    await expect(stat(join(root, 'data/plugins_data/test-plugin'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports oversized language files without disabling the plugin or preventing uninstall', async () => {
    const lang = await localized()
    await writeFile(join(lang, 'fr.json'), 'x'.repeat(128 * 1024 + 1))
    expect((await store.read(manifest.id)).languageErrors?.join()).toContain('size limit')
    expect((await store.read(manifest.id)).manifest?.id).toBe(manifest.id)
    await store.uninstall(manifest.id)
    expect(await store.list()).toEqual([])
  })

  it('rejects a language directory link outside the package without reading or removing its files', async () => {
    await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ ...manifest, lang: 'lang' }))
    await store.install(join(source, 'PLUGIN.json'))
    const outside = join(root, 'outside-languages')
    await mkdir(outside)
    await writeFile(join(outside, 'en.json'), '{"version":0}')
    await symlink(outside, join(root, 'data/plugins/test-plugin/package/lang'), process.platform === 'win32' ? 'junction' : 'dir')
    expect((await store.read(manifest.id)).languageErrors?.join()).toContain('directory')
    await store.uninstall(manifest.id)
    expect(await readFile(join(outside, 'en.json'), 'utf8')).toBe('{"version":0}')
  })

  it('loads custom translations supplied inside a ZIP', async () => {
    const zip = await pluginZip([
      { name: 'PLUGIN.json', text: JSON.stringify({ ...manifest, lang: 'lang' }) },
      { name: 'index.html', text: '<p>Plugin</p>' },
      { name: 'lang/fr.json', text: '{"version":0,"_meta":{"name":"Français"},"plugin":{"name":"Carnet"}}' }
    ])
    await store.install(zip)
    expect(pluginDisplayText(await store.read(manifest.id), 'fr')).toBe('Carnet')
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


describe('confirmed plugin replacement', () => {
  async function replacement(version = '2.0.0') {
    await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ ...manifest, plugin_version: version }))
    await writeFile(join(source, 'index.html'), '<p>New</p>')
    return store.prepareInstall(join(source, 'PLUGIN.json'))
  }
  async function installedHtml() { return readFile(await store.packageFile(manifest.id, 'index.html'), 'utf8') }

  it('previews both versions without changing the installation and cancels only the staged copy', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    await store.data(manifest.id, 'draft', true, 'keep')
    const preview = await replacement()
    expect(preview.installed?.manifest?.pluginVersion).toBe('1.0.0')
    expect(preview.incoming.pluginVersion).toBe('2.0.0')
    expect(await installedHtml()).toBe('<p>Hello</p>')
    expect(await store.data(manifest.id, 'draft')).toBe('keep')
    await store.cancelInstall(preview.token)
    expect(await installedHtml()).toBe('<p>Hello</p>')
    expect(await store.data(manifest.id, 'draft')).toBe('keep')
    expect(await readdir(join(root, 'data/tmp'))).toEqual([])
    await expect(store.finishInstall(preview.token, { replace: true })).rejects.toThrow('no longer pending')
  })

  it('installs the approved snapshot and preserves enabled state and all data by default', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    for (const [index, value] of [false, 0, '', [], null].entries()) await store.data(manifest.id, 'key' + index, true, value)
    const data = join(root, 'data/plugins_data/test-plugin')
    await writeFile(join(data, 'profiles.json'), '{unreadable but retained')
    const preview = await replacement()
    await store.setEnabled(manifest.id, false)
    await writeFile(join(source, 'index.html'), 'changed after preview')
    const stop = vi.fn(async () => { expect(await installedHtml()).toBe('<p>Hello</p>') })
    const item = await store.finishInstall(preview.token, { replace: true }, stop)
    expect(stop).toHaveBeenCalledExactlyOnceWith(manifest.id)
    expect(item.enabled).toBe(false)
    expect(item.manifest?.pluginVersion).toBe('2.0.0')
    expect(await installedHtml()).toBe('<p>New</p>')
    expect(await readFile(join(data, 'profiles.json'), 'utf8')).toBe('{unreadable but retained')
    await store.setEnabled(manifest.id, true)
    for (const [index, value] of [false, 0, '', [], null].entries()) expect(await store.data(manifest.id, 'key' + index)).toEqual(value)
    expect(await readdir(join(root, 'data/tmp'))).toEqual([])
  })

  it('deletes only opted-in plugin data, including data written during backend shutdown', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    const other = join(root, 'data/plugins_data/other-plugin')
    await mkdir(other, { recursive: true })
    await writeFile(join(other, 'keep'), 'untouched')
    const preview = await replacement()
    await store.finishInstall(preview.token, { replace: true, deleteData: true }, async () => {
      await store.data(manifest.id, 'draft', true, 'last write')
      await writeFile(join(root, 'data/plugins_data/test-plugin/profiles.json'), 'private data')
    })
    await expect(stat(join(root, 'data/plugins_data/test-plugin'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(join(other, 'keep'), 'utf8')).toBe('untouched')
    expect(await installedHtml()).toBe('<p>New</p>')
  })

  it.each(['1.0.0', '0.9.0'])('requires confirmation for same-version and older packages (%s)', async version => {
    await store.install(join(source, 'PLUGIN.json'))
    const preview = await replacement(version)
    const stop = vi.fn()
    await expect(store.finishInstall(preview.token, {}, stop)).rejects.toThrow('already installed')
    expect(stop).not.toHaveBeenCalled()
    expect(await installedHtml()).toBe('<p>Hello</p>')
    const retry = await replacement(version)
    expect((await store.finishInstall(retry.token, { replace: true })).manifest?.pluginVersion).toBe(version)
  })

  it('cleans superseded staging and does not let an old token cancel or confirm a new selection', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    const first = await replacement()
    const second = await replacement('3.0.0')
    expect(await readdir(join(root, 'data/tmp'))).toHaveLength(1)
    await store.cancelInstall(first.token)
    await expect(store.finishInstall(first.token, { replace: true })).rejects.toThrow('no longer pending')
    expect((await store.finishInstall(second.token, { replace: true })).manifest?.pluginVersion).toBe('3.0.0')
  })

  it('refuses stale confirmation even after a different installation of the same version', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    const preview = await replacement()
    await rename(join(root, 'data/plugins/test-plugin'), join(root, 'old-installation'))
    await writeFile(join(source, 'PLUGIN.json'), JSON.stringify(manifest))
    await new PluginStore(store.dataDirectory).install(join(source, 'PLUGIN.json'))
    const stop = vi.fn()
    await expect(store.finishInstall(preview.token, { replace: true }, stop)).rejects.toThrow('Installed plugin changed')
    expect(stop).not.toHaveBeenCalled()
    expect((await store.read(manifest.id)).manifest?.pluginVersion).toBe('1.0.0')
  })

  it('rejects invalid packages before approval while allowing a damaged old package to be replaced', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    await writeFile(join(source, 'PLUGIN.json'), JSON.stringify({ ...manifest, ui: 'missing.html' }))
    await expect(store.prepareInstall(join(source, 'PLUGIN.json'))).rejects.toThrow()
    expect(await installedHtml()).toBe('<p>Hello</p>')
    expect(await readdir(join(root, 'data/tmp'))).toEqual([])
    await writeFile(join(root, 'data/plugins/test-plugin/package/PLUGIN.json'), '{broken')
    const preview = await replacement()
    expect(preview.installed?.manifest).toBeUndefined()
    expect(preview.installed?.error).toBeTruthy()
    expect((await store.finishInstall(preview.token, { replace: true })).error).toBeUndefined()
  })

  it.each(['stop', 'data', 'package'])('preserves the old package and data when %s fails', async failure => {
    await store.install(join(source, 'PLUGIN.json'))
    await store.data(manifest.id, 'draft', true, 'keep')
    const preview = await replacement()
    const move = fs.retry.rename({ timeout: 2_000, interval: 25 })
    const target = join(root, 'data/plugins/test-plugin'), data = join(root, 'data/plugins_data/test-plugin')
    let failed = false
    vi.spyOn(fs.retry, 'rename').mockImplementation(() => async (from, to) => {
      if (!failed && ((failure === 'data' && from === data) || (failure === 'package' && to === target))) {
        failed = true
        throw new Error('Directory busy')
      }
      return move(from, to)
    })
    await expect(store.finishInstall(preview.token, { replace: true, deleteData: true }, async () => {
      if (failure === 'stop') throw new Error('Backend busy')
    })).rejects.toThrow('busy')
    expect(await installedHtml()).toBe('<p>Hello</p>')
    expect(await store.data(manifest.id, 'draft')).toBe('keep')
    expect(await readdir(join(root, 'data/tmp'))).toEqual([])
  })

  it('preserves recoverable original files and reports their location if rollback also fails', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    await store.data(manifest.id, 'draft', true, 'keep')
    const preview = await replacement()
    const move = fs.retry.rename({ timeout: 2_000, interval: 25 })
    const target = join(root, 'data/plugins/test-plugin'), data = join(root, 'data/plugins_data/test-plugin')
    vi.spyOn(fs.retry, 'rename').mockImplementation(() => async (from, to) => {
      if (to === target || to === data) throw new Error('Directory busy')
      return move(from, to)
    })
    await expect(store.finishInstall(preview.token, { replace: true, deleteData: true })).rejects.toThrow('preserved files remain at')
    await rm(join(root, 'data/tmp'), { recursive: true, force: true })
    const [stage] = (await readdir(join(root, 'data/plugins'))).filter(name => name.startsWith('.replace-'))
    expect(await readFile(join(root, 'data/plugins', stage, 'previous/package/index.html'), 'utf8')).toBe('<p>Hello</p>')
    expect(JSON.parse(await readFile(join(root, 'data/plugins', stage, 'data/state.json'), 'utf8')).values.draft).toBe('keep')
    expect(await new PluginStore(store.dataDirectory).list()).toEqual([])
  })

  it('rejects linked data before stopping the plugin when deletion was selected', async () => {
    await store.install(join(source, 'PLUGIN.json'))
    await mkdir(join(root, 'data/plugins_data'))
    const outside = join(root, 'outside-data')
    await mkdir(outside)
    await writeFile(join(outside, 'keep'), 'untouched')
    await symlink(outside, join(root, 'data/plugins_data/test-plugin'), process.platform === 'win32' ? 'junction' : 'dir')
    const preview = await replacement()
    const stop = vi.fn()
    await expect(store.finishInstall(preview.token, { replace: true, deleteData: true }, stop)).rejects.toThrow('managed directory')
    expect(stop).not.toHaveBeenCalled()
    expect(await installedHtml()).toBe('<p>Hello</p>')
    expect(await readFile(join(outside, 'keep'), 'utf8')).toBe('untouched')
  })
})
