import Database from 'better-sqlite3'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { NativeConversationDatabase } from './nativeConversationDatabase'
import { NativeAgentRuntime } from './nativeAgentRuntime'
import * as projectStore from '../projectStore'
import { SqliteMemoryStore } from './memoryStore'
import { FileEditStore } from '../fileEditStore'
import { archiveAgentAttachments } from './agentAttachmentStore'
import { authorizationInputHash } from '../../runtime/authorizationReceipts'
import type { ExecutionToolCall } from '../../runtime/executionState'
import type { AgentRuntimeEvent } from '../../shared/agentTypes'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import * as workspacePath from '../workspacePath'

describe('native product snapshot', () => {
  it('keeps recalled memory and discarded compression visible consistently across reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-context-events-')), file = join(root, 'conversation.sqlite')
    const global = new Database(':memory:'), options = { attachmentRoot: join(root, 'attachments'),
      memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) }
    let database = NativeConversationDatabase.open(file, options)
    try {
      const events: AgentRuntimeEvent[] = [], identity = { threadId: 'thread', runId: 'run' }
      database.runs.createThreadAndRun({ ...identity, thread: {}, submissionId: 'submission',
        message: { id: 'run:input', value: { id: 'run:input', kind: 'user', content: 'Task', context: { runId: 'run' } } } })
      await database.runs.enter('input', identity)
      const callbacks = database.activityProjection.contextCallbacks('run', 'thread', { push: event => events.push(event) })
      const details = { query: 'Workspace preference', promptText: 'Use LF line endings', memoryCount: 1 }
      callbacks.onMemoryRecall(details); callbacks.onMemoryRecall(details)
      const summaryId = callbacks.onCompressionStart!()
      callbacks.onCompressionCompleted!(summaryId, 'Uncommitted summary', { modelContent: 'Uncommitted summary', cutoffIndex: 0,
        activatedAfterMessageIndex: 0, inputTokensBefore: 20, inputTokensAfter: 5 })
      database.activityProjection.publishCommittedContextSummary('run', 'thread', { id: summaryId, modelContent: 'Uncommitted summary', cutoffIndex: 0 }, { push: event => events.push(event) })
      expect(events.filter(event => event.type === 'context_compression_completed')).toEqual([])
      callbacks.onCompressionFailed!(summaryId)
      expect(events.at(-1)).toMatchObject({ type: 'context_compression_discarded', summaryId })
      const snapshot = database.readSnapshot('thread')
      expect(snapshot.activities[0].memoryRecalls).toMatchObject([details])
      expect(snapshot.activities[0].summaries ?? []).toEqual([])
      expect(() => callbacks.onMemoryRecall({ ...details, memoryCount: 0 })).toThrow('positive integer')
      database.close(); database = NativeConversationDatabase.open(file, options)
      expect(database.readSnapshot('thread')).toEqual(snapshot)
    } finally { database.close(); global.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it('projects live progress and approval events without making observations execution evidence', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-events-')), file = join(root, 'conversation.sqlite')
    const global = new Database(':memory:'), options = { attachmentRoot: join(root, 'attachments'),
      memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) }
    let database = NativeConversationDatabase.open(file, options)
    try {
      const identity = { threadId: 'thread', runId: 'run' }, events: AgentRuntimeEvent[] = []
      database.runs.createThreadAndRun({ ...identity, thread: {}, submissionId: 'submission',
        message: { id: 'run:input', value: { id: 'run:input', kind: 'user', content: 'Task', context: { runId: 'run' } } } })
      await database.runs.enter('input', identity)
      const observer = database.activityProjection.observer('run', 'thread', { push: event => events.push(event) })
      const modelId = observer.startModel(), initialRevision = database.runs.store.load('thread')!.revisionId
      const progress = [{ index: 0, name: 'read_file', characterCount: 12, complete: false }]
      observer.model({ kind: 'tool_input', modelId, progress })
      expect(database.readSnapshot('thread', { executingRunId: 'run' }).activities[0].models[0].toolCallProgress).toEqual(progress)
      expect(database.runs.store.load('thread')!.revisionId).toBe(initialRevision)
      const call: ExecutionToolCall & { args: Record<string, unknown> } = { id: 'call', providerCallId: 'provider', name: 'read_file', args: { path: 'notes.txt' },
        artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `call:${purpose}`])) as ExecutionToolCall['artifacts'] }
      const observedCall = { id: call.id, name: call.name, args: call.args }
      observer.model({ kind: 'completed', modelId, message: { id: 'model', role: 'assistant', content: [{ type: 'reasoning', text: 'Reasoning', summary: 'Short summary' }, { type: 'text', text: 'Observed' }] },
        calls: [observedCall], streamedText: '', streamedReasoning: '', usage: undefined, responseMetadata: undefined })
      const scope = () => ({ ...identity, expectedRevisionId: database.runs.store.load('thread')!.revisionId })
      database.runs.store.acceptModel(scope(), { id: 'model', value: { kind: 'assistant', content: [{ type: 'reasoning', reasoning: 'Reasoning', summary: [{ type: 'summary_text', text: 'Short summary' }] }, { type: 'text', text: 'Saved' }], context: { runId: 'run' },
        calls: [{ id: 'provider', name: call.name, args: call.args }] } }, [call], { modelCalls: 1, todos: [] })
      database.runs.store.prepareTools(scope(), [{ callId: call.id, args: call.args, authorization: { approval: 'pending' } }], [
        { id: 'approval', generation: 'generation', kind: 'tool', callIds: [call.id], request: {
          actionRequests: [{ name: call.name, args: call.args, description: 'Confirm' }],
          reviewConfigs: [{ actionName: call.name, allowedDecisions: ['approve', 'reject'] }] } }
      ])
      observer.approval({ call: observedCall, approval: { status: 'pending_approval', interruptId: 'approval', actionIndex: 0 } })
      expect(database.readSnapshot('thread', { executingRunId: 'run' }).activities[0].tools[0].approval?.interruptId).toBe('approval')
      // A rejected call has a durable result without a tool-dispatch observation.
      database.runs.store.resolveWait(scope(), { approval: 'generation' }, () => {
        database.runs.store.settleCall(identity, call.id, { id: 'result', value: { kind: 'tool', resultFor: 'provider', content: 'Rejected', context: { runId: 'run' } } })
      })
      database.runs.store.finishBatch(scope(), [])
      const commit = { commitId: scope().expectedRevisionId, messageIds: ['model', 'result'] }
      await observer.committed(commit); await observer.committed(commit)
      observer.tool({ kind: 'settled', call: observedCall, succeeded: false, output: 'Late transport copy of rejection' })
      expect(events.filter(event => event.type === 'tool_completed')).toMatchObject([{ call: { id: call.id }, output: 'Rejected' }])
      expect(events.map(event => event.type)).toEqual(['model_started', 'model_tool_calls', 'model_completed', 'tool_started', 'tool_approval_requested', 'tool_completed'])
      database.activityProjection.releaseRun('run')
      const snapshot = database.readSnapshot('thread', { executingRunId: 'run' })
      expect(snapshot.activities[0].models[0].text).toBe('Saved')
      expect(snapshot.activities[0].models[0]).toMatchObject({ reasoning: 'Reasoning', reasoningSummary: 'Short summary' })
      expect(events.find(event => event.type === 'model_completed')).toMatchObject({ model: { reasoningSummary: 'Short summary' } })
      expect(snapshot.activities[0].models[0].toolCallProgress).toBeUndefined()
      expect(snapshot.activities[0].tools[0].output).toBe('Rejected')
      expect(snapshot.activities[0].tools[0].approval).toBeUndefined()
      database.close(); database = NativeConversationDatabase.open(file, options)
      expect(database.readSnapshot('thread', { executingRunId: 'run' })).toEqual(snapshot)
      expect(database.readActivityWindow('thread', 'run', 100, { executingRunId: 'run' }).models[0].reasoningSummary).toBe('Short summary')
    } finally { database.close(); global.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it.each(['write_file', 'read_file'] as const)('projects %s paths from the correct source and discards previews overtaken by a saved answer', async name => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'anas-native-preview-'))), global = new Database(':memory:')
    const database = NativeConversationDatabase.open(join(root, 'conversation.sqlite'), { attachmentRoot: join(root, 'attachments'),
      memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) })
    const original = workspacePath.resolveCanonicalWorkspacePath, resolvePath = vi.spyOn(workspacePath, 'resolveCanonicalWorkspacePath')
    try {
      writeFileSync(join(root, 'notes.txt'), 'Fixture')
      const identity = { threadId: 'thread', runId: 'run' }
      database.runs.createThreadAndRun({ ...identity, thread: {}, submissionId: 'submission',
        message: { id: 'run:input', value: { id: 'run:input', kind: 'user', content: 'Task', context: { runId: 'run' } } } })
      await database.runs.enter('input', identity)
      const scope = () => ({ ...identity, expectedRevisionId: database.runs.store.load('thread')!.revisionId })
      const args = name === 'write_file' ? { path: 'notes.txt', content: 'New content' } : { path: 'notes.txt' }
      const call: ExecutionToolCall = { id: 'call', providerCallId: 'provider', name, args,
        artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `call:${purpose}`])) as ExecutionToolCall['artifacts'] }
      database.runs.store.acceptModel(scope(), { id: 'model', value: { kind: 'assistant', content: '', calls: [{ id: 'provider', name, args }] } }, [call], { modelCalls: 1, todos: [] })
      const preparedTarget = join(root, 'prepared-target.txt')
      database.runs.store.prepareTools(scope(), [{ callId: call.id, args, authorization: { approval: 'pending',
        ...(name === 'write_file' ? { patch: { id: call.id, name, inputHash: authorizationInputHash(args), requiresApproval: true, humanApproved: false,
          targets: [{ path: preparedTarget, lexicalPath: preparedTarget, locator: ['operations', 0, 'path'], kind: 'file' as const, access: 'write' as const }] } } : {}) } }], [
        { id: 'approval', generation: 'generation', kind: 'tool', callIds: [call.id], request: {
          actionRequests: [{ name, args, description: 'Confirm' }], reviewConfigs: [{ actionName: name, allowedDecisions: ['approve', 'reject'] }] } }
      ])
      const snapshot = await database.readSnapshotWithPreviews('thread', root)
      expect(snapshot.interrupts[0]).toMatchObject({ value: { actionRequests: [{ name, args }] } })
      expect(database.runs.store.load('thread')?.calls[0].args).toEqual(args)
      expect(snapshot.interrupts[0].pathPreviews).toEqual([{ actionIndex: 0, locator: ['path'], source: 'relative',
        absolutePath: name === 'write_file' ? preparedTarget : join(root, 'notes.txt') }])
      if (name === 'write_file') expect(resolvePath).not.toHaveBeenCalled()
      else {
        let release!: () => void, entered!: () => void
        const gate = new Promise<void>(resolve => { release = resolve }), started = new Promise<void>(resolve => { entered = resolve })
        resolvePath.mockImplementationOnce(async (...args) => { entered(); await gate; return original(...args) })
        const pending = database.readSnapshotWithPreviews('thread', root)
        await started
        database.runs.saveAnswers(scope(), [{ id: 'approval', generation: 'generation', response: { decisions: [{ type: 'approve' }] } }])
        release()
        expect((await pending).interrupts).toEqual([])
        expect(database.runs.store.load('thread')!.phase).toBe('waiting')
      }
      database.validate()
    } finally { resolvePath.mockRestore(); database.close(); global.close(); rmSync(root, { recursive: true, force: true }) }
  })

  it('uses the existing visible-message window, attachments, todos, activities and explicit settling state across reopen', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anas-native-snapshot-')), file = join(root, 'conversation.sqlite'), attachmentRoot = join(root, 'attachments')
    const global = new Database(':memory:'), options = { attachmentRoot, memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) }
    let database = NativeConversationDatabase.open(file, options)
    let runtime: NativeAgentRuntime | undefined
    const project = vi.spyOn(projectStore, 'getProject').mockRejectedValue(new Error('Offline project settings'))
    try {
      database.runs.createThread({ title: 'Long conversation' }, 'thread')
      expect(database.readSnapshot('thread')).toMatchObject({ messages: [], todos: [], interrupts: [], activities: [], messageWindow: { total: 0, startIndex: 0 } })
      const source = join(root, 'notes.txt'); writeFileSync(source, 'Archived note')
      const attachments = await archiveAgentAttachments([{ path: source, name: 'notes.txt', kind: 'text', mimeType: 'text/plain', size: 13, contextPolicy: 'conversation' }],
        { threadId: 'thread', runId: 'run-111', messageId: 'run-111:input' }, attachmentRoot)
      for (let index = 0; index < 112; index++) {
        const identity = { threadId: 'thread', runId: `run-${index}` }
        database.runs.createRun({ ...identity, operation: 'agent', attachments: index === 111 ? attachments : [],
          message: { id: `${identity.runId}:input`, value: { id: `${identity.runId}:input`, kind: 'user', content: `Question ${index}`, context: { runId: identity.runId } } } })
        expect(database.readSnapshot('thread').pendingRun?.id).toBe(identity.runId)
        await database.runs.enter('input', identity)
        const scope = () => ({ ...identity, expectedRevisionId: database.runs.store.load('thread')!.revisionId })
        if (index === 74) {
          const summary = { id: 'summary-74', summaryText: 'Earlier decisions', modelContent: 'Earlier decisions', cutoffIndex: 140,
            activatedAfterMessageIndex: 148, coveredThroughMessageId: 'run-69:answer', firstPreservedMessageId: 'run-70:input', inputTokensBefore: 500, inputTokensAfter: 100 }
          database.summaries.recordContextSummaryStarted(identity.runId, summary.id)
          database.summaries.stageContextSummary(identity.runId, summary.id, summary)
          database.runs.store.commitSummary(scope(), summary)
        }
        database.runs.store.acceptModel(scope(), { id: `${identity.runId}:answer`, value: { kind: 'assistant', content: `Answer ${index}` } }, [], {
          ...database.runs.store.load('thread')!.context, modelCalls: 1, todos: [{ content: 'Keep the plan visible', status: 'completed' }]
        })
        database.runs.store.finish(scope(), 'completed')
      }
      const page = database.readSnapshot('thread')
      expect(page.messageWindow).toEqual({ startIndex: 124, shown: 100, total: 224, remaining: 124 })
      expect(page.messages[0].id).toBe('run-62:input')
      expect(page.messages.at(-2)!.attachments).toMatchObject([{ id: attachments[0].artifact.id, available: true }])
      expect(page.todos).toEqual([{ content: 'Keep the plan visible', status: 'completed' }])
      expect(page.activities.every(activity => activity.runId !== 'run-0' && activity.runId !== 'run-1')).toBe(true)
      expect(page.pendingRun).toBeUndefined()
      expect(page.settlingRun).toBeUndefined()
      expect(database.readSnapshot('thread', { settlingRunId: 'run-111' }).settlingRun?.id).toBe('run-111')
      expect(database.readSnapshot('thread', { settlingRunId: 'run-110' }).settlingRun).toBeUndefined()
      database.close(); database = NativeConversationDatabase.open(file, options)
      expect(database.readSnapshot('thread')).toEqual(page)
      const full = database.readSnapshot('thread', { startIndex: 0 })
      expect(full.messageWindow).toEqual({ startIndex: 0, shown: 224, total: 224, remaining: 0 })
      expect(full.messages[0].id).toBe('run-0:input')
      expect(database.readSnapshot('thread', { startIndex: 999 }).messageWindow).toEqual({ startIndex: 224, shown: 0, total: 224, remaining: 224 })
      expect(() => database.readSnapshot('thread', { startIndex: -1 })).toThrow('cursor is invalid')
      runtime = new NativeAgentRuntime(database, root, { push: () => {} })
      expect((await runtime.getSnapshot('thread')).messages).toEqual(page.messages)
      const earlier = await runtime.loadEarlierMessages({ threadId: 'thread', beforeIndex: 124 })
      expect(earlier.messageWindow).toEqual({ startIndex: 24, shown: 200, total: 224, remaining: 24 })
      expect(earlier.activities.find(activity => activity.runId === 'run-74')?.summaries).toMatchObject([
        { coveredThroughMessageId: 'run-69:answer', firstPreservedMessageId: 'run-70:input' }
      ])
      expect((await runtime.loadEarlierMessages({ threadId: 'thread', beforeIndex: 24 })).messages).toEqual(full.messages)
      expect(() => runtime!.loadEarlierMessages({ threadId: 'thread', beforeIndex: -1 })).toThrow('cursor is invalid')
      expect(runtime.loadEarlierActivities({ threadId: 'thread', runId: 'run-0', beforeSequence: Number.MAX_SAFE_INTEGER })).toMatchObject({ runId: 'run-0' })
      expect(() => runtime!.loadEarlierActivities({ threadId: 'other', runId: 'run-0', beforeSequence: 1 })).toThrow('was not found in thread')
      expect(() => runtime!.loadEarlierActivities({ threadId: 'thread', runId: 'run-0', beforeSequence: -1 })).toThrow('cursor is invalid')
      expect(project).not.toHaveBeenCalled()
    } finally { await runtime?.shutdown(); project.mockRestore(); database.close(); global.close(); rmSync(root, { recursive: true, force: true }) }
  }, 20_000)
})

it.each(['same-run', 'new-run'] as const)('reads one coherent native snapshot while another connection commits %s progress at the same timestamp', async change => {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-snapshot-transaction-')), file = join(root, 'conversation.sqlite'), global = new Database(':memory:')
  const options = { attachmentRoot: join(root, 'attachments'), memoryStore: new SqliteMemoryStore(global), fileEditStore: new FileEditStore(join(root, 'file_edits')) }
  const reader = NativeConversationDatabase.open(file, options), writer = NativeConversationDatabase.open(file, options)
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
  const owner = { threadId: 'thread', runId: 'first' }
  const message = (runId: string) => ({ id: `${runId}:input`, value: { id: `${runId}:input`, kind: 'user' as const, content: runId, context: { runId } } })
  let entering: Promise<void> | undefined
  try {
    reader.runs.createThreadAndRun({ ...owner, thread: {}, submissionId: 'first-submission', message: message(owner.runId) })
    await reader.runs.enter('input', owner)
    const scope = () => ({ ...owner, expectedRevisionId: writer.runs.store.load(owner.threadId)!.revisionId })
    if (change === 'new-run') writer.runs.store.finish(scope(), 'completed')
    const before = reader.readSnapshot(owner.threadId), original = reader.messages.window.bind(reader.messages)
    const read = vi.spyOn(reader.messages, 'window').mockImplementationOnce((...args) => {
      if (change === 'new-run') {
        const next = { threadId: owner.threadId, runId: 'second' }
        writer.runs.createRun({ ...next, operation: 'agent', message: message(next.runId) })
        entering = writer.runs.enter('input', next)
      } else {
        writer.runs.store.acceptModel(scope(), { id: 'answer', value: { kind: 'assistant', content: 'Committed after snapshot began', context: { runId: owner.runId } } }, [], { modelCalls: 1, todos: [] })
        writer.runs.store.finish(scope(), 'completed')
      }
      return original(...args)
    })
    expect(reader.readSnapshot(owner.threadId)).toEqual(before)
    await entering; read.mockRestore()
    const after = reader.readSnapshot(owner.threadId)
    if (change === 'new-run') {
      expect(after.pendingRun).toMatchObject({ id: 'second', status: 'running' })
      expect(after.messages.map(item => item.id)).toEqual(['first:input', 'second:input'])
      expect(reader.messages.activities.getRun('second')?.createdAt).toBe(reader.messages.activities.getRun('first')?.createdAt)
    } else {
      expect(after.thread.status).toBe('idle')
      expect(after.messages.map(item => item.id)).toEqual(['first:input', 'answer'])
    }
    reader.validate(); writer.validate()
  } finally { vi.useRealTimers(); reader.close(); writer.close(); global.close(); rmSync(root, { recursive: true, force: true }) }
})
