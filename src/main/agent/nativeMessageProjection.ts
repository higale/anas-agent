import { withholdToolResult } from '../../runtime/modelRequestRecovery'
import type Database from 'better-sqlite3'
import { isDeepStrictEqual } from 'node:util'
import { NativeExecutionStore, type NativeExecutionCommit } from './nativeExecutionStore'
import { RunActivityMetadata } from './runActivityMetadata'
import { NativeMessageReader } from './nativeMessageReader'

/** Explicit native database creation only. Existing databases receive this
 * column with the native schema; constructors never alter schemas. */
export const nativeMessageProjectionSchema = 'ALTER TABLE agent_message_payloads ADD COLUMN body_sequence INTEGER;'

/** Installed with native product storage after removing previous triggers.
 * Body retention belongs to explicit native collection, not this projection. */
export const nativeMessageReleaseSchema = `
  CREATE TRIGGER agent_release_message_payload AFTER DELETE ON agent_message_payloads
  BEGIN
    UPDATE agent_tool_messages SET model_message_id=NULL
      WHERE thread_id=OLD.thread_id AND model_message_id=OLD.message_id;
    UPDATE agent_tool_messages SET tool_message_id=NULL
      WHERE thread_id=OLD.thread_id AND tool_message_id=OLD.message_id;
    DELETE FROM agent_tool_messages
      WHERE thread_id=OLD.thread_id AND model_message_id IS NULL AND tool_message_id IS NULL;
  END;
`

/** Product indexes derived from a native commit on the same SQLite connection.
 * Tool results are readable as activities immediately, but enter conversation
 * history only when the owning store publishes their completed batch. */
export class NativeMessageProjection {
  private readonly store: NativeExecutionStore
  private readonly activities: RunActivityMetadata
  constructor(private readonly database: Database.Database) {
    this.store = new NativeExecutionStore(database)
    this.activities = new RunActivityMetadata(database)
  }

  /** Rebuild derived call links from current native evidence at startup. No
   * message, execution identity, approval decision or external effect is changed. */
  reconcileToolIdentities(): void {
    if (!this.database.inTransaction) throw new Error('Activity reconciliation requires the owning transaction.')
    const runs = this.database.prepare(`SELECT DISTINCT payload.run_id,payload.thread_id
      FROM agent_message_payloads payload JOIN execution_model_calls call
        ON call.thread_id=payload.thread_id AND call.record_id=payload.record_id
      LEFT JOIN agent_tool_messages link ON link.thread_id=payload.thread_id AND link.run_id=payload.run_id
        AND link.call_id=call.call_id AND link.model_message_id=payload.message_id
      WHERE payload.run_id IS NOT NULL AND link.call_id IS NULL`).all() as { run_id: string; thread_id: string }[]
    for (const run of runs) this.reconcileRunTools(run.thread_id, run.run_id)
  }

  private reconcileRunTools(threadId: string, runId: string): void {
    const rows = this.database.prepare(`SELECT payload.record_id,history.position FROM agent_message_payloads payload
      LEFT JOIN execution_messages history ON history.thread_id=payload.thread_id AND history.record_id=payload.record_id
      WHERE payload.thread_id=? AND payload.run_id=? ORDER BY payload.body_sequence`).all(threadId, runId) as {
        record_id: string; position: number | null
      }[]
    const records = rows.map(row => ({ ...this.store.readMessageRecord(threadId, row.record_id), position: row.position }))
    const previous = this.database.prepare('SELECT call_id,model_message_id,tool_message_id FROM agent_tool_messages WHERE thread_id=? AND run_id=?')
      .all(threadId, runId) as { call_id: string; model_message_id: string | null; tool_message_id: string | null }[]
    const links = records.flatMap(record => {
      if (!record.value.calls?.length) return []
      const ids = this.store.readModelCallIds(threadId, record.recordId)
      return record.value.calls.map((call, index) => ({ id: ids[index], providerId: call.id ?? ids[index],
        name: call.name, modelId: record.id, position: record.position, index,
        resultId: previous.find(link => link.call_id === ids[index] && link.model_message_id === record.id)?.tool_message_id ?? null }))
    })
    // Exact result ownership is available for an active batch and retained effects.
    const exact = this.database.prepare(`SELECT call_id,result_record_id FROM execution_calls WHERE thread_id=? AND result_record_id IS NOT NULL
      UNION SELECT call_id,result_record_id FROM execution_effects WHERE thread_id=? AND run_id=? AND result_record_id IS NOT NULL`)
      .all(threadId, threadId, runId) as { call_id: string; result_record_id: string }[]
    for (const owner of exact) {
      const link = links.find(link => link.id === owner.call_id), result = records.find(record => record.recordId === owner.result_record_id)
      if (link && result) link.resultId = result.id
    }
    // Completed batches append results in call order. Partial batches are only
    // paired where identity is unambiguous; never guess from completion order.
    const responses = records.filter(record => record.value.calls?.length && record.position !== null)
      .sort((left, right) => left.position! - right.position!)
    for (const [index, response] of responses.entries()) {
      const results = records.filter(record => record.value.kind === 'tool' && record.position !== null
        && record.position > response.position! && (responses[index + 1] === undefined || record.position < responses[index + 1].position!))
        .sort((left, right) => left.position! - right.position!)
      const batch = links.filter(link => link.modelId === response.id)
      for (const providerId of new Set(batch.map(link => link.providerId))) {
        const calls = batch.filter(link => link.providerId === providerId)
        const answers = results.filter(record => record.value.resultFor === providerId)
        if (calls.length === answers.length) calls.forEach((link, offset) => { link.resultId = answers[offset].id })
        else for (const answer of answers) {
          const link = calls.find(link => answer.id === `${link.id}:result`)
          if (link) link.resultId = answer.id
        }
      }
    }
    // Transfer metadata only when a provider ID identifies one call in the run.
    // Old links may contain an earlier batch's result, so they are not result evidence.
    for (const old of previous) {
      const matches = links.filter(link => link.providerId === old.call_id)
      if (matches.length !== 1) continue
      const link = matches[0]
      if (old.call_id !== link.id) this.renameToolActivity(runId, old.call_id, link.id)
    }
    const insert = this.database.prepare(`INSERT INTO agent_tool_messages(thread_id,run_id,call_id,model_message_id,tool_message_id)
      VALUES(?,?,?,?,?) ON CONFLICT(thread_id,run_id,call_id) DO UPDATE SET model_message_id=excluded.model_message_id,tool_message_id=excluded.tool_message_id`)
    const descendants = this.database.prepare(`SELECT model.run_id,model.subagent_id,message.message_id FROM agent_model_activities model
      JOIN agent_model_messages message ON message.run_id=model.run_id AND message.model_id=model.model_id
      JOIN agent_subagent_calls child ON child.id=model.subagent_id WHERE child.child_run_id=?`).all(runId) as {
        run_id: string; subagent_id: string; message_id: string
      }[]
    const affectedRuns = new Set([runId])
    for (const link of links) {
      insert.run(threadId, runId, link.id, link.modelId, link.resultId)
      const targets = [{ run_id: runId, subagent_id: null }, ...descendants.filter(target => target.message_id === link.modelId)]
      for (const target of targets) {
        const key = `tool:${target.subagent_id ?? 'root'}:${link.id}`
        this.database.prepare(`INSERT INTO agent_activities(run_id,activity_key,sequence,kind,activity_id,parent_subagent_id,name,status)
          VALUES(?,?,?,'tool',?,?,?,?) ON CONFLICT(run_id,activity_key) DO UPDATE SET status=excluded.status`)
          .run(target.run_id, key, this.activities.nextSequence(target.run_id), link.id, target.subagent_id, link.name, link.resultId ? 'completed' : 'running')
        affectedRuns.add(target.run_id)
      }
    }
    for (const old of previous) if (!links.some(link => link.id === old.call_id)
      && (!old.tool_message_id || links.some(link => link.resultId === old.tool_message_id))) {
      const obsolete = this.database.prepare(`SELECT activity.run_id,activity.activity_key FROM agent_activities activity
        LEFT JOIN agent_subagent_calls child ON child.id=activity.parent_subagent_id
        WHERE activity.kind='tool' AND activity.activity_id=? AND
          ((activity.run_id=? AND activity.parent_subagent_id IS NULL) OR child.child_run_id=?)`)
        .all(old.call_id, runId, runId) as { run_id: string; activity_key: string }[]
      for (const activity of obsolete) {
        this.database.prepare('DELETE FROM agent_activities WHERE run_id=? AND activity_key=?').run(activity.run_id, activity.activity_key)
        this.database.prepare('DELETE FROM agent_activity_timing WHERE run_id=? AND activity_key=?').run(activity.run_id, activity.activity_key)
      }
      this.database.prepare('DELETE FROM agent_tool_messages WHERE thread_id=? AND run_id=? AND call_id=?').run(threadId, runId, old.call_id)
    }
    const state = this.store.load(threadId)
    if (state?.runId === runId) for (const approval of state.approvals) {
      if (approval.kind !== 'tool' && approval.kind !== 'effect_recovery') continue
      approval.callIds.forEach((id, actionIndex) => {
        const targets = this.database.prepare(`SELECT activity.run_id,activity.activity_key FROM agent_activities activity
          LEFT JOIN agent_subagent_calls child ON child.id=activity.parent_subagent_id
          WHERE activity.kind='tool' AND activity.activity_id=? AND
            ((activity.run_id=? AND activity.parent_subagent_id IS NULL) OR child.child_run_id=?)`)
          .all(id, runId, runId) as { run_id: string; activity_key: string }[]
        for (const target of targets) {
          this.database.prepare('DELETE FROM agent_tool_approvals WHERE run_id=? AND interrupt_id=? AND action_index=?')
            .run(target.run_id, approval.id, actionIndex)
          this.database.prepare(`INSERT INTO agent_tool_approvals(run_id,activity_key,interrupt_id,action_index) VALUES(?,?,?,?)
            ON CONFLICT(run_id,activity_key) DO UPDATE SET interrupt_id=excluded.interrupt_id,action_index=excluded.action_index`)
            .run(target.run_id, target.activity_key, approval.id, actionIndex)
        }
      })
    }
    for (const affected of affectedRuns) this.orderRecoveredTools(affected)
  }

  private orderRecoveredTools(runId: string): void {
    const entries = this.database.prepare(`
      SELECT 'agent_activities' AS table_name, activity.rowid AS row_id,
        COALESCE(model.sequence + (call.call_index + 1.0) / (1 + (SELECT COUNT(*) FROM execution_model_calls sibling
          WHERE sibling.thread_id=call.thread_id AND sibling.record_id=call.record_id)),activity.sequence) AS ordering
      FROM agent_activities activity
      LEFT JOIN agent_subagent_calls child ON child.id=activity.parent_subagent_id
      LEFT JOIN agent_tool_messages link ON link.run_id=COALESCE(child.child_run_id,activity.run_id) AND link.call_id=activity.activity_id
        AND activity.kind='tool'
      LEFT JOIN agent_message_payloads payload ON payload.thread_id=link.thread_id AND payload.message_id=link.model_message_id
      LEFT JOIN execution_model_calls call ON call.thread_id=payload.thread_id AND call.record_id=payload.record_id AND call.call_id=link.call_id
      LEFT JOIN agent_model_messages message ON message.run_id=activity.run_id AND message.message_id=link.model_message_id
      LEFT JOIN agent_model_activities model ON model.run_id=message.run_id AND model.model_id=message.model_id
        AND model.subagent_id IS activity.parent_subagent_id
      WHERE activity.run_id=?
      UNION ALL SELECT 'agent_model_activities',rowid,sequence FROM agent_model_activities WHERE run_id=?
      UNION ALL SELECT 'agent_context_summaries',rowid,sequence FROM agent_context_summaries WHERE run_id=?
      UNION ALL SELECT 'agent_memory_recalls',rowid,sequence FROM agent_memory_recalls WHERE run_id=?
      ORDER BY ordering,row_id`).all(runId, runId, runId, runId) as { table_name: string; row_id: number }[]
    entries.forEach((entry, sequence) => {
      this.database.prepare(`UPDATE ${entry.table_name} SET sequence=? WHERE rowid=?`).run(sequence, entry.row_id)
    })
  }

  private renameToolActivity(sourceRunId: string, from: string, to: string): void {
    const targets = this.database.prepare(`SELECT activity.run_id,activity.activity_key,activity.parent_subagent_id
      FROM agent_activities activity LEFT JOIN agent_subagent_calls child ON child.id=activity.parent_subagent_id
      WHERE activity.kind='tool' AND activity.activity_id=? AND
        ((activity.run_id=? AND activity.parent_subagent_id IS NULL) OR child.child_run_id=?)`)
      .all(from, sourceRunId, sourceRunId) as { run_id: string; activity_key: string; parent_subagent_id: string | null }[]
    for (const target of targets) {
      const key = `tool:${target.parent_subagent_id ?? 'root'}:${to}`
      if (this.database.prepare('SELECT 1 FROM agent_activities WHERE run_id=? AND activity_key=?').get(target.run_id, key)) continue
      this.database.prepare(`INSERT INTO agent_activities(run_id,activity_key,sequence,kind,activity_id,parent_subagent_id,name,status,output_json)
        SELECT run_id,?,sequence,kind,?,parent_subagent_id,name,status,output_json FROM agent_activities WHERE run_id=? AND activity_key=?`)
        .run(key, to, target.run_id, target.activity_key)
      // Timing rows have no activity foreign key; replace any orphaned target.
      this.database.prepare('DELETE FROM agent_activity_timing WHERE run_id=? AND activity_key=?').run(target.run_id, key)
      for (const table of ['agent_tool_approvals', 'agent_activity_timing']) {
        this.database.prepare(`UPDATE ${table} SET activity_key=? WHERE run_id=? AND activity_key=?`).run(key, target.run_id, target.activity_key)
      }
      this.database.prepare('DELETE FROM agent_activities WHERE run_id=? AND activity_key=?').run(target.run_id, target.activity_key)
    }
  }

  commit(commit: NativeExecutionCommit): void {
    if (!this.database.inTransaction) throw new Error('Message projections require the owning execution transaction.')
    const head = this.database.prepare('SELECT run_id,revision_id,phase FROM execution_state WHERE thread_id=?').get(commit.threadId)
    if (!isDeepStrictEqual(head, { run_id: commit.runId, revision_id: commit.revisionId, phase: commit.phase })) throw new Error('Message projection no longer matches the execution commit.')
    for (const record of commit.messageRecords) {
      if (!isDeepStrictEqual(this.store.readMessageRecord(commit.threadId, record.recordId), record)) throw new Error('Message projection has no matching durable body.')
      if (commit.summary && record.value.context?.summary && record.value.context.summaryId === commit.summary.id) continue
      if (record.value.context?.runId !== undefined && record.value.context.runId !== commit.runId) throw new Error('Committed message belongs to another run.')
      const replacedToolResult = commit.replacedToolResults?.[record.recordId]
      const existing = this.database.prepare('SELECT run_id,record_id,body_sequence FROM agent_message_payloads WHERE thread_id=? AND message_id=?')
        .get(commit.threadId, record.id) as { run_id: string | null; record_id: string; body_sequence: number | null } | undefined
      if (existing) {
        if (existing.run_id !== commit.runId || !Number.isSafeInteger(existing.body_sequence)
          || existing.body_sequence === null || existing.body_sequence < 0) {
          throw new Error('Committed message conflicts with its existing activity reference.')
        }
        if (existing.record_id !== record.recordId) {
          const validToolReplacement = replacedToolResult === existing.record_id && record.value.kind === 'tool'
            && commit.phase === 'prepare_model' && isDeepStrictEqual(record.value, withholdToolResult(this.store.readMessageRecord(commit.threadId, replacedToolResult).value))
            && this.database.prepare('SELECT 1 FROM execution_messages WHERE thread_id=? AND message_id=? AND record_id=?').get(commit.threadId, record.id, record.recordId)
          if (!validToolReplacement && (existing.record_id !== commit.previousResponseRecordId || record.value.kind !== 'assistant'
            || !this.database.prepare('SELECT 1 FROM execution_state WHERE thread_id=? AND response_record_id=?').get(commit.threadId, record.recordId))) {
            throw new Error('Committed message conflicts with its existing activity reference.')
          }
          // Explicit revisions retain their original activity position and call identity.
          this.database.prepare('UPDATE agent_message_payloads SET record_id=? WHERE thread_id=? AND message_id=?')
            .run(record.recordId, commit.threadId, record.id)
        }
      } else {
        const order = this.database.prepare('SELECT coalesce(max(body_sequence),0)+1 AS next FROM agent_message_payloads WHERE thread_id=?')
          .get(commit.threadId) as { next: number }
        this.database.prepare('INSERT INTO agent_message_payloads(thread_id,message_id,run_id,record_id,body_sequence) VALUES (?,?,?,?,?)')
          .run(commit.threadId, record.id, commit.runId, record.recordId, order.next)
      }
      // The tool already completed; changing its saved return value does not execute or complete it again.
      if (replacedToolResult) {
        if (!existing || !this.database.prepare('SELECT 1 FROM agent_tool_messages WHERE thread_id=? AND run_id=? AND tool_message_id=?')
          .get(commit.threadId, commit.runId, record.id)) throw new Error('The replaced result has no owned tool call.')
        continue
      }
      const native = record.value.calls?.length ? this.store.readModelCallIds(commit.threadId, record.recordId) : undefined
      if (record.value.kind === 'assistant') {
        const linked = this.database.prepare(`SELECT model.model_id FROM agent_model_activities model
          LEFT JOIN agent_model_messages message ON message.run_id=model.run_id AND message.model_id=model.model_id
          WHERE model.run_id=? AND model.subagent_id IS NULL AND (message.message_id=? OR (message.message_id IS NULL AND model.status='running'))
          ORDER BY (message.message_id IS NOT NULL) DESC,model.sequence DESC LIMIT 1`).get(commit.runId, record.id) as { model_id: string } | undefined
        this.activities.model(commit.runId, { id: linked?.model_id ?? `message:${record.id}`, messageId: record.id, status: 'completed' })
      }
      if (record.value.kind === 'assistant') for (const [index, call] of (record.value.calls ?? []).entries()) {
        const callId = native?.[index]
        if (callId === undefined) throw new Error('Model activity has no owned application call identity.')
        this.database.prepare(`INSERT INTO agent_tool_messages(thread_id,run_id,call_id,model_message_id) VALUES (?,?,?,?)
          ON CONFLICT(thread_id,run_id,call_id) DO UPDATE SET model_message_id=excluded.model_message_id`)
          .run(commit.threadId, commit.runId, callId, record.id)
        const result = this.database.prepare('SELECT tool_message_id FROM agent_tool_messages WHERE thread_id=? AND run_id=? AND call_id=?')
          .get(commit.threadId, commit.runId, callId) as { tool_message_id: string | null }
        if (!result.tool_message_id) this.activities.upsert({ runId: commit.runId, key: `tool:root:${callId}`, kind: 'tool',
          id: callId, name: call.name, status: 'running' })
      }
      if (record.value.kind === 'tool') {
        const owner = this.database.prepare('SELECT call_id FROM execution_calls WHERE thread_id=? AND result_record_id=?')
          .get(commit.threadId, record.recordId) as { call_id: string } | undefined
        if (!owner) throw new Error('Tool activity has no owned application call identity.')
        const callId = owner.call_id, key = `tool:root:${callId}`
        this.database.prepare(`INSERT INTO agent_tool_messages(thread_id,run_id,call_id,tool_message_id) VALUES(?,?,?,?)
          ON CONFLICT(thread_id,run_id,call_id) DO UPDATE SET tool_message_id=excluded.tool_message_id`)
          .run(commit.threadId, commit.runId, callId, record.id)
        const existing = this.database.prepare('SELECT name FROM agent_activities WHERE run_id=? AND activity_key=?')
          .get(commit.runId, key) as { name: string } | undefined
        this.activities.upsert({ runId: commit.runId, key, kind: 'tool', id: callId,
          name: existing?.name ?? record.value.name ?? 'tool', status: 'completed' })
        this.database.prepare('DELETE FROM agent_tool_approvals WHERE run_id=? AND activity_key=?').run(commit.runId, key)
      }
    }
    const changed = this.database.prepare(`SELECT history.position,history.message_id,history.record_id FROM execution_messages history
      LEFT JOIN agent_message_index entry ON entry.thread_id=history.thread_id AND entry.position=history.position
      WHERE history.thread_id=? AND (entry.record_id IS NULL OR entry.record_id<>history.record_id) ORDER BY history.position`)
      .all(commit.threadId) as { position: number; message_id: string; record_id: string }[]
    for (const row of changed) {
      const record = this.store.readMessageRecord(commit.threadId, row.record_id)
      const owner = this.database.prepare('SELECT run_id FROM agent_message_payloads WHERE thread_id=? AND message_id=?')
        .get(commit.threadId, row.message_id) as { run_id: string | null } | undefined
      if (!owner) throw new Error('Committed history has no message owner.')
      const visible = record.value.kind === 'user' || record.value.kind === 'assistant' && !record.value.calls?.length
      this.database.prepare(`INSERT INTO agent_message_index(thread_id,position,record_id,message_id,run_id,visible) VALUES (?,?,?,?,?,?)
        ON CONFLICT(thread_id,position) DO UPDATE SET record_id=excluded.record_id,message_id=excluded.message_id,run_id=excluded.run_id,visible=excluded.visible`)
        .run(commit.threadId, row.position, record.recordId, record.id, owner.run_id, Number(visible))
    }
    this.database.prepare(`DELETE FROM agent_message_index WHERE thread_id=? AND NOT EXISTS
      (SELECT 1 FROM execution_messages history WHERE history.thread_id=agent_message_index.thread_id AND history.position=agent_message_index.position)`)
      .run(commit.threadId)
    if (['completed', 'cancelled', 'failed'].includes(commit.phase)) {
      const evidence = new NativeMessageReader(this.database).rootActivityEvidence(commit.runId)
      this.activities.reconcile(commit.runId, evidence)
    }
  }
}
