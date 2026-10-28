import Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import { conversationIdentitySchema, conversationResourceSchema } from './conversationSchema'
import { fileChangeLedgerSchema } from './fileChangeLedger'
import { nativeExecutionSchema } from './nativeExecutionStore'
import { nativeRunOwnerSchema } from './nativeRunOwner'
import { nativeManagedResultSchema } from './nativeManagedResults'
import { nativeMessageProjectionSchema, nativeMessageReleaseSchema } from './nativeMessageProjection'
import { nativeConversationSchemaVersion } from './nativeStorageValidation'

const schema = conversationIdentitySchema() + conversationResourceSchema + fileChangeLedgerSchema
  + nativeExecutionSchema + nativeRunOwnerSchema + nativeManagedResultSchema + nativeMessageProjectionSchema + nativeMessageReleaseSchema

function tables(database: Database.Database) {
  return (database.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string }>)
    .map(({ name }) => ({ name,
      columns: database.prepare('SELECT name,type,"notnull",dflt_value,pk,hidden FROM pragma_table_xinfo(?)').all(name),
      foreignKeys: database.prepare('SELECT id,seq,"table","from","to",on_update,on_delete,match FROM pragma_foreign_key_list(?)').all(name),
      indexes: (database.prepare('SELECT name,"unique",origin,partial FROM pragma_index_list(?) ORDER BY name').all(name) as Array<{ name: string }>)
        .map(index => ({ ...index, columns: database.prepare('SELECT seqno,cid,name,"desc",coll,key FROM pragma_index_xinfo(?) ORDER BY seqno').all(index.name) })) }))
}
let expected: ReturnType<typeof tables> | undefined
let expectedTriggers: Array<{ name: string; sql: string }> | undefined

/** Read-only structure validation. It never repairs a database or consults an
 * older schema, and therefore also works after removing upgrade modules. */
export function validateNativeConversationSchema(database: Database.Database): void {
  if (database.pragma('user_version', { simple: true }) !== nativeConversationSchemaVersion) throw new Error('Unsupported native conversation database version.')
  if (!expected) {
    const reference = new Database(':memory:')
    try {
      reference.exec(schema); expected = tables(reference)
      expectedTriggers = reference.prepare("SELECT name,sql FROM sqlite_schema WHERE type='trigger'").all() as Array<{ name: string; sql: string }>
    } finally { reference.close() }
  }
  const actual = new Map(tables(database).map(table => [table.name, table]))
  for (const table of expected) {
    if (!isDeepStrictEqual(actual.get(table.name), table)) throw new Error(`Invalid native conversation schema: ${table.name}.`)
  }
  for (const trigger of expectedTriggers!) {
    const actual = database.prepare("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?").get(trigger.name) as { sql: string } | undefined
    if (actual?.sql !== trigger.sql) throw new Error(`Invalid native conversation schema: ${trigger.name}.`)
  }
}

/** Explicit new native storage creation. Existing native stores are checked
 * without running startup recovery; unsupported stores are rejected. */
export function initializeNativeConversationStorage(database: Database.Database): void {
  database.pragma('foreign_keys=ON')
  if (database.pragma('foreign_keys', { simple: true }) !== 1) throw new Error('Native storage requires foreign keys before initialization.')
  if (database.prepare("SELECT 1 FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%'").get()) {
    validateNativeConversationSchema(database)
    return
  }
  if (database.pragma('user_version', { simple: true }) !== 0) throw new Error('Cannot initialize an unknown empty database version.')
  database.transaction(() => {
    database.exec(schema)
    database.pragma(`user_version=${nativeConversationSchemaVersion}`)
    validateNativeConversationSchema(database)
  })()
}
