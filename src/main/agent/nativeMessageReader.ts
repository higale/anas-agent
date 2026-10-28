import type Database from 'better-sqlite3'
import type { AgentContextStatus, AgentRunActivity } from '../../shared/agentTypes'
import { NativeExecutionStore } from './nativeExecutionStore'
import { presentConversationMessage } from './conversationPresentation'
import type { ExecutionMessageRecord } from '../../runtime/executionState'
import { rootActivityEvidence } from '../../runtime/runActivities'
import { RunActivityReader, type ActivityPayloadReader } from './runActivityReader'
import { presentToolResult, traceReasoningSummary } from '../../runtime/messagePresentation'
import { RunActivityObservations } from './runActivityObservations'
import { decodeExecutionInput } from '../../runtime/executionInput'

/** Reads product projections of native execution records.
 * History positions and activity payloads can retain different body versions;
 * neither reader substitutes the newest body with the same message ID. */
export class NativeMessageReader {
  private readonly store: NativeExecutionStore
  readonly activities: RunActivityReader
  readonly observations: RunActivityObservations

  submittedUserMessage(runId: string) {
    const row = this.database.prepare('SELECT input_json FROM agent_run_input_intents WHERE run_id=?').get(runId) as { input_json: string } | undefined
    const message = row ? decodeExecutionInput(row.input_json) : undefined
    return message ? presentConversationMessage(message.value, message.id) : undefined
  }

  committedDirections(threadId: string, runId: string, messageIds?: readonly string[]) {
    const prefix = `${runId}:direction:`
    const rows = this.database.prepare(`SELECT record_id,message_id FROM agent_message_index WHERE thread_id=? AND run_id=?
      AND substr(message_id,1,?)=? AND (? IS NULL OR message_id IN (SELECT value FROM json_each(?))) ORDER BY position`)
      .all(threadId, runId, prefix.length, prefix, messageIds ? JSON.stringify(messageIds) : null, messageIds ? JSON.stringify(messageIds) : null) as { record_id: string; message_id: string }[]
    return rows.map(row => {
      const record = this.store.readMessageRecord(threadId, row.record_id)
      if (record.id !== row.message_id || record.value.kind !== 'user' || record.value.context?.runId !== runId
        || !Array.isArray(record.value.context?.directionAfterCallIds)) throw new Error('Committed direction has invalid message ownership.')
      return { queuedInputId: record.id.slice(prefix.length), message: this.present(threadId, record) }
    })
  }

  /** Resolve the exact first visible body, never a newer observation or the
   * whole execution history. Only the short display label leaves this reader. */
  roundSummary(threadId: string, runId: string): string {
    const entry = this.database.prepare(`SELECT record_id FROM agent_message_index
      WHERE thread_id=? AND run_id=? AND visible=1 ORDER BY position LIMIT 1`)
      .get(threadId, runId) as { record_id: string } | undefined
    let message = entry ? this.store.readMessageRecord(threadId, entry.record_id).value : undefined
    if (!entry) {
      const intent = this.database.prepare(`SELECT intent.input_json FROM agent_run_input_intents intent
        JOIN agent_runs run ON run.id=intent.run_id WHERE run.id=? AND run.thread_id=?`)
        .get(runId, threadId) as { input_json: string } | undefined
      if (intent) message = decodeExecutionInput(intent.input_json)?.value
    }
    if (message?.kind !== 'user') return ''
    const content = message.context?.displayText ?? message.content
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.find(block => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')?.text ?? '' : ''
    return text.slice(0, 160).replace(/\s+/g, ' ').trim()
  }

  constructor(private readonly database: Database.Database) {
    this.store = new NativeExecutionStore(database)
    this.observations = new RunActivityObservations(database)
    this.activities = new RunActivityReader(database, {
      model: (runId, modelId, messageId, subagentId) => this.modelPayload(runId, modelId, messageId, subagentId),
      tool: (runId, callId, name, subagentId) => this.toolPayload(runId, callId, name, subagentId)
    })
  }

  payload(threadId: string, messageId: string) {
    return this.payloadRecord(threadId, messageId)?.value
  }

  private payloadRecord(threadId: string, messageId: string, runId?: string) {
    const row = this.database.prepare('SELECT record_id,run_id FROM agent_message_payloads WHERE thread_id=? AND message_id=?')
      .get(threadId, messageId) as { record_id: string; run_id: string } | undefined
    if (!row) return undefined
    if (runId !== undefined && row.run_id !== runId) throw new Error('Activity payload belongs to another run.')
    const record = this.store.readMessageRecord(threadId, row.record_id)
    if (record.id !== messageId) throw new Error('Activity payload references another message identity.')
    if (runId !== undefined && record.value.context?.runId !== undefined && record.value.context.runId !== runId) {
      throw new Error('Activity body belongs to another run.')
    }
    return record
  }

  private activitySource(runId: string, subagentId?: string) {
    if (subagentId) {
      const child = this.database.prepare('SELECT child_thread_id AS threadId,child_run_id AS runId FROM agent_subagent_calls WHERE id=?')
        .get(subagentId) as { threadId: string; runId: string } | undefined
      if (!child) throw new Error('Activity child does not exist.')
      return child
    }
    const run = this.database.prepare('SELECT thread_id AS threadId FROM agent_runs WHERE id=?').get(runId) as { threadId: string } | undefined
    if (!run) throw new Error('Run does not exist.')
    return { ...run, runId }
  }

  private modelPayload: ActivityPayloadReader['model'] = (runId, modelId, messageId, subagentId) => {
    const source = this.activitySource(runId, subagentId)
    const record = messageId ? this.payloadRecord(source.threadId, messageId, source.runId) : undefined
    const message = record && record.value.kind === 'assistant' ? this.present(source.threadId, record) : undefined
    if (!message) {
      const pending = this.observations.pendingModel(runId, modelId)
      return { text: pending?.text ?? '', reasoning: pending?.reasoning ?? '', toolCallIds: pending?.toolCallIds ?? [],
        ...(pending?.reasoningSummary ? { reasoningSummary: pending.reasoningSummary } : {}) }
    }
    const summary = traceReasoningSummary(message.content)
    return {
      text: message?.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('') ?? '',
      reasoning: message?.content.flatMap(block => block.type === 'reasoning' ? [block.text] : []).join('') ?? '',
      ...(summary ? { reasoningSummary: summary } : {}),
      toolCallIds: message?.toolCalls?.map(call => call.id) ?? []
    }
  }

  private toolPayload: ActivityPayloadReader['tool'] = (runId, callId, name, subagentId) => {
    const source = this.activitySource(runId, subagentId)
    const link = this.database.prepare('SELECT model_message_id,tool_message_id FROM agent_tool_messages WHERE thread_id=? AND run_id=? AND call_id=?')
      .get(source.threadId, source.runId, callId) as { model_message_id: string | null; tool_message_id: string | null } | undefined
    const model = link?.model_message_id ? this.payloadRecord(source.threadId, link.model_message_id, source.runId) : undefined
    const call = model ? this.present(source.threadId, model).toolCalls?.find(call => call.id === callId) : undefined
    const result = link?.tool_message_id ? this.payloadRecord(source.threadId, link.tool_message_id, source.runId) : undefined
    const pending = this.observations.pendingTool(runId, callId, subagentId)
    return { call: { id: callId, name: call?.name ?? name, args: call?.args ?? pending?.call.args ?? {} },
      output: result ? presentToolResult(this.present(source.threadId, result).content) : pending?.output }
  }

  runMessages(runId: string) { return this.selectedMessages(runId) }

  /** Saved results count even before their parallel batch enters history.
   * Streaming activity and a newer same-ID body are never used as evidence. */
  rootActivityEvidence(runId: string) {
    return this.database.transaction(() => {
      if (!this.database.prepare('SELECT 1 FROM agent_runs WHERE id=?').get(runId)) throw new Error('Run does not exist.')
      return rootActivityEvidence(this.runMessages(runId), runId)
    })()
  }

  private present(threadId: string, record: ExecutionMessageRecord) {
    const message = record.value
    const ids = message.calls?.length ? this.store.readModelCallIds(threadId, record.recordId) : undefined
    const result = message.kind === 'tool' ? this.database.prepare(
      'SELECT call_id FROM agent_tool_messages WHERE thread_id=? AND tool_message_id=?'
    ).get(threadId, record.id) as { call_id: string } | undefined : undefined
    // Direction placement follows the owning batch's native identities, even
    // when a v1 body recorded the provider IDs used in that batch.
    let directionIds: string[] | undefined
    if (message.kind === 'user' && Array.isArray(message.context?.directionAfterCallIds)
      && message.context.directionAfterCallIds.length) {
      const batch = this.database.prepare(`SELECT response.record_id FROM execution_messages response
        JOIN execution_messages direction ON direction.thread_id=response.thread_id
        WHERE direction.thread_id=? AND direction.record_id=? AND response.position<direction.position
          AND EXISTS (SELECT 1 FROM execution_model_calls call WHERE call.thread_id=response.thread_id AND call.record_id=response.record_id)
        ORDER BY response.position DESC LIMIT 1`).get(threadId, record.recordId) as { record_id: string } | undefined
      if (batch) directionIds = this.store.readModelCallIds(threadId, batch.record_id)
    }
    return presentConversationMessage({ ...message,
      ...(directionIds ? { context: { ...message.context, directionAfterCallIds: directionIds } } : {}),
      ...(ids ? { calls: message.calls!.map((call, index) => ({ ...call, id: ids[index] })) } : {}),
      ...(result ? { resultFor: result.call_id } : {}) }, record.id)
  }

  activityMessages(runId: string, activity: AgentRunActivity) {
    if (activity.runId !== runId) throw new Error('Activity belongs to another run.')
    const ids = new Set(activity.models.flatMap(model => !model.subagentId && model.messageId ? [model.messageId] : []))
    const callIds = activity.tools.flatMap(tool => tool.subagentId ? [] : [tool.call.id])
    const links = this.database.prepare(`SELECT model_message_id,tool_message_id FROM agent_tool_messages
      WHERE run_id=? AND call_id IN (SELECT value FROM json_each(?))`).all(runId, JSON.stringify(callIds)) as {
        model_message_id: string | null; tool_message_id: string | null
      }[]
    for (const link of links) {
      if (link.model_message_id) ids.add(link.model_message_id)
      if (link.tool_message_id) ids.add(link.tool_message_id)
    }
    return this.selectedMessages(runId, [...ids])
  }

  private selectedMessages(runId: string, ids?: string[]) {
    const rows = this.database.prepare(`SELECT thread_id,message_id,record_id,body_sequence FROM agent_message_payloads
      WHERE run_id=? AND (? IS NULL OR message_id IN (SELECT value FROM json_each(?))) ORDER BY body_sequence`)
      .all(runId, ids ? JSON.stringify(ids) : null, ids ? JSON.stringify(ids) : null) as {
        thread_id: string; message_id: string; record_id: string; body_sequence: number | null
      }[]
    return rows.map(row => {
      if (!Number.isSafeInteger(row.body_sequence) || row.body_sequence === null || row.body_sequence < 0) throw new Error('Activity message has no committed body order.')
      const record = this.store.readMessageRecord(row.thread_id, row.record_id)
      if (record.id !== row.message_id) throw new Error('Activity payload references another message identity.')
      const message = this.present(row.thread_id, record)
      if (message.runId !== undefined && message.runId !== runId) throw new Error('Activity body belongs to another run.')
      return { ...message, runId }
    })
  }

  window(threadId: string, startIndex?: number, limit = 100) {
    return this.database.transaction(() => {
      if (!this.database.prepare('SELECT 1 FROM agent_threads WHERE id=?').get(threadId)) throw new Error('Conversation does not exist.')
      const totalCount = (this.database.prepare('SELECT COUNT(*) AS count FROM agent_message_index WHERE thread_id=? AND visible=1')
        .get(threadId) as { count: number }).count
      const size = Math.max(0, Math.floor(limit))
      const offset = startIndex === undefined ? Math.max(0, totalCount - size) : Math.min(totalCount, Math.max(0, Math.floor(startIndex)))
      // Preserve the product's explicit-start behavior: the requested suffix
      // is returned in full; limit applies to the default tail window.
      const rows = this.database.prepare(`SELECT record_id,message_id FROM agent_message_index
        WHERE thread_id=? AND visible=1 ORDER BY position LIMIT ? OFFSET ?`)
        .all(threadId, startIndex === undefined ? size : totalCount - offset, offset) as Array<{ record_id: string; message_id: string | null }>
      const messages = rows.map(row => {
        const record = this.store.readMessageRecord(threadId, row.record_id)
        if (row.message_id !== null && record.id !== row.message_id) throw new Error('History index references another message identity.')
        return this.present(threadId, record)
      })
      const status = this.database.prepare('SELECT status_json FROM agent_context_status WHERE thread_id=?').get(threadId) as { status_json: string } | undefined
      return { messages, startIndex: offset, totalCount,
        ...(status ? { contextStatus: JSON.parse(status.status_json) as AgentContextStatus } : {}) }
    })()
  }
}
