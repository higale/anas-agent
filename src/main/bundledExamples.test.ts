import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { basename, join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '', bundled: '', failPublish: false, copying: undefined as undefined | (() => Promise<void>) }))
vi.mock('./config/dataDir', async original => ({
  ...await original<typeof import('./config/dataDir')>(),
  getBundledExamplesDir: () => join(state.bundled, 'examples'),
  getExamplesDir: () => join(state.root, 'data/examples'),
  getTempDir: () => join(state.root, 'data/tmp')
}))
vi.mock('node:fs/promises', async original => {
  const native = await original<typeof import('node:fs/promises')>()
  return { ...native,
    cp: async (...args: Parameters<typeof native.cp>) => {
      if (String(args[0]) === join(state.bundled, 'examples')) await state.copying?.()
      return native.cp(...args)
    },
    rename: async (...args: Parameters<typeof native.rename>) => {
      if (state.failPublish && basename(String(args[0])) === '.examples.mirror.tmp') throw new Error('Injected publish failure')
      return native.rename(...args)
    }
  }
})
let initialize: typeof import('./bundledExamples').initializeBundledExamples
const { prepareExamples } = createRequire(import.meta.url)('../../scripts/prepare-examples.cjs') as {
  prepareExamples(source: string, target: string): Promise<void>
}
beforeEach(async () => {
  vi.resetModules()
  state.root = await mkdtemp(join(tmpdir(), 'anas-bundled-examples-'))
  state.bundled = join(state.root, 'bundled')
  await prepareExamples(resolve('data/examples'), join(state.bundled, 'examples'))
  initialize = (await import('./bundledExamples')).initializeBundledExamples
})
afterEach(async () => {
  state.failPublish = false; state.copying = undefined
  await rm(state.root, { recursive: true, force: true })
})

it('refreshes the whole tree, including documentation and new categories, while preserving imported copies', async () => {
  const examples = join(state.root, 'data/examples')
  await mkdir(join(examples, 'retired'), { recursive: true })
  await writeFile(join(examples, 'retired/old.txt'), 'stale')
  await mkdir(join(state.root, 'data/tools/imported'), { recursive: true })
  await writeFile(join(state.root, 'data/tools/imported/local.txt'), 'user copy')
  await writeFile(join(state.bundled, 'examples/README.md'), 'Shared examples')
  await mkdir(join(state.bundled, 'examples/future'))
  await writeFile(join(state.bundled, 'examples/future/guide.txt'), 'Future resource')
  await initialize()
  for (const file of ['README.md', 'plugins/README.md', 'plugins/README.en.md', 'future/guide.txt',
    'skills/weather/SKILL.md', 'tools/read_text_raw/TOOL.json', 'plugins/notepad.zip']) {
    expect(await readFile(join(examples, file))).toEqual(await readFile(join(state.bundled, 'examples', file)))
  }
  await expect(lstat(join(examples, 'retired'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(state.root, 'data/tools/imported/local.txt'), 'utf8')).toBe('user copy')
  // Reinitialization after restoring an older backup refreshes every category.
  await rm(examples, { recursive: true })
  await initialize()
  expect(await readdir(examples)).toEqual(expect.arrayContaining(['skills', 'tools', 'plugins', 'README.md']))
  expect(await readdir(join(examples, 'plugins'))).toEqual(expect.arrayContaining(['notepad.zip', 'backend-demo.zip', 'text-tools.zip', 'writing-helper.zip']))
  await expect(lstat(join(examples, 'plugins/notepad'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readdir(join(state.root, 'data/tmp'))).toEqual([])
})

it.each(['skills/weather/SKILL.md', 'tools/read_text_raw/TOOL.json', 'plugins/notepad.zip'])(
  'retains every current category if %s is invalid, and retries after correction', async file => {
    await initialize()
    const published = join(state.root, 'data/examples')
    const manifest = join(state.bundled, 'examples', file), original = await readFile(manifest)
    await writeFile(join(state.bundled, 'examples/plugins/README.md'), 'Must not publish partially')
    await writeFile(manifest, 'invalid manifest')
    await expect(initialize()).rejects.toThrow()
    expect(await readFile(join(published, file))).toEqual(original)
    expect(await readFile(join(published, 'plugins/README.md'), 'utf8')).not.toBe('Must not publish partially')
    await writeFile(manifest, original)
    await initialize()
    expect(await readFile(join(published, 'plugins/README.md'), 'utf8')).toBe('Must not publish partially')
    expect(await readdir(join(state.root, 'data/tmp'))).toEqual([])
  })

it('restores the previous tree if publishing the new tree fails', async () => {
  await initialize()
  const readme = join(state.root, 'data/examples/plugins/README.md'), original = await readFile(readme)
  await writeFile(join(state.bundled, 'examples/plugins/README.md'), 'New version')
  state.failPublish = true
  await expect(initialize()).rejects.toThrow('Injected publish failure')
  expect(await readFile(readme)).toEqual(original)
  state.failPublish = false
  await initialize()
  expect(await readFile(readme, 'utf8')).toBe('New version')
})

it('retains published ZIPs when a new archive contains an invalid plugin manifest', async () => {
  await initialize()
  const target = join(state.root, 'data/examples/plugins/notepad.zip')
  const previous = await readFile(target)
  const source = join(state.root, 'invalid-source')
  await cp(resolve('data/examples'), source, { recursive: true })
  await writeFile(join(source, 'plugins/notepad/PLUGIN.json'), '{}')
  await prepareExamples(source, join(state.bundled, 'examples'))
  await expect(initialize()).rejects.toThrow()
  expect(await readFile(target)).toEqual(previous)
  expect(await readdir(join(state.root, 'data/tmp'))).toEqual([])
})

it('shares an in-flight refresh and keeps the previous tree visible until validation completes', async () => {
  await initialize()
  const readme = join(state.root, 'data/examples/plugins/README.md'), original = await readFile(readme)
  await writeFile(join(state.bundled, 'examples/plugins/README.md'), 'New version')
  let release!: () => void, started!: () => void
  const blocked = new Promise<void>(resolve => { release = resolve })
  const copying = new Promise<void>(resolve => { started = resolve })
  state.copying = async () => { started(); await blocked }
  const first = initialize()
  try {
    await copying
    expect(initialize()).toBe(first)
    expect(await readFile(readme)).toEqual(original)
  } finally { release(); await first }
  expect(await readFile(readme, 'utf8')).toBe('New version')
})

it('rejects a linked destination and preserves its external contents', async () => {
  const outside = join(state.root, 'outside')
  await mkdir(outside)
  await writeFile(join(outside, 'local.txt'), 'Keep external data')
  await mkdir(join(state.root, 'data'))
  await symlink(outside, join(state.root, 'data/examples'), process.platform === 'win32' ? 'junction' : 'dir')
  await expect(initialize()).rejects.toThrow('regular directory')
  expect(await readFile(join(outside, 'local.txt'), 'utf8')).toBe('Keep external data')
})
