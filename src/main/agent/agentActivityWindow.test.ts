import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { ExecutionMessageInput, ExecutionToolCall } from '../../runtime/executionState'
import { conversationMessageRecordId, encodeConversationMessage } from '../../runtime/conversationStorage'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { defaultCapabilities } from '@shared/agentCapabilities'
import type { AgentRunActivity, AgentRuntimeEvent } from '@shared/agentTypes'
import type { SubagentConfig } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { SqliteMemoryStore } from '../../test/legacyMemoryFixture'
import { FileEditStore } from '../fileEditStore'
import { displayTransaction } from './activityDisplayProjection'
import { rebuildActivityDirectory } from './activityDirectoryIndex'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-activity-window-')), memory = new Database(':memory:')
  const file = join(root, 'conversation.sqlite'), options = {
    attachmentRoot: join(root, 'attachments'), memoryStore: new SqliteMemoryStore(memory), fileEditStore: new FileEditStore(join(root, 'file_edits')) }
  let database = NativeConversationDatabase.open(file, options)
  return { get database() { return database },
    reopen() { database.close(); database = NativeConversationDatabase.open(file, options); return database },
    sql(action: (raw: Database.Database) => void) { const raw = new Database(file); try { action(raw) } finally { raw.close() } },
    close() { database.close(); memory.close(); rmSync(root, { recursive: true, force: true }) }
  }
}
async function createRun(database: NativeConversationDatabase, threadId: string, runId: string) {
  const run = database.runs.createRun({ threadId, runId, operation: 'agent', message: {
    id: runId + ':input', value: { id: runId + ':input', kind: 'user', content: 'Task', context: { runId } }
  } })
  await database.runs.enter('input', { threadId, runId }); return run
}
function scope(database: NativeConversationDatabase, threadId: string, runId: string) {
  return { threadId, runId, expectedRevisionId: database.runs.store.load(threadId)!.revisionId }
}
async function putMessages(database: NativeConversationDatabase, threadId: string, messages: ExecutionMessageInput[], runId: string) {
  const store = database.runs.store
  let count = 0
  for (let index = 0; index < messages.length; index += 1) {
    const response = messages[index], calls: ExecutionToolCall[] = (response.value.calls ?? []).map(call => ({
      id: call.id!, providerCallId: call.id, name: call.name, args: call.args,
      artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, call.id + ':' + purpose])) as ExecutionToolCall['artifacts']
    })), context = { modelCalls: ++count, todos: [] }
    store.acceptModel(scope(database, threadId, runId), response, calls, context)
    if (calls.length) {
      store.prepareTools(scope(database, threadId, runId), calls.map(call => ({ callId: call.id, args: call.args })))
      for (const call of calls) store.settleCall({ threadId, runId }, call.id, messages[++index])
      store.finishBatch(scope(database, threadId, runId))
    } else store.continueAfterModel(scope(database, threadId, runId), [], context)
  }
}

function fullSequences(activity: AgentRunActivity): number[] {
  return [...activity.models, ...activity.tools, ...activity.subagents.filter((entry) => !entry.detailsDeferred),
    ...(activity.summaries ?? []), ...(activity.memoryRecalls ?? [])].map((entry) => entry.sequence).sort((a, b) => a - b)
}

function config(): SubagentConfig {
  return {
    index: 0, name: 'reviewer', enabled: true, builtIn: false, description: 'Review a file.', systemPrompt: 'Review the assigned file.',
    capabilities: { ...structuredClone(defaultCapabilities), profile: false, workspace: true, memory: true, toolMode: 'all', tools: [], skills: { mode: 'default', project: false, entries: [] } }
  }
}

describe('run activity windows', () => {
  it('does not report a healthy display directory as damaged when rebuild visits calls in a different order', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread(), run = await createRun(database, thread.id, 'repair-order')
      const calls = ['zeta', 'alpha'].map(id => ({ id, name: 'lookup', args: {} }))
      await putMessages(database, thread.id, [
        { id: 'request', value: { kind: 'assistant', content: 'Checking', calls, context: { runId: run.id } } },
        ...calls.map(call => ({ id: `result-${call.id}`, value: { kind: 'tool' as const, resultFor: call.id, content: 'Found', context: { runId: run.id } } }))
      ], run.id)
      database.runs.store.finish(scope(database, thread.id, run.id), 'completed')
      h.sql(raw => {
        expect(rebuildActivityDirectory(raw)).toBe(false)
        expect(rebuildActivityDirectory(raw)).toBe(false)
        raw.prepare("UPDATE agent_display_items SET group_id='missing' WHERE item_key='model-tool:root:message:request:1'").run()
        expect(rebuildActivityDirectory(raw)).toBe(true)
        expect(rebuildActivityDirectory(raw)).toBe(false)
        raw.prepare("UPDATE agent_display_groups SET item_json=json_set(item_json,'$.key','wrong')").run()
        expect(rebuildActivityDirectory(raw)).toBe(true)
        expect(rebuildActivityDirectory(raw)).toBe(false)
        raw.prepare("UPDATE agent_display_groups SET item_json='null'").run()
        expect(rebuildActivityDirectory(raw)).toBe(true)
        expect(rebuildActivityDirectory(raw)).toBe(false)
        raw.pragma('ignore_check_constraints = ON')
        raw.prepare("UPDATE agent_display_groups SET item_json='broken'").run()
        raw.pragma('ignore_check_constraints = OFF')
        expect(rebuildActivityDirectory(raw)).toBe(true)
        expect(rebuildActivityDirectory(raw)).toBe(false)
        const group = raw.prepare('SELECT group_id FROM agent_display_groups ORDER BY sequence LIMIT 1').get() as { group_id: string }
        raw.prepare("UPDATE agent_display_groups SET group_id='',item_json=json_set(item_json,'$.key','') WHERE group_id=?").run(group.group_id)
        raw.prepare("UPDATE agent_display_items SET group_id='' WHERE group_id=?").run(group.group_id)
        expect(rebuildActivityDirectory(raw)).toBe(true)
        expect(rebuildActivityDirectory(raw)).toBe(false)
      })
    } finally { h.close() }
  })

  it('drops uncommitted display drafts on reopen while keeping committed reasoning and replies', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread(), run = await createRun(database, thread.id, 'restart-display')
      await putMessages(database, thread.id, [{ id: 'saved', value: { kind: 'assistant', content: [
        { type: 'reasoning', reasoning: 'Saved reasoning' }, { type: 'text', text: 'Saved reply' }
      ], context: { runId: run.id } } }], run.id)
      database.messages.observations.recordModel(run.id, { id: 'streaming', status: 'running', text: 'Unsaved reply', reasoning: 'Unsaved reasoning', toolCallIds: [] })
      database.messages.observations.recordToolProgress(run.id, 'streaming', [{ index: 0, name: 'read_file', characterCount: 40, complete: false }])
      const input = { threadId: thread.id, runId: run.id, requestId: 'restart' }, signal = new AbortController().signal
      const before = await database.activityDirectory.read(input, signal)
      expect(before.items.filter(item => item.type === 'reply')).toHaveLength(2)
      const reopened = h.reopen(), after = await reopened.activityDirectory.read(input, signal)
      expect(after.items.filter(item => item.type === 'reply')).toMatchObject([{ model: { messageId: 'saved' } }])
      const group = after.items.filter(item => item.type === 'process').at(-1)!
      const members = await reopened.activityDirectory.read({ ...input, parentId: group.key }, signal)
      expect(members.items).toMatchObject([{ type: 'entry', item: { type: 'model', model: { id: 'streaming', hasText: false, hasReasoning: false } } }])
      expect(reopened.messages.activities.getDisplayDetail({ ...input, kind: 'model', id: 'message:saved' })).toMatchObject({ text: 'Saved reply', reasoning: 'Saved reasoning' })
    } finally { h.close() }
  })

  it('keeps a skill activity readable before and after the input is committed', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread(), runId = 'skill-run', id = 'skill-input'
      database.runs.createRun({ threadId: thread.id, runId, operation: 'agent', message: {
        id, value: { id, kind: 'user', content: 'Expanded review instructions', context: { runId, displayText: '/review changes' } }
      } })
      const input = { threadId: thread.id, runId, requestId: 'test' }
      const before = await database.activityDirectory.read(input, new AbortController().signal)
      expect(before.items).toMatchObject([{ type: 'entry', item: { type: 'skill', invocation: {
        name: 'review', promptText: '', detail: { id, kind: 'skill' }
      } } }])
      expect(database.messages.runInputMessage(thread.id, runId)?.skillInvocation?.promptText).toBe('Expanded review instructions')
      await database.runs.enter('input', { threadId: thread.id, runId })
      database.runs.store.finish(scope(database, thread.id, runId), 'completed')
      expect(database.messages.submittedUserMessage(runId)).toBeUndefined()
      const after = await database.activityDirectory.read(input, new AbortController().signal)
      expect(after.items).toEqual(before.items)
      expect(database.messages.runInputMessage(thread.id, runId)?.skillInvocation?.promptText).toBe('Expanded review instructions')
      expect(() => database.messages.runInputMessage('another-thread', runId)).toThrow('another conversation')
    } finally { h.close() }
  })

  it('returns complete reply directories and empty unchanged revisions', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread(), run = await createRun(database, thread.id, 'replies')
      await putMessages(database, thread.id, Array.from({ length: 120 }, (_, index) => ({
        id: 'answer-' + index, value: { kind: 'assistant', content: 'Answer ' + index, context: { runId: run.id } }
      })), run.id)
      const input = { threadId: thread.id, runId: run.id, requestId: 'test' }, signal = new AbortController().signal
      const first = await database.activityDirectory.read(input, signal)
      expect(first.items).toHaveLength(120)
      expect(first.items[0]).toMatchObject({ type: 'reply', model: { text: '', hasText: true } })
      expect(await database.activityDirectory.read({ ...input, version: first.version }, signal)).toEqual({
        version: first.version, baseVersion: first.version, items: [], removed: []
      })
      await expect(database.activityDirectory.read({ ...input, threadId: 'other' }, signal)).rejects.toThrow('another conversation')
      expect(database.messages.activities.getDisplayDetail({ ...input, kind: 'model', id: 'message:answer-0' })).toEqual({ text: 'Answer 0', reasoning: '' })
    } finally { h.close() }
  })

  it('keeps a long process whole across raw batches, pages its members and never scans tool results', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread(), run = await createRun(database, thread.id, 'group-run')
      const calls = Array.from({ length: 150 }, (_, index) => ({ id: `call-${index}`, name: 'lookup', args: { query: `Lookup ${index}` } }))
      await putMessages(database, thread.id, [
        { id: 'request', value: { kind: 'assistant', content: '', calls, context: { runId: run.id } } },
        ...calls.map((call): ExecutionMessageInput => ({ id: `result-${call.id}`, value: { kind: 'tool', resultFor: call.id, content: 'Large result'.repeat(1000), context: { runId: run.id } } })),
        { id: 'answer', value: { kind: 'assistant', content: 'Following reply', context: { runId: run.id } } }
      ], run.id)
      h.sql(raw => raw.prepare("UPDATE execution_message_bodies SET value=? WHERE message_id LIKE 'result-%'").run(Buffer.from('Unreadable tool result')))
      const input = { threadId: thread.id, runId: run.id, requestId: 'test' }
      const signal = new AbortController().signal, source = database.activityDirectory
      const outline = await source.read(input, signal)
      expect(outline.items).toHaveLength(2)
      const group = outline.items[0]
      expect(group).toMatchObject({ type: 'process', hasTools: true })
      expect(outline.items[1]).toMatchObject({ type: 'reply', model: { messageId: 'answer' } })
      const first = await source.read({ ...input, parentId: group.key }, signal)
      expect(first.items).toHaveLength(151)
      expect(first.items[1]).toMatchObject({ type: 'entry', key: 'model-tool:root:message:request:0', item: { tool: { call: { args: { summary: 'Lookup 0' } } } } })
      expect(JSON.stringify(first)).not.toContain('Large result')
      expect(() => database.messages.activities.getDisplayDetail({ ...input, kind: 'tool', id: calls[0].id })).toThrow()
    } finally { h.close() }
  })

  it('yields long scans to cancellation without returning a truncated group', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread(), run = await createRun(database, thread.id, 'cancel-run')
      for (let index = 0; index < 300; index++) database.messages.observations.recordTool(run.id, { id: `call-${index}`, name: 'lookup', args: {} }, 'running')
      const controller = new AbortController()
      const outline = await database.activityDirectory.read({ threadId: thread.id, runId: run.id, requestId: 'outline' }, controller.signal)
      const promise = database.activityDirectory.read({ threadId: thread.id, runId: run.id, requestId: 'test', parentId: outline.items[0].key }, controller.signal)
      setImmediate(() => controller.abort())
      await expect(promise).rejects.toThrow(/abort/i)
    } finally { h.close() }
  })

  it('reads 10000 display headers without decoding bodies and yields to cancellation', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread(), run = await createRun(database, thread.id, 'scan-run')
      // Build an isolated read fixture directly, avoiding execution of artificial
      // model/tool rounds. Invalid bodies prove reads use only display headers.
      h.sql(raw => displayTransaction(raw, () => {
        const body = raw.prepare('INSERT INTO execution_message_bodies(thread_id,record_id,message_id,value) VALUES (?,?,?,?)')
        const payload = raw.prepare('INSERT INTO agent_message_payloads(thread_id,message_id,run_id,record_id) VALUES (?,?,?,?)')
        const model = raw.prepare("INSERT INTO agent_model_activities(run_id,model_id,sequence,status) VALUES (?,?,?,'completed')")
        const message = raw.prepare('INSERT INTO agent_model_messages(run_id,model_id,message_id) VALUES (?,?,?)')
        const timing = raw.prepare('INSERT INTO agent_activity_timing VALUES (?,?,?,?)')
        const header = raw.prepare('INSERT INTO agent_display_headers VALUES (?,?,?)')
        for (let index = 0; index <= 10000; index++) {
          const id = randomUUID(), value = encodeConversationMessage({ kind: 'assistant',
            content: index === 10000 ? [{ type: 'text', text: 'Following reply' }] : [{ type: 'reasoning', reasoning: 'Thought '.repeat(128) }],
            source: { contentFormat: 'portable', metadata: {}, extras: {} },
            context: { runId: run.id } }), recordId = conversationMessageRecordId(id, value)
          body.run(thread.id, recordId, id, Buffer.from('Not decoded by directory reads')); payload.run(thread.id, id, run.id, recordId)
          header.run(thread.id, id, JSON.stringify({ kind: 'assistant', hasText: index === 10000, hasReasoning: index < 10000,
            reasoningSummary: 'Inspecting workspace changes. '.repeat(8).slice(0, 240), calls: [] }))
          model.run(run.id, id, index); message.run(run.id, id, id); timing.run(run.id, `model:${id}`, run.createdAt, run.createdAt)
        }
      })())
      let ticks = 0
      const heartbeat = setInterval(() => { ticks++ }, 1), started = performance.now()
      try {
        const page = await database.activityDirectory.read({ threadId: thread.id, runId: run.id, requestId: 'test' }, new AbortController().signal)
        expect(page.items).toMatchObject([{ type: 'process', hasThought: true }, { type: 'reply', model: { hasText: true } }])
        expect(page.items).toHaveLength(2)
        expect(JSON.stringify(page).length).toBeLessThan(10_000)
        const members = await database.activityDirectory.read({ threadId: thread.id, runId: run.id, requestId: 'members', parentId: page.items[0].key }, new AbortController().signal)
        expect(members.items).toHaveLength(10000)
        expect(ticks).toBeGreaterThan(1)
        process.stdout.write(`Activity scan: 10001 display headers, ${(performance.now() - started).toFixed(0)}ms, ${ticks} event-loop ticks, ${JSON.stringify(page).length} transport characters\n`)
        expect(await database.activityDirectory.read({ threadId: thread.id, runId: run.id, requestId: 'unchanged', version: page.version }, new AbortController().signal))
          .toEqual({ version: page.version, baseVersion: page.version, items: [], removed: [] })
      } finally { clearInterval(heartbeat) }
    } finally { h.close() }
  }, 20000)

  it('provides complete in-flight reasoning independently of display clients', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread()
      const run = await createRun(database, thread.id, 'stream-run')
      const observer = database.activityProjection.observer(run.id, thread.id, { push() {} })
      const modelId = observer.startModel()
      observer.model({ kind: 'delta', channel: 'reasoning', modelId, text: 'before closing' })
      observer.model({ kind: 'delta', channel: 'reasoning', modelId, text: ' and after reopening' })
      expect(database.messages.activities.getDisplayDetail({ threadId: thread.id, runId: run.id, kind: 'model', id: modelId }))
        .toMatchObject({ reasoning: 'before closing and after reopening' })
      expect(database.runs.store.load(thread.id)?.messages[0].value.content).toBe('Task')
    } finally { h.close() }
  })

  it('keeps the same tool card identity from streamed arguments through committed execution', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread(), run = await createRun(database, thread.id, 'draft-run')
      const model = { id: 'draft-model', status: 'running' as const, text: '', reasoning: '', toolCallIds: [] }
      database.messages.observations.recordModel(run.id, model)
      database.activityProjection.rememberToolCallProgress({ type: 'model_tool_calls', threadId: thread.id, runId: run.id,
        modelId: model.id, progress: [{ index: 0, name: 'lookup', characterCount: 9, complete: false }] })
      const input = { threadId: thread.id, runId: run.id, requestId: 'test' }
      const signal = new AbortController().signal
      const before = await database.activityDirectory.read(input, signal)
      const members = await database.activityDirectory.read({ ...input, parentId: before.items[0].key }, signal)
      const call = { id: 'accepted-call', name: 'lookup', args: { query: 'value' } }
      database.messages.observations.recordModel(run.id, { ...model, status: 'completed', messageId: 'request', toolCallIds: [call.id] })
      await putMessages(database, thread.id, [
        { id: 'request', value: { kind: 'assistant', content: '', calls: [call], context: { runId: run.id } } },
        { id: 'result', value: { kind: 'tool', resultFor: call.id, content: 'Done', context: { runId: run.id } } }
      ], run.id)
      const after = await database.activityDirectory.read(input, signal)
      const settled = await database.activityDirectory.read({ ...input, parentId: after.items[0].key }, signal)
      expect(after.items[0].key).toBe(before.items[0].key)
      expect(settled.items.map(item => item.key)).toEqual(members.items.map(item => item.key))
      expect(settled.items[1]).toMatchObject({ item: { tool: { status: 'completed', call: { id: call.id } } } })
    } finally { h.close() }
  })

  it('reads a child stream from its owner without retaining ancestor copies after commit', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread(), run = await createRun(database, thread.id, 'root-stream')
      const child = database.runs.createSubagentCall({ id: 'stream-child', ownerThreadId: thread.id, parentThreadId: thread.id, parentRunId: run.id,
        childThreadId: 'child-thread', childRunId: 'child-run', config: config(), description: 'Review', childThread: {} })
      const observer = database.activityProjection.observer(child.childRunId, child.childThreadId,
        { push(event) { database.subagentProjection.projectEvent(child, event) } })
      const modelId = observer.startModel()
      const input = { threadId: thread.id, runId: run.id, subagentId: child.id, requestId: 'child-stream' }, signal = new AbortController().signal
      const initial = await database.activityDirectory.read(input, signal)
      observer.model({ kind: 'delta', channel: 'reasoning', modelId, text: 'Child live reasoning' })
      const reasoning = await database.activityDirectory.read({ ...input, version: initial.version }, signal)
      expect(reasoning.items).toMatchObject([{ type: 'process', hasThought: true, active: { model: { hasReasoning: true } } }])
      observer.model({ kind: 'delta', channel: 'text', modelId, text: 'Child live reply' })
      const replying = await database.activityDirectory.read(input, signal)
      expect(replying.items).toMatchObject([{ type: 'process' }, { type: 'reply', model: { id: modelId, hasText: true } }])
      expect(database.messages.activities.getDisplayDetail({ threadId: thread.id, runId: run.id, kind: 'model', id: modelId, subagentId: child.id }))
        .toMatchObject({ reasoning: 'Child live reasoning' })
      await database.runs.enter('input', { threadId: child.childThreadId, runId: child.childRunId })
      const model = { id: modelId, messageId: 'child-answer', status: 'completed' as const, text: 'Answer', reasoning: 'Reason', toolCallIds: [] }
      database.messages.observations.recordModel(child.childRunId, model)
      database.subagentProjection.recordProjectedModelActivity(child.id, thread.id, { ...model, subagentId: child.id })
      await putMessages(database, child.childThreadId, [{ id: model.messageId, value: { kind: 'assistant', content: 'Answer', context: { runId: child.childRunId } } }], child.childRunId)
      database.messages.observations.releaseCommitted(child.childRunId)
      expect(database.messages.observations.pendingModel(child.childRunId, modelId)).toBeUndefined()
      expect(database.messages.observations.pendingModel(run.id, modelId)).toBeUndefined()
      expect(database.messages.activities.getDisplayDetail({ threadId: thread.id, runId: run.id, kind: 'model', id: modelId, subagentId: child.id })).toMatchObject({ text: 'Answer' })
      const page = await database.activityDirectory.read({ threadId: thread.id, runId: run.id, requestId: 'test', subagentId: child.id }, new AbortController().signal)
      expect(page.items).toMatchObject([{ type: 'reply', model: { messageId: 'child-answer', subagentId: child.id } }])
    } finally { h.close() }
  })

  it('propagates nested child display changes to every ancestor without revising directories for later text chunks', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread(), run = await createRun(database, thread.id, 'nested-stream')
      const parent = database.runs.createSubagentCall({ id: 'parent', ownerThreadId: thread.id, parentThreadId: thread.id, parentRunId: run.id,
        childThreadId: 'parent-thread', childRunId: 'parent-run', config: config(), description: 'Parent', childThread: {} })
      await database.runs.enter('input', { threadId: parent.childThreadId, runId: parent.childRunId })
      const child = database.runs.createSubagentCall({ id: 'leaf', parentSubagentId: parent.id, ownerThreadId: thread.id,
        parentThreadId: parent.childThreadId, parentRunId: parent.childRunId, childThreadId: 'leaf-thread', childRunId: 'leaf-run',
        config: config(), description: 'Leaf', childThread: {} })
      const observer = database.activityProjection.observer(child.childRunId, child.childThreadId, { push(event) {
        let projected: AgentRuntimeEvent | undefined = event
        for (const carrier of [child, parent]) if (projected) projected = database.subagentProjection.projectEvent(carrier, projected)
      } })
      const modelId = observer.startModel(), signal = new AbortController().signal
      const inputs = [
        { threadId: thread.id, runId: run.id, subagentId: child.id, requestId: 'root-copy' },
        { threadId: parent.childThreadId, runId: parent.childRunId, subagentId: child.id, requestId: 'parent-copy' },
        { threadId: child.childThreadId, runId: child.childRunId, requestId: 'owner' }
      ]
      for (const input of inputs) expect((await database.activityDirectory.read(input, signal)).items).toHaveLength(1)
      observer.model({ kind: 'delta', channel: 'reasoning', modelId, text: 'Nested reasoning' })
      for (const input of inputs) expect((await database.activityDirectory.read(input, signal)).items)
        .toMatchObject([{ type: 'process', hasThought: true, active: { model: { id: modelId, hasReasoning: true } } }])
      observer.model({ kind: 'delta', channel: 'text', modelId, text: 'Nested reply' })
      const replying = await Promise.all(inputs.map(input => database.activityDirectory.read(input, signal)))
      for (const update of replying) expect(update.items).toMatchObject([{ type: 'process' }, { type: 'reply', model: { id: modelId, hasText: true } }])
      observer.model({ kind: 'delta', channel: 'text', modelId, text: ' continues' })
      for (const [index, input] of inputs.entries()) expect(await database.activityDirectory.read({ ...input, version: replying[index].version }, signal))
        .toMatchObject({ version: replying[index].version, items: [], removed: [] })
      observer.model({ kind: 'tool_input', modelId, progress: [{ index: 0, name: 'read_file', characterCount: 12, complete: false }] })
      for (const input of inputs) expect((await database.activityDirectory.read(input, signal)).items)
        .toMatchObject([{ type: 'process' }, { type: 'reply' }, { type: 'process', active: { type: 'tool', progress: { characterCount: 12 } } }])
    } finally { h.close() }
  })

  it('gives every visible run its own bounded window', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread()
      const runIds: string[] = []
      for (const id of ['first-run', 'second-run']) {
        const run = await createRun(database, thread.id, id)
        runIds.push(run.id)
        await putMessages(database, thread.id, Array.from({ length: 120 }, (_, index) => ({
          id: `${id}-answer-${index}`, value: { kind: 'assistant', content: `Answer ${index}`, context: { runId: run.id } }
        })), run.id)
        database.runs.store.finish(scope(database, thread.id, run.id), 'failed', 'The provider stopped.')
      }
      const pages = database.messages.activities.getActivitiesForRuns(thread.id, runIds)
      expect(pages).toHaveLength(2)
      expect(pages.map(fullSequences)).toEqual([Array.from({ length: 100 }, (_, index) => index + 20), Array.from({ length: 100 }, (_, index) => index + 20)])
      expect(pages.map((page) => page.activityWindow)).toEqual([
        { startSequence: 20, endSequence: 119, totalCount: 120, hasEarlier: true },
        { startSequence: 20, endSequence: 119, totalCount: 120, hasEarlier: true }
      ])
    } finally { h.close() }
  })

  it('pages all activity kinds in shared sequence order without losing earlier bodies', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread()
      const run = await createRun(database, thread.id, 'long-run')
      const messages: ExecutionMessageInput[] = []
      for (let index = 0; index < 65; index += 1) {
        const call = { id: `call-${index}`, name: 'lookup', args: { index } }
        database.messages.observations.recordModel(run.id, { id: `model-${index}`, messageId: `model-message-${index}`, status: 'completed', text: '', reasoning: '', toolCallIds: [call.id] })
        database.messages.observations.recordTool(run.id, call, 'completed')
        database.summaries.recordContextSummaryStarted(run.id, `summary-${index}`)
        database.summaries.stageContextSummary(run.id, `summary-${index}`, { summaryText: `summary body-${index}` })
        const child = database.runs.createSubagentCall({ id: `subagent-${index}`, ownerThreadId: thread.id, parentThreadId: thread.id, parentRunId: run.id,
          childThreadId: `child-${index}`, childRunId: `child-run-${index}`, config: config(), description: 'Review', childThread: {} })
        database.runs.subagents.finish({ subagentId: child.id, ownerThreadId: thread.id, status: 'completed', result: 'Done' })
        messages.push({ id: `model-message-${index}`, value: { kind: 'assistant', content: `model body-${index}`, calls: [call], context: { runId: run.id } } })
        messages.push({ id: `tool-message-${index}`, value: { kind: 'tool', resultFor: call.id, content: `tool body-${index}`, context: { runId: run.id } } })
      }
      await putMessages(database, thread.id, messages, run.id)
      const reader = database.messages.activities
      let page = reader.getActivitiesForRuns(thread.id, [run.id])[0]
      expect(fullSequences(page)).toHaveLength(100)
      expect(page.activityWindow).toMatchObject({ totalCount: 260, hasEarlier: true })
      expect(page.models[0].text).toBe('model body-40')
      expect(page.models[0].round).toBe(41)
      const all = [page]
      while (page.activityWindow!.hasEarlier) {
        const before = page.activityWindow!.startSequence!
        page = reader.getRunActivityWindow(run.id, { beforeSequence: before })
        expect(fullSequences(page).every((sequence) => sequence < before)).toBe(true)
        all.push(page)
      }
      expect(all.map((entry) => fullSequences(entry).length)).toEqual([100, 100, 60])
      expect(all.flatMap(fullSequences).sort((a, b) => a - b)).toEqual(Array.from({ length: 260 }, (_, index) => index))
      expect(all.at(-1)!.models[0].text).toBe('model body-0')
      expect(all.at(-1)!.models[0].round).toBe(1)
      expect(all.at(-1)!.tools[0].output).toBe('tool body-0')
      expect(all.at(-1)!.summaries![0].summaryText).toBe('summary body-0')
      expect(reader.getModelActivity(run.id, 'model-0')?.text).toBe('model body-0')
      expect(reader.getToolActivity(run.id, 'call-0')).toMatchObject({ call: { args: { index: 0 } }, output: 'tool body-0' })
      expect(reader.getRunActivityWindow(run.id, { beforeSequence: 0 }).activityWindow).toEqual({ startSequence: null, endSequence: null, totalCount: 260, hasEarlier: false })
      expect(() => reader.getRunActivityWindow(run.id, { beforeSequence: -1 })).toThrow()
      expect(() => reader.getRunActivityWindow(run.id, { beforeSequence: 1.5 })).toThrow()
    } finally { h.close() }
  })

  it('does not decode an older message body until its SQL window is requested', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread()
      const run = await createRun(database, thread.id, 'body-window')
      const messages: ExecutionMessageInput[] = Array.from({ length: 130 }, (_, index) => ({ id: `answer-${index}`, value: { kind: 'assistant', content: `answer body-${index}`, context: { runId: run.id } } }))
      await putMessages(database, thread.id, messages, run.id)
      const reader = database.messages.activities
      h.sql(raw => raw.prepare('UPDATE execution_message_bodies SET value=? WHERE message_id=?').run(Buffer.from('not valid message JSON'), 'answer-0'))
      const latest = reader.getRunActivityWindow(run.id)
      expect(latest.models).toHaveLength(100)
      expect(latest.models[0].text).toBe('answer body-30')
      expect(latest.models[0].round).toBe(31)
      const page = database.readActivityWindow(thread.id, run.id, Number.MAX_SAFE_INTEGER)
      expect(page.models).toEqual(latest.models)
      expect(() => database.readActivityWindow(thread.id, run.id, latest.activityWindow!.startSequence!)).toThrow()
      expect(() => reader.getRunActivityWindow(run.id, { beforeSequence: latest.activityWindow!.startSequence! })).toThrow()
    } finally { h.close() }
  })

  it('keeps model rounds stable across windows, precise reads, and live updates for each agent', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread()
      const run = await createRun(database, thread.id, 'rounds-run')
      database.runs.createSubagentCall({ id: 'child', ownerThreadId: thread.id, parentThreadId: thread.id, parentRunId: run.id,
        childThreadId: 'child-thread', childRunId: 'child-run', config: config(), description: 'Review', childThread: {} })
      for (let index = 0; index < 110; index += 1) {
        for (const subagentId of [undefined, 'child']) {
          const model = database.messages.observations.recordModel(run.id, { id: `${subagentId ?? 'root'}-${index}`, subagentId, status: 'running', text: '', reasoning: '', toolCallIds: [] })
          expect(model.round).toBe(index + 1)
        }
      }
      const latest = database.messages.activities.getRunActivityWindow(run.id)
      for (const subagentId of [undefined, 'child']) {
        const models = latest.models.filter((model) => model.subagentId === subagentId)
        expect(models.map((model) => model.round)).toEqual(Array.from({ length: 50 }, (_, index) => index + 61))
        expect(database.messages.activities.getModelActivity(run.id, `${subagentId ?? 'root'}-0`)?.round).toBe(1)
        const updated = database.messages.observations.recordModel(run.id, { id: `${subagentId ?? 'root'}-109`, subagentId, status: 'completed', text: 'Completed', reasoning: '', toolCallIds: [], round: 1 })
        expect(updated.round).toBe(110)
        expect(database.messages.activities.getModelActivity(run.id, updated.id)?.round).toBe(110)
        const appended = database.messages.observations.recordModel(run.id, { id: `${subagentId ?? 'root'}-110`, subagentId, status: 'running', text: '', reasoning: '', toolCallIds: [] })
        expect(appended.round).toBe(111)
      }
      const earlier = database.messages.activities.getRunActivityWindow(run.id, { beforeSequence: latest.activityWindow!.startSequence! })
      for (const subagentId of [undefined, 'child']) {
        expect(earlier.models.filter((model) => model.subagentId === subagentId).map((model) => model.round)).toEqual(Array.from({ length: 50 }, (_, index) => index + 11))
      }
      expect(database.messages.activities.getRunActivityWindow(run.id).models.find((model) => model.id === 'root-109')?.round).toBe(110)
      database.runs.store.finish(scope(database, thread.id, run.id), 'failed', 'Stopped.')
      const nextRun = await createRun(database, thread.id, 'next-rounds-run')
      expect(database.messages.observations.recordModel(nextRun.id, { id: 'new-root', status: 'running', text: '', reasoning: '', toolCallIds: [] }).round).toBe(1)
    } finally { h.close() }
  })

  it('keeps active children and the visible parent chain as deferred headers without loading old results', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread()
      const run = await createRun(database, thread.id, 'subagent-window')
      const parent = database.runs.createSubagentCall({
        id: 'parent', ownerThreadId: thread.id, parentThreadId: thread.id, parentRunId: run.id,
        childThreadId: 'parent-thread', childRunId: 'parent-run', config: config(), description: 'Review parent.', childThread: { title: 'Parent', projectId: thread.projectId }
      })
      const child = database.runs.createSubagentCall({
        id: 'child', ownerThreadId: thread.id, parentThreadId: parent.childThreadId, parentRunId: parent.childRunId,
        parentSubagentId: parent.id, childThreadId: 'child-thread', childRunId: 'child-run', config: config(), description: 'Review child.', childThread: { title: 'Child', projectId: thread.projectId }
      })
      database.runs.subagents.finish({ subagentId: parent.id, ownerThreadId: thread.id, status: 'completed', result: 'large result '.repeat(10000) })
      const input = { threadId: thread.id, runId: run.id, requestId: 'test' }
      const signal = new AbortController().signal
      expect((await database.activityDirectory.read(input, signal)).items).toMatchObject([{ type: 'entry', item: { subagent: { id: parent.id } } }])
      expect((await database.activityDirectory.read({ ...input, subagentId: parent.id }, signal)).items).toMatchObject([{ type: 'entry', item: { subagent: { id: child.id } } }])
      expect((await database.activityDirectory.read({ ...input, subagentId: child.id }, signal)).items).toEqual([])
      await expect(database.activityDirectory.read({ ...input, subagentId: 'unknown' }, signal)).rejects.toThrow('another run')
      for (let index = 0; index < 110; index += 1) database.summaries.recordContextSummaryStarted(run.id, `summary-${index}`)
      const latest = database.messages.activities.getRunActivityWindow(run.id)
      expect(fullSequences(latest)).toHaveLength(100)
      expect(latest.subagents).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: parent.id, status: 'completed', detailsDeferred: true }),
        expect.objectContaining({ id: child.id, parentSubagentId: parent.id, status: 'running', detailsDeferred: true })
      ]))
      expect(latest.subagents.every((entry) => entry.result === undefined)).toBe(true)
      expect(database.messages.activities.getSubagentActivity(run.id, parent.id)).toMatchObject({ result: 'large result '.repeat(10000) })
      const earlier = database.messages.activities.getRunActivityWindow(run.id, { beforeSequence: latest.activityWindow!.startSequence! })
      expect(earlier.subagents.find((entry) => entry.id === parent.id)).toMatchObject({ result: 'large result '.repeat(10000) })
      expect(earlier.subagents.find((entry) => entry.id === parent.id)?.detailsDeferred).toBeUndefined()
    } finally { h.close() }
  })
})
