import Database from 'better-sqlite3'
import { lstat, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join, relative, sep } from 'node:path'
import { getAgentCatalogFile, getAgentConversationDatabaseFile, getProjectsDir } from '../config/dataDir'
import { withApplicationDataSnapshot } from '../applicationDataSnapshot'

export interface AgentDatabaseSnapshotFile {
  absPath: string
  relPath: string
  size: number
  conversationIds?: string[]
}

async function fileExists(path: string): Promise<boolean> {
  try {
    if (!(await lstat(path)).isFile()) throw new Error(`Database is not a regular file: ${path}`)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

export async function snapshotAgentDatabase(source: string, destination: string): Promise<boolean> {
  if (!(await fileExists(source))) return false
  await mkdir(dirname(destination), { recursive: true })
  const database = new Database(source, { readonly: true, fileMustExist: true })
  try {
    await database.backup(destination)
    return true
  } finally {
    database.close()
  }
}

export async function snapshotAgentStorage(
  sourceDataDir: string,
  destinationDataDir: string
): Promise<AgentDatabaseSnapshotFile[]> {
  return withApplicationDataSnapshot(() => copyAgentStorage(sourceDataDir, destinationDataDir))
}

async function copyAgentStorage(sourceDataDir: string, destinationDataDir: string): Promise<AgentDatabaseSnapshotFile[]> {
  const catalogPath = getAgentCatalogFile(destinationDataDir)
  if (!await snapshotAgentDatabase(getAgentCatalogFile(sourceDataDir), catalogPath)) {
    const projects = await readdir(getProjectsDir(sourceDataDir), { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
    for (const project of projects) {
      if (!project.isDirectory()) continue
      const conversations = await readdir(join(getProjectsDir(sourceDataDir), project.name, 'conversations')).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return []
        throw error
      })
      if (conversations.length) throw new Error('Conversation databases exist without an agent catalog.')
    }
    return []
  }
  const catalog = new Database(catalogPath, { fileMustExist: true })
  let rows: Array<{ id: string; project_id: string }>
  try {
    catalog.pragma('foreign_keys = ON')
    catalog.prepare(`DELETE FROM agent_conversations
      WHERE id IN (SELECT owner_thread_id FROM agent_conversation_deletions)`).run()
    rows = catalog.prepare('SELECT id, project_id FROM agent_conversations ORDER BY id').all() as Array<{ id: string; project_id: string }>
  } finally {
    catalog.close()
  }

  const snapshots = [catalogPath]
  for (const { id, project_id: projectId } of rows) {
    const source = getAgentConversationDatabaseFile(id, sourceDataDir, projectId)
    const destination = getAgentConversationDatabaseFile(id, destinationDataDir, projectId)
    const info = await lstat(source)
    if (!info.isFile()) throw new Error(`Conversation database is not a regular file: ${id}`)
    if (!await snapshotAgentDatabase(source, destination)) {
      throw new Error(`Conversation database disappeared while creating a backup: ${id}`)
    }
    snapshots.push(destination)
  }
  return Promise.all(snapshots.map(async (path) => ({
    absPath: path,
    relPath: relative(destinationDataDir, path).split(sep).join('/'),
    size: (await stat(path)).size,
    ...(path === catalogPath ? { conversationIds: rows.map(row => row.id) } : {})
  })))
}
