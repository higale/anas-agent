import Database from 'better-sqlite3'
import { copyFile, cp, lstat, mkdir, mkdtemp, readFile, readdir, readlink, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { parseProjectStore } from './projectStore'
import { AgentStorage } from './agent/agentStorage'
import { AgentDatabase } from './agent/agentDatabase'
import { replaceProjectData } from './backupService'
import { repairArchivedFileChangeVersions } from './recoveryFileChanges'

async function storageFiles(root: string, directory: 'sqlite' | 'file_edits'): Promise<Map<string, string>> {
  const files = new Map<string, string>()
  async function visit(path: string, relative: string): Promise<void> {
    const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT' && !relative) return undefined
      throw error
    })
    if (!info) return
    if (files.size >= 100_000 || relative.split('/').length > 64) throw new Error(`${directory} preservation exceeds the file count or depth limit.`)
    if (info.isDirectory()) {
      files.set(relative, `directory:${info.dev}:${info.ino}`)
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative ? `${relative}/${name}` : name)
    } else if (info.isFile()) {
      files.set(relative, `file:${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`)
    } else if (info.isSymbolicLink()) {
      files.set(relative, `link:${info.dev}:${info.ino}:${await readlink(path)}`)
    } else throw new Error(`Cannot preserve special file: ${path}`)
  }
  await visit(join(root, directory), '')
  return files
}

async function stageProjectRepair(root: string, staged: string, before: string, after: string) {
  if (await realpath(root) !== root) throw new Error('Project data directory changed while repairing.')
  const pendingDeletion = await lstat(join(root, 'projects.json.delete-journal')).then(() => true, (error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return false
    throw error
  })
  if (pendingDeletion) throw new Error('Project deletion recovery must finish before project data can be repaired.')
  // The stage is written before the deletion journal. An interrupted staging
  // write does not start a transaction; preserve its bytes before replacement
  // and leave the original stage untouched instead of blocking data repair.
  const projectPath = join(root, 'projects.json')
  const projectInfo = await lstat(projectPath)
  if (!projectInfo.isFile() || await readFile(projectPath, 'utf8') !== before) throw new Error('Project file changed since inspection.')
  const files = await storageFiles(root, 'sqlite')
  const fileEdits = await storageFiles(root, 'file_edits')
  const issues: string[] = []
  for (const relative of files.keys()) {
    if (/^(catalog\.sqlite|conversations\/[^/]+\.sqlite)-(wal|shm|journal)$/.test(relative) && !files.has(relative.replace(/-(wal|shm|journal)$/, ''))) {
      issues.push(`SQLite database is missing for ${relative}; original files preserved.`)
    }
  }
  const verifyUnchanged = async (): Promise<void> => {
    const currentProject = await lstat(projectPath)
    if (!currentProject.isFile() || currentProject.ino !== projectInfo.ino || currentProject.dev !== projectInfo.dev
      || await readFile(projectPath, 'utf8') !== before
      || JSON.stringify([...await storageFiles(root, 'sqlite')]) !== JSON.stringify([...files])
      || JSON.stringify([...await storageFiles(root, 'file_edits')]) !== JSON.stringify([...fileEdits])) {
      throw new Error('Project data changed since inspection; inspect again before repairing.')
    }
  }
  for (const [relative, signature] of files) {
    const target = join(staged, 'sqlite', relative)
    if (signature.startsWith('directory:')) await mkdir(target, { recursive: true })
    else if (signature.startsWith('link:')) await cp(join(root, 'sqlite', relative), target, { dereference: false, verbatimSymlinks: true })
    else await copyFile(join(root, 'sqlite', relative), target)
  }
  await verifyUnchanged()
  await writeFile(join(staged, 'projects.json'), after, { flag: 'wx', mode: 0o600 })
  const fields: string[] = []
  const projects = parseProjectStore(JSON.parse(after))
  const projectIds = new Set(projects.projects.map(({ id }) => id))
  let conversationIds: string[] | undefined
  const probeRoot = join(staged, 'validation')
  await mkdir(probeRoot)
  for (const [relative, signature] of files) {
    if (!(relative === 'catalog.sqlite' || /^conversations\/[^/]+\.sqlite$/.test(relative))) continue
    if (!signature.startsWith('file:') || ['', '-wal', '-shm', '-journal'].some(suffix => files.get(`${relative}${suffix}`)?.startsWith('link:'))) {
      issues.push(`sqlite/${relative}: linked or invalid database family preserved without modification.`)
      continue
    }
    const original = join(staged, 'sqlite', relative)
    const probe = join(probeRoot, 'database.sqlite')
    try {
      for (const suffix of ['', '-wal', '-journal']) {
        if (files.has(`${relative}${suffix}`)) await copyFile(`${original}${suffix}`, `${probe}${suffix}`)
      }
      let version: number
      let repairedFields: string[] = []
      const database = new Database(probe, { fileMustExist: true })
      try {
        version = database.pragma('user_version', { simple: true }) as number
        database.pragma('user_version = 0')
        if (relative !== 'catalog.sqlite') repairedFields = await repairArchivedFileChangeVersions(database, root)
        const checkpoint = database.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>
        if (checkpoint.some((result) => result.busy)) throw new Error('SQLite snapshot is busy.')
        database.pragma('journal_mode = DELETE')
      } finally { database.close() }
      if (relative === 'catalog.sqlite') conversationIds = AgentStorage.validateCatalogBackup(probe, projectIds)
      else AgentDatabase.validateBackup(probe, join(root, 'attachments'), projectIds, basename(relative, '.sqlite'))
      if (version !== 0 || repairedFields.length) {
        await copyFile(probe, original)
        for (const suffix of ['-wal', '-shm', '-journal']) await rm(`${original}${suffix}`, { force: true })
        if (version !== 0) fields.push(`sqlite/${relative}: user_version (${version} → 0)`)
        fields.push(...repairedFields.map(field => `sqlite/${relative}: ${field}`))
      }
    } catch (error) {
      issues.push(`sqlite/${relative}: ${error instanceof Error ? error.message : String(error)}`)
      // Keep the original family intact when this database cannot be salvaged.
      for (const suffix of ['', '-wal', '-shm', '-journal']) {
        await rm(`${original}${suffix}`, { force: true })
        if (files.has(`${relative}${suffix}`)) await copyFile(join(root, 'sqlite', `${relative}${suffix}`), `${original}${suffix}`)
      }
    } finally {
      for (const name of await readdir(probeRoot)) await rm(join(probeRoot, name), { force: true })
    }
  }
  if (conversationIds) {
    for (const id of conversationIds) if (!files.has(`conversations/${id}.sqlite`)) issues.push(`Missing conversation database: ${id}`)
    const registered = new Set(conversationIds.map(id => `conversations/${id}.sqlite`))
    for (const relative of files.keys()) {
      if (/^conversations\/[^/]+\.sqlite$/.test(relative) && !registered.has(relative)) issues.push(`Unregistered conversation database preserved: ${relative}`)
    }
  } else if (!files.has('catalog.sqlite') && [...files.keys()].some(relative => /^conversations\/[^/]+\.sqlite$/.test(relative))) {
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
