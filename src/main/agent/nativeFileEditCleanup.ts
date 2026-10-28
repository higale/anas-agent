import type Database from 'better-sqlite3'
import type { NativeExecutionCommit } from './nativeExecutionStore'

export function handoffUnacceptedNativeFileEdits(database: Database.Database, threadId: string, runId: string): void {
  database.prepare(`INSERT OR IGNORE INTO agent_file_edit_retained_operations(request_id,operation_id)
    SELECT json_extract(effect.target_json,'$.requestId'),json_extract(effect.target_json,'$.operationId')
    FROM execution_effects effect WHERE effect.thread_id=? AND effect.run_id=? AND effect.effect_kind='file_patch' AND effect.tool_name!='restore_file_edit'
      AND json_type(effect.target_json,'$.requestId')='text' AND json_type(effect.target_json,'$.operationId')='text'
      AND NOT EXISTS (SELECT 1 FROM execution_messages message WHERE message.thread_id=effect.thread_id AND message.record_id=effect.result_record_id)`)
    .run(threadId, runId)
  // The transaction owner retains incomplete inverse/source evidence, but
  // can clean a finalized pair whose result never reached execution history.
  handoffRestores(database, threadId, runId)
}

function handoffRestores(database: Database.Database, threadId: string, runId: string, recordIds?: string[]): void {
  const restored = database.prepare(`SELECT args_json,target_json FROM execution_effects effect
    WHERE thread_id=@threadId AND run_id=@runId AND tool_name='restore_file_edit' AND effect_kind='file_patch'
      AND ((@records IS NULL AND NOT EXISTS (SELECT 1 FROM execution_messages message
          WHERE message.thread_id=effect.thread_id AND message.record_id=effect.result_record_id))
        OR (state='result' AND result_record_id IN (SELECT value FROM json_each(@records))))`)
    .all({ threadId, runId, records: recordIds ? JSON.stringify(recordIds) : null }) as {
      args_json: string; target_json: string
    }[]
  for (const effect of restored) {
    const pairs = database.prepare(`SELECT json_extract(@target,'$.requestId') AS requestId,
        json_extract(@target,'$.operationId') AS operationId
      WHERE json_type(@target,'$.requestId')='text' AND json_type(@target,'$.operationId')='text'
      UNION SELECT CASE WHEN json_type(@args,'$.request_id')='text' AND length(trim(json_extract(@args,'$.request_id'))) > 0
        THEN trim(json_extract(@args,'$.request_id')) ELSE @runId END, json_extract(@args,'$.operation_id')
      WHERE json_type(@args,'$.operation_id')='text'`)
      .all({ target: effect.target_json, args: effect.args_json, runId }) as { requestId: string; operationId: string }[]
    for (const pair of pairs) {
      database.prepare('DELETE FROM agent_file_edit_retained_operations WHERE request_id=? AND operation_id=?').run(pair.requestId, pair.operationId)
      database.prepare('INSERT OR IGNORE INTO agent_file_edit_cleanup_outbox(run_id) VALUES (?)').run(pair.requestId)
    }
  }
}

export function handoffNativeFileEdits(database: Database.Database, commit: NativeExecutionCommit): void {
  // During a live run, only acceptance of the exact restore result releases
  // its recovery handoff. A journal result alone is not acceptance.
  handoffRestores(database, commit.threadId, commit.runId, commit.messageRecords.map(record => record.recordId))
  if (!['completed', 'cancelled', 'failed'].includes(commit.phase)) return
  handoffUnacceptedNativeFileEdits(database, commit.threadId, commit.runId)
  database.prepare('INSERT OR IGNORE INTO agent_file_edit_cleanup_outbox(run_id) VALUES (?)').run(commit.runId)
}
