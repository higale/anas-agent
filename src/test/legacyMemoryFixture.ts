import Database from 'better-sqlite3'
import { randomUUID } from 'node:crypto'
import { getAgentCatalogFile } from '../main/config/dataDir'
import type { MemoryResources } from '../main/agent/memoryStore'
import type { PreferenceMemoryStore } from '../main/agent/preferenceMemoryStore'

type MemoryScope = 'global' | 'project'
type MemoryKind = 'preference' | 'fact' | 'experience'
type MemoryOrigin = 'user' | 'agent'

interface MemoryItem {
  id: string
  scope: MemoryScope
  projectId?: string
  kind: MemoryKind
  content: string
  keywords: string[]
  importance: number
  origin: MemoryOrigin
  sourceThreadId?: string
  sourceRunId?: string
  createdAt: string
  updatedAt: string
  score?: number
}

interface MemorySearchRequest {
  query?: string
  scope?: 'all' | MemoryScope
  projectId?: string
  kind?: 'all' | MemoryKind
  limit?: number
  offset?: number
}

interface MemorySaveRequest {
  id?: string
  scope: MemoryScope
  projectId?: string
  kind: MemoryKind
  content: string
  keywords: string[]
  importance: number
}

export class SqliteMemoryStore {
  readonly preferences?: PreferenceMemoryStore
  constructor(private readonly database: Database.Database) { initializeLegacyMemoryTables(database) }
  async saveMemory(request: MemorySaveRequest, context: { origin: 'user' | 'agent' }): Promise<MemoryItem> {
    const id = request.id ?? randomUUID(), timestamp = new Date().toISOString()
    const namespace = JSON.stringify(request.scope === 'global' ? ['memories', 'global'] : ['memories', 'project', request.projectId])
    const value = { kind: request.kind, content: request.content, keywords: request.keywords ?? [], importance: request.importance ?? 3, origin: context.origin }
    this.database.prepare('INSERT OR REPLACE INTO agent_store_items VALUES (?,?,?,?,?)').run(namespace, id, JSON.stringify(value), timestamp, timestamp)
    return { ...request, ...value, id, createdAt: timestamp, updatedAt: timestamp }
  }
  async searchMemories(request: MemorySearchRequest = {}) {
    const rows = this.database.prepare('SELECT * FROM agent_store_items').all() as Array<{ namespace_path: string; key: string; value_json: string; created_at: string; updated_at: string }>
    const items: MemoryItem[] = rows.filter(row => {
      const ns = JSON.parse(row.namespace_path)
      return ns[0] === 'memories' && (!request.scope || request.scope === 'all' || ns[1] === request.scope) && (!request.projectId || ns[2] === request.projectId)
    }).map(row => { const ns = JSON.parse(row.namespace_path); return { ...JSON.parse(row.value_json), id: row.key, scope: ns[1], projectId: ns[2], createdAt: row.created_at, updatedAt: row.updated_at } })
    return { items, total: items.length }
  }
}

export function legacyMemory(resources: MemoryResources) {
  if (!resources.preferences) throw new Error('Expected persisted preference storage in this fixture.')
  const file = getAgentCatalogFile(resources.preferences.dataDir)
  async function use<T>(action: (store: SqliteMemoryStore) => Promise<T>) {
    const database = new Database(file, { fileMustExist: true })
    try { return await action(new SqliteMemoryStore(database)) } finally { database.close() }
  }
  return {
    saveMemory: (request: MemorySaveRequest, context: { origin: 'user' | 'agent' }) => use(store => store.saveMemory(request, context)),
    searchMemories: (request?: MemorySearchRequest) => use(store => store.searchMemories(request))
  }
}

function initializeLegacyMemoryTables(database: Database.Database): void {
  database.exec(`
      CREATE TABLE IF NOT EXISTS agent_store_items (
        namespace_path TEXT NOT NULL CHECK (json_valid(namespace_path)),
        key TEXT NOT NULL CHECK (length(key) > 0),
        value_json TEXT NOT NULL CHECK (json_valid(value_json)),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (namespace_path, key)
      );

      CREATE INDEX IF NOT EXISTS agent_store_items_updated_idx
        ON agent_store_items (updated_at DESC);

      CREATE VIRTUAL TABLE IF NOT EXISTS agent_memory_fts USING fts5(
        namespace_path UNINDEXED,
        key UNINDEXED,
        content,
        keywords,
        tokenize = 'trigram'
      );
    `)
}
