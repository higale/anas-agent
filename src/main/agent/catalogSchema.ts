import Database from 'better-sqlite3'

export const catalogVersion = 2
export const catalogConversationColumns = ['id', 'title', 'project_id', 'model_config_id', 'model_parameter_preset_id', 'pinned', 'access_mode', 'status', 'user_turn_count', 'has_queued_inputs', 'created_at', 'updated_at']
export const catalogConversationSchema = `CREATE TABLE agent_conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  project_id TEXT NOT NULL,
  model_config_id TEXT,
  model_parameter_preset_id TEXT,
  pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
  access_mode TEXT NOT NULL CHECK (access_mode IN ('strict_approval', 'smart_approval', 'full_access')),
  status TEXT NOT NULL CHECK (status IN ('idle', 'running', 'interrupted', 'failed')),
  user_turn_count INTEGER NOT NULL CHECK (user_turn_count >= 0),
  has_queued_inputs INTEGER NOT NULL DEFAULT 0 CHECK (has_queued_inputs IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`
export const catalogConversationIndexes = `CREATE INDEX agent_conversations_order_idx ON agent_conversations (pinned DESC, updated_at DESC, id);
CREATE INDEX agent_conversations_project_idx ON agent_conversations (project_id);`

/** Check the actual constraint on an isolated in-memory table, never by writing user data. */
export function validateCatalogAccessMode(database: Database.Database): void {
  const row = database.prepare("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = 'agent_conversations'").get() as { sql: string } | undefined
  const probe = new Database(':memory:')
  try {
    if (!row) throw new Error('Missing conversation catalog table.')
    probe.exec(row.sql)
    const insert = probe.prepare(`INSERT INTO agent_conversations
      (id, title, project_id, pinned, access_mode, status, user_turn_count, has_queued_inputs, created_at, updated_at)
      VALUES (?, '', 'probe', 0, ?, 'idle', 0, 0, '', '')`)
    for (const mode of ['strict_approval', 'smart_approval', 'full_access']) insert.run(mode, mode)
    let rejected = false
    try { insert.run('invalid', 'invalid') } catch { rejected = true }
    if (!rejected) throw new Error('Missing access mode constraint.')
    const invalid = database.prepare("SELECT 1 FROM agent_conversations WHERE access_mode IS NULL OR access_mode NOT IN ('strict_approval', 'smart_approval', 'full_access') LIMIT 1").get()
    if (invalid) throw new Error('Invalid saved access mode.')
  } catch (cause) {
    throw new Error('Invalid agent catalog access mode structure or values; repair the saved data before opening it.', { cause })
  } finally { probe.close() }
}

const requiredCatalogColumns: Record<string, string[]> = {
  agent_conversations: catalogConversationColumns,
  agent_thread_locations: ['thread_id', 'owner_thread_id'],
  agent_run_locations: ['run_id', 'thread_id', 'owner_thread_id', 'submission_id'],
  agent_conversation_deletions: ['owner_thread_id'],
  agent_workspace_state: ['id', 'active_thread_id', 'draft_project_id', 'draft_model_config_id', 'draft_model_parameter_preset_id'],
  agent_store_items: ['namespace_path', 'key', 'value_json', 'created_at', 'updated_at'],
  agent_memory_fts: ['namespace_path', 'key', 'content', 'keywords']
}

export function validateCatalogSchema(database: Database.Database): void {
  const version = database.pragma('user_version', { simple: true }) as number
  if (version !== catalogVersion) throw new Error(`Unsupported agent catalog schema ${version}; expected ${catalogVersion}.`)
  for (const [table, required] of Object.entries(requiredCatalogColumns)) {
    const columns = new Set((database.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>).map(({ name }) => name))
    if (!columns.size) throw new Error(`Agent catalog is missing table ${table}.`)
    for (const column of required) {
      if (!columns.has(column)) throw new Error(`Agent catalog is missing column ${table}.${column}.`)
    }
  }
  validateCatalogAccessMode(database)
}
