import Database from 'better-sqlite3'
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { parseProjectStore, readProjectStoreFile, writeProjectStoreDocument } from './projectStore'
import { AgentStorage } from './agent/agentStorage'
import { catalogVersion, catalogConversationColumns, catalogConversationSchema, catalogConversationIndexes, validateCatalogAccessMode, validateCatalogSchema } from './agent/catalogSchema'
import { NativeConversationDatabase } from './agent/nativeConversationDatabase'
import { replaceProjectData } from './backupService'
import { repairArchivedFileChangeVersions } from './recoveryFileChanges'
import { getProjectDir, getProjectStoreFile } from './config/dataDir'
import { readConversationCatalogSnapshot, writeConversationCatalogSnapshot } from './agent/conversationCatalog'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'
import { defaultCapabilities, defaultRestrictSubagents, serializeCapabilities } from '@shared/agentCapabilities'
import projectDefaultsDocument from '../../data/config/projects.json'

const projectStateFields = ['pinned', 'collapsed', 'sort_order', 'thread_order'] as const
function projectUiState(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  return Object.fromEntries(projectStateFields.filter(key => Object.hasOwn(value, key)).map(key => [key, (value as Record<string, unknown>)[key]]))
}

/** A repair-only document assembled from independent current-layout files. */
export async function readRepairProjectDocument(root: string): Promise<string | undefined> {
  const directory = dirname(getProjectStoreFile(root))
  const rawState = await readFile(getProjectStoreFile(root), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const entries = await readdir(directory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return []
    throw error
  })
  if (rawState === undefined && entries.every(entry => entry.isFile() && entry.name.endsWith('.tmp'))) return undefined
  const state = rawState === undefined ? { version: 0, storage_layout: 'project-directories', projects: [] } : JSON.parse(rawState)
  const projects: Record<string, unknown>[] = []
  const directoryRepairs: string[] = []
  if (state.storage_layout !== 'project-directories') directoryRepairs.push('state.json.storage_layout')
  if (!Array.isArray(state.projects)) directoryRepairs.push('state.json.projects')
  const seen = new Set<string>()
  for (const [index, value] of (Array.isArray(state.projects) ? state.projects : []).entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.id !== 'string' || seen.has(value.id)
      || Object.keys(value).some(key => key !== 'id' && !projectStateFields.some(field => field === key))) {
      directoryRepairs.push(`state.json.projects[${index}]`)
    }
    if (typeof value?.id === 'string') seen.add(value.id)
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const document = JSON.parse(await readFile(join(directory, entry.name, 'project.json'), 'utf8'))
    if (document.project?.id !== entry.name) throw new Error(`Project directory identity mismatch: ${entry.name}`)
    if (document.version !== 0) directoryRepairs.push(`${entry.name}/project.json.version`)
    const ui = Array.isArray(state.projects) ? state.projects.find((value: { id?: string }) => value?.id === entry.name) : undefined
    projects.push({ ...document.project, pinned: false, collapsed: false, ...projectUiState(ui) })
  }
  return JSON.stringify({ version: state.version, projects, directory_repairs: directoryRepairs })
}

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
  const stateInfo = () => lstat(projectPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return undefined
    throw error
  })
  const projectInfo = await stateInfo()
  if (projectInfo && !projectInfo.isFile() || await readRepairProjectDocument(root) !== before) throw new Error('Project file changed since inspection.')
  const scan = async () => new Map<string, string>([
    ...[...await storageFiles(root)].map(([name, signature]) => [`db${name ? `/${name}` : ''}`, signature] as const)
  ])
  const files = await scan()
  const issues: string[] = []
  for (const relative of files.keys()) {
    if (/^db\/(catalog\.sqlite|projects\/[^/]+\/conversations\/[^/]+\/conversation\.sqlite)-(wal|shm|journal)$/.test(relative) && !files.has(relative.replace(/-(wal|shm|journal)$/, ''))) {
      issues.push(`SQLite database is missing for ${relative}; original files preserved.`)
    }
  }
  const verifyUnchanged = async (): Promise<void> => {
    const currentProject = await stateInfo()
    if (currentProject && !currentProject.isFile() || currentProject?.ino !== projectInfo?.ino || currentProject?.dev !== projectInfo?.dev
      || await readRepairProjectDocument(root) !== before
      || JSON.stringify([...await scan()]) !== JSON.stringify([...files])) {
      throw new Error('Project data changed since inspection; inspect again before repairing.')
    }
  }
  for (const [relative, signature] of files) {
    const target = join(staged, relative)
    if (signature.startsWith('directory:')) await mkdir(target, { recursive: true })
    else if (signature.startsWith('link:')) await cp(join(root, relative), target, { dereference: false, verbatimSymlinks: true })
    else await copyFile(join(root, relative), target)
  }
  await verifyUnchanged()
  writeProjectStoreDocument(getProjectStoreFile(staged), JSON.parse(after))
  const fields: string[] = JSON.parse(before).directory_repairs ?? []
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
    if (!(relative === 'db/catalog.sqlite' || /^db\/projects\/[^/]+\/conversations\/[^/]+\/conversation\.sqlite$/.test(relative))) continue
    if (!signature.startsWith('file:') || ['', '-wal', '-shm', '-journal'].some(suffix => {
      const signature = files.get(`${relative}${suffix}`)
      return signature !== undefined && !signature.startsWith('file:')
    })) {
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
        NativeConversationDatabase.validateBackup(probe, join(root, dirname(relative), 'attachments'), new Set([relative.split('/')[2]]), relative.split('/')[4])
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
    const catalog = new Database(join(staged, 'db/catalog.sqlite'), { readonly: true, fileMustExist: true })
    const registered = new Set<string>()
    try {
      for (const row of catalog.prepare('SELECT id, project_id FROM agent_conversations').all() as Array<{ id: string; project_id: string }>) {
        const relative = `db/projects/${row.project_id}/conversations/${row.id}/conversation.sqlite`
        registered.add(relative)
        if (!files.has(relative)) issues.push(`Missing conversation database: ${row.id}`)
      }
    } finally { catalog.close() }
    for (const relative of files.keys()) {
      if (/^db\/projects\/[^/]+\/conversations\/[^/]+\/conversation\.sqlite$/.test(relative) && !registered.has(relative)) issues.push(`Unregistered conversation database preserved: ${relative}`)
    }
  } else if (!files.has('db/catalog.sqlite') && [...files.keys()].some(relative => /^db\/projects\/[^/]+\/conversations\/[^/]+\/conversation\.sqlite$/.test(relative))) {
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

/** Explicit recovery publishes only usable current data. Anything that cannot
 * be salvaged remains in the full preservation copy, outside the active store. */
export async function repairProjectsForStartup(
  root: string,
  repair: (value: unknown) => { value: Record<string, unknown>; fields: string[] },
  preserve: () => Promise<string>
): Promise<{ preservationPath: string; repaired: string[]; unresolved: string[]; readyToRestart: true }> {
  root = await realpath(root)
  const repaired: string[] = []
  const unresolved: string[] = []
  const preservationPath = await replaceProjectData(root, async staged => {
    const files = await storageFiles(root)
    const verifyUnchanged = async () => {
      if (JSON.stringify([...await storageFiles(root)]) !== JSON.stringify([...files])) throw new Error('Project data changed since inspection; inspect again.')
    }
    for (const [relative, signature] of files) {
      const target = join(staged, 'db', relative)
      if (signature.startsWith('directory:')) await mkdir(target, { recursive: true })
      else if (signature.startsWith('link:')) await cp(join(root, 'db', relative), target, { dereference: false, verbatimSymlinks: true })
      else await copyFile(join(root, 'db', relative), target)
    }
    await verifyUnchanged()
    const isolate = async (path: string, reason: string) => {
      const entry = await lstat(path).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
      if (!entry) return
      await rm(path, { recursive: true, force: true })
      repaired.push(`Isolated from active data; original retained in preservation copy: ${reason}`)
    }
    const dbRoot = join(staged, 'db')
    const dbInfo = await lstat(dbRoot).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    if (dbInfo && !dbInfo.isDirectory()) await isolate(dbRoot, 'db is not a real directory')
    await mkdir(dbRoot, { recursive: true })
    const readJson = async (path: string): Promise<Record<string, unknown> | undefined> => {
      try {
        if (!(await lstat(path)).isFile()) throw new Error('Not a regular file')
        const value: unknown = JSON.parse(await readFile(path, 'utf8'))
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object')
        return value as Record<string, unknown>
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') repaired.push(`Rebuilt unreadable metadata; original retained: ${path}`)
        return undefined
      }
    }
    const projectsRoot = join(staged, 'db/projects')
    const projectsInfo = await lstat(projectsRoot).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
    if (projectsInfo && !projectsInfo.isDirectory()) await isolate(projectsRoot, 'db/projects is not a directory')
    await mkdir(projectsRoot, { recursive: true })
    for (const [relative, signature] of files) {
      if (!signature.startsWith('file:') && /^(catalog\.sqlite|projects\/[^/]+\/conversations\/[^/]+\/conversation\.sqlite)-(wal|shm|journal)$/.test(relative)) {
        await isolate(join(staged, 'db', relative), `db/${relative}; invalid SQLite recovery file`)
      }
    }
    const state = await readJson(getProjectStoreFile(staged))
    const pending = await readJson(join(staged, 'db/project-write.json'))
    let pendingProjects: Record<string, unknown>[] = []
    if (pending?.version === 0) {
      try {
        parseProjectStore(pending.next)
        pendingProjects = (pending.next as { projects: Record<string, unknown>[] }).projects
      } catch { repaired.push('Unusable project write journal isolated; existing project files salvaged.') }
    }
    for (const journal of ['project-write.json', 'project-deletion.json', 'project-deletion.stage.json']) {
      if (files.has(journal)) await isolate(join(staged, 'db', journal), `db/${journal}; unfinished operation stopped during explicit recovery`)
    }
    const { version: _version, ...defaults } = projectDefaultsDocument
    const timestamp = new Date().toISOString()
    const defaultProject = (id: string) => ({ ...defaults, capabilities: serializeCapabilities(defaultCapabilities),
      restrict_subagents: defaultRestrictSubagents,
      id, name: id === DEFAULT_WORKSPACE_PROJECT_ID ? 'Default Project' : id, kind: 'workspace',
      pinned: false, collapsed: false, sourceFolders: [], createdAt: timestamp, updatedAt: timestamp })
    const base = defaultProject(DEFAULT_WORKSPACE_PROJECT_ID)
    const definitions = new Map<string, Record<string, unknown>>([[DEFAULT_WORKSPACE_PROJECT_ID, base]])
    for (const entry of await readdir(projectsRoot, { withFileTypes: true })) {
      if (entry.name === 'state.json') continue
      const directory = join(projectsRoot, entry.name)
      try {
        getProjectDir(entry.name, staged)
        if (!entry.isDirectory()) throw new Error('Not a project directory')
      } catch { await isolate(directory, `db/projects/${entry.name}`); continue }
      const document = await readJson(join(directory, 'project.json'))
      const ui = Array.isArray(state?.projects) ? state.projects.find(value => value?.id === entry.name) : undefined
      const source = document?.project && typeof document.project === 'object' && !Array.isArray(document.project) ? document.project : {}
      definitions.set(entry.name, { ...source, ...projectUiState(ui), id: entry.name })
    }
    for (const project of pendingProjects) {
      try { getProjectDir(String(project.id), staged); definitions.set(String(project.id), project) } catch { /* Retained in original journal. */ }
    }
    const projects: Record<string, unknown>[] = []
    for (const [id, original] of definitions) {
      const fallback = defaultProject(id)
      const attempt = (value: Record<string, unknown>) => {
        const result = repair({ version: 0, projects: id === DEFAULT_WORKSPACE_PROJECT_ID ? [value] : [base, value] })
        return { project: (result.value.projects as Record<string, unknown>[]).find(project => project.id === id)!, fields: result.fields }
      }
      let value: Record<string, unknown> = { pinned: false, collapsed: false, ...original, id }
      try { const result = attempt(value); value = result.project; repaired.push(...result.fields) }
      catch {
        value = fallback
        for (const [key, item] of Object.entries(original)) {
          if (key === 'id') continue
          try { value = attempt({ ...value, [key]: item }).project } catch { repaired.push(`Project ${id}: ${key} rebuilt; original retained.`) }
        }
      }
      projects.push(value)
    }
    // Replace only staged metadata; source files and their exact bytes remain preserved.
    await rm(getProjectStoreFile(staged), { recursive: true, force: true })
    for (const project of projects) await rm(join(projectsRoot, String(project.id), 'project.json'), { recursive: true, force: true })
    writeProjectStoreDocument(getProjectStoreFile(staged), { version: 0, projects })
    const document = (await readRepairProjectDocument(staged))!
    const salvaged = await mkdtemp(join(staged, 'salvage-'))
    let salvageIssues: string[] = []
    try {
      const result = await stageProjectRepair(staged, salvaged, document, document)
      repaired.push(...result.fields)
      salvageIssues = result.issues
      await rm(join(staged, 'db'), { recursive: true })
      await rename(join(salvaged, 'db'), join(staged, 'db'))
    } finally { await rm(salvaged, { recursive: true, force: true }) }

    const catalogPath = join(staged, 'db/catalog.sqlite')
    let catalog: Database.Database | undefined
    try {
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        const info = await lstat(`${catalogPath}${suffix}`).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
        if (info && !info.isFile()) throw new Error('Catalog family must contain regular files')
      }
      catalog = new Database(catalogPath, { fileMustExist: true })
      repaired.push(...repairCatalogAccessMode(catalog))
      catalog.pragma(`user_version = ${catalogVersion}`)
      validateCatalogSchema(catalog)
      if ((catalog.pragma('integrity_check') as Array<{ integrity_check: string }>).some(row => row.integrity_check !== 'ok')) throw new Error('Catalog integrity check failed')
    } catch {
      catalog?.close(); catalog = undefined
      if (files.has('catalog.sqlite')) unresolved.push('Shared catalog records could not be recovered; original catalog retained in preservation copy.')
      for (const suffix of ['', '-wal', '-shm', '-journal']) await isolate(`${catalogPath}${suffix}`, `db/catalog.sqlite${suffix}; catalog rebuilt from surviving current conversations`)
      AgentStorage.openNative(staged).close()
      catalog = new Database(catalogPath, { fileMustExist: true })
      repaired.push('Missing or unusable catalog rebuilt from surviving current conversations.')
    }
    const projectIds = new Set(projects.map(project => String(project.id)))
    try {
      catalog.pragma('foreign_keys = ON')
      const deleted = new Set((catalog.prepare('SELECT owner_thread_id FROM agent_conversation_deletions').all() as Array<{ owner_thread_id: string }>).map(row => row.owner_thread_id))
      const originalOwners = (catalog.prepare('SELECT id FROM agent_conversations').all() as Array<{ id: string }>).map(row => row.id)
      const rejected = new Set<string>()
      const workspace = catalog.prepare('SELECT * FROM agent_workspace_state WHERE id=1').get() as { active_thread_id: string | null; draft_project_id: string } | undefined
      catalog.transaction(() => {
        catalog!.exec('DELETE FROM agent_run_locations; DELETE FROM agent_thread_locations; DELETE FROM agent_conversation_deletions; DELETE FROM agent_conversations;')
      })()
      for (const projectId of projectIds) {
        const directory = join(projectsRoot, projectId, 'conversations')
        const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
        if (!info) continue
        if (!info.isDirectory()) { await isolate(directory, `Project ${projectId}: invalid conversation directory`); continue }
        for (const entry of await readdir(directory, { withFileTypes: true })) {
          const conversation = join(directory, entry.name)
          unresolved.push(...salvageIssues.filter(issue => issue.startsWith(`db/projects/${projectId}/conversations/${entry.name}/conversation.sqlite:`)))
          try {
            if (!entry.isDirectory() || deleted.has(entry.name)) throw new Error('Invalid or previously deleted conversation')
            const file = join(conversation, 'conversation.sqlite')
            if (!(await lstat(file)).isFile()) throw new Error('Missing or linked conversation database')
            for (const suffix of ['-wal', '-shm', '-journal']) {
              const info = await lstat(`${file}${suffix}`).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error })
              if (info && !info.isFile()) throw new Error('Conversation recovery file is linked or invalid')
            }
            NativeConversationDatabase.validateBackup(file, join(conversation, 'attachments'), new Set([projectId]), entry.name)
            const database = new Database(file, { readonly: true, fileMustExist: true })
            try {
              const snapshot = readConversationCatalogSnapshot(database, entry.name)
              if (!snapshot) throw new Error('Conversation owner is missing')
              writeConversationCatalogSnapshot(catalog, snapshot)
            } finally { database.close() }
          } catch (error) {
            rejected.add(entry.name)
            const reason = `${projectId}/${entry.name}: ${error instanceof Error ? error.message : String(error)}`
            unresolved.push(`${reason}; original retained outside active data.`)
            await isolate(conversation, reason)
          }
        }
      }
      for (const id of originalOwners) {
        if (!deleted.has(id) && !rejected.has(id) && !catalog.prepare('SELECT 1 FROM agent_conversations WHERE id=?').get(id)) {
          unresolved.push(`Missing conversation database: ${id}; original catalog evidence retained in preservation copy.`)
        }
      }
      catalog.prepare('UPDATE agent_workspace_state SET active_thread_id=?, draft_project_id=? WHERE id=1').run(
        workspace?.active_thread_id && catalog.prepare('SELECT 1 FROM agent_conversations WHERE id=?').get(workspace.active_thread_id) ? workspace.active_thread_id : null,
        workspace && projectIds.has(workspace.draft_project_id) ? workspace.draft_project_id : DEFAULT_WORKSPACE_PROJECT_ID)
      catalog.pragma('wal_checkpoint(TRUNCATE)')
      catalog.pragma('journal_mode = DELETE')
    } finally { catalog.close() }
    await readProjectStoreFile(getProjectStoreFile(staged))
    AgentStorage.validateCatalogBackup(catalogPath, projectIds)
    const ready = AgentStorage.openNative(staged)
    try {
      ready.getWorkspaceState()
      for (const thread of ready.listThreads()) ready.conversationForThread(thread.id)
    } finally { ready.close() }
    repaired.push('Project definitions and surviving conversations validated for startup; catalog references rebuilt.')
    return verifyUnchanged
  }, preserve)
  return { preservationPath, repaired, unresolved: [...new Set(unresolved)], readyToRestart: true }
}
