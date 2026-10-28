import type Database from 'better-sqlite3'
import { existsSync, statSync } from 'node:fs'
import { resolve, sep } from 'node:path'
import { normalizeSubagentConfigSnapshot } from './subagentTaskStore'
import { FileChangeLedger } from './fileChangeLedger'

type SqliteForeignKeyRow = {
  id: number
  seq: number
  table: string
  from: string
  to: string
  on_delete: string
}

function hasCascadeForeignKey(
  database: Database.Database,
  sourceTable: string,
  targetTable: string,
  columns: ReadonlyArray<readonly [source: string, target: string]>
): boolean {
  const foreignKeys = database.pragma(
    `foreign_key_list(${sourceTable})`
  ) as SqliteForeignKeyRow[]
  const constraints = new Map<number, SqliteForeignKeyRow[]>()
  for (const row of foreignKeys) {
    const constraint = constraints.get(row.id) ?? []
    constraint.push(row)
    constraints.set(row.id, constraint)
  }
  return [...constraints.values()].some((constraint) => {
    const ordered = [...constraint].sort((left, right) => left.seq - right.seq)
    return ordered.length === columns.length
      && ordered.every((row, index) => (
        row.table === targetTable
        && row.on_delete === 'CASCADE'
        && row.from === columns[index]?.[0]
        && row.to === columns[index]?.[1]
      ))
  })
}

function assertCascadeForeignKey(
  database: Database.Database,
  sourceTable: string,
  targetTable: string,
  columns: ReadonlyArray<readonly [source: string, target: string]>
): void {
  if (hasCascadeForeignKey(database, sourceTable, targetTable, columns)) return
  const source = columns.map(([column]) => column)
  const target = columns.map(([, column]) => column)
  const sourceDescription = source.length === 1
    ? `${sourceTable}.${source[0]}`
    : `${sourceTable} (${source.join(', ')})`
  const targetDescription = target.length === 1
    ? `${targetTable}.${target[0]}`
    : `${targetTable} (${target.join(', ')})`
  throw new Error(
    `Unsupported agent database schema: ${sourceDescription} must reference ${targetDescription} ON DELETE CASCADE.`
  )
}

export function assertManagedCallStorageIntegrity(database: Database.Database): void {
  if (!hasCascadeForeignKey(database, 'agent_managed_calls', 'agent_runs', [
    ['run_id', 'id'],
    ['thread_id', 'thread_id']
  ])) {
    throw new Error(
      'Unsupported agent database schema: agent_managed_calls must reference agent_runs with (run_id, thread_id) ON DELETE CASCADE.'
    )
  }

  const invalidCall = database.prepare(`
    SELECT call.id
    FROM agent_managed_calls AS call
    LEFT JOIN agent_runs AS run ON run.id = call.run_id
    WHERE call.thread_id IS NULL
      OR run.id IS NULL
      OR run.thread_id <> call.thread_id
    LIMIT 1
  `).get() as { id: string } | undefined
  if (invalidCall) {
    throw new Error(
      `Managed call ${invalidCall.id} does not belong to its recorded conversation.`
    )
  }
}

export function assertSubagentStorageIntegrity(database: Database.Database): void {
  assertCascadeForeignKey(
    database,
    'agent_hidden_threads',
    'agent_threads',
    [['thread_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_threads',
    [['owner_thread_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_threads',
    [['parent_thread_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_runs',
    [['parent_run_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_threads',
    [['child_thread_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_runs',
    [['child_run_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_runs',
    [
      ['parent_run_id', 'id'],
      ['parent_thread_id', 'thread_id']
    ]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_calls',
    'agent_subagent_calls',
    [['parent_subagent_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_observations',
    'agent_subagent_calls',
    [['subagent_id', 'id']]
  )
  assertCascadeForeignKey(
    database,
    'agent_subagent_observations',
    'agent_runs',
    [['observing_run_id', 'id']]
  )

  const invalidCall = database.prepare(`
    SELECT call.id
    FROM agent_subagent_calls AS call
    LEFT JOIN agent_threads AS owner ON owner.id = call.owner_thread_id
    LEFT JOIN agent_hidden_threads AS owner_hidden ON owner_hidden.thread_id = call.owner_thread_id
    LEFT JOIN agent_threads AS parent_thread ON parent_thread.id = call.parent_thread_id
    LEFT JOIN agent_runs AS parent_run ON parent_run.id = call.parent_run_id
    LEFT JOIN agent_threads AS child_thread ON child_thread.id = call.child_thread_id
    LEFT JOIN agent_hidden_threads AS child_hidden ON child_hidden.thread_id = call.child_thread_id
    LEFT JOIN agent_runs AS child_run ON child_run.id = call.child_run_id
    LEFT JOIN agent_subagent_calls AS parent_call ON parent_call.id = call.parent_subagent_id
    WHERE owner.id IS NULL
      OR owner_hidden.thread_id IS NOT NULL
      OR parent_thread.id IS NULL
      OR parent_run.id IS NULL
      OR parent_run.thread_id <> call.parent_thread_id
      OR child_thread.id IS NULL
      OR child_hidden.thread_id IS NULL
      OR child_run.id IS NULL
      OR child_run.thread_id <> call.child_thread_id
      OR child_thread.project_id <> owner.project_id
      OR parent_thread.project_id <> owner.project_id
      OR (
        call.parent_subagent_id IS NULL
        AND call.parent_thread_id <> call.owner_thread_id
      )
      OR (
        call.parent_subagent_id IS NOT NULL
        AND (
          parent_call.id IS NULL
          OR parent_call.id = call.id
          OR parent_call.owner_thread_id <> call.owner_thread_id
          OR parent_call.child_thread_id <> call.parent_thread_id
          OR parent_call.child_run_id <> call.parent_run_id
        )
      )
    LIMIT 1
  `).get() as { id: string } | undefined
  if (invalidCall) {
    throw new Error(`Subagent ${invalidCall.id} has an invalid conversation relationship.`)
  }

  const invalidObservation = database.prepare(`
    SELECT observation.subagent_id, observation.observing_run_id
    FROM agent_subagent_observations AS observation
    LEFT JOIN agent_subagent_calls AS call ON call.id = observation.subagent_id
    LEFT JOIN agent_runs AS observing_run ON observing_run.id = observation.observing_run_id
    WHERE call.id IS NULL
      OR observing_run.id IS NULL
      OR observation.observing_run_id <> call.parent_run_id
      OR observing_run.thread_id <> call.parent_thread_id
    LIMIT 1
  `).get() as { subagent_id: string; observing_run_id: string } | undefined
  if (invalidObservation) {
    throw new Error(
      `Subagent observation ${invalidObservation.subagent_id}/${invalidObservation.observing_run_id} does not belong to its parent run.`
    )
  }

  const storedConfigs = database.prepare(`
    SELECT id, agent_name, config_json
    FROM agent_subagent_calls
    ORDER BY rowid ASC
  `).all() as Array<{ id: string; agent_name: string; config_json: string }>
  for (const stored of storedConfigs) {
    const config = normalizeSubagentConfigSnapshot(JSON.parse(stored.config_json))
    if (config.name !== stored.agent_name) {
      throw new Error(`Subagent ${stored.id} config snapshot does not match its stored name.`)
    }
  }

  const cycle = database.prepare(`
    WITH RECURSIVE ancestry(origin_id, current_id, parent_id, path, cyclic) AS (
      SELECT id, id, parent_subagent_id, ',' || id || ',', 0
      FROM agent_subagent_calls
      UNION ALL
      SELECT
        ancestry.origin_id,
        parent.id,
        parent.parent_subagent_id,
        ancestry.path || parent.id || ',',
        instr(ancestry.path, ',' || parent.id || ',') > 0
      FROM ancestry
      INNER JOIN agent_subagent_calls AS parent ON parent.id = ancestry.parent_id
      WHERE ancestry.parent_id IS NOT NULL AND ancestry.cyclic = 0
    )
    SELECT origin_id
    FROM ancestry
    WHERE cyclic = 1
    LIMIT 1
  `).get() as { origin_id: string } | undefined
  if (cycle) throw new Error(`Subagent ancestry contains a cycle at ${cycle.origin_id}.`)

  const invalidProjection = database.prepare(`
    WITH RECURSIVE projected(run_id, subagent_id) AS (
      SELECT parent_run_id, id
      FROM agent_subagent_calls
      UNION ALL
      SELECT projected.run_id, child.id
      FROM projected
      INNER JOIN agent_subagent_calls AS child
        ON child.parent_subagent_id = projected.subagent_id
    ), projected_once AS (
      SELECT DISTINCT run_id, subagent_id
      FROM projected
    ), referenced AS (
      SELECT
        activity.run_id,
        activity.activity_key AS reference_key,
        CASE
          WHEN activity.kind = 'subagent' THEN activity.activity_id
          ELSE activity.parent_subagent_id
        END AS subagent_id
      FROM agent_activities AS activity
      WHERE activity.kind = 'subagent' OR activity.parent_subagent_id IS NOT NULL
      UNION ALL
      SELECT
        model.run_id,
        'model:' || model.model_id,
        model.subagent_id
      FROM agent_model_activities AS model
      WHERE model.subagent_id IS NOT NULL
    )
    SELECT referenced.reference_key
    FROM referenced
    LEFT JOIN projected_once
      ON projected_once.run_id = referenced.run_id
      AND projected_once.subagent_id = referenced.subagent_id
    WHERE projected_once.subagent_id IS NULL
    LIMIT 1
  `).get() as { reference_key: string } | undefined
  if (invalidProjection) {
    throw new Error(
      `Subagent activity ${invalidProjection.reference_key} does not belong to its projected run.`
    )
  }

  const invalidSubagentActivity = database.prepare(`
    SELECT activity.activity_key
    FROM agent_activities AS activity
    INNER JOIN agent_subagent_calls AS call ON call.id = activity.activity_id
    WHERE activity.kind = 'subagent'
      AND activity.parent_subagent_id IS NOT call.parent_subagent_id
    LIMIT 1
  `).get() as { activity_key: string } | undefined
  if (invalidSubagentActivity) {
    throw new Error(
      `Subagent activity ${invalidSubagentActivity.activity_key} has an invalid parent.`
    )
  }
}

export function assertAttachmentCleanupOutboxIntegrity(database: Database.Database): void {
  const liveThreadCleanup = database.prepare(`
    SELECT cleanup.thread_id
    FROM agent_attachment_cleanup_outbox AS cleanup
    INNER JOIN agent_threads AS thread ON thread.id = cleanup.thread_id
    LIMIT 1
  `).get() as { thread_id: string } | undefined
  if (liveThreadCleanup) {
    throw new Error(
      `Live conversation ${liveThreadCleanup.thread_id} cannot be scheduled for attachment cleanup.`
    )
  }
}

export function assertCleanupStorageIntegrity(database: Database.Database): void {
  assertAttachmentCleanupOutboxIntegrity(database)
  const files = database.prepare('SELECT attachment_id, thread_id, storage_path FROM agent_attachment_file_cleanup_outbox').all() as Array<{
    attachment_id: string; thread_id: string; storage_path: string
  }>
  for (const file of files) {
    const segments = file.storage_path.split('/')
    if (segments.length !== 3 || segments[0] !== file.thread_id || segments[1] !== file.attachment_id
      || segments.some((segment) => !segment || segment === '.' || segment === '..' || /[\\:]/.test(segment))) {
      throw new Error(`Attachment cleanup ${file.attachment_id} has an invalid managed path.`)
    }
    const referenced = database.prepare(`SELECT 1 FROM agent_attachments WHERE id = ? OR storage_path = ?
      UNION ALL SELECT 1 FROM agent_queued_attachments WHERE id = ? OR storage_path = ? LIMIT 1`)
      .get(file.attachment_id, file.storage_path, file.attachment_id, file.storage_path)
    if (referenced) throw new Error(`Live attachment ${file.attachment_id} cannot be scheduled for cleanup.`)
  }
}

/** Product resources keep the same format across execution replacement.
 * Validate their ownership and files without opening a graph-backed store. */
export function validateConversationResources(database: Database.Database, attachmentRoot: string,
  projectIds: ReadonlySet<string>, expectedOwnerThreadId?: string): void {
  const managedTables = new Set((database.prepare(`
    SELECT name
    FROM sqlite_schema
    WHERE type = 'table'
      AND name IN ('agent_managed_calls', 'agent_managed_call_observations')
  `).all() as Array<{ name: string }>).map((row) => row.name))
  if (managedTables.has('agent_managed_calls')) {
    assertManagedCallStorageIntegrity(database)
  }
  assertSubagentStorageIntegrity(database)
  assertCleanupStorageIntegrity(database)
  if (managedTables.has('agent_managed_call_observations')) {
    if (!managedTables.has('agent_managed_calls')) {
      throw new Error('Managed call observations exist without the managed call table.')
    }
    const invalidObservation = database.prepare(`
      SELECT observation.call_id, observation.run_id
      FROM agent_managed_call_observations AS observation
      LEFT JOIN agent_managed_calls AS call ON call.id = observation.call_id
      LEFT JOIN agent_runs AS observing_run ON observing_run.id = observation.run_id
      WHERE call.id IS NULL
        OR observing_run.id IS NULL
        OR call.thread_id <> observing_run.thread_id
        OR observation.thread_id IS NULL
        OR observation.thread_id <> call.thread_id
        OR observation.thread_id <> observing_run.thread_id
      LIMIT 1
    `).get() as { call_id: string; run_id: string } | undefined
    if (invalidObservation) {
      throw new Error(
        `Managed call observation ${invalidObservation.call_id}/${invalidObservation.run_id} crosses conversations.`
      )
    }
  }
  const foreignKeys = database.pragma('foreign_key_check') as unknown[]
  if (foreignKeys.length > 0) throw new Error('Agent database foreign key check failed.')
  new FileChangeLedger(database).validateIntegrity()
  const threadProjects = database.prepare('SELECT DISTINCT project_id FROM agent_threads').all() as Array<{
    project_id: string
  }>
  const missingProject = threadProjects.find((row) => !projectIds.has(row.project_id))
  if (missingProject) {
    throw new Error(`Agent thread references missing project ${missingProject.project_id}.`)
  }
  if (expectedOwnerThreadId !== undefined) {
    const owners = database.prepare(`
      SELECT thread.id FROM agent_threads thread
      WHERE NOT EXISTS (
        SELECT 1 FROM agent_hidden_threads hidden WHERE hidden.thread_id = thread.id
      )
    `).all() as Array<{ id: string }>
    if (owners.length !== 1 || owners[0]?.id !== expectedOwnerThreadId) {
      throw new Error(`Conversation database does not belong to ${expectedOwnerThreadId}.`)
    }
  }
  const root = resolve(attachmentRoot)
  const rows = database.prepare('SELECT storage_path, size FROM agent_attachments').all() as Array<{
    storage_path: string
    size: number
  }>
  for (const row of rows) {
    const path = resolve(root, row.storage_path)
    if (path === root || !path.startsWith(`${root}${sep}`)) {
      throw new Error(`Agent attachment path escapes the attachment root: ${row.storage_path}`)
    }
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size !== row.size) {
      throw new Error(`Agent attachment is missing or has an invalid size: ${row.storage_path}`)
    }
  }
  const queuedRows = database.prepare(`
    SELECT storage_path, size
    FROM agent_queued_attachments
  `).all() as Array<{ storage_path: string; size: number }>
  for (const row of queuedRows) {
    const path = resolve(root, row.storage_path)
    if (path === root || !path.startsWith(`${root}${sep}`)) {
      throw new Error(`Queued attachment path escapes the attachment root: ${row.storage_path}`)
    }
    if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size !== row.size) {
      throw new Error(`Queued attachment is missing or has an invalid size: ${row.storage_path}`)
    }
  }
}
