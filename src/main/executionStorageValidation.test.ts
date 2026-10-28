import Database from 'better-sqlite3'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { readFrozenStorage } from '../test/frozenStorage'
import { AgentStorage } from './agent/agentStorage'
import { validateExecutionStorageDirectory } from './executionStorageValidation'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function directory() { const root = await mkdtemp(join(tmpdir(), 'anas-storage-preflight-')); roots.push(root); return root }

it('leaves a fresh directory empty for native initialization', async () => {
  const root = await directory()
  await expect(validateExecutionStorageDirectory(root)).resolves.toBeUndefined()
  expect(await readdir(root)).toEqual([])
})

it.each([0, 99])('rejects execution version %s without changing its original database', async version => {
  const root = await directory(), file = join(root, 'db/catalog.sqlite')
  await mkdir(join(root, 'db'))
  await writeFile(file, readFrozenStorage('legacy-catalog').bytes)
  if (version !== 0) { const database = new Database(file); database.pragma(`user_version=${version}`); database.close() }
  const before = await readFile(file)
  await expect(validateExecutionStorageDirectory(root)).rejects.toThrow(`Unsupported execution storage version ${version}`)
  expect(await readFile(file)).toEqual(before)
  expect(await readdir(join(root, 'db'))).toEqual(['catalog.sqlite'])
})

it.each(['missing', 'empty'])('preserves orphan conversations when the catalog is %s', async kind => {
  const root = await directory(), material = join(root, 'db/conversations/orphan/material')
  await mkdir(join(root, 'db/conversations/orphan'), { recursive: true })
  await writeFile(material, 'keep')
  if (kind === 'empty') new Database(join(root, 'db/catalog.sqlite')).close()
  await expect(validateExecutionStorageDirectory(root)).rejects.toThrow('has no catalog')
  expect(await readFile(material, 'utf8')).toBe('keep')
})

it('reads a copied native WAL without checkpointing or rewriting the live database family', async () => {
  const root = await directory(), storage = AgentStorage.openNative(root)
  try {
    storage.createThread({ title: 'Keep native history' })
    const paths = ['catalog.sqlite', 'catalog.sqlite-wal', 'catalog.sqlite-shm'].map(name => join(root, 'db', name))
    const before = await Promise.all(paths.map(path => readFile(path)))
    await expect(validateExecutionStorageDirectory(root)).resolves.toBeUndefined()
    expect(await Promise.all(paths.map(path => readFile(path)))).toEqual(before)
  } finally { storage.close() }
})
