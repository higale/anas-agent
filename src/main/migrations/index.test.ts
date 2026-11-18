import Database from 'better-sqlite3'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { restoreFrozenStorageDirectory } from '../../test/frozenStorage'
import { validateNativeConversationSchema } from '../agent/nativeDatabaseSchema'
import { upgradeSavedConversationStorage, upgradeStagedConversationStorage } from './index'
import { conversationV3ToV4 } from './conversation-v3-to-v4'

const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'anas-v3-upgrade-test-')); roots.push(parent)
  const frozen = join(parent, 'frozen'), root = join(parent, 'data')
  restoreFrozenStorageDirectory('native-repair-base', frozen)
  const [id] = await readdir(join(frozen, 'db/conversations'))
  const directory = join(root, 'db/projects/default-workspace/conversations', id)
  await mkdir(directory, { recursive: true })
  const file = join(directory, 'conversation.sqlite')
  await copyFile(join(frozen, 'db/conversations', id, 'conversation.sqlite'), file)
  await copyFile(join(frozen, 'db/catalog.sqlite'), join(root, 'db/catalog.sqlite'))
  const catalog = new Database(join(root, 'db/catalog.sqlite'))
  catalog.prepare('DELETE FROM agent_conversations WHERE id<>?').run(id)
  catalog.prepare('UPDATE agent_conversations SET project_id=?').run('default-workspace')
  catalog.close()
  return { parent, root, file, backups: join(parent, 'backups') }
}

function registerSecond(root: string): void {
  const catalog = new Database(join(root, 'db/catalog.sqlite'))
  try {
    const row = catalog.prepare('SELECT * FROM agent_conversations LIMIT 1').get() as Record<string, unknown>
    row.id = 'second'
    catalog.prepare(`INSERT INTO agent_conversations (${Object.keys(row).join(',')}) VALUES (${Object.keys(row).map(key => '@' + key).join(',')})`).run(row)
  } finally { catalog.close() }
}
function rows(file: string) {
  const database = new Database(file, { readonly: true })
  try {
    const tables = database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]
    return Object.fromEntries(tables.map(({ name }) => [name, database.prepare(`SELECT * FROM "${name}"`).all().map(value => {
      const row = { ...value as Record<string, unknown> }; delete row.source_path; return row
    })]))
  } finally { database.close() }
}

it('upgrades frozen v3 data, preserves every old row and backup, and is safely repeatable', async () => {
  const f = await fixture(), original = await readFile(f.file), before = rows(f.file)
  const backup = await upgradeSavedConversationStorage(f.root, f.backups)
  expect(await readFile(join(backup!, 'data', relative(f.root, f.file)))).toEqual(original)
  expect(rows(f.file)).toEqual(before)
  const database = new Database(f.file)
  try {
    validateNativeConversationSchema(database)
    for (const table of ['agent_attachments', 'agent_queued_attachments']) {
      expect(database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE source_path IS NOT NULL`).get()).toEqual({ count: 0 })
    }
  } finally { database.close() }
  const upgraded = await readFile(f.file)
  expect(await upgradeSavedConversationStorage(f.root, f.backups)).toBeUndefined()
  expect(await readFile(f.file)).toEqual(upgraded)
  expect(await readdir(f.backups)).toHaveLength(1)
})

it.each([0, 2, 99])('refuses unsupported version %s without rewriting its bytes', async from => {
  const f = await fixture(), database = new Database(f.file)
  database.pragma(`user_version=${from}`); database.close()
  const original = await readFile(f.file)
  await expect(upgradeSavedConversationStorage(f.root, f.backups)).rejects.toThrow('no upgrade path')
  expect(await readFile(f.file)).toEqual(original)
})

it('leaves an empty uninitialized database to the current initializer', async () => {
  const f = await fixture()
  await rm(f.file)
  new Database(f.file).close()
  const original = await readFile(f.file)
  expect(await upgradeSavedConversationStorage(f.root, f.backups)).toBeUndefined()
  expect(await readFile(f.file)).toEqual(original)
})

it('rejects a damaged old schema while still working only on a disposable copy', async () => {
  const f = await fixture(), database = new Database(f.file)
  database.exec('DROP TABLE agent_queued_attachments'); database.close()
  const original = await readFile(f.file)
  await expect(upgradeSavedConversationStorage(f.root, f.backups)).rejects.toThrow()
  expect(await readFile(f.file)).toEqual(original)
})

it('upgrades structure without validating or rewriting existing message records', async () => {
  const f = await fixture(), database = new Database(f.file)
  database.exec('PRAGMA foreign_keys=OFF; DELETE FROM execution_message_bodies'); database.close()
  const before = rows(f.file)
  await upgradeStagedConversationStorage(f.root)
  expect(rows(f.file)).toEqual(before)
  const upgraded = new Database(f.file)
  try { validateNativeConversationSchema(upgraded) } finally { upgraded.close() }
})

it('does not convert a database when preservation cannot be created', async () => {
  const f = await fixture(), original = await readFile(f.file)
  await expect(upgradeSavedConversationStorage(f.root, join(f.root, 'invalid-backups'))).rejects.toThrow('outside')
  expect(await readFile(f.file)).toEqual(original)
})

it('rolls back a failure during live conversion and succeeds on retry', async () => {
  const f = await fixture(), before = rows(f.file), original = conversationV3ToV4.upgrade
  let calls = 0
  vi.spyOn(conversationV3ToV4, 'upgrade').mockImplementation(database => {
    original(database)
    if (++calls === 2) throw new Error('Injected interruption after ALTER TABLE')
  })
  await expect(upgradeSavedConversationStorage(f.root, f.backups)).rejects.toThrow('Original databases are preserved')
  const database = new Database(f.file)
  try {
    expect(database.pragma('user_version', { simple: true })).toBe(3)
    expect((database.pragma('table_info(agent_attachments)') as { name: string }[]).some(row => row.name === 'source_path')).toBe(false)
  } finally { database.close() }
  expect(rows(f.file)).toEqual(before)
  vi.restoreAllMocks()
  await upgradeSavedConversationStorage(f.root, f.backups)
  expect(rows(f.file)).toEqual(before)
})

it('retains WAL data and upgrades only an extracted restore candidate', async () => {
  const f = await fixture(), writer = new Database(f.file)
  writer.pragma('journal_mode=WAL'); writer.pragma('wal_autocheckpoint=0')
  writer.exec("UPDATE agent_threads SET title='Saved in WAL'")
  const stage = join(f.parent, 'staged'), stagedFile = join(stage, relative(f.root, f.file))
  await mkdir(join(stagedFile, '..'), { recursive: true })
  await copyFile(join(f.root, 'db/catalog.sqlite'), join(stage, 'db/catalog.sqlite'))
  await copyFile(f.file, stagedFile); await copyFile(f.file + '-wal', stagedFile + '-wal')
  const original = await readFile(f.file), wal = await readFile(f.file + '-wal')
  try {
    await upgradeStagedConversationStorage(stage)
    expect(await readFile(f.file)).toEqual(original)
    expect(await readFile(f.file + '-wal')).toEqual(wal)
    const database = new Database(stagedFile)
    try {
      validateNativeConversationSchema(database)
      expect(database.prepare('SELECT DISTINCT title FROM agent_threads').all()).toEqual([{ title: 'Saved in WAL' }])
    } finally { database.close() }
  } finally { writer.close() }
})

it('rejects an unknown version in another conversation before converting any database', async () => {
  const f = await fixture(), other = join(f.root, 'db/projects/default-workspace/conversations/second/conversation.sqlite')
  await mkdir(join(other, '..'), { recursive: true }); await copyFile(f.file, other)
  registerSecond(f.root)
  const database = new Database(other); database.pragma('user_version=99'); database.close()
  const before = await readFile(f.file)
  await expect(upgradeSavedConversationStorage(f.root, f.backups)).rejects.toThrow('no upgrade path')
  expect(await readFile(f.file)).toEqual(before)
})

it('retries a partially completed collection without replaying a completed upgrade', async () => {
  const f = await fixture(), other = join(f.root, 'db/projects/default-workspace/conversations/second/conversation.sqlite')
  await mkdir(join(other, '..'), { recursive: true }); await copyFile(f.file, other)
  registerSecond(f.root)
  const before = rows(f.file), original = conversationV3ToV4.upgrade
  let calls = 0
  vi.spyOn(conversationV3ToV4, 'upgrade').mockImplementation(database => {
    original(database)
    if (++calls === 4) throw new Error('Second live database interrupted')
  })
  await expect(upgradeSavedConversationStorage(f.root, f.backups)).rejects.toThrow('Original databases are preserved')
  const files = [f.file, other].sort()
  const versions = files.map(file => {
    const database = new Database(file)
    try { return database.pragma('user_version', { simple: true }) } finally { database.close() }
  })
  expect(versions).toEqual([4, 3])
  vi.restoreAllMocks()
  const retry = vi.spyOn(conversationV3ToV4, 'upgrade')
  await upgradeSavedConversationStorage(f.root, f.backups)
  expect(retry).toHaveBeenCalledTimes(2) // One probe and one live conversion.
  for (const file of files) {
    expect(rows(file)).toEqual(before)
    const database = new Database(file)
    try { validateNativeConversationSchema(database) } finally { database.close() }
  }
})

it('ignores unregistered and pending-deletion databases without opening or converting them', async () => {
  const f = await fixture(), other = join(f.root, 'db/projects/default-workspace/conversations/second/conversation.sqlite')
  await mkdir(join(other, '..'), { recursive: true }); await copyFile(f.file, other)
  const invalid = new Database(other); invalid.pragma('user_version=99'); invalid.close()
  const catalog = new Database(join(f.root, 'db/catalog.sqlite'))
  catalog.exec('INSERT INTO agent_conversation_deletions SELECT id FROM agent_conversations'); catalog.close()
  const originals = await Promise.all([f.file, other].map(file => readFile(file)))
  expect(await upgradeSavedConversationStorage(f.root, f.backups)).toBeUndefined()
  expect(await Promise.all([f.file, other].map(file => readFile(file)))).toEqual(originals)
})
