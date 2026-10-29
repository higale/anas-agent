import Database from 'better-sqlite3'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { getAgentCatalogFile, getAgentConversationDatabaseFile } from '../config/dataDir'
import { snapshotAgentDatabase, snapshotAgentStorage } from './agentDatabaseBackup'

const roots: string[] = []
const databases: Database.Database[] = []

async function temporaryDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'anas-agent-backup-'))
  roots.push(root)
  return root
}

async function openDatabase(file: string): Promise<Database.Database> {
  await mkdir(dirname(file), { recursive: true })
  const database = new Database(file)
  databases.push(database)
  database.pragma('journal_mode = WAL')
  return database
}

afterEach(async () => {
  for (const database of databases.splice(0)) database.close()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('agent database snapshots', () => {
  it('includes committed WAL data while the source database remains open', async () => {
    const root = await temporaryDirectory()
    const sourcePath = join(root, 'source.sqlite')
    const source = await openDatabase(sourcePath)
    source.exec("CREATE TABLE records (content TEXT); INSERT INTO records VALUES ('Persisted message')")
    const destination = join(root, 'snapshot.sqlite')

    await expect(snapshotAgentDatabase(sourcePath, destination)).resolves.toBe(true)

    const snapshot = await openDatabase(destination)
    expect(snapshot.prepare('SELECT content FROM records').get()).toEqual({ content: 'Persisted message' })
  })

  it('snapshots the catalog and every listed conversation with stable archive paths', async () => {
    const source = await temporaryDirectory()
    const destination = await temporaryDirectory()
    await mkdir(join(source, 'db/conversations/old'), { recursive: true })
    await writeFile(join(source, 'db/projects.json'), 'unreadable original project')
    await writeFile(join(source, 'db/conversations/old/conversation.sqlite'), 'unreadable original database')
    const catalog = await openDatabase(getAgentCatalogFile(source))
    catalog.exec("CREATE TABLE agent_conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'default-workspace'); CREATE TABLE agent_conversation_deletions (owner_thread_id TEXT); CREATE TABLE agent_thread_locations (thread_id TEXT, owner_thread_id TEXT); INSERT INTO agent_conversations (id) VALUES ('first'), ('second')")
    for (const id of ['first', 'second']) {
      const conversation = await openDatabase(getAgentConversationDatabaseFile(id, source))
      conversation.exec('CREATE TABLE records (content TEXT)')
      conversation.prepare('INSERT INTO records VALUES (?)').run(`Message in ${id}`)
    }

    const snapshots = await snapshotAgentStorage(source, destination)

    expect(snapshots.map(({ relPath }) => relPath)).toEqual([
      'db/catalog.sqlite', 'db/projects/default-workspace/conversations/first/conversation.sqlite', 'db/projects/default-workspace/conversations/second/conversation.sqlite'
    ])
    expect(snapshots.every(({ size }) => size > 0)).toBe(true)
    expect(await readFile(join(source, 'db/projects.json'), 'utf8')).toBe('unreadable original project')
    expect(await readFile(join(source, 'db/conversations/old/conversation.sqlite'), 'utf8')).toBe('unreadable original database')
    for (const id of ['first', 'second']) {
      const snapshot = await openDatabase(getAgentConversationDatabaseFile(id, destination))
      expect(snapshot.prepare('SELECT content FROM records').get()).toEqual({ content: `Message in ${id}` })
    }
  })

  it('fails the backup when a catalog entry has no conversation database', async () => {
    const source = await temporaryDirectory()
    const destination = await temporaryDirectory()
    const catalog = await openDatabase(getAgentCatalogFile(source))
    catalog.exec("CREATE TABLE agent_conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'default-workspace'); CREATE TABLE agent_conversation_deletions (owner_thread_id TEXT); CREATE TABLE agent_thread_locations (thread_id TEXT, owner_thread_id TEXT); INSERT INTO agent_conversations (id) VALUES ('missing')")

    await expect(snapshotAgentStorage(source, destination)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('does not resolve a catalog conversation ID outside its directory', async () => {
    const source = await temporaryDirectory()
    const destination = await temporaryDirectory()
    const catalog = await openDatabase(getAgentCatalogFile(source))
    catalog.exec("CREATE TABLE agent_conversations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL DEFAULT 'default-workspace'); CREATE TABLE agent_conversation_deletions (owner_thread_id TEXT); CREATE TABLE agent_thread_locations (thread_id TEXT, owner_thread_id TEXT); INSERT INTO agent_conversations (id) VALUES ('../outside')")

    await expect(snapshotAgentStorage(source, destination)).rejects.toThrow('not a valid storage directory name')
  })

  it('has no database snapshots before storage has been created', async () => {
    await expect(snapshotAgentStorage(await temporaryDirectory(), await temporaryDirectory())).resolves.toEqual([])
  })

  it('does not silently omit conversation files when their catalog is missing', async () => {
    const source = await temporaryDirectory()
    await openDatabase(getAgentConversationDatabaseFile('orphan', source))
    await expect(snapshotAgentStorage(source, await temporaryDirectory())).rejects.toThrow('without an agent catalog')
  })
})
