import type Database from 'better-sqlite3'
import { lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { filePatchDefinitionSchema, filePatchRecordMetadataSchema, patchTextHash } from './filePatchRecord'

interface StoredChange {
  request_id: string
  operation_id: string
  revision: number
  definition_json: string
  metadata_json: string
}

interface RepairRecord {
  row: StoredChange
  definition: ReturnType<typeof filePatchDefinitionSchema.parse>
  metadata: ReturnType<typeof filePatchRecordMetadataSchema.parse>
  text?: string
}

// Manual recovery of archived evidence only. Runtime readers remain strict,
// and the caller validates the complete staged database before installing it.
export async function repairArchivedFileChangeVersions(database: Database.Database, dataRoot: string): Promise<string[]> {
  const columns = new Set((database.prepare('SELECT name FROM pragma_table_info(?)').all('agent_file_changes') as Array<{ name: string }>).map(row => row.name))
  if (!['request_id', 'operation_id', 'revision', 'definition_json', 'metadata_json'].every(column => columns.has(column))) return []
  const invalidVersion = database.prepare(`SELECT 1 FROM agent_file_changes
    WHERE json_type(definition_json, '$.version') IS NOT 'integer' OR json_extract(definition_json, '$.version') IS NOT 0
      OR json_type(metadata_json, '$.version') IS NOT 'integer' OR json_extract(metadata_json, '$.version') IS NOT 0 LIMIT 1`).get()
  if (!invalidVersion) return []
  const rows: StoredChange[] = []
  let bytes = 0
  for (const value of database.prepare('SELECT request_id, operation_id, revision, definition_json, metadata_json FROM agent_file_changes').iterate()) {
    const row = value as StoredChange
    bytes += Buffer.byteLength(row.definition_json) + Buffer.byteLength(row.metadata_json)
    if (rows.length >= 100_000 || bytes > 128 * 1024 ** 2) throw new Error('Archived file change repair exceeds the record or metadata size limit; original data preserved.')
    rows.push(row)
  }
  const key = (requestId: string, operationId: string): string => `${requestId}/${operationId}`
  const records = new Map<string, RepairRecord>(rows.map(row => {
    const definition = filePatchDefinitionSchema.parse({ ...JSON.parse(row.definition_json), version: 0 })
    const metadata = filePatchRecordMetadataSchema.parse({ ...JSON.parse(row.metadata_json), version: 0 })
    if (metadata.requestId !== row.request_id || metadata.operationId !== row.operation_id || metadata.revision !== row.revision
      || metadata.transaction.id !== row.operation_id || metadata.definitionHash !== patchTextHash(row.definition_json)
      || metadata.transaction.entries.length !== definition.entries.length) {
      throw new Error(`File change ${key(row.request_id, row.operation_id)} has inconsistent evidence; original data preserved.`)
    }
    return [key(row.request_id, row.operation_id), { row, definition, metadata }]
  }))
  const visiting = new Set<string>()
  const definitionText = (record: RepairRecord): string => {
    if (record.text !== undefined) return record.text
    const id = key(record.row.request_id, record.row.operation_id)
    if (visiting.has(id)) throw new Error(`File change recovery references contain a cycle: ${id}.`)
    visiting.add(id)
    const original = JSON.parse(record.row.definition_json)
    let changed = original.version !== 0
    if (record.definition.restores) changed = repairReference(record.definition.restores, changed) || changed
    record.text = changed ? JSON.stringify(record.definition) : record.row.definition_json
    visiting.delete(id)
    return record.text
  }
  const repairReference = (reference: { requestId: string; operationId: string; definitionHash: string }, definitionChanged: boolean): boolean => {
    const id = key(reference.requestId, reference.operationId)
    const target = records.get(id)
    if (!target) {
      // History deletion can remove a referenced operation. Metadata-only
      // repairs preserve that reference and leave external back-references valid.
      // A changed definition needs joint repair to update those back-references.
      if (definitionChanged) throw new Error(`Related file change ${id} is unavailable in this archive; preserve its recovery evidence for joint repair.`)
      return false
    }
    if (reference.definitionHash !== patchTextHash(target.row.definition_json)) {
      throw new Error(`File change reference ${id} has an invalid definition hash.`)
    }
    const nextHash = patchTextHash(definitionText(target))
    if (reference.definitionHash === nextHash) return false
    reference.definitionHash = nextHash
    return true
  }
  const updates: Array<{ row: StoredChange; definition: string; metadata: string }> = []
  for (const record of records.values()) {
    const definition = definitionText(record)
    const { metadata, row } = record
    const definitionChanged = definition !== row.definition_json
    let changed = JSON.parse(row.metadata_json).version !== 0 || metadata.definitionHash !== patchTextHash(definition)
    metadata.definitionHash = patchTextHash(definition)
    if (metadata.transaction.reverseAttempt) changed = repairReference(metadata.transaction.reverseAttempt, definitionChanged) || changed
    if (metadata.transaction.recovery?.inverse) changed = repairReference(metadata.transaction.recovery.inverse, definitionChanged) || changed
    const text = changed ? JSON.stringify(metadata) : row.metadata_json
    if (definition === row.definition_json && text === row.metadata_json) continue
    const liveRecord = join(dataRoot, 'file_edits', row.request_id, row.operation_id)
    const exists = await lstat(liveRecord).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false
      throw error
    })
    if (exists) throw new Error(`File change ${key(row.request_id, row.operation_id)} still has recovery material; preserve it for joint repair.`)
    updates.push({ row, definition, metadata: text })
  }
  database.transaction(() => {
    const update = database.prepare('UPDATE agent_file_changes SET definition_json = ?, metadata_json = ? WHERE request_id = ? AND operation_id = ?')
    for (const { row, definition, metadata } of updates) update.run(definition, metadata, row.request_id, row.operation_id)
  })()
  return updates.map(({ row }) => `agent_file_changes[${key(row.request_id, row.operation_id)}]: format version and definition references`)
}
