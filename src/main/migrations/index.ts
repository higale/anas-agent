import Database from 'better-sqlite3'
import { copyFile, lstat, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { nativeConversationSchemaVersion } from '../agent/nativeStorageValidation'
import { validateNativeConversationSchema } from '../agent/nativeDatabaseSchema'
import { getAgentCatalogFile, getAgentConversationDatabaseFile } from '../config/dataDir'
import { createPreservationDirectory } from '../recoveryData'
import { conversationV3ToV4 } from './conversation-v3-to-v4'

// Retiring an old version requires only removing its step and fixtures. Current
// schema creation, validation, repair and business readers never import this map.
const steps = new Map([[conversationV3ToV4.from, conversationV3ToV4]])
const suffixes = ['', '-wal', '-shm', '-journal']

async function fileInfo(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
}

async function conversationFiles(root: string): Promise<string[]> {
  const catalogFile = getAgentCatalogFile(root), info = await fileInfo(catalogFile)
  if (!info) return []
  if (!info.isFile()) throw new Error('Agent catalog is not a regular file.')
  const catalog = new Database(catalogFile, { readonly: true, fileMustExist: true })
  let files: string[]
  try {
    // Match runtime/backup ownership. Interrupted deletions and unregistered
    // creation remnants must not become a new startup validation barrier.
    const rows = catalog.prepare(`SELECT id, project_id FROM agent_conversations
      WHERE id NOT IN (SELECT owner_thread_id FROM agent_conversation_deletions)`).all() as { id: string; project_id: string }[]
    files = rows.map(row => getAgentConversationDatabaseFile(row.id, root, row.project_id))
  } finally { catalog.close() }
  for (const file of files) if (!(await lstat(file)).isFile()) throw new Error(`Conversation database is not a regular file: ${file}`)
  return files.sort()
}

function version(file: string): number | undefined {
  const database = new Database(file, { readonly: true, fileMustExist: true })
  try {
    const value = database.pragma('user_version', { simple: true }) as number
    // An interrupted new-store creation may leave an empty SQLite file. The
    // current initializer owns it; it is not an old format to migrate.
    if (value === 0 && !database.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()) return undefined
    return value
  }
  finally { database.close() }
}

function requireUpgradePath(from: number): void {
  let current = from
  while (current !== nativeConversationSchemaVersion) {
    const step = steps.get(current)
    if (!step || step.to <= current || step.to > nativeConversationSchemaVersion) {
      throw new Error(`Unsupported conversation database version ${from}; no upgrade path to ${nativeConversationSchemaVersion}. Original data was not converted.`)
    }
    current = step.to
  }
}

async function signature(file: string): Promise<string> {
  return JSON.stringify(await Promise.all(suffixes.filter(suffix => suffix !== '-shm').map(async suffix => {
    const info = await fileInfo(file + suffix)
    if (!info) return null
    if (!info.isFile()) throw new Error(`Invalid SQLite file family: ${file + suffix}`)
    return [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]
  })))
}

async function copyFamily(file: string, target: string): Promise<void> {
  await mkdir(dirname(target), { recursive: true })
  for (const suffix of suffixes) {
    const info = await fileInfo(file + suffix)
    if (!info) continue
    if (!info.isFile()) throw new Error(`Invalid SQLite file family: ${file + suffix}`)
    await copyFile(file + suffix, target + suffix)
  }
}

function upgrade(file: string, expectedVersion: number): void {
  const database = new Database(file, { fileMustExist: true })
  try {
    database.pragma('foreign_keys=ON')
    database.transaction(() => {
      let current = database.pragma('user_version', { simple: true }) as number
      if (current !== expectedVersion) throw new Error('Conversation version changed during upgrade.')
      while (current !== nativeConversationSchemaVersion) {
        const step = steps.get(current)!
        step.upgrade(database)
        current = step.to
        database.pragma(`user_version=${current}`)
      }
      validateNativeConversationSchema(database)
    }).immediate()
  } finally { database.close() }
}

/** Call with application writers stopped. Each database commits atomically;
 * a restart safely skips already completed databases after a partial upgrade. */
async function upgradeDirectory(root: string, backupDirectory?: string): Promise<string | undefined> {
  const pending = (await conversationFiles(root)).map(file => ({ file, from: version(file) }))
    .filter((item): item is { file: string; from: number } => item.from !== undefined && item.from !== nativeConversationSchemaVersion)
  for (const item of pending) requireUpgradePath(item.from)
  if (!pending.length) return undefined
  const staged = await mkdtemp(join(tmpdir(), 'anas-database-upgrade-'))
  let preservationPath: string | undefined
  let preservationComplete = false
  try {
    const originals = new Map<string, string>()
    for (const [index, item] of pending.entries()) {
      originals.set(item.file, await signature(item.file))
      const probe = join(staged, String(index), 'conversation.sqlite')
      await copyFamily(item.file, probe)
      upgrade(probe, item.from)
    }
    const verify = async (file: string) => {
      if (await signature(file) !== originals.get(file)) throw new Error('Conversation data changed during upgrade preparation; retry after stopping other writers.')
    }
    for (const item of pending) await verify(item.file)
    if (backupDirectory) {
      preservationPath = await createPreservationDirectory(root, backupDirectory)
      for (const item of pending) await copyFamily(item.file, join(preservationPath, 'data', relative(root, item.file)))
      await writeFile(join(preservationPath, 'upgrade.json'), JSON.stringify({ version: 0, source: root,
        targetVersion: nativeConversationSchemaVersion, databases: pending.map(item => ({ path: relative(root, item.file), from: item.from })) }, null, 2), { flag: 'wx' })
      preservationComplete = true
    }
    for (const item of pending) { await verify(item.file); upgrade(item.file, item.from) }
    return preservationPath
  } catch (cause) {
    if (preservationPath) {
      const detail = cause instanceof Error ? cause.message : String(cause)
      throw new Error(preservationComplete
        ? `Database upgrade failed. Original databases are preserved at ${preservationPath}. ${detail}`
        : `Database preservation failed; live databases were not converted. Incomplete backup: ${preservationPath}. ${detail}`, { cause })
    }
    throw cause
  } finally { await rm(staged, { recursive: true, force: true }) }
}

export function upgradeSavedConversationStorage(root: string, backupDirectory: string): Promise<string | undefined> {
  return upgradeDirectory(root, backupDirectory)
}

/** Only an extracted restore candidate; the source archive remains untouched. */
export async function upgradeStagedConversationStorage(root: string): Promise<void> {
  await upgradeDirectory(root)
}
