import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ root: '', bundled: '' }))
vi.mock('./config/dataDir', async original => ({
  ...await original<typeof import('./config/dataDir')>(),
  getBundledExamplesDir: () => join(state.bundled, 'examples'),
  getTempDir: () => join(state.root, 'data/tmp')
}))
let validate: typeof import('./bundledExamples').validateBundledExamples
const { prepareExamples } = createRequire(import.meta.url)('../../scripts/prepare-examples.cjs') as {
  prepareExamples(source: string, target: string): Promise<void>
}
beforeEach(async () => {
  vi.resetModules()
  state.root = await mkdtemp(join(tmpdir(), 'anas-bundled-examples-'))
  state.bundled = join(state.root, 'bundled')
  await prepareExamples(resolve('data/examples'), join(state.bundled, 'examples'))
  validate = (await import('./bundledExamples')).validateBundledExamples
})
afterEach(async () => { await rm(state.root, { recursive: true, force: true }) })

it('validates packaged examples in place without releasing or overwriting user data', async () => {
  await validate()
  await expect(readdir(join(state.root, 'data/examples'))).rejects.toMatchObject({ code: 'ENOENT' })
  const legacy = join(state.root, 'data/examples/plugins')
  await mkdir(legacy, { recursive: true })
  await writeFile(join(legacy, 'README.md'), 'Keep the old copy')
  await validate()
  expect(await readFile(join(legacy, 'README.md'), 'utf8')).toBe('Keep the old copy')
  expect(await readdir(join(state.bundled, 'examples/plugins'))).toEqual(expect.arrayContaining([
    'notepad.zip', 'backend-demo.zip', 'text-tools.zip', 'writing-helper.zip'
  ]))
  expect(await readdir(join(state.root, 'data/tmp'))).toEqual([])
})

it.each(['skills/weather/SKILL.md', 'tools/read_text_raw/TOOL.json', 'plugins/notepad.zip', 'subagents/web-researcher/AGENT.json'])(
  'reports invalid bundled %s and permits retry after correction', async file => {
    const manifest = join(state.bundled, 'examples', file), original = await readFile(manifest)
    await writeFile(manifest, 'invalid manifest')
    await expect(validate()).rejects.toThrow()
    await writeFile(manifest, original)
    await expect(validate()).resolves.toBeUndefined()
    await expect(readdir(join(state.root, 'data/examples'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readdir(join(state.root, 'data/tmp'))).toEqual([])
  })
