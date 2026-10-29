import { lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { cleanupUnknownData } from './unknownDataCleanup'
import { getDataStorageUsage } from './dataStorageUsage'

let root: string, data: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'anas-unknown-cleanup-'))
  data = join(root, 'data')
  await mkdir(data)
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })
async function file(path: string, content = 'retained') {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}
const usage = () => getDataStorageUsage({ dataDir: data, electronCacheSize: async () => 0 })

it('previews and removes obsolete and unknown data while retaining complete managed trees and write recovery files', async () => {
  const retained = ['.env', 'config/settings.json', 'config/assets/custom.png', 'db/catalog.sqlite',
    'db/catalog.sqlite-wal', 'db/projects/state.json', 'db/project-deletion.json', 'db/project-deletion.stage.json',
    'db/projects/default-workspace/conversations/unregistered/arbitrary.bin', 'db/plugins/uninstalled/secret.bin',
    'subagents/custom/AGENT.json', 'subagents/custom/skills/private/extra.bin', 'subagents/.transaction/previous/PROMPT.md',
    'cache/tool-results/old.txt', 'cache/anything.txt', 'skills/custom/extra.bin', 'tools/custom/data.bin',
    'plugins/.remove-recoverable/transaction.json', 'plugins/.replace-recoverable/previous/data.bin',
    'examples/future/document.md', 'lang/custom.json', 'help/custom.md', 'electron/Local State',
    'tmp/generated.bin', 'log/current.log', 'dev/model-http/request.json',
    'config/.settings.json.1.2.tmp', 'db/projects/state.json.write.tmp',
    'config/.avatar-assets-stage-interrupted/previous-assets/source.png', '.examples.mirror.previous/readme.md']
  for (const path of retained) await file(join(data, path))
  await file(join(data, 'config/custom_tools.json'), 'obsolete')
  await file(join(data, 'config/capabilities.json'), 'obsolete')
  await file(join(data, 'sqlite/conversations/old.sqlite'), 'old database')
  await file(join(data, 'saved-backup.zip'), 'backup')
  await mkdir(join(data, 'empty-old-directory'))
  const snapshot = await usage()
  expect(snapshot.unknownFiles).toEqual(['config/capabilities.json', 'config/custom_tools.json', 'empty-old-directory/', 'saved-backup.zip', 'sqlite/'])
  expect(snapshot.cleanup.unknown_files).toEqual({ totalBytes: 34, approximate: false, hasData: true })
  await cleanupUnknownData(data, snapshot.unknownFiles)
  for (const path of retained) expect(await readFile(join(data, path), 'utf8')).toBe('retained')
  expect((await usage()).unknownFiles).toEqual([])
})

it('keeps files created after the preview and does not treat recognized paths supplied by a caller as cleanup candidates', async () => {
  await file(join(data, 'old.txt'))
  const snapshot = await usage()
  await file(join(data, 'new.txt'))
  await file(join(data, 'config/models.json'))
  await cleanupUnknownData(data, [...snapshot.unknownFiles, 'config/models.json'])
  await expect(lstat(join(data, 'old.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(data, 'new.txt'), 'utf8')).toBe('retained')
  expect(await readFile(join(data, 'config/models.json'), 'utf8')).toBe('retained')
})

it.each([undefined, ['../outside'], ['/outside'], ['config/../../outside'], ['C:/outside'], ['config\\outside'], ['old.txt//']])(
  'rejects invalid previews before deleting any data: %j', async invalid => {
    await file(join(data, 'old.txt'))
    await expect(cleanupUnknownData(data, Array.isArray(invalid) ? ['old.txt', ...invalid] : invalid)).rejects.toThrow('preview')
    expect(await readFile(join(data, 'old.txt'), 'utf8')).toBe('retained')
  })

it('removes an unknown directory link itself without measuring or deleting its external target', async () => {
  const outside = join(root, 'outside')
  await file(join(outside, 'user.txt'))
  await symlink(outside, join(data, 'old-link'), process.platform === 'win32' ? 'junction' : 'dir')
  const snapshot = await usage()
  expect(snapshot.unknownFiles).toEqual(['old-link'])
  expect(snapshot.cleanup.unknown_files).toEqual({ totalBytes: 0, approximate: false, hasData: true })
  await cleanupUnknownData(data, snapshot.unknownFiles)
  expect(await readFile(join(outside, 'user.txt'), 'utf8')).toBe('retained')
  await expect(lstat(join(data, 'old-link'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('does not follow a recognized container replaced by a link after preview', async () => {
  await file(join(data, 'config/obsolete.json'))
  const snapshot = await usage()
  await rename(join(data, 'config'), join(root, 'outside-config'))
  await symlink(join(root, 'outside-config'), join(data, 'config'), process.platform === 'win32' ? 'junction' : 'dir')
  await cleanupUnknownData(data, snapshot.unknownFiles)
  expect(await readFile(join(root, 'outside-config/obsolete.json'), 'utf8')).toBe('retained')
})

it('retains a recognized but malformed configuration path for repair', async () => {
  await file(join(data, 'config/settings.json/evidence.txt'))
  expect((await usage()).unknownFiles).toEqual([])
})

it('reports zero-byte files and empty directories as cleanup data', async () => {
  await file(join(data, 'empty.txt'), '')
  await mkdir(join(data, 'old-empty'))
  expect((await usage()).cleanup.unknown_files).toEqual({ totalBytes: 0, approximate: false, hasData: true })
})
