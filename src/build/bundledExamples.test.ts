import { createRequire } from 'node:module'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { PluginStore } from '../main/plugins/pluginStore'

const { prepareExamples } = createRequire(import.meta.url)('../../scripts/prepare-examples.cjs') as {
  prepareExamples(source: string, target: string): Promise<void>
}
let root: string, source: string, output: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'anas-example-build-'))
  source = join(root, 'source'); output = join(root, 'out/examples')
  await cp(resolve('data/examples'), source, { recursive: true })
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it('builds independently installable plugin ZIPs with all source files and keeps the other examples', async () => {
  await prepareExamples(source, output)
  const data = join(root, 'data')
  await mkdir(data)
  const store = new PluginStore(data)
  const plugins = (await readdir(join(source, 'plugins'), { withFileTypes: true })).filter(entry => entry.isDirectory())
  expect((await readdir(join(output, 'plugins'))).sort()).toEqual([
    'README.en.md', 'README.md', ...plugins.map(entry => entry.name + '.zip')
  ].sort())
  for (const plugin of plugins) {
    const item = await store.install(join(output, 'plugins', plugin.name + '.zip'))
    expect(item.error).toBeUndefined()
    const directory = join(source, 'plugins', plugin.name)
    for (const file of await readdir(directory, { recursive: true, withFileTypes: true })) {
      if (file.isFile()) {
        const path = join(file.parentPath, file.name)
        const relative = path.slice(directory.length + 1).replaceAll('\\', '/')
        expect(await readFile(await store.packageFile(item.id, relative))).toEqual(await readFile(path))
      }
    }
  }
  for (const file of ['skills/weather/SKILL.md', 'tools/read_text_raw/TOOL.json', 'tools/file_sha256/TOOL.json', 'tools/json_format/TOOL.json', 'plugins/README.md']) {
    expect(await readFile(join(output, file))).toEqual(await readFile(join(source, file)))
  }
})

it('rebuilds stable ZIP content without carrying stale output or filesystem timestamps', async () => {
  await prepareExamples(source, output)
  const before = await readFile(join(output, 'plugins/notepad.zip'))
  await writeFile(join(output, 'obsolete.txt'), 'old output')
  await mkdir(join(source, 'plugins/notepad/__pycache__'))
  await writeFile(join(source, 'plugins/notepad/__pycache__/old.pyc'), 'discard')
  await utimes(join(source, 'plugins/notepad/PLUGIN.json'), new Date(), new Date())
  await prepareExamples(source, output)
  expect(await readFile(join(output, 'plugins/notepad.zip'))).toEqual(before)
  expect(await readdir(output)).not.toContain('obsolete.txt')
  expect(await readdir(join(root, 'out'))).toEqual(['examples'])
})

it('preserves the previous output if an example cannot be packaged', async () => {
  await prepareExamples(source, output)
  const before = await readFile(join(output, 'plugins/notepad.zip'))
  await rm(join(source, 'plugins/notepad/PLUGIN.json'))
  await expect(prepareExamples(source, output)).rejects.toThrow()
  expect(await readFile(join(output, 'plugins/notepad.zip'))).toEqual(before)
  expect(await readdir(join(root, 'out'))).toEqual(['examples'])
})
