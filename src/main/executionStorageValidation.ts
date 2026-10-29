import Database from 'better-sqlite3'
import { catalogVersion, validateCatalogSchema } from './agent/catalogSchema'
import { copyFile, lstat, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getProjectsDir } from './config/dataDir'

async function info(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
}

/** Inspect a raw catalog copy, including WAL. Even a read-only SQLite open can
 * create shared-memory bookkeeping, so the original is never opened here. */
async function executionVersion(root: string, requireEmptyConversations: boolean): Promise<number | undefined> {
  const file = join(root, 'db', 'catalog.sqlite'), catalog = await info(file)
  const directory = await info(join(root, 'db'))
  if (directory && !directory.isDirectory()) throw new Error('Execution storage must be in a real database directory.')
  const assertEmpty = async () => {
    const projects = getProjectsDir(root), entries = await info(projects)
    let hasConversations = false
    if (entries?.isDirectory()) for (const entry of await readdir(projects, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const conversations = join(projects, entry.name, 'conversations')
      if (await info(conversations) && (await readdir(conversations)).length) hasConversations = true
    }
    if (entries && !entries.isDirectory() || hasConversations
      || await info(join(root, 'db', 'project-deletion.json'))) throw new Error('Execution storage has no catalog; repair the saved data before opening it.')
  }
  if (!catalog) {
    await assertEmpty()
    for (const suffix of ['-wal', '-shm', '-journal']) if (await info(`${file}${suffix}`)) throw new Error('Execution catalog is missing but its recovery files remain; repair the saved data before opening it.')
    return undefined
  }
  if (!catalog.isFile()) throw new Error('Execution catalog must be a regular file.')
  const temporary = await mkdtemp(join(tmpdir(), 'anas-execution-version-'))
  try {
    const copy = join(temporary, 'catalog.sqlite')
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const entry = await info(`${file}${suffix}`)
      if (!entry) continue
      if (!entry.isFile()) throw new Error('Execution catalog family must contain regular files.')
      await copyFile(`${file}${suffix}`, `${copy}${suffix}`)
    }
    const database = new Database(copy, { fileMustExist: true })
    try {
      const version = database.pragma('user_version', { simple: true }) as number
      const tables = database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()
      if (!tables && version === 0) { await assertEmpty(); return undefined }
      if (version === catalogVersion) {
        validateCatalogSchema(database)
        if ((requireEmptyConversations || !await info(getProjectsDir(root))) && database.prepare('SELECT 1 FROM agent_conversations LIMIT 1').get()) {
          throw new Error('Conversation databases are missing; preserve the catalog before repairing project data.')
        }
      }
      return version
    } finally { database.close() }
  } finally { await rm(temporary, { recursive: true, force: true }) }
}


/** Startup preflight reads a copied catalog and never upgrades saved execution data. */
export async function validateExecutionStorageDirectory(root: string, options: { requireEmptyConversations?: boolean } = {}): Promise<void> {
  const version = await executionVersion(root, options.requireEmptyConversations ?? false)
  if (version !== undefined && version !== catalogVersion) {
    throw new Error(`Unsupported execution storage version ${version}; expected catalog ${catalogVersion}. Repair the saved data before opening it; automatic conversion is not supported.`)
  }
}
