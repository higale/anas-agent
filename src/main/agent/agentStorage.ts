import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, rmSync } from 'node:fs'
import { readdir, rm } from 'node:fs/promises'
import { isProjectStorageEntry } from '../projectStorageEntries'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { Worker } from 'node:worker_threads'
import type {
  AgentAccessMode, AgentStorageUsageSnapshot, AgentThread, AgentThreadCreate,
  AgentThreadUpdate, AgentWorkspaceState
} from '@shared/agentTypes'
import { DEFAULT_WORKSPACE_PROJECT_ID } from '@shared/types'
import {
  getAgentCatalogFile, getAgentConversationDatabaseFile, getAgentConversationDir, getAgentConversationsDir, getAgentAttachmentsDir, getAgentConversationTempDir, getFileEditRecordsDir, getProjectsDir
} from '../config/dataDir'
import { measureDirectorySize } from '../dataStorageUsage'
import { runtimeLog } from '../runtimeLogger'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { completeProjectCatalogDeletion, readConversationCatalogSnapshot, writeConversationCatalogSnapshot } from './conversationCatalog'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore, managedDirectChildPath } from '../fileEditStore'
import { AgentThreadLockedError } from './agentErrors'
import { catalogVersion, catalogConversationSchema, catalogConversationIndexes, validateCatalogSchema } from './catalogSchema'

const nativeDependency = createRequire(import.meta.url)

interface ConversationRow {
  id: string
  title: string
  project_id: string
  model_config_id: string | null
  model_parameter_preset_id: string | null
  pinned: number
  access_mode: AgentAccessMode
  status: AgentThread['status']
  user_turn_count: number
  has_queued_inputs: number
  created_at: string
  updated_at: string
}

function threadFromRow(row: ConversationRow): AgentThread {
  return {
    id: row.id, title: row.title, projectId: row.project_id,
    ...(row.model_config_id ? { modelConfigId: row.model_config_id } : {}),
    ...(row.model_parameter_preset_id ? { modelParameterPresetId: row.model_parameter_preset_id } : {}),
    pinned: Boolean(row.pinned), accessMode: row.access_mode, status: row.status,
    userTurnCount: row.user_turn_count, createdAt: row.created_at, updatedAt: row.updated_at
  }
}


function requireText(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} must be non-empty text.`)
}

function runStorageWorker<T>(body: string, data: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolvePromise, reject) => {
    let result: T
    const worker = new Worker(`
      const { workerData, parentPort } = require('node:worker_threads');
      const Database = require(workerData.modulePath);
      ${body}
    `, { eval: true, workerData: { ...data, modulePath: nativeDependency.resolve('better-sqlite3') } })
    worker.once('message', (value: T) => { result = value })
    worker.once('error', reject)
    worker.once('exit', (code) => code === 0 ? resolvePromise(result) : reject(new Error(`Agent storage worker exited with code ${code}.`)))
  })
}

/** Physical directory ownership depends on product resources, not execution tables. */
export interface ConversationStorageConnection {
  getThread(threadId: string): AgentThread | null
  createThread(options?: AgentThreadCreate, threadId?: string): AgentThread
  updateThread(threadId: string, update: AgentThreadUpdate): AgentThread
  setAccessMode(threadId: string, mode: AgentAccessMode): AgentThread
  listThreadIds(): string[]
  readCatalogSnapshot(ownerThreadId: string): ReturnType<typeof readConversationCatalogSnapshot>
  close(): void
}
interface ConversationConnectionOptions<T> {
  attachmentRoot: string
  temporaryRoot: string
  memoryStore: SqliteMemoryStore
  fileEditStore: FileEditStore
  onFileChanges?(runId: string): void
  onChanged?(database: T): void
}

export class AgentStorage<T extends ConversationStorageConnection = NativeConversationDatabase> {
  private readonly conversations = new Map<string, T>()
  private readonly unregisteredCreations = new Set<string>()
  private readonly creatingProjects = new Map<string, string>()
  private preview?: T
  private closed = false
  private maintaining = false
  private sharedMemoryStore: SqliteMemoryStore
  private catalog: Database.Database
  readonly dataDir: string

  private constructor(dataDir: string, private readonly onFileChanges: ((ownerThreadId: string, runId: string) => void) | undefined,
    private readonly openDatabase: (file: string, options: ConversationConnectionOptions<T>) => T,
    private readonly openPreview: (memory: SqliteMemoryStore) => T) {
    this.dataDir = resolve(dataDir)
    mkdirSync(dirname(getAgentCatalogFile(this.dataDir)), { recursive: true })
    this.catalog = new Database(getAgentCatalogFile(this.dataDir))
    try {
      this.initializeCatalog()
      mkdirSync(getProjectsDir(this.dataDir), { recursive: true })
      this.sharedMemoryStore = new SqliteMemoryStore(this.catalog)
    } catch (error) {
      this.catalog.close()
      throw error
    }
  }

  /** Explicit native format. No inference, migration or legacy database opening. */
  static openNative(dataDir: string, onFileChanges?: (ownerThreadId: string, runId: string) => void): AgentStorage<NativeConversationDatabase> {
    return new AgentStorage<NativeConversationDatabase>(dataDir, onFileChanges,
      (file, options) => NativeConversationDatabase.open(file, options), memoryStore => {
        const root = getAgentConversationTempDir(randomUUID(), dataDir)
        return NativeConversationDatabase.open(':memory:', { attachmentRoot: resolve(root, 'attachments'),
          fileEditStore: new FileEditStore(resolve(root, 'file_edits')), memoryStore })
      })
  }

  get memoryStore(): SqliteMemoryStore { return this.sharedMemoryStore }

  private initializeCatalog(): void {
    this.catalog.pragma('foreign_keys = ON')
    const version = this.catalog.pragma('user_version', { simple: true }) as number
    const tables = this.catalog.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'table' LIMIT 1").get()
    if (tables) {
      validateCatalogSchema(this.catalog)
      if (!existsSync(getProjectsDir(this.dataDir)) && this.catalog.prepare('SELECT 1 FROM agent_conversations LIMIT 1').get()) {
        throw new Error('Conversation databases are missing; preserve the catalog before repairing project data.')
      }
      this.catalog.pragma('journal_mode = WAL')
      this.initializeWorkspaceState()
      return
    }
    if (version !== 0) throw new Error(`Unsupported agent catalog schema ${version}; expected ${catalogVersion}.`)
    this.catalog.pragma('journal_mode = WAL')
    this.catalog.transaction(() => {
      this.catalog.exec(`
        ${catalogConversationSchema}
        ${catalogConversationIndexes}
        CREATE TABLE agent_thread_locations (
          thread_id TEXT PRIMARY KEY,
          owner_thread_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE
        );
        CREATE INDEX agent_thread_locations_owner_idx ON agent_thread_locations (owner_thread_id);
        CREATE TABLE agent_run_locations (
          run_id TEXT PRIMARY KEY,
          thread_id TEXT NOT NULL REFERENCES agent_thread_locations(thread_id) ON DELETE CASCADE,
          owner_thread_id TEXT NOT NULL REFERENCES agent_conversations(id) ON DELETE CASCADE,
          submission_id TEXT UNIQUE
        );
        CREATE INDEX agent_run_locations_owner_idx ON agent_run_locations (owner_thread_id);
        CREATE TABLE agent_conversation_deletions (
          owner_thread_id TEXT PRIMARY KEY REFERENCES agent_conversations(id) ON DELETE CASCADE
        );
        CREATE TABLE agent_workspace_state (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          active_thread_id TEXT REFERENCES agent_conversations(id) ON DELETE SET NULL,
          draft_project_id TEXT NOT NULL,
          draft_model_config_id TEXT,
          draft_model_parameter_preset_id TEXT
        );
      `)
      this.initializeWorkspaceState()
      new SqliteMemoryStore(this.catalog)
      this.catalog.pragma(`user_version = ${catalogVersion}`)
    })()
  }

  private initializeWorkspaceState(): void {
    this.catalog.prepare(`INSERT OR IGNORE INTO agent_workspace_state
      (id, active_thread_id, draft_project_id, draft_model_config_id, draft_model_parameter_preset_id)
      VALUES (1, NULL, ?, NULL, NULL)`).run(DEFAULT_WORKSPACE_PROJECT_ID)
  }

  static validateCatalogBackup(file: string, projectIds: ReadonlySet<string>): string[] {
    if (!existsSync(file)) return []
    if (!lstatSync(file).isFile()) throw new Error('Agent catalog is not a regular file.')
    const database = new Database(file, { readonly: true, fileMustExist: true })
    try {
      validateCatalogSchema(database)
      const integrity = database.pragma('integrity_check') as Array<{ integrity_check: string }>
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('Agent catalog integrity check failed.')
      if ((database.pragma('foreign_key_check') as unknown[]).length) throw new Error('Agent catalog foreign key check failed.')
      const rows = database.prepare('SELECT id, project_id FROM agent_conversations ORDER BY id').all() as Array<{ id: string; project_id: string }>
      for (const row of rows) {
        getAgentConversationDatabaseFile(row.id, dirname(dirname(file)), row.project_id)
        if (!projectIds.has(row.project_id)) throw new Error(`Agent conversation references missing project ${row.project_id}.`)
      }
      const invalidLocation = database.prepare(`
        SELECT run_id FROM agent_run_locations run
        JOIN agent_thread_locations thread ON thread.thread_id = run.thread_id
        WHERE run.owner_thread_id <> thread.owner_thread_id LIMIT 1
      `).get()
      if (invalidLocation) throw new Error('Agent run location crosses conversations.')
      return rows.map(({ id }) => id)
    } finally { database.close() }
  }

  private requireOpen(): void {
    if (this.closed) throw new Error('Agent storage is closed.')
    if (this.maintaining) throw new Error('Agent storage maintenance is in progress.')
  }

  listThreads(): AgentThread[] {
    this.requireOpen()
    return (this.catalog.prepare('SELECT * FROM agent_conversations ORDER BY pinned DESC, updated_at DESC, id').all() as ConversationRow[]).map(threadFromRow)
  }

  getThread(ownerThreadId: string): AgentThread | null {
    this.requireOpen()
    const row = this.catalog.prepare('SELECT * FROM agent_conversations WHERE id = ?').get(ownerThreadId) as ConversationRow | undefined
    return row ? threadFromRow(row) : null
  }

  ownerForThread(threadId: string): string | undefined {
    this.requireOpen()
    return (this.catalog.prepare('SELECT owner_thread_id FROM agent_thread_locations WHERE thread_id = ?').get(threadId) as { owner_thread_id: string } | undefined)?.owner_thread_id
  }

  conversationForThread(threadId: string): T {
    const owner = this.ownerForThread(threadId)
    if (!owner) throw new Error(`Thread ${threadId} was not found.`)
    return this.openConversation(owner)
  }

  conversationForRun(runId: string): T | undefined {
    this.requireOpen()
    const location = this.catalog.prepare('SELECT owner_thread_id FROM agent_run_locations WHERE run_id = ?').get(runId) as { owner_thread_id: string } | undefined
    return location ? this.openConversation(location.owner_thread_id) : undefined
  }

  submissionOwner(submissionId: string): string | undefined {
    this.requireOpen()
    return (this.catalog.prepare('SELECT owner_thread_id FROM agent_run_locations WHERE submission_id = ?').get(submissionId) as { owner_thread_id: string } | undefined)?.owner_thread_id
  }

  queuedConversationIds(): string[] {
    this.requireOpen()
    return (this.catalog.prepare('SELECT id FROM agent_conversations WHERE has_queued_inputs = 1 ORDER BY updated_at, id').all() as Array<{ id: string }>).map(({ id }) => id)
  }

  private projectFor(ownerThreadId: string): string {
    const project = this.getThread(ownerThreadId)?.projectId ?? this.creatingProjects.get(ownerThreadId)
    if (!project) throw new Error(`Conversation ${ownerThreadId} has no project location.`)
    return project
  }

  private fileEditStore(ownerThreadId: string): FileEditStore {
    const root = getFileEditRecordsDir(ownerThreadId, this.dataDir, this.projectFor(ownerThreadId))
    const roots = () => this.listThreads().filter(thread => !this.isConversationDeleting(thread.id))
      .map(thread => getFileEditRecordsDir(thread.id, this.dataDir, thread.projectId))
    return new FileEditStore(root, {
      roots,
      requestRoot: (requestId) => {
        this.requireOpen()
        const location = this.catalog.prepare('SELECT owner_thread_id FROM agent_run_locations WHERE run_id = ?')
          .get(requestId) as { owner_thread_id: string } | undefined
        if (location) {
          if (location.owner_thread_id !== ownerThreadId && this.isConversationDeleting(location.owner_thread_id)) {
            throw new Error('File edit conversation is being deleted.')
          }
          return getFileEditRecordsDir(location.owner_thread_id, this.dataDir, this.projectFor(location.owner_thread_id))
        }
        // Truncating a run may retain recovery material after removing its catalog locator.
        // Search only registered current-layout conversations, never abandoned legacy data.
        const candidates = [...new Set([root, ...roots()])].filter(directory => existsSync(managedDirectChildPath(directory, requestId)))
        if (candidates.length > 1) throw new Error(`File edit request belongs to multiple conversations: ${requestId}`)
        return candidates[0] ?? root
      }
    })
  }

  openConversation(ownerThreadId: string, options: { create?: boolean; deleting?: boolean; projectId?: string } = {}): T {
    this.requireOpen()
    if (options.create && !this.getThread(ownerThreadId)) this.creatingProjects.set(ownerThreadId, options.projectId ?? this.creatingProjects.get(ownerThreadId) ?? DEFAULT_WORKSPACE_PROJECT_ID)
    const deleting = this.isConversationDeleting(ownerThreadId)
    if (deleting && !options.deleting) throw new Error('Conversation deletion is pending; retry deleting this conversation to finish cleanup.')
    const file = getAgentConversationDatabaseFile(ownerThreadId, this.dataDir, this.projectFor(ownerThreadId))
    const existing = this.conversations.get(ownerThreadId)
    if (existing) return existing
    const thread = this.getThread(ownerThreadId)
    if (!thread && !options.create) throw new Error(`Conversation ${ownerThreadId} was not found.`)
    const directory = getAgentConversationDir(ownerThreadId, this.dataDir, this.projectFor(ownerThreadId))
    if (!thread && existsSync(directory)) throw new Error(`Conversation directory already exists: ${ownerThreadId}`)
    if (existsSync(directory) && !lstatSync(directory).isDirectory()) throw new Error(`Conversation storage is not a directory: ${ownerThreadId}`)
    if (thread && !existsSync(file)) throw new Error(`Conversation database is missing: ${ownerThreadId}`)
    if (existsSync(file) && !lstatSync(file).isFile()) throw new Error(`Conversation database is not a regular file: ${ownerThreadId}`)
    mkdirSync(dirname(file), { recursive: true })
    const database = this.openDatabase(file, {
      attachmentRoot: getAgentAttachmentsDir(ownerThreadId, this.dataDir, this.projectFor(ownerThreadId)),
      onFileChanges: (runId) => this.onFileChanges?.(ownerThreadId, runId),
      memoryStore: this.sharedMemoryStore,
      temporaryRoot: getAgentConversationTempDir(ownerThreadId, this.dataDir),
      fileEditStore: this.fileEditStore(ownerThreadId),
      onChanged: (current) => {
        if (this.closed || this.conversations.get(ownerThreadId) !== current) return
        try { this.refreshConversation(ownerThreadId) } catch (error) {
          runtimeLog('error', 'agent-storage', 'Failed to refresh conversation directory metadata.', { ownerThreadId, error })
        }
      }
    })
    this.conversations.set(ownerThreadId, database)
    if (!thread) this.unregisteredCreations.add(ownerThreadId)
    try {
      if (thread && !deleting && database.getThread(ownerThreadId)?.projectId !== thread.projectId) throw new Error(`Conversation database identity or project does not match ${ownerThreadId}.`)
      if (thread && database.listThreadIds().some(id => database.getThread(id)?.projectId !== thread.projectId)) throw new Error(`Conversation children cross project boundaries: ${ownerThreadId}`)
      this.refreshConversation(ownerThreadId)
      return database
    } catch (error) {
      this.conversations.delete(ownerThreadId)
      database.close()
      throw error
    }
  }

  createThread(options: AgentThreadCreate = {}, threadId: string = randomUUID()): AgentThread {
    this.requireOpen()
    if (this.getThread(threadId)) throw new Error(`Conversation ${threadId} already exists.`)
    this.creatingProjects.set(threadId, options.projectId ?? DEFAULT_WORKSPACE_PROJECT_ID)
    let database: T
    try { database = this.openConversation(threadId, { create: true }) }
    catch (error) { this.creatingProjects.delete(threadId); throw error }
    try {
      const thread = database.createThread(options, threadId)
      this.refreshConversation(threadId)
      this.creatingProjects.delete(threadId)
      return thread
    } catch (error) {
      this.closeConversation(threadId)
      rmSync(getAgentConversationDir(threadId, this.dataDir, this.projectFor(threadId)), { recursive: true, force: true })
      this.unregisteredCreations.delete(threadId)
      this.creatingProjects.delete(threadId)
      throw error
    }
  }

  refreshConversation(ownerThreadId: string): void {
    this.requireOpen()
    const database = this.conversations.get(ownerThreadId)
    const snapshot = database?.readCatalogSnapshot(ownerThreadId)
    if (!snapshot) return
    if (snapshot.thread.projectId !== this.projectFor(ownerThreadId)) throw new Error(`Conversation project does not match its storage directory: ${ownerThreadId}`)
    writeConversationCatalogSnapshot(this.catalog, snapshot)
    this.unregisteredCreations.delete(ownerThreadId)
    this.creatingProjects.delete(ownerThreadId)
  }

  updateThread(threadId: string, update: AgentThreadUpdate): AgentThread {
    if ('projectId' in update) throw new Error('Conversation project cannot be changed.')
    const database = this.conversationForThread(threadId)
    const next = database.updateThread(threadId, update)
    this.refreshConversation(this.ownerForThread(threadId)!)
    return next
  }

  setAccessMode(threadId: string, accessMode: AgentAccessMode): AgentThread {
    const next = this.conversationForThread(threadId).setAccessMode(threadId, accessMode)
    this.refreshConversation(this.ownerForThread(threadId)!)
    return next
  }

  getWorkspaceState(): AgentWorkspaceState {
    this.requireOpen()
    const row = this.catalog.prepare('SELECT * FROM agent_workspace_state WHERE id = 1').get() as {
      active_thread_id: string | null; draft_project_id: string; draft_model_config_id: string | null; draft_model_parameter_preset_id: string | null
    } | undefined
    if (!row) throw new Error('Agent workspace state is missing.')
    return row.active_thread_id ? { mode: 'thread', threadId: row.active_thread_id } : {
      mode: 'new_thread', projectId: row.draft_project_id,
      ...(row.draft_model_config_id ? { modelConfigId: row.draft_model_config_id } : {}),
      modelParameterPresetId: row.draft_model_parameter_preset_id
    }
  }

  setWorkspaceState(state: AgentWorkspaceState): void {
    this.requireOpen()
    if (!state || typeof state !== 'object' || Array.isArray(state)) throw new Error('Agent workspace state is invalid.')
    if (state.mode === 'thread') {
      if (!this.getThread(state.threadId)) throw new Error(`Conversation ${state.threadId} was not found.`)
      this.catalog.prepare('UPDATE agent_workspace_state SET active_thread_id = ? WHERE id = 1').run(state.threadId)
      return
    }
    if (state.mode !== 'new_thread') throw new Error('Agent workspace mode is invalid.')
    requireText(state.projectId, 'Agent workspace project ID')
    if (state.modelConfigId !== undefined) requireText(state.modelConfigId, 'Agent workspace model configuration ID')
    if (state.modelParameterPresetId !== null) {
      requireText(state.modelParameterPresetId, 'Agent workspace model parameter preset ID')
      if (!state.modelConfigId) throw new Error('A model parameter preset requires a model configuration.')
    }
    this.catalog.prepare(`UPDATE agent_workspace_state SET active_thread_id = NULL, draft_project_id = ?,
      draft_model_config_id = ?, draft_model_parameter_preset_id = ? WHERE id = 1`)
      .run(state.projectId, state.modelConfigId ?? null, state.modelParameterPresetId)
  }

  previewDatabase(): T {
    this.requireOpen()
    return this.preview ??= this.openPreview(this.sharedMemoryStore)
  }

  openedConversations(): Array<{ ownerId: string; database: T }> {
    this.requireOpen()
    return [...this.conversations].map(([ownerId, database]) => ({ ownerId, database }))
  }

  openedConversation(ownerThreadId: string): T | undefined {
    this.requireOpen()
    return this.conversations.get(ownerThreadId)
  }

  closeConversation(ownerThreadId: string): void {
    const database = this.conversations.get(ownerThreadId)
    if (!database) return
    try { this.refreshConversation(ownerThreadId) } finally {
      this.conversations.delete(ownerThreadId)
      database.close()
    }
  }

  isConversationDeleting(ownerThreadId: string): boolean {
    this.requireOpen()
    return Boolean(this.catalog.prepare('SELECT 1 FROM agent_conversation_deletions WHERE owner_thread_id = ?').get(ownerThreadId))
  }

  beginConversationDeletion(ownerThreadId: string): void {
    this.requireOpen()
    if (FileEditStore.isRootBusy(getFileEditRecordsDir(ownerThreadId, this.dataDir, this.projectFor(ownerThreadId)))) {
      throw new AgentThreadLockedError(ownerThreadId, 'be deleted while its file recovery material is in use')
    }
    this.catalog.prepare('INSERT OR IGNORE INTO agent_conversation_deletions VALUES (?)').run(ownerThreadId)
  }

  conversationForCleanup(ownerThreadId: string): T | undefined {
    this.requireOpen()
    // A live handle still owns its work even if its file has disappeared.
    const existing = this.conversations.get(ownerThreadId)
    if (existing) return existing
    try {
      lstatSync(getAgentConversationDatabaseFile(ownerThreadId, this.dataDir, this.projectFor(ownerThreadId)))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    return this.openConversation(ownerThreadId, { deleting: true })
  }

  async removeConversation(ownerThreadId: string): Promise<void> {
    this.requireOpen()
    if (!this.getThread(ownerThreadId)) {
      if (!this.unregisteredCreations.has(ownerThreadId)) return
      const database = this.conversations.get(ownerThreadId)
      if (database?.listThreadIds().length) throw new Error('An unregistered conversation with saved threads cannot be discarded.')
    } else {
      this.beginConversationDeletion(ownerThreadId)
    }
    const file = getAgentConversationDatabaseFile(ownerThreadId, this.dataDir, this.projectFor(ownerThreadId))
    // The entire database is being discarded; do not read or project damaged data.
    const database = this.conversations.get(ownerThreadId)
    database?.close()
    this.conversations.delete(ownerThreadId)
    await rm(getAgentConversationTempDir(ownerThreadId, this.dataDir), { recursive: true, force: true })
    await rm(dirname(file), { recursive: true, force: true })
    this.catalog.prepare('DELETE FROM agent_conversations WHERE id = ?').run(ownerThreadId)
    this.unregisteredCreations.delete(ownerThreadId)
    this.creatingProjects.delete(ownerThreadId)
  }

  completeProjectDeletion(projectId: string): void {
    this.requireOpen()
    completeProjectCatalogDeletion(this.catalog, projectId)
  }

  async getStorageUsage(): Promise<AgentStorageUsageSnapshot> {
    const [conversationBytes, memoryBytes] = await Promise.all([
      readdir(getProjectsDir(this.dataDir), { withFileTypes: true }).then(projects => Promise.all(projects.filter(project => project.isDirectory() && isProjectStorageEntry(getProjectsDir(this.dataDir), project))
        .map(project => measureDirectorySize(getAgentConversationsDir(this.dataDir, project.name))))).then(sizes => sizes.reduce((sum, size) => sum + size, 0)),
      runStorageWorker<number>(`
        const database = new Database(workerData.file, { readonly: true, fileMustExist: true });
        try {
          const row = database.prepare(\`SELECT COALESCE(SUM(
            length(CAST(namespace_path AS BLOB)) + length(CAST(key AS BLOB))
            + length(CAST(value_json AS BLOB)) + length(CAST(created_at AS BLOB))
            + length(CAST(updated_at AS BLOB))
          ), 0) AS bytes FROM agent_store_items
          WHERE json_extract(namespace_path, '$[0]') = 'memories'\`).get();
          parentPort.postMessage(row.bytes);
        } finally { database.close(); }
      `, { file: getAgentCatalogFile(this.dataDir) })
    ])
    return {
      conversations: { totalBytes: conversationBytes, approximate: true, hasData: this.listThreads().some(thread => !thread.pinned) },
      memories: { totalBytes: memoryBytes, approximate: true, hasData: memoryBytes > 0 }
    }
  }

  async compact(): Promise<void> {
    this.requireOpen()
    const files = this.listThreads().map(({ id, projectId }) => getAgentConversationDatabaseFile(id, this.dataDir, projectId))
    files.push(getAgentCatalogFile(this.dataDir))
    for (const id of [...this.conversations.keys()]) this.closeConversation(id)
    this.preview?.close()
    this.preview = undefined
    this.maintaining = true
    this.catalog.close()
    try {
      await runStorageWorker<void>(`
          for (const file of workerData.files) {
            const database = new Database(file, { fileMustExist: true });
            try { database.exec('VACUUM'); database.pragma('wal_checkpoint(TRUNCATE)'); }
            finally { database.close(); }
          }
      `, { files })
    } finally {
      this.maintaining = false
      this.catalog = new Database(getAgentCatalogFile(this.dataDir))
      this.initializeCatalog()
      this.sharedMemoryStore = new SqliteMemoryStore(this.catalog)
    }
  }

  close(): void {
    if (this.closed) return
    if (this.maintaining) throw new Error('Wait for agent storage maintenance to finish before closing.')
    for (const id of [...this.conversations.keys()]) this.closeConversation(id)
    this.preview?.close()
    this.preview = undefined
    this.closed = true
    this.catalog.close()
  }
}
