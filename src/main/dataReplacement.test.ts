import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { recoverInterruptedDataRestoreExcept } from './dataReplacement'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'anas-restore-root-')))
  roots.push(root)
  const data = join(root, 'data'), transaction = await mkdtemp(join(root, '.anas-restore-v4-data-'))
  await mkdir(data); await writeFile(join(data, 'keep.txt'), 'Keep current data')
  return { root, data, transaction, journal: join(transaction, 'transaction.json') }
}

it.each([false, true])('recognizes equivalent restore roots through a parent alias (saved alias: %s)', async savedAlias => {
  const h = await fixture(), links = await realpath(await mkdtemp(join(tmpdir(), 'anas-restore-alias-')))
  roots.push(links)
  const alias = join(links, 'parent'); await symlink(h.root, alias, 'junction')
  await writeFile(h.journal, JSON.stringify({ version: 0, dataDir: savedAlias ? join(alias, 'data') : h.data,
    phase: 'committed', previousEntries: [], installedEntries: [] }))
  await expect(recoverInterruptedDataRestoreExcept(undefined, savedAlias ? h.data : join(alias, 'data'))).resolves.toBe(false)
  await expect(readdir(h.transaction)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(h.data, 'keep.txt'), 'utf8')).toBe('Keep current data')
})

it('rejects a journal for another real directory without changing either directory', async () => {
  const h = await fixture(), other = join(h.root, 'other'); await mkdir(other)
  const journal = JSON.stringify({ version: 0, dataDir: other, phase: 'activated', previousEntries: [], installedEntries: [] })
  await writeFile(h.journal, journal)
  await expect(recoverInterruptedDataRestoreExcept(undefined, h.data)).rejects.toThrow('Invalid restore transaction journal')
  expect(await readFile(h.journal, 'utf8')).toBe(journal)
  expect(await readFile(join(h.data, 'keep.txt'), 'utf8')).toBe('Keep current data')
  expect(await readdir(other)).toEqual([])
})

it.each([
  ['destination', 'db'], ['destination', 'db/projects'], ['destination', 'db/projects/project'],
  ['source', 'previous'], ['source', 'previous/db'], ['source', 'previous/db/projects'], ['source', 'previous/db/projects/project']
])('preserves both trees when rollback %s has a linked ancestor %s', async (side, ancestor) => {
  const h = await fixture(), name = 'db/projects/project/conversations'
  const outside = join(h.root, 'external')
  const entry = side === 'source' ? `previous/${name}` : name
  const externalEntry = join(outside, ...entry.split('/').slice(ancestor.split('/').length))
  await mkdir(externalEntry, { recursive: true })
  await writeFile(join(externalEntry, 'keep.txt'), 'unrelated data')
  const link = join(side === 'source' ? h.transaction : h.data, ancestor)
  await mkdir(dirname(link), { recursive: true })
  await symlink(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
  const other = side === 'source' ? join(h.data, name) : join(h.transaction, 'previous', name)
  await mkdir(other, { recursive: true }); await writeFile(join(other, 'keep.txt'), 'retained original')
  const journal = JSON.stringify({ version: 0, dataDir: h.data, phase: 'restoring_previous', previousEntries: [name], installedEntries: [] })
  await writeFile(h.journal, journal)
  await expect(recoverInterruptedDataRestoreExcept(undefined, h.data)).rejects.toThrow('linked or invalid directory')
  expect(await readFile(join(externalEntry, 'keep.txt'), 'utf8')).toBe('unrelated data')
  expect(await readFile(join(other, 'keep.txt'), 'utf8')).toBe('retained original')
  expect(await readFile(h.journal, 'utf8')).toBe(journal)
})

it('recreates missing rollback parents and leaves a completed rollback unchanged on retry', async () => {
  const h = await fixture(), name = 'db/projects/project/conversations'
  const saved = join(h.transaction, 'previous', name)
  await mkdir(saved, { recursive: true }); await writeFile(join(saved, 'keep.txt'), 'original conversation')
  await writeFile(h.journal, JSON.stringify({ version: 0, dataDir: h.data, phase: 'swapping', previousEntries: [name], installedEntries: [] }))
  await expect(recoverInterruptedDataRestoreExcept(undefined, h.data)).resolves.toBe(true)
  expect(await readFile(join(h.data, name, 'keep.txt'), 'utf8')).toBe('original conversation')
  await expect(recoverInterruptedDataRestoreExcept(undefined, h.data)).resolves.toBe(false)
  expect(await readFile(join(h.data, name, 'keep.txt'), 'utf8')).toBe('original conversation')
})
