import Database from 'better-sqlite3'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ConversationMessage } from '../../runtime/conversationMessage'
import type { ExecutionToolCall } from '../../runtime/executionState'
import { toolEffectArtifactPurposes } from '../../runtime/toolEffectIdentity'
import { defaultCapabilities } from '../../shared/agentCapabilities'
import { AgentStorage } from './agentStorage'
import { getAgentConversationDatabaseFile, getAgentAttachmentsDir } from '../config/dataDir'
import { NativeRunOwner } from './nativeRunOwner'
import { NativeMessageProjection } from './nativeMessageProjection'
import { NativeMessageReader } from './nativeMessageReader'
import { NativeHistoryOwner } from './nativeHistoryOwner'
import { archiveAgentAttachments, type ArchivedAgentAttachment } from './agentAttachmentStore'

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'anas-native-history-owner-'))
  const storage = AgentStorage.openNative(root), thread = storage.createThread({ modelConfigId: 'chosen-model' })
  const product = storage.conversationForThread(thread.id), file = getAgentConversationDatabaseFile(thread.id, root)
  let sql = new Database(file); sql.pragma('foreign_keys=ON')
  let projection = new NativeMessageProjection(sql), owner = new NativeRunOwner(sql, commit => projection.commit(commit))
  const scope = (runId: string, threadId = thread.id) => ({ threadId, runId, expectedRevisionId: owner.store.load(threadId)!.revisionId })
  return { root, product, thread, scope, get sql() { return sql }, get owner() { return owner },
    history() { return new NativeHistoryOwner(sql, owner) }, reader() { return new NativeMessageReader(sql) },
    async complete(runId: string, options: { message?: Partial<ConversationMessage>; attachments?: ArchivedAgentAttachment[]; summary?: boolean; beforeFinish?: () => Promise<void> } = {}) {
      const id = `${runId}:input`
      owner.createRun({ threadId: thread.id, runId, operation: 'agent', attachments: options.attachments,
        message: { id, value: { kind: 'user', content: runId, ...options.message, id, context: { ...options.message?.context, runId } } } })
      await owner.enter('input', { threadId: thread.id, runId })
      if (options.summary) {
        const summary = { id: `${runId}:summary`, summaryText: `${runId} shown summary`, modelContent: `${runId} model summary`,
          cutoffIndex: owner.store.load(thread.id)!.messages.length, activatedAfterMessageIndex: 0, inputTokensBefore: 20, inputTokensAfter: 10 }
        product.summaries.recordContextSummaryStarted(runId, summary.id); product.summaries.stageContextSummary(runId, summary.id, summary)
        owner.store.commitSummary(scope(runId), summary)
      }
      await options.beforeFinish?.()
      owner.store.acceptModel(scope(runId), { id: `${runId}:answer`, value: { kind: 'assistant', content: `${runId} answer` } }, [],
        { ...owner.store.load(thread.id)!.context, modelCalls: 1 })
      owner.store.finish(scope(runId), 'completed')
    },
    async attachment(runId: string) {
      const file = join(root, `${runId}.txt`); writeFileSync(file, `${runId} attachment`)
      return archiveAgentAttachments([{ path: file, name: `${runId}.txt`, mimeType: 'text/plain', kind: 'text', size: readFileSync(file).length, contextPolicy: 'conversation' }],
        { threadId: thread.id, runId, messageId: `${runId}:input` }, getAgentAttachmentsDir(thread.id, root))
    },
    reopen() { sql.close(); sql = new Database(file); sql.pragma('foreign_keys=ON'); projection = new NativeMessageProjection(sql); owner = new NativeRunOwner(sql, commit => projection.commit(commit)) },
    dispose() { sql.close(); storage.close(); rmSync(root, { recursive: true, force: true }) } }
}

describe('native product history revisions', () => {
  it('rejects conflicting history ownership without deleting any run or message', async () => {
    const h = fixture()
    try {
      await h.complete('first'); await h.complete('second')
      const revision = h.history().prepare({ threadId: h.thread.id, messageId: 'second:input', kind: 'truncate' })
      const before = h.owner.store.readHistory(h.thread.id)
      h.sql.prepare("UPDATE agent_message_index SET run_id='first' WHERE thread_id=? AND message_id='second:input'").run(h.thread.id)
      expect(() => h.history().commit(revision)).toThrow('disagree about their owning run')
      expect(h.owner.store.readHistory(h.thread.id)).toEqual(before)
      expect(h.product.readModel.getRun('first')).not.toBeNull(); expect(h.product.readModel.getRun('second')).not.toBeNull()
    } finally { h.dispose() }
  })

  it('retains uncertain file recovery without reclassifying accepted results after truncation', async () => {
    const h = fixture()
    try {
      await h.complete('first')
      const identity = { threadId: h.thread.id, runId: 'second' }
      h.owner.createRun({ ...identity, operation: 'agent', message: { id: 'second:input', value: { id: 'second:input', kind: 'user', content: 'Edit', context: { runId: 'second' } } } })
      await h.owner.enter('input', identity)
      const calls: ExecutionToolCall[] = ['accepted', 'uncertain'].map(id => ({ id, name: 'apply_patch', providerCallId: id, args: {},
        artifacts: Object.fromEntries(toolEffectArtifactPurposes.map(purpose => [purpose, `${id}:${purpose}`])) as ExecutionToolCall['artifacts'] }))
      h.owner.store.acceptModel(h.scope('second'), { id: 'second:model', value: { kind: 'assistant', content: '',
        calls: calls.map(call => ({ id: call.id, name: call.name, args: call.args })) } }, calls, { modelCalls: 1, todos: [] })
      h.owner.store.prepareTools(h.scope('second'), calls.map(call => ({ callId: call.id, args: call.args })))
      for (const call of calls) {
        const key = { ...identity, callId: call.id }
        h.owner.store.prepareEffect(key, 'confirm')
        h.owner.store.armEffect(key, { kind: 'file_patch', target: { requestId: 'second', operationId: call.id } })
      }
      const result = { id: 'accepted:result', value: { kind: 'tool' as const, resultFor: 'accepted', content: 'Accepted result' } }
      h.owner.store.saveEffectResult({ ...identity, callId: 'accepted' }, result)
      h.owner.store.settleCall(identity, 'accepted', result); h.owner.store.finish(h.scope('second'), 'cancelled')
      expect(h.product.resourceCleanup.listRetainedFileEditOperationIds('second')).toEqual(['uncertain'])
      h.history().commit(h.history().prepare({ threadId: h.thread.id, messageId: 'second:input', kind: 'truncate' })); h.reopen()
      expect(h.product.resourceCleanup.listRetainedFileEditOperationIds('second')).toEqual(['uncertain'])
      expect(h.sql.prepare("SELECT * FROM execution_effects WHERE run_id='second'").all()).toEqual([])
    } finally { h.dispose() }
  })

  it('atomically truncates later runs and attachments, restores the earlier summary and supports repeated edits to empty', async () => {
    const h = fixture()
    try {
      await h.complete('first', { summary: true })
      const archived = await h.attachment('second')
      await h.complete('second', { summary: true, attachments: archived }); await h.complete('third')
      const revision = h.history().prepare({ threadId: h.thread.id, messageId: 'second:answer', kind: 'truncate' })
      const original = h.owner.store.readHistory(h.thread.id), window = h.reader().window(h.thread.id)
      h.sql.exec("CREATE TRIGGER fail_history_cleanup BEFORE INSERT ON agent_attachment_file_cleanup_outbox BEGIN SELECT RAISE(ABORT,'cleanup failed'); END")
      expect(() => h.history().commit(revision)).toThrow('cleanup failed')
      expect(h.owner.store.readHistory(h.thread.id)).toEqual(original)
      expect(h.reader().window(h.thread.id)).toEqual(window)
      expect(h.product.readModel.getRun('second')).not.toBeNull()
      expect(h.product.resources.listAttachmentsForMessages(h.thread.id, ['second:input'])).toHaveLength(1)
      h.sql.exec('DROP TRIGGER fail_history_cleanup')
      h.sql.exec("CREATE TRIGGER fail_history_bodies BEFORE DELETE ON execution_message_bodies WHEN OLD.message_id='second:input' BEGIN SELECT RAISE(ABORT,'body cleanup failed'); END")
      expect(() => h.history().commit(revision)).toThrow('body cleanup failed')
      expect(h.owner.store.readHistory(h.thread.id)).toEqual(original)
      expect(h.reader().window(h.thread.id)).toEqual(window)
      expect(h.product.readModel.getRun('second')).not.toBeNull()
      h.sql.exec('DROP TRIGGER fail_history_bodies'); h.history().commit(revision); h.reopen()
      expect(h.owner.store.load(h.thread.id)).toBeUndefined()
      expect(h.owner.store.readHistory(h.thread.id)?.messages.map(message => message.id)).toEqual(['first:input', 'first:answer'])
      expect(h.owner.store.readHistory(h.thread.id)?.context.summary?.id).toBe('first:summary')
      expect(h.reader().window(h.thread.id).messages.map(message => message.id)).toEqual(['first:input', 'first:answer'])
      expect(h.product.readModel.getRun('first')).not.toBeNull()
      expect(h.product.readModel.getRun('second')).toBeNull(); expect(h.product.readModel.getRun('third')).toBeNull()
      expect(h.product.resourceCleanup.listAttachmentFileCleanup()).toEqual([{ id: archived[0].artifact.id, path: archived[0].artifact.path }])
      expect(readFileSync(archived[0].artifact.path, 'utf8')).toBe('second attachment')
      expect(() => h.history().commit(revision)).toThrow('history changed')
      h.history().commit(h.history().prepare({ threadId: h.thread.id, messageId: 'first:input', kind: 'truncate' })); h.reopen()
      expect(h.reader().window(h.thread.id).messages).toEqual([])
      expect(h.owner.store.readHistory(h.thread.id)?.context).toEqual({ modelCalls: 0, todos: [] })
      await h.complete('new')
      expect(h.reader().window(h.thread.id).messages.map(message => message.id)).toEqual(['new:input', 'new:answer'])
      expect(h.sql.pragma('foreign_key_check')).toEqual([])
    } finally { h.dispose() }
  })

  it('regenerates the selected skill input without losing media, metadata or original archived attachments', async () => {
    const h = fixture()
    try {
      await h.complete('first', { summary: true })
      const archived = await h.attachment('second'), later = await h.attachment('third')
      const content = [{ type: 'text', text: 'Old skill instructions' }, { type: 'image', data: new Uint8Array([0, 255]), mimeType: 'image/png' }, { type: 'text', text: 'Keep later text' }]
      await h.complete('second', { attachments: archived, message: { content, context: { displayText: '/review changes' },
        artifact: new Map([['saved', new Uint8Array([2, 4])]]), source: { metadata: { zero: 0 }, extras: { disabled: false } } } })
      await h.complete('third', { attachments: later })
      const request = { threadId: h.thread.id, messageId: 'second:input', kind: 'regenerate' as const, runId: 'replacement' }
      expect(() => h.history().prepare(request)).toThrow('Skill instructions must be refreshed')
      const beforePreparation = h.owner.store.readHistory(h.thread.id)
      const revision = h.history().prepare({ ...request, skillPromptText: 'Current skill instructions' })
      expect(h.owner.store.readHistory(h.thread.id)).toEqual(beforePreparation)
      expect(h.product.readModel.getRun('replacement')).toBeNull()
      expect(revision.replacement?.message.value.content).toEqual([{ type: 'text', text: 'Current skill instructions' }, ...content.slice(1)])
      const { run } = h.history().commit(revision)
      expect(run).toMatchObject({ id: 'replacement', status: 'running' })
      expect(h.reader().window(h.thread.id).messages.map(message => message.id)).toEqual(['first:input', 'first:answer'])
      expect(h.product.resources.listAttachmentsForMessages(h.thread.id, ['second:input'])).toMatchObject([{ id: archived[0].artifact.id, runId: 'replacement', path: archived[0].artifact.path }])
      expect(h.product.resourceCleanup.listAttachmentFileCleanup().map(item => item.id)).toEqual([later[0].artifact.id])
      h.reopen(); await h.owner.enter('continue', { threadId: h.thread.id, runId: 'replacement' })
      const state = h.owner.store.load(h.thread.id)!
      expect(state.messages.at(-1)?.value).toEqual(revision.replacement?.message.value)
      expect(state.context.summary?.id).toBe('first:summary')
      expect(h.reader().window(h.thread.id).messages.at(-1)).toMatchObject({ id: 'second:input', runId: 'replacement', skillInvocation: { name: 'review' } })
      expect(h.product.getThread(h.thread.id)?.modelConfigId).toBe('chosen-model')
      expect(readFileSync(archived[0].artifact.path, 'utf8')).toBe('second attachment')
      expect(h.sql.pragma('foreign_key_check')).toEqual([])
    } finally { h.dispose() }
  })

  it('rejects an intervening submission before it changes the head, then rejects the changed history', async () => {
    const h = fixture()
    try {
      await h.complete('first')
      const revision = h.history().prepare({ threadId: h.thread.id, messageId: 'first:input', kind: 'truncate' })
      h.owner.createRun({ threadId: h.thread.id, runId: 'concurrent', operation: 'agent',
        message: { id: 'concurrent:input', value: { id: 'concurrent:input', kind: 'user', content: 'Continue', context: { runId: 'concurrent' } } } })
      expect(() => h.history().commit(revision)).toThrow('busy')
      expect(h.owner.store.readHistory(h.thread.id)?.revisionId).toBe(revision.revisionId)
      expect(h.product.readModel.getRun('concurrent')).toMatchObject({ status: 'running' })
      expect(h.reader().window(h.thread.id).messages.map(message => message.id)).toEqual(['first:input', 'first:answer'])
      expect(h.product.resourceCleanup.listAttachmentFileCleanup()).toEqual([])
      await h.owner.enter('input', { threadId: h.thread.id, runId: 'concurrent' })
      h.owner.store.finish(h.scope('concurrent'), 'cancelled')
      expect(() => h.history().commit(revision)).toThrow('history changed')
      expect(h.product.readModel.getRun('first')).not.toBeNull()
    } finally { h.dispose() }
  })

  it('requires affected children to stop and removes only their native executions in the same transaction', async () => {
    const h = fixture()
    try {
      await h.complete('first')
      await h.complete('second', { beforeFinish: async () => {
        for (const id of ['child', 'other-child']) {
          const child = h.owner.createSubagentCall({ id, ownerThreadId: h.thread.id, parentThreadId: h.thread.id, parentRunId: 'second',
            childThreadId: `${id}-thread`, childRunId: `${id}-run`, description: 'Child', childThread: { title: 'Child' },
            config: { capabilities: structuredClone(defaultCapabilities), index: 0, name: 'helper', enabled: true, builtIn: false, description: 'Help', systemPrompt: 'Help' } })
          await h.owner.enter('input', { threadId: child.childThreadId, runId: child.childRunId })
        }
      } })
      expect(h.sql.prepare('SELECT id FROM agent_threads WHERE id NOT IN (SELECT thread_id FROM agent_hidden_threads)').all()).toEqual([{ id: h.thread.id }])
      const revision = h.history().prepare({ threadId: h.thread.id, messageId: 'second:input', kind: 'truncate' })
      expect(() => h.history().commit(revision)).toThrow('tasks must be stopped')
      h.owner.store.finish(h.scope('child-run', 'child-thread'), 'cancelled')
      expect(() => h.history().commit(revision)).toThrow('tasks must be stopped')
      h.owner.reconcileSubagent('child', h.thread.id)
      expect(() => h.history().commit(revision)).toThrow('tasks must be stopped')
      h.owner.store.finish(h.scope('other-child-run', 'other-child-thread'), 'cancelled')
      h.owner.reconcileSubagent('other-child', h.thread.id)
      const before = h.owner.store.readHistory(h.thread.id), children = ['child-thread', 'other-child-thread'].map(id => h.owner.store.readHistory(id))
      for (const target of ['other-child-run', 'second']) {
        h.sql.exec(`CREATE TRIGGER fail_child_history BEFORE DELETE ON agent_runs WHEN OLD.id='${target}' BEGIN SELECT RAISE(ABORT,'history removal failed'); END`)
        expect(() => h.history().commit(revision)).toThrow('history removal failed')
        expect(h.owner.store.readHistory(h.thread.id)).toEqual(before)
        expect(['child-thread', 'other-child-thread'].map(id => h.owner.store.readHistory(id))).toEqual(children)
        for (const id of ['child-thread', 'other-child-thread']) expect(h.product.getThread(id)).not.toBeNull()
        h.sql.exec('DROP TRIGGER fail_child_history')
      }
      h.history().commit(revision); h.reopen()
      expect(h.owner.store.readHistory('child-thread')).toBeUndefined()
      expect(h.product.getThread('child-thread')).toBeNull()
      expect(h.sql.prepare("SELECT * FROM execution_message_bodies WHERE thread_id='child-thread'").all()).toEqual([])
      expect(h.product.resourceCleanup.listAttachmentCleanupThreadIds()).toContain('child-thread')
      expect(h.product.resourceCleanup.listFileEditCleanupRunIds()).toContain('child-run')
      expect(h.owner.store.readHistory('other-child-thread')).toBeUndefined()
      expect(h.product.getThread('other-child-thread')).toBeNull()
      expect(h.product.resourceCleanup.listAttachmentCleanupThreadIds()).toContain('other-child-thread')
      expect(h.product.resourceCleanup.listFileEditCleanupRunIds()).toContain('other-child-run')
      expect(h.product.readModel.getRun('first')).not.toBeNull()
      expect(h.reader().window(h.thread.id).messages.map(message => message.id)).toEqual(['first:input', 'first:answer'])
    } finally { h.dispose() }
  })
})

it.each(['truncate', 'regenerate'] as const)('restores the last earlier manual summary and clears later plans during native %s', async kind => {
  const h = fixture()
  try {
    await h.complete('first', { summary: true, beforeFinish: async () => {
      const state = h.owner.store.load(h.thread.id)!
      h.owner.store.prepareContext(h.scope('first'), { ...state.context, todos: [{ content: 'Old derived plan', status: 'pending' }] })
    } })
    h.owner.createRun({ threadId: h.thread.id, runId: 'manual', operation: 'compression' })
    await h.owner.enter('input', { threadId: h.thread.id, runId: 'manual' })
    const summary = { id: 'manual-summary', summaryText: 'Manual summary', modelContent: 'Manual body', cutoffIndex: 2,
      activatedAfterMessageIndex: 1, coveredThroughMessageId: 'first:answer', inputTokensBefore: 20, inputTokensAfter: 10 }
    h.product.summaries.recordContextSummaryStarted('manual', summary.id)
    h.product.summaries.stageContextSummary('manual', summary.id, summary)
    h.owner.store.commitSummary(h.scope('manual'), summary); h.owner.store.finish(h.scope('manual'), 'completed')
    await h.complete('second', { summary: true }); await h.complete('third', { summary: true })
    h.reopen()
    const revision = h.history().prepare({ threadId: h.thread.id, messageId: 'second:input', ...(kind === 'regenerate' ? { kind, runId: 'replacement' } : { kind }) })
    h.history().commit(revision); h.reopen()
    if (kind === 'regenerate') await h.owner.enter('continue', { threadId: h.thread.id, runId: 'replacement' })
    const history = h.owner.store.readHistory(h.thread.id)!
    expect(history.context.summary?.id).toBe('manual-summary')
    expect(history.context.todos).toEqual([])
    expect(history.messages.map(message => message.id)).toEqual(kind === 'regenerate' ? ['first:input', 'first:answer', 'second:input'] : ['first:input', 'first:answer'])
    expect(h.product.readModel.getRun('manual')?.status).toBe('completed')
    expect(h.product.readModel.getRun('second')).toBeNull(); expect(h.product.readModel.getRun('third')).toBeNull()
    expect(h.product.summaries.getCommittedContextSummary('manual', 'manual-summary')?.modelContent).toBe('Manual body')
    const summaries = h.product.readSnapshot(h.thread.id).activities.flatMap(activity => activity.summaries ?? [])
    expect(summaries.map(summary => summary.id)).toContain('manual-summary')
    expect(summaries.map(summary => summary.id)).not.toContain('second:summary')
    expect(summaries.map(summary => summary.id)).not.toContain('third:summary')
  } finally { h.dispose() }
})
