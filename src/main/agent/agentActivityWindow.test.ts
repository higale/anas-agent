import Database from 'better-sqlite3'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecutionMessageInput, ExecutionToolCall } from '../../runtime/executionState'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { defaultCapabilities } from '@shared/agentCapabilities'
import type { AgentRunActivity } from '@shared/agentTypes'
import type { SubagentConfig } from '@shared/types'
import { describe, expect, it } from 'vitest'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-activity-window-')), memory = new Database(':memory:')
  const file = join(root, 'conversation.sqlite'), database = NativeConversationDatabase.open(file, {
    attachmentRoot: join(root, 'attachments'), memoryStore: new SqliteMemoryStore(memory), fileEditStore: new FileEditStore(join(root, 'file_edits')) })
  return { database,
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
  it('reads both directions in bounded pages and keeps evicted bodies available from the database', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread()
      const run = await createRun(database, thread.id, 'paged-run')
      for (let index = 0; index < 750; index++) database.messages.observations.recordMemoryRecall(run.id,
        { id: `recall-${index}`, query: 'query', promptText: `BODY_${index}`, memoryCount: 1 })
      const source = database.messages.activities
      const latest = source.getDisplayPage({ threadId: thread.id, runId: run.id })
      const first = source.getDisplayPage({ threadId: thread.id, runId: run.id, after: -1 })
      expect(first.activityWindow).toMatchObject({ startSequence: 0, endSequence: 299, hasEarlier: false, hasLater: true })
      expect(first.memoryRecalls?.[0].id).toBe('recall-0')
      expect(latest.activityWindow).toMatchObject({ hasEarlier: true, hasLater: false })
      const lastFullPage = source.getDisplayPage({ threadId: thread.id, runId: run.id, after: 649, limit: 100 })
      expect(lastFullPage.activityWindow).toMatchObject({ startSequence: 650, endSequence: 749, hasLater: false })
      expect(latest.memoryRecalls).toHaveLength(300)
      expect(latest.activityWindow).toMatchObject({ startSequence: 450, endSequence: 749, totalCount: 750 })
      const earlier = source.getDisplayPage({ threadId: thread.id, runId: run.id, before: 450, limit: 100 })
      expect(earlier.activityWindow).toMatchObject({ startSequence: 350, endSequence: 449 })
      const later = source.getDisplayPage({ threadId: thread.id, runId: run.id, after: 449, limit: 100 })
      expect(later.memoryRecalls?.map(item => item.id)).toEqual(latest.memoryRecalls!.slice(0, 100).map(item => item.id))
      expect(source.getDisplayDetail({ threadId: thread.id, runId: run.id, kind: 'memory', id: 'recall-0' })).toEqual({ text: 'BODY_0' })
      expect(() => source.getDisplayPage({ threadId: 'other', runId: run.id })).toThrow('another conversation')
      expect(() => source.getDisplayDetail({ threadId: 'other', runId: run.id, kind: 'memory', id: 'recall-0' })).toThrow('another conversation')
    } finally { h.close() }
  })

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

  it('reads a child stream from its owner without retaining ancestor copies after commit', async () => {
    const h = fixture(), { database } = h
    try {
      const thread = database.createThread(), run = await createRun(database, thread.id, 'root-stream')
      const child = database.runs.createSubagentCall({ id: 'stream-child', ownerThreadId: thread.id, parentThreadId: thread.id, parentRunId: run.id,
        childThreadId: 'child-thread', childRunId: 'child-run', config: config(), description: 'Review', childThread: {} })
      const observer = database.activityProjection.observer(child.childRunId, child.childThreadId,
        { push(event) { database.subagentProjection.projectEvent(child, event) } })
      const modelId = observer.startModel()
      observer.model({ kind: 'delta', channel: 'reasoning', modelId, text: 'Child live reasoning' })
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
        for (let index = 0; index < 120; index += 1) database.messages.observations.recordMemoryRecall(run.id, { id: `recall-${index}`, query: 'query', promptText: `${id}-${index}`, memoryCount: 1 })
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
        database.messages.observations.recordMemoryRecall(run.id, { id: `recall-${index}`, query: `query-${index}`, promptText: `memory-${index}`, memoryCount: 1 })
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
      expect(page.activityWindow).toMatchObject({ totalCount: 325, hasEarlier: true })
      expect(page.models[0].text).toBe('model body-45')
      expect(page.models[0].round).toBe(46)
      const all = [page]
      while (page.activityWindow!.hasEarlier) {
        const before = page.activityWindow!.startSequence!
        page = reader.getRunActivityWindow(run.id, { beforeSequence: before })
        expect(fullSequences(page).every((sequence) => sequence < before)).toBe(true)
        all.push(page)
      }
      expect(all.map((entry) => fullSequences(entry).length)).toEqual([100, 100, 100, 25])
      expect(all.flatMap(fullSequences).sort((a, b) => a - b)).toEqual(Array.from({ length: 325 }, (_, index) => index))
      expect(all.at(-1)!.models[0].text).toBe('model body-0')
      expect(all.at(-1)!.models[0].round).toBe(1)
      expect(all.at(-1)!.tools[0].output).toBe('tool body-0')
      expect(all.at(-1)!.summaries![0].summaryText).toBe('summary body-0')
      expect(all.at(-1)!.memoryRecalls![0].promptText).toBe('memory-0')
      expect(reader.getModelActivity(run.id, 'model-0')?.text).toBe('model body-0')
      expect(reader.getToolActivity(run.id, 'call-0')).toMatchObject({ call: { args: { index: 0 } }, output: 'tool body-0' })
      expect(reader.getRunActivityWindow(run.id, { beforeSequence: 0 }).activityWindow).toEqual({ startSequence: null, endSequence: null, totalCount: 325, hasEarlier: false })
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
      for (let index = 0; index < 110; index += 1) database.messages.observations.recordMemoryRecall(run.id, { id: `recall-${index}`, query: 'query', promptText: 'memory', memoryCount: 1 })
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
