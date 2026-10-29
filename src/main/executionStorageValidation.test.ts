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

it('ignores previous-layout files while initializing and reopening current storage', async () => {
  const root = await directory()
  await mkdir(join(root, 'db/conversations/old'), { recursive: true })
  const previous = ['db/projects.json', 'db/conversations/old/conversation.sqlite']
  for (const path of previous) await writeFile(join(root, path), 'unreadable original')
  await expect(validateExecutionStorageDirectory(root)).resolves.toBeUndefined()
  const storage = AgentStorage.openNative(root)
  let id: string
  try { id = storage.createThread({ title: 'Current conversation' }).id } finally { storage.close() }
  await expect(validateExecutionStorageDirectory(root)).resolves.toBeUndefined()
  const reopened = AgentStorage.openNative(root)
  try { expect(reopened.getThread(id)?.title).toBe('Current conversation') } finally { reopened.close() }
  for (const path of previous) expect(await readFile(join(root, path), 'utf8')).toBe('unreadable original')
})

it.each([0, 1, 99])('rejects execution version %s without changing its original database', async version => {
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
  const root = await directory(), material = join(root, 'db/projects/default-workspace/conversations/orphan/material')
  await mkdir(join(root, 'db/projects/default-workspace/conversations/orphan'), { recursive: true })
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

it('rejects an incorrectly labelled current catalog before runtime and preserves its bytes', async () => {
  const root = await directory(), file = join(root, 'db/catalog.sqlite')
  await mkdir(join(root, 'db'))
  await writeFile(file, readFrozenStorage('legacy-catalog').bytes)
  const database = new Database(file)
  database.pragma('user_version=2')
  database.close()
  const before = await readFile(file)
  await expect(validateExecutionStorageDirectory(root)).rejects.toThrow('access mode')
  expect(() => AgentStorage.openNative(root)).toThrow('access mode')
  expect(() => AgentStorage.validateCatalogBackup(file, new Set())).toThrow('access mode')
  expect(await readFile(file)).toEqual(before)
})

it.each([false, true])('recreates missing project directories only when catalog conversations=%s allow initialization', async hasConversation => {
  const root = await directory()
  const storage = AgentStorage.openNative(root)
  try { if (hasConversation) storage.createThread({ title: 'Retain catalog evidence' }) } finally { storage.close() }
  await rm(join(root, 'db/projects'), { recursive: true })
  if (hasConversation) {
    await expect(validateExecutionStorageDirectory(root)).rejects.toThrow('Conversation databases are missing')
    expect(() => AgentStorage.openNative(root)).toThrow('Conversation databases are missing')
  } else {
    await expect(validateExecutionStorageDirectory(root)).resolves.toBeUndefined()
    const reopened = AgentStorage.openNative(root)
    try { expect(reopened.createThread().projectId).toBe('default-workspace') } finally { reopened.close() }
  }
})
