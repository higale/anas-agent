import Database from 'better-sqlite3'
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseProjectStore } from './projectStore'
import { AgentStorage } from './agent/agentStorage'
import { catalogVersion, catalogConversationColumns, catalogConversationSchema, catalogConversationIndexes, validateCatalogAccessMode } from './agent/catalogSchema'
import { NativeConversationDatabase } from './agent/nativeConversationDatabase'
import { replaceProjectData } from './backupService'
import { repairArchivedFileChangeVersions } from './recoveryFileChanges'
import { getProjectStoreFile } from './config/dataDir'

/** Manual repair of a staged copy. Invalid choices use the current default;
 * no historical permission names or version conversion rules are interpreted. */
function repairCatalogAccessMode(database: Database.Database): string[] {
  try { validateCatalogAccessMode(database); return [] } catch { /* Rebuild only the known current table shape. */ }
  const columns = database.prepare('PRAGMA table_info(agent_conversations)').all() as Array<{ name: string }>
  if (columns.length !== catalogConversationColumns.length || columns.some(({ name }) => !catalogConversationColumns.includes(name))) {
    throw new Error('Unrecognized conversation catalog columns; original database preserved.')
  }
  const foreignKeys = database.pragma('foreign_keys', { simple: true })
  database.pragma('foreign_keys = OFF')
  try {
    database.transaction(() => {
      database.exec(catalogConversationSchema.replace('CREATE TABLE agent_conversations', 'CREATE TABLE repaired_conversations'))
      const selected = catalogConversationColumns.map(column => column === 'access_mode'
        ? "CASE WHEN access_mode IN ('strict_approval', 'smart_approval', 'full_access') THEN access_mode ELSE 'smart_approval' END"
        : column)
      database.exec(`INSERT INTO repaired_conversations (${catalogConversationColumns.join(',')})
        SELECT ${selected.join(',')} FROM agent_conversations;
        DROP TABLE agent_conversations;
        ALTER TABLE repaired_conversations RENAME TO agent_conversations;
        ${catalogConversationIndexes}`)
      validateCatalogAccessMode(database)
      if ((database.pragma('foreign_key_check') as unknown[]).length) throw new Error('Agent catalog foreign key check failed.')
    })()
  } finally { database.pragma(`foreign_keys = ${foreignKeys ? 'ON' : 'OFF'}`) }
  return ['agent_conversations.access_mode (constraint repaired; invalid values use smart_approval)']
}

async function storageFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  async function visit(path: string, relative: string): Promise<void> {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && !relative) return undefined
      throw error
    })
    if (!info) return
    if (files.size >= 100_000 || relative.split('/').length > 64) throw new Error('Database directory preservation exceeds the file count or depth limit.')
    if (info.isDirectory()) {
      files.set(relative, `directory:${info.dev}:${info.ino}`)
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative ? `${relative}/${name}` : name)
    } else if (info.isFile()) {
      files.set(relative, `file:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
    } else if (info.isSymbolicLink()) {
      files.set(relative, `link:${info.dev}:${info.ino}:${await readlink(path)}`)
    } else throw new Error(`Cannot preserve special file: ${path}`)
  }
  await visit(join(root, 'db'), '')
  return files
}

async function stageProjectRepair(root: string, staged: string, before: string, after: string) {
  if (await realpath(root) !== root) throw new Error('Project data directory changed while repairing.')
  const pendingDeletion = await lstat(join(root, 'db', 'project-deletion.json')).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (pendingDeletion) throw new Error('Project deletion recovery must finish before project data can be repaired.')
  // The stage is written before the deletion journal. An interrupted staging
  // write does not start a transaction; preserve its bytes before replacement
  // and leave the original stage untouched instead of blocking data repair.
  const projectPath = getProjectStoreFile(root)
  const projectInfo = await lstat(projectPath)
  if (!projectInfo.isFile() || await readFile(projectPath, 'utf8') !== before) throw new Error('Project file changed since inspection.')
  const scan = async () => new Map<string, string>([
    ...[...await storageFiles(root)].map(([name, signature]) => [`db${name ? `/${name}` : ''}`, signature] as const)
  ])
  const files = await scan()
  const issues: string[] = []
  for (const relative of files.keys()) {
    if (/^db\/(catalog\.sqlite|conversations\/[^/]+\/conversation\.sqlite)-(wal|shm|journal)$/.test(relative) && !files.has(relative.replace(/-(wal|shm|journal)$/, ''))) {
      issues.push(`SQLite database is missing for ${relative}; original files preserved.`)
    }
  }
  const verifyUnchanged = async (): Promise<void> => {
    const currentProject = await lstat(projectPath)
    if (!currentProject.isFile() || currentProject.ino !== projectInfo.ino || currentProject.dev !== projectInfo.dev
      || await readFile(projectPath, 'utf8') !== before
      || JSON.stringify([...await scan()]) !== JSON.stringify([...files])) {
      throw new Error('Project data changed since inspection; inspect again before repairing.')
    }
  }
  for (const [relative, signature] of files) {
    if (relative === 'db/projects.json') continue // Write the repaired document below.
    const target = join(staged, relative)
    if (signature.startsWith('directory:')) await mkdir(target, { recursive: true })
    else if (signature.startsWith('link:')) await cp(join(root, relative), target, { dereference: false, verbatimSymlinks: true })
    else await copyFile(join(root, relative), target)
  }
  await verifyUnchanged()
  await writeFile(getProjectStoreFile(staged), after, { flag: 'wx', mode: 0o600 })
  const fields: string[] = []
  const projects = parseProjectStore(JSON.parse(after))
  const projectIds = new Set(projects.projects.map(({ id }) => id))
  let conversationIds: string[] | undefined
  const probeRoot = join(staged, 'validation')
  await mkdir(probeRoot)
  let unsupportedConversations = false
  // Inspect each conversation's schema first. Repair cannot trust a damaged
  // version field, nor force native content into the old execution format.
  const databaseFiles = [...files].sort(([a], [b]) => Number(a === 'db/catalog.sqlite') - Number(b === 'db/catalog.sqlite'))
  for (const [relative, signature] of databaseFiles) {
    if (!(relative === 'db/catalog.sqlite' || /^db\/conversations\/[^/]+\/conversation\.sqlite$/.test(relative))) continue
    if (!signature.startsWith('file:') || ['', '-wal', '-shm', '-journal'].some(suffix => files.get(`${relative}${suffix}`)?.startsWith('link:'))) {
      issues.push(`${relative}: linked or invalid database family preserved without modification.`)
      continue
    }
    const original = join(staged, relative)
    const probe = join(probeRoot, 'database.sqlite')
    try {
      for (const suffix of ['', '-wal', '-journal']) {
        if (files.has(`${relative}${suffix}`)) await copyFile(`${original}${suffix}`, `${probe}${suffix}`)
      }
      let version: number
      const targetVersion = relative === 'db/catalog.sqlite' ? catalogVersion : 1
      let repairedFields: string[] = []
      const database = new Database(probe, { fileMustExist: true })
      try {
        version = database.pragma('user_version', { simple: true }) as number
        if (relative === 'db/catalog.sqlite') {
          if (unsupportedConversations) throw new Error('Unsupported conversation schema; catalog preserved without conversion.')
          repairedFields = repairCatalogAccessMode(database)
        } else {
          const native = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_state'").get())
          const legacy = Boolean(database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='current_state'").get())
          if (!native || legacy) {
            unsupportedConversations = true
            throw new Error('Unsupported execution schema; original database preserved without conversion.')
          }
        }
        database.pragma(`user_version = ${targetVersion}`)
        if (relative !== 'db/catalog.sqlite') repairedFields = await repairArchivedFileChangeVersions(database, join(root, dirname(relative)))
        const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>
        if (checkpoint.some((result) => result.busy)) throw new Error('SQLite snapshot is busy.')
        database.pragma('journal_mode = DELETE')
      } finally { database.close() }
      if (relative === 'db/catalog.sqlite') conversationIds = AgentStorage.validateCatalogBackup(probe, projectIds)
      else {
        NativeConversationDatabase.validateBackup(probe, join(root, dirname(relative), 'attachments'), projectIds, relative.split('/')[2])
      }
      if (version !== targetVersion || repairedFields.length) {
        await copyFile(probe, original)
        for (const suffix of ['-wal', '-shm', '-journal']) await rm(`${original}${suffix}`, { force: true })
        if (version !== targetVersion) fields.push(`${relative}: user_version (${version} → ${targetVersion})`)
        fields.push(...repairedFields.map(field => `${relative}: ${field}`))
      }
    } catch (error) {
      issues.push(`${relative}: ${error instanceof Error ? error.message : String(error)}`)
      // Keep the original family intact when this database cannot be salvaged.
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        await rm(`${original}${suffix}`, { force: true })
        if (files.has(`${relative}${suffix}`)) await copyFile(join(root, `${relative}${suffix}`), `${original}${suffix}`)
      }
    } finally {
      for (const name of await readdir(probeRoot)) await rm(join(probeRoot, name), { force: true })
    }
  }
  if (conversationIds) {
    for (const id of conversationIds) if (!files.has(`db/conversations/${id}/conversation.sqlite`)) issues.push(`Missing conversation database: ${id}`)
    const registered = new Set(conversationIds.map(id => `db/conversations/${id}/conversation.sqlite`))
    for (const relative of files.keys()) {
      if (/^db\/conversations\/[^/]+\/conversation\.sqlite$/.test(relative) && !registered.has(relative)) issues.push(`Unregistered conversation database preserved: ${relative}`)
    }
  } else if (!files.has('db/catalog.sqlite') && [...files.keys()].some(relative => /^db\/conversations\/[^/]+\/conversation\.sqlite$/.test(relative))) {
    issues.push('Catalog database is missing; conversation databases are preserved and require catalog recovery.')
  }
  return { fields, issues, verifyUnchanged }
}

export async function inspectProjectStorageRepair(root: string, before: string, after: string): Promise<{ fields: string[]; issues: string[] }> {
  const staged = await mkdtemp(join(tmpdir(), 'anas-project-repair-check-'))
  try { const { fields, issues } = await stageProjectRepair(root, staged, before, after); return { fields, issues } }
  finally { await rm(staged, { recursive: true, force: true }) }
}

export async function repairProjectStorage(root: string, before: string, after: string, preserve: () => Promise<string>): Promise<{ preservationPath: string; unresolved: string[] }> {
  root = await realpath(root)
  let unresolved: string[] = []
  const preservationPath = await replaceProjectData(root, async (staged) => {
    const result = await stageProjectRepair(root, staged, before, after)
    unresolved = result.issues
    return result.verifyUnchanged
  }, preserve)
  return { preservationPath, unresolved }
}
