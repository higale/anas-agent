import type Database from 'better-sqlite3'

/** Published v3 stores filenames only. Never infer a missing original path. */
export const conversationV3ToV4 = {
  from: 3,
  to: 4,
  upgrade(database: Database.Database): void {
    database.exec('ALTER TABLE agent_attachments ADD COLUMN source_path TEXT')
    database.exec('ALTER TABLE agent_queued_attachments ADD COLUMN source_path TEXT')
  }
}
