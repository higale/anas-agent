import type Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { AgentSkillInvocation, AgentToolCall } from '../../shared/agentTypes'
import { displayTool } from '../../shared/activityDisplay'
import { presentConversationMessage } from './conversationPresentation'
import { presentToolResult, traceReasoningSummary } from '../../runtime/messagePresentation'
import { NativeExecutionStore } from './nativeExecutionStore'
import { decodeExecutionInput } from '../../runtime/executionInput'
import { displayTransaction } from './activityDisplayProjection'

export interface ActivityMessageHeader {
  kind: ConversationMessage['kind']
  hasText: boolean
  hasReasoning: boolean
  reasoningSummary?: string
  calls: { call: AgentToolCall; freeform?: boolean }[]
  childId?: string
  directionAfterCallIds?: string[]
  skill?: AgentSkillInvocation
}

/** Rebuildable display metadata. Bodies and execution decisions have one owner;
 * a directory read never decodes them to discover presentation boundaries. */
export const activityDirectorySchema = `
  ALTER TABLE agent_run_input_intents ADD COLUMN display_json TEXT;
  CREATE TABLE agent_display_headers (
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    header_json TEXT NOT NULL,
    PRIMARY KEY(thread_id,message_id),
    FOREIGN KEY(thread_id,message_id) REFERENCES agent_message_payloads(thread_id,message_id) ON DELETE CASCADE
  );
`

export function activityMessageHeader(threadId: string, runId: string, id: string, value: ConversationMessage, callIds: string[]): ActivityMessageHeader {
  const message = presentConversationMessage(value, id)
  const summary = traceReasoningSummary(message.content)
  let result = value.kind === 'tool' ? presentToolResult(message.content) : undefined
  if (typeof result === 'string') { try { result = JSON.parse(result) } catch { result = undefined } }
  const childId = result && typeof result === 'object' && 'subagent_id' in result && typeof result.subagent_id === 'string'
    ? result.subagent_id : undefined
  return {
    kind: value.kind,
    hasText: message.content.some(block => block.type === 'text' && /\S/.test(block.text)),
    hasReasoning: message.content.some(block => block.type === 'reasoning' && Boolean(block.text)),
    ...(summary ? { reasoningSummary: [...summary.slice(0, 240)].join('') } : {}),
    calls: (message.toolCalls ?? []).map((call, index) => {
      const tool = displayTool(threadId, runId, { call: { ...call, id: callIds[index] ?? call.id }, sequence: 0, status: 'completed' })
      return { call: tool.call, ...(tool.freeform ? { freeform: true } : {}) }
    }),
    ...(childId ? { childId } : {}),
    ...(message.directionAfterToolCallIds?.length ? { directionAfterCallIds: message.directionAfterToolCallIds } : {}),
    ...(message.skillInvocation ? { skill: { ...message.skillInvocation, promptText: '' } } : {})
  }
}

export function writeActivityMessageHeader(database: Database.Database, threadId: string, runId: string, id: string,
  value: ConversationMessage, callIds: string[]): void {
  const header = activityMessageHeader(threadId, runId, id, value, callIds)
  database.prepare(`INSERT INTO agent_display_headers(thread_id,message_id,header_json) VALUES(?,?,?)
    ON CONFLICT(thread_id,message_id) DO UPDATE SET header_json=excluded.header_json
    WHERE header_json<>excluded.header_json`).run(threadId, id, JSON.stringify(header))
}

/** Explicit repair only, after the original database has been preserved. */
export function rebuildActivityDirectory(database: Database.Database): boolean {
  const fingerprint = () => {
    const hash = createHash('sha256')
    // Group IDs preserve UI identity during incremental writes; a rebuild may
    // choose another ID for the same partition. Compare membership by the
    // group's first item, while still checking stored IDs and JSON agree.
    const groups = new Map<string, string>()
    const identity = (row: { run_id: string; agent_id: string; group_id: string }) => JSON.stringify([row.run_id, row.agent_id, row.group_id])
    for (const row of database.prepare('SELECT * FROM agent_display_groups ORDER BY run_id,agent_id,sequence,part,item_key').iterate() as Iterable<{
      run_id: string; agent_id: string; group_id: string; item_key: string; item_json: string
    }>) {
      groups.set(identity(row), row.item_key)
      let json = row.item_json
      try {
        const group = JSON.parse(json)
        if (group && typeof group === 'object' && !Array.isArray(group)) json = JSON.stringify({ ...group, key: Boolean(row.group_id) && group.key === row.group_id })
      } catch { /* Compare malformed metadata verbatim; the rebuild replaces it. */ }
      hash.update(JSON.stringify({ ...row, group_id: row.item_key, item_json: json }))
    }
    for (const row of database.prepare('SELECT * FROM agent_display_items ORDER BY run_id,agent_id,item_key').iterate() as Iterable<{
      run_id: string; agent_id: string; group_id: string | null
    }>) {
      const key = row.group_id === null ? undefined : groups.get(identity({ ...row, group_id: row.group_id }))
      hash.update(JSON.stringify({ ...row, group_id: row.group_id === null ? null : key === undefined ? ['missing', row.group_id] : ['group', key] }))
    }
    for (const query of [
      'SELECT * FROM agent_display_headers ORDER BY thread_id,message_id',
      'SELECT * FROM agent_display_delegations ORDER BY run_id,activity_key',
      'SELECT run_id,display_json FROM agent_run_input_intents ORDER BY run_id',
      'SELECT run_id,model_id,display_round FROM agent_model_activities ORDER BY run_id,model_id'
    ]) for (const row of database.prepare(query).iterate()) hash.update(JSON.stringify(row))
    return hash.digest('hex')
  }
  const before = fingerprint()
  const store = new NativeExecutionStore(database)
  displayTransaction(database, () => {
    database.prepare('DELETE FROM agent_display_groups').run()
    database.prepare('DELETE FROM agent_display_items').run()
    database.prepare('DELETE FROM agent_display_delegations').run()
    database.prepare(`WITH rounds AS (SELECT run_id,model_id,row_number() OVER (PARTITION BY run_id,subagent_id ORDER BY sequence,model_id) AS round
      FROM agent_model_activities) UPDATE agent_model_activities SET display_round=(SELECT round FROM rounds
      WHERE rounds.run_id=agent_model_activities.run_id AND rounds.model_id=agent_model_activities.model_id)`).run()
    database.prepare(`INSERT OR IGNORE INTO agent_display_changes SELECT run_id,'model:' || model_id FROM agent_model_activities`).run()
    database.prepare(`INSERT OR IGNORE INTO agent_display_changes SELECT run_id,'activity:' || activity_key FROM agent_activities`).run()
    database.prepare(`INSERT OR IGNORE INTO agent_display_changes SELECT run_id,'summary:' || summary_id FROM agent_context_summaries`).run()
    database.prepare(`INSERT OR IGNORE INTO agent_display_changes SELECT run_id,'message:' || message_id FROM agent_message_payloads WHERE run_id IS NOT NULL`).run()
    database.prepare(`INSERT OR IGNORE INTO agent_display_changes SELECT id,'input' FROM agent_runs`).run()
    for (const row of database.prepare('SELECT thread_id,message_id,run_id,record_id FROM agent_message_payloads').all() as {
      thread_id: string; message_id: string; run_id: string; record_id: string
    }[]) {
      const record = store.readMessageRecord(row.thread_id, row.record_id)
      writeActivityMessageHeader(database, row.thread_id, row.run_id, row.message_id, record.value,
        record.value.calls?.length ? store.readModelCallIds(row.thread_id, row.record_id) : [])
    }
    for (const row of database.prepare(`SELECT input.run_id,input.input_json,run.thread_id FROM agent_run_input_intents input
      JOIN agent_runs run ON run.id=input.run_id`).all() as { run_id: string; input_json: string; thread_id: string }[]) {
      const message = decodeExecutionInput(row.input_json)
      const header = message ? JSON.stringify({ id: message.id, header: activityMessageHeader(row.thread_id, row.run_id, message.id, message.value, []) }) : null
      database.prepare('UPDATE agent_run_input_intents SET display_json=? WHERE run_id=? AND display_json IS NOT ?').run(header, row.run_id, header)
    }
  })()
  return fingerprint() !== before
}
