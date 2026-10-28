import { mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
